import {
	checkReceivingMethodReadiness,
	isLocallyValidTarget,
} from "./check-method-readiness";
import {
	type ExchangeRateQuote,
	quoteUsdAmountMinor,
	quoteWithExchangeRate,
} from "./rates";

export type PaymentCandidate = {
	id: string;
	target_value: string;
	min_amount_minor: string | null;
	max_amount_minor: string | null;
	payment_method_id: string;
	code: string;
	decimals: number;
	rail_code: string;
	network_name: string;
	rail_kind: "chain" | "exchange" | "wallet";
	asset_kind: "native" | "token" | "external";
	contract_address: string | null;
	adapter: string | null;
	default_confirmations: number;
	connection_id: string;
};

// Payment routes require a usable HTTP recovery path; WSS is supplemental.
export const readyPaymentConnectionSql = `connection.enabled = 1 AND
 (rail.kind IN ('exchange', 'wallet') OR
  (connection.health_status = 'healthy' AND connection.transport = 'http'))`;

export async function listPaymentCandidates(
	db: D1Database,
	filter: {
		network?: string;
		asset?: string;
		receivingMethodId?: string;
		paymentMethodId?: string;
	} = {},
) {
	const conditions = ["rm.enabled = 1", "rm.target_value != ''"];
	const values: string[] = [];
	for (const [column, value] of [
		["asset.rail_code", filter.network],
		["asset.code", filter.asset],
		["rm.id", filter.receivingMethodId],
		["asset.id", filter.paymentMethodId],
	] as const) {
		if (value !== undefined) {
			conditions.push(`${column} = ?`);
			values.push(value);
		}
	}
	const rows = await db
		.prepare(`SELECT rm.id, rm.target_value, rm.min_amount_minor, rm.max_amount_minor,
 asset.id AS payment_method_id, asset.code, asset.decimals, asset.rail_code,
 asset.kind AS asset_kind, asset.contract_address, asset.default_confirmations,
 rail.adapter, rail.name AS network_name, rail.kind AS rail_kind,
 (SELECT connection.id FROM payment_ingresses connection
  WHERE connection.rail_code = asset.rail_code AND ${readyPaymentConnectionSql}
  ORDER BY connection.priority, connection.id LIMIT 1) AS connection_id
 FROM receiving_methods rm
 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
 JOIN payment_assets asset ON asset.id = link.payment_asset_id
 JOIN payment_rails rail ON rail.code = asset.rail_code
 WHERE ${conditions.join(" AND ")} ORDER BY rm.sort_order, rm.id, asset.id`)
		.bind(...values)
		.all<
			Omit<PaymentCandidate, "connection_id"> & { connection_id: string | null }
		>();
	const candidates: PaymentCandidate[] = [];
	const providerReadiness = new Map<string, boolean>();
	for (const candidate of rows.results) {
		if (
			!candidate.connection_id ||
			!isLocallyValidTarget(candidate.target_value, candidate.adapter) ||
			(candidate.asset_kind === "token" && !candidate.contract_address)
		)
			continue;
		if (candidate.rail_kind !== "chain") {
			let ready = providerReadiness.get(candidate.id);
			if (ready === undefined) {
				ready = (await checkReceivingMethodReadiness(db, candidate.id)).ready;
				providerReadiness.set(candidate.id, ready);
			}
			if (!ready) continue;
		}
		candidates.push({ ...candidate, connection_id: candidate.connection_id });
	}
	return candidates;
}

export async function quotePaymentCandidates(
	db: D1Database,
	candidates: PaymentCandidate[],
	input: { amount: string; currency: string },
) {
	const needsDollarQuote = candidates.some(
		(candidate) =>
			candidate.min_amount_minor !== null ||
			candidate.max_amount_minor !== null,
	);
	const amountUsdMinor = needsDollarQuote
		? await quoteUsdAmountMinor(db, input)
		: null;
	const quotes = new Map<string, ExchangeRateQuote | null>();
	const options: Array<{
		candidate: PaymentCandidate;
		quote: ExchangeRateQuote;
	}> = [];
	let rateUnavailable = needsDollarQuote && amountUsdMinor === null;
	for (const candidate of candidates) {
		if (
			candidate.min_amount_minor !== null ||
			candidate.max_amount_minor !== null
		) {
			if (amountUsdMinor === null) continue;
			const amount = BigInt(amountUsdMinor);
			if (
				(candidate.min_amount_minor !== null &&
					amount < BigInt(candidate.min_amount_minor)) ||
				(candidate.max_amount_minor !== null &&
					amount > BigInt(candidate.max_amount_minor))
			)
				continue;
		}
		const key = `${candidate.code}:${candidate.decimals}`;
		if (!quotes.has(key))
			quotes.set(
				key,
				await quoteWithExchangeRate(db, {
					...input,
					paymentAsset: candidate.code,
					assetDecimals: candidate.decimals,
				}),
			);
		const quote = quotes.get(key);
		if (!quote) {
			rateUnavailable = true;
			continue;
		}
		options.push({ candidate, quote });
	}
	return { options, amountUsdMinor, rateUnavailable };
}

export function shuffledPaymentCandidates<T>(candidates: readonly T[]) {
	return candidates
		.map((candidate) => ({ candidate, rank: Math.random() }))
		.sort((left, right) => left.rank - right.rank)
		.map(({ candidate }) => candidate);
}

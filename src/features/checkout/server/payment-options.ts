import { z } from "zod";
import { orderIdPathSchema } from "#/features/orders/schema";
import { initializeOkPayOrder } from "#/features/orders/server/okpay-hosted";
import {
	listPaymentCandidates,
	quotePaymentCandidates,
	shuffledPaymentCandidates,
} from "#/features/payment-settings/server/payment-candidates";
import {
	allocateUniqueReceivingMethodAndSnapshot,
	ReceivingMethodUnavailableError,
} from "#/features/payment-settings/server/receiving-method-locks";
import { DomainError } from "#/lib/domain-error";
import { decimalToUnits, unitsToDecimal } from "#/lib/money";
import { minorToDecimal } from "#/lib/units";
import { loadOperationalSettings } from "#/server/operational-settings";
import { getCheckoutOrderWithDatabase } from "./checkout-order";

export const paymentOptionInput = z.object({
	orderId: orderIdPathSchema,
	network: z.string().trim().min(1).max(100),
	paymentMethodId: z.string().trim().min(1).max(100),
});

type OrderForSelection = {
	id: string;
	external_order_id: string;
	status: string;
	amount: string;
	currency: string;
	paymentAmount: string | null;
	description: string | null;
	return_url: string | null;
	expires_at: number;
	received_amount_units: string;
	payment_asset_id: string | null;
	provider_order_id: string | null;
	payment_url: string | null;
	version: number;
	current_asset_code: string;
	current_network: string;
	current_network_name: string;
	current_payment_method_id: string;
	current_rail_kind: "chain" | "exchange" | "wallet" | "";
	receiving_method_id: string | null;
	payment_count: number;
	pending_review_count: number;
};

export type CheckoutPaymentOption = {
	paymentMethodId: string;
	asset: string;
	network: string;
	networkName: string;
	railKind: "chain" | "exchange" | "wallet" | "";
	amount: string;
	current: boolean;
};

function canSelect(order: OrderForSelection) {
	return (
		order.status === "pending" &&
		order.received_amount_units === "0" &&
		order.expires_at > Date.now() &&
		!order.provider_order_id &&
		order.payment_count === 0 &&
		order.pending_review_count === 0
	);
}

export async function listCheckoutPaymentOptions(
	db: D1Database,
	orderId: string,
) {
	const order = await readOrder(db, orderIdPathSchema.parse(orderId));
	if (!order) return null;
	if (order.receiving_method_id)
		return {
			selectable: false,
			options: [
				{
					paymentMethodId: order.current_payment_method_id,
					asset: order.current_asset_code,
					network: order.current_network,
					networkName: order.current_network_name,
					railKind: order.current_rail_kind,
					amount: order.paymentAmount ?? "",
					current: true,
				},
			],
			unavailableReason: null,
		};
	if (!canSelect(order))
		return { selectable: false, options: [], unavailableReason: null };
	const quoted = await quotePaymentCandidates(
		db,
		await listPaymentCandidates(db),
		order,
	);
	const grouped = new Map<string, CheckoutPaymentOption>();
	for (const { candidate, quote } of quoted.options) {
		const key = `${candidate.rail_kind}:${candidate.rail_code}:${candidate.payment_method_id}`;
		if (!grouped.has(key))
			grouped.set(key, {
				paymentMethodId: candidate.payment_method_id,
				asset: candidate.code,
				network: candidate.rail_code,
				networkName: candidate.network_name,
				railKind: candidate.rail_kind,
				amount: quote.paymentAmount,
				current: false,
			});
	}
	const options = [...grouped.values()];
	return {
		selectable: true,
		options,
		unavailableReason: options.length
			? null
			: quoted.rateUnavailable
				? ("rate_unavailable" as const)
				: ("payment_method_unavailable" as const),
	};
}

export async function selectCheckoutPaymentOption(
	db: D1Database,
	input: z.infer<typeof paymentOptionInput>,
) {
	const data = paymentOptionInput.parse(input);
	const order = await readOrder(db, data.orderId);
	if (!order) throw new PaymentOptionError("order_not_found", 404);
	if (order.receiving_method_id) return existingSelection(db, order, data);
	if (!canSelect(order)) throw new PaymentOptionError("order_unavailable", 409);
	const candidates = await listPaymentCandidates(db, {
		network: data.network,
		paymentMethodId: data.paymentMethodId,
	});
	const quoted = await quotePaymentCandidates(db, candidates, order);
	if (!quoted.options.length)
		throw new PaymentOptionError(
			quoted.rateUnavailable
				? "rate_unavailable"
				: "payment_option_unavailable",
			409,
		);
	const now = Date.now();
	const settings = await loadOperationalSettings(db);
	for (const { candidate, quote } of shuffledPaymentCandidates(
		quoted.options,
	)) {
		try {
			await allocateUniqueReceivingMethodAndSnapshot(db, {
				orderId: order.id,
				receivingMethodId: candidate.id,
				paymentMethodId: candidate.payment_method_id,
				decimals: candidate.decimals,
				expectedAmountUnits: decimalToUnits(
					quote.paymentAmount,
					candidate.decimals,
					"up",
				).toString(),
				...(quoted.amountUsdMinor !== null
					? { orderAmountUsdMinor: quoted.amountUsdMinor }
					: {}),
				expiresAt: order.expires_at,
				reusableAt: settings.immediateReleaseMode
					? order.expires_at
					: order.expires_at + settings.reorgMonitorMs,
				immediateReleaseMode: settings.immediateReleaseMode,
				now,
				checkoutAmountDecimals: settings.checkoutAmountDecimals,
				rate: {
					source: quote.source,
					raw: quote.rawRate,
					adjustment: String(quote.adjustmentBps),
					final: quote.finalRate,
					observedAt: quote.observedAt,
				},
				existingOrder: { expectedVersion: order.version },
			});
		} catch (error) {
			if (!(error instanceof ReceivingMethodUnavailableError)) throw error;
			const current = await readOrder(db, order.id);
			if (current?.receiving_method_id)
				return existingSelection(db, current, data);
			if (!current || !canSelect(current) || current.version !== order.version)
				throw new PaymentOptionError("order_unavailable", 409);
			continue;
		}
		if (candidate.rail_code === "okpay") {
			const selected = await getCheckoutOrderWithDatabase(db, order.id);
			if (!selected?.actual_amount)
				throw new PaymentOptionError("order_unavailable", 409);
			await initializeOkPayOrder(
				db,
				{
					orderId: order.id,
					externalOrderId: order.external_order_id,
					status: "pending",
					amount: order.amount,
					currency: order.currency,
					paymentAmount: selected.actual_amount,
					paymentAsset: candidate.code,
					paymentNetwork: candidate.rail_code,
					checkoutUrl: "",
					expiresAt: selected.expiration_time ?? "",
				},
				{
					externalOrderId: order.external_order_id,
					amount: order.amount,
					currency: order.currency,
					paymentAsset: candidate.code,
					paymentNetwork: candidate.rail_code,
					description: order.description ?? undefined,
					returnUrl: order.return_url ?? undefined,
				},
			);
		}
		return selectedResult(db, order.id);
	}
	throw new PaymentOptionError("payment_option_unavailable", 409);
}

function existingSelection(
	db: D1Database,
	order: OrderForSelection,
	data: z.infer<typeof paymentOptionInput>,
) {
	if (
		order.current_network !== data.network ||
		order.current_payment_method_id !== data.paymentMethodId
	)
		throw new PaymentOptionError("payment_snapshot_immutable", 409);
	return selectedResult(db, order.id);
}

async function selectedResult(db: D1Database, orderId: string) {
	const order = await getCheckoutOrderWithDatabase(db, orderId);
	if (!order) throw new PaymentOptionError("order_not_found", 404);
	return {
		orderId,
		asset: order.token ?? "",
		network: order.network ?? "",
		paymentAmount: order.actual_amount ?? "",
		expiresAt: order.expiration_time ?? "",
		order,
	};
}

async function readOrder(db: D1Database, id: string) {
	const row = await db
		.prepare(
			`SELECT o.id, o.external_order_id, o.status, o.amount_minor,
			 o.currency, o.currency_decimals, o.description, o.return_url, o.expires_at,
			 o.received_amount_units, o.payment_asset_id,
			 o.provider_order_id, o.payment_url, o.version,
			 ops.expected_amount_units, ops.decimals AS payment_decimals,
			 COALESCE(ops.asset_code, a.code, '') AS current_asset_code,
			 COALESCE(ops.rail_code, a.rail_code, '') AS current_network,
			 COALESCE(rail.name, ops.rail_code, a.rail_code, '') AS current_network_name,
			 COALESCE(ops.asset_id, '') AS current_payment_method_id,
			 COALESCE(ops.rail_kind, rail.kind, '') AS current_rail_kind,
			 ops.receiving_method_id,
			 (SELECT COUNT(*) FROM order_payments op WHERE op.order_id = o.id) AS payment_count,
			 (SELECT COUNT(*) FROM payment_reviews pr WHERE pr.order_id = o.id
			  AND pr.status = 'pending') AS pending_review_count
			 FROM orders o LEFT JOIN payment_assets a ON a.id = o.payment_asset_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 LEFT JOIN payment_rails rail ON rail.code = COALESCE(ops.rail_code, a.rail_code)
			 WHERE o.id = ? LIMIT 1`,
		)
		.bind(id)
		.first<
			Omit<OrderForSelection, "amount" | "paymentAmount"> & {
				amount_minor: string;
				currency_decimals: number;
				expected_amount_units: string | null;
				payment_decimals: number | null;
			}
		>();
	if (!row) return null;
	return {
		...row,
		amount: minorToDecimal(row.amount_minor, row.currency_decimals),
		paymentAmount:
			row.expected_amount_units !== null && row.payment_decimals !== null
				? unitsToDecimal(
						BigInt(row.expected_amount_units),
						row.payment_decimals,
					)
				: null,
	};
}

export class PaymentOptionError extends DomainError {
	constructor(
		code:
			| "order_not_found"
			| "payment_snapshot_immutable"
			| "order_unavailable"
			| "receiving_method_not_ready"
			| "payment_option_unavailable"
			| "rate_unavailable",
		status: number,
	) {
		super(code, status, code);
		this.name = "PaymentOptionError";
	}
}

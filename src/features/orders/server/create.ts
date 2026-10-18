import { generateOrderId } from "#/features/orders/order-id";
import type { CreateOrderInput } from "#/features/orders/schema";
import type { ApiOrder } from "#/features/orders/server/query";
import type { ReceivingMethodReadiness } from "#/features/payment-settings/readiness";
import { isLocallyValidTarget } from "#/features/payment-settings/server/check-method-readiness";
import {
	quoteUsdAmountMinor,
	quoteWithExchangeRate,
} from "#/features/payment-settings/server/rates";
import {
	allocateUniqueReceivingMethodAndSnapshot,
	PaymentOrderConflictError,
	ReceivingMethodUnavailableError,
} from "#/features/payment-settings/server/receiving-method-locks";
import { decimalToUnits } from "#/lib/money";
import { currencyDecimals, decimalToMinor } from "#/lib/units";
import { loadOperationalSettings } from "#/server/operational-settings";
import type { RuntimeCache } from "#/server/runtime/types";

const paymentRouteCacheTtlSeconds = 30;

type PaymentRouteCandidate = {
	id: string;
	target_value: string;
	min_amount_minor: string | null;
	max_amount_minor: string | null;
	payment_method_id: string;
	code: string;
	decimals: number;
	rail_code: string;
	asset_kind: "native" | "token" | "external";
	contract_address: string | null;
	adapter: string | null;
	default_confirmations: number;
	connection_id: string | null;
};

async function createOrderAwaitingReceivingMethod(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
): Promise<ApiOrder> {
	context.stage?.("settings");
	const settings = await loadOperationalSettings(db);
	const expiresInMs = resolveOrderExpiryMs(input.expiresInMs, settings);
	const id = generateOrderId();
	const now = Date.now();
	const expiresAt = now + expiresInMs;
	const fiatDecimals = currencyDecimals(input.currency);
	const amountMinor = decimalToMinor(input.amount, fiatDecimals).toString();
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO orders
					 (id, external_order_id, status, amount_minor, currency, currency_decimals,
					 payment_asset_id, received_amount_units,
					 description, return_url, notify_url, api_key_id, api_protocol, metadata, expires_at, version, created_at, updated_at)
					 VALUES (?, ?, 'pending', ?, ?, ?, NULL, '0', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		)
		.bind(
			id,
			input.externalOrderId,
			amountMinor,
			input.currency,
			fiatDecimals,
			input.description ?? null,
			input.returnUrl ?? null,
			input.notifyUrl ?? null,
			context.apiKeyId ?? null,
			context.apiProtocol ?? null,
			input.metadata ? JSON.stringify(input.metadata) : null,
			expiresAt,
			now,
			now,
		)
		.run();
	if (result.meta.changes !== 1) {
		const existing = await db
			.prepare(
				"SELECT 1 AS value FROM orders WHERE external_order_id = ? AND api_key_id IS ? LIMIT 1",
			)
			.bind(input.externalOrderId, context.apiKeyId ?? null)
			.first<{ value: number }>();
		if (existing)
			throw new OrderServiceError(
				"external_order_exists",
				"External order ID already exists",
				409,
			);
		throw new Error("Order could not be created");
	}
	return {
		orderId: id,
		externalOrderId: input.externalOrderId,
		status: "pending",
		amount: input.amount,
		currency: input.currency,
		checkoutUrl: `${new URL(requestUrl).origin}/checkout/${id}`,
		expiresAt: new Date(expiresAt).toISOString(),
		...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
	};
}

export async function createOrder(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
): Promise<ApiOrder> {
	const order = await createOrderRecord(db, input, requestUrl, context);
	if (order.paymentNetwork === "okpay") {
		const { initializeOkPayOrder } = await import(
			"#/features/orders/server/okpay-hosted"
		);
		await initializeOkPayOrder(db, order, input);
	}
	return order;
}

async function createOrderRecord(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
): Promise<ApiOrder> {
	if (input.receivingMethodId)
		return createOrderFromReceivingMethod(db, input, requestUrl, context);
	if (!(input.paymentAsset && input.paymentNetwork))
		return createOrderAwaitingReceivingMethod(db, input, requestUrl, context);
	const methods = await loadPaymentRouteCandidates(
		db,
		input.paymentAsset,
		input.paymentNetwork,
		context.cache,
		context.stage,
	);
	context.stage?.("candidate_query");
	const readyMethods = methods.filter((method) =>
		isRouteCandidateReady(method),
	);
	context.stage?.("readiness");
	const selectedMethod = pickRandomItem(readyMethods);
	if (selectedMethod)
		return createOrderFromReceivingMethod(
			db,
			{ ...input, receivingMethodId: selectedMethod.id },
			requestUrl,
			context,
			undefined,
			selectedMethod,
		);
	if (methods.length === 0)
		throw new OrderServiceError(
			"receiving_method_not_found",
			"No receiving method matches the requested asset and rail",
			422,
		);
	throw new OrderServiceError(
		"receiving_method_not_ready",
		"No matching receiving method is currently ready",
		422,
	);
}

async function loadPaymentRouteCandidates(
	db: D1Database,
	paymentAsset: string,
	paymentNetwork: string,
	cache?: RuntimeCache,
	stage?: (stage: string) => void,
): Promise<Array<PaymentRouteCandidate>> {
	const cacheKey = `payment-route:v1:${paymentNetwork}:${paymentAsset}`;
	if (cache) {
		try {
			const cached = await cache.get(cacheKey);
			const parsed = cached ? JSON.parse(cached) : null;
			if (
				Array.isArray(parsed) &&
				parsed.length > 0 &&
				parsed.every(isRouteCandidate)
			) {
				stage?.("route_cache_hit");
				return parsed as PaymentRouteCandidate[];
			}
		} catch {
			stage?.("route_cache_fallback");
			// KV is an optional routing optimisation; D1 remains authoritative.
		}
	}
	stage?.("route_cache_miss");
	const methods = await db
		.prepare(
			`SELECT rm.id, rm.target_value, rm.min_amount_minor, rm.max_amount_minor,
			 pa.id AS payment_method_id,
			 pa.code, pa.decimals, pa.kind AS asset_kind, pa.rail_code, pa.contract_address,
			 pa.default_confirmations, pr.adapter,
			 (SELECT connection.id FROM payment_ingresses connection
			  WHERE connection.rail_code = pa.rail_code AND connection.enabled = 1
			  ORDER BY connection.priority, connection.id LIMIT 1) AS connection_id
			 FROM receiving_methods rm
			 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
			 JOIN payment_assets pa ON pa.id = link.payment_asset_id
			 JOIN payment_rails pr ON pr.code = pa.rail_code
			 WHERE rm.enabled = 1
			 AND rm.target_value != ''
			 AND pa.code = ?
			 AND pa.rail_code = ?
			 AND EXISTS (SELECT 1 FROM payment_ingresses pc
				WHERE pc.rail_code = pa.rail_code AND pc.enabled = 1)`,
		)
		.bind(paymentAsset, paymentNetwork)
		.all<PaymentRouteCandidate>();
	if (cache && methods.results.length) {
		try {
			const cacheWrite = cache.put(cacheKey, JSON.stringify(methods.results), {
				expirationTtl: paymentRouteCacheTtlSeconds,
			});
			void cacheWrite
				.then(() => stage?.("route_cache_write"))
				.catch(() => stage?.("route_cache_fallback"));
		} catch {
			stage?.("route_cache_fallback");
		}
	}
	return methods.results;
}

function isRouteCandidate(value: unknown): value is PaymentRouteCandidate {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		typeof candidate.target_value === "string" &&
		typeof candidate.payment_method_id === "string" &&
		candidate.payment_method_id.length > 0 &&
		typeof candidate.code === "string" &&
		candidate.code.length > 0 &&
		typeof candidate.decimals === "number" &&
		typeof candidate.rail_code === "string" &&
		candidate.rail_code.length > 0 &&
		(candidate.min_amount_minor === null ||
			typeof candidate.min_amount_minor === "string") &&
		(candidate.max_amount_minor === null ||
			typeof candidate.max_amount_minor === "string") &&
		(candidate.asset_kind === "native" ||
			candidate.asset_kind === "token" ||
			candidate.asset_kind === "external") &&
		(candidate.contract_address === null ||
			typeof candidate.contract_address === "string") &&
		typeof candidate.default_confirmations === "number" &&
		(typeof candidate.connection_id === "string" ||
			candidate.connection_id === null)
	);
}

function isRouteCandidateReady(method: PaymentRouteCandidate) {
	if (!method.connection_id) return false;
	if (method.asset_kind === "token" && !method.contract_address) return false;
	return isLocallyValidTarget(method.target_value, method.adapter);
}

function pickRandomItem<T>(items: readonly T[]): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(Math.random() * items.length)];
}

async function createOrderFromReceivingMethod(
	db: D1Database,
	input: CreateOrderInput,
	requestUrl: string,
	context: OrderCreationContext = {},
	prevalidatedReadiness?: ReceivingMethodReadiness,
	routeCandidate?: PaymentRouteCandidate,
): Promise<ApiOrder> {
	const methodId = input.receivingMethodId;
	if (!methodId) throw new Error("Receiving method is required");
	const methods = routeCandidate
		? { results: [routeCandidate] }
		: await db
				.prepare(
					`SELECT rm.id, rm.target_value, rm.min_amount_minor, rm.max_amount_minor,
					 pa.id AS payment_method_id, pa.default_confirmations,
					 pa.code, pa.decimals, pa.rail_code, pa.kind AS asset_kind,
					 pa.contract_address, pr.adapter,
					 (SELECT connection.id FROM payment_ingresses connection
					  WHERE connection.rail_code = pa.rail_code AND connection.enabled = 1
					  ORDER BY connection.priority, connection.id LIMIT 1) AS connection_id
					 FROM receiving_methods rm
					 JOIN receiving_method_assets link ON link.receiving_method_id = rm.id
					 JOIN payment_assets pa ON pa.id = link.payment_asset_id
					 JOIN payment_rails pr ON pr.code = pa.rail_code
				 WHERE rm.id = ? ${input.paymentAsset ? "AND pa.code = ?" : ""} ${
						input.paymentNetwork ? "AND pa.rail_code = ?" : ""
					}`,
				)
				.bind(
					methodId,
					...(input.paymentAsset ? [input.paymentAsset] : []),
					...(input.paymentNetwork ? [input.paymentNetwork] : []),
				)
				.all<PaymentRouteCandidate>();
	const readinessInput = {
		paymentAsset: input.paymentAsset,
		paymentNetwork: input.paymentNetwork,
	};
	const resolvedReadiness = routeCandidate
		? (prevalidatedReadiness ?? {
				receivingMethodId: methodId,
				ready: true,
				status: "ready" as const,
				reasons: [],
				checkedAt: Date.now(),
			})
		: validateMethodCandidateReadiness(methods.results[0], readinessInput);
	context.stage?.("method_details");
	if (!resolvedReadiness.ready)
		throw new OrderServiceError(
			"receiving_method_not_ready",
			resolvedReadiness.reasons[0]?.message ?? "Receiving method is not ready",
			422,
		);
	const method =
		input.paymentAsset || input.paymentNetwork
			? methods.results.find(
					(candidate) =>
						(!input.paymentAsset || candidate.code === input.paymentAsset) &&
						(!input.paymentNetwork ||
							candidate.rail_code === input.paymentNetwork),
				)
			: methods.results.length === 1
				? methods.results[0]
				: undefined;
	if (!method)
		throw new OrderServiceError(
			"receiving_method_not_found",
			methods.results.length > 1
				? "Select a currency supported by this receiving method"
				: "Receiving method does not exist",
			422,
		);
	const connectionId = method.connection_id;
	if (!connectionId)
		throw new OrderServiceError(
			"receiving_method_not_ready",
			"The receiving connection is unavailable.",
			422,
		);
	const paymentInput = {
		...input,
		paymentAsset: method.code,
		paymentNetwork: method.rail_code,
	};
	const exchangeRateQuoteTask = quoteWithExchangeRate(db, {
		amount: input.amount,
		currency: input.currency,
		paymentAsset: method.code,
		assetDecimals: method.decimals,
	});
	const orderAmountTask =
		method.min_amount_minor !== null || method.max_amount_minor !== null
			? quoteUsdAmountMinor(db, {
					amount: input.amount,
					currency: input.currency,
				})
			: Promise.resolve(null);
	const settingsTask = loadOperationalSettings(db);
	const [exchangeRateQuote, orderAmountUsdMinor, settings] = await Promise.all([
		exchangeRateQuoteTask,
		orderAmountTask,
		settingsTask,
	]);
	context.stage?.("quote");
	let paymentAmount =
		exchangeRateQuote?.paymentAmount ??
		(await quotePaymentAmount(db, paymentInput, method.decimals));
	const expectedAmountUnits = decimalToUnits(
		paymentAmount,
		method.decimals,
		"up",
	).toString();
	context.stage?.("settings");
	const expiresInMs = resolveOrderExpiryMs(input.expiresInMs, settings);
	const now = Date.now();
	const expiresAt = now + expiresInMs;
	const fiatDecimals = currencyDecimals(input.currency);
	const amountMinor = decimalToMinor(input.amount, fiatDecimals).toString();
	const orderId = generateOrderId();
	try {
		const allocation = await allocateUniqueReceivingMethodAndSnapshot(db, {
			orderId,
			receivingMethodId: methodId,
			paymentMethodId: method.payment_method_id,
			expectedAmountUnits,
			...(orderAmountUsdMinor ? { orderAmountUsdMinor } : {}),
			decimals: method.decimals,
			expiresAt,
			reusableAt: settings.immediateReleaseMode
				? expiresAt
				: expiresAt + settings.reorgMonitorMs,
			prepared: {
				now,
				reusableAt: settings.immediateReleaseMode
					? expiresAt
					: expiresAt + settings.reorgMonitorMs,
				method: {
					id: method.id,
					min_amount_minor: method.min_amount_minor,
					max_amount_minor: method.max_amount_minor,
					target_value: method.target_value,
					payment_method_id: method.payment_method_id,
					default_confirmations: method.default_confirmations,
					asset_id: method.payment_method_id,
					rail_code: method.rail_code,
					connection_id: connectionId,
				},
			},
			immediateReleaseMode: settings.immediateReleaseMode,
			now,
			checkoutAmountDecimals: settings.checkoutAmountDecimals,
			skipLockMaintenance: Boolean(routeCandidate),
			stage: context.stage,
			...(exchangeRateQuote
				? {
						rate: {
							source: exchangeRateQuote.source,
							raw: exchangeRateQuote.rawRate,
							adjustment: String(exchangeRateQuote.adjustmentBps),
							final: exchangeRateQuote.finalRate,
							observedAt: exchangeRateQuote.observedAt,
						},
					}
				: {}),
			order: {
				externalOrderId: input.externalOrderId,
				amountMinor,
				currency: input.currency,
				currencyDecimals: fiatDecimals,
				...(input.description ? { description: input.description } : {}),
				...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
				...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
				...(context.apiKeyId ? { apiKeyId: context.apiKeyId } : {}),
				...(context.apiProtocol ? { apiProtocol: context.apiProtocol } : {}),
				...(input.metadata ? { metadata: input.metadata } : {}),
			},
		});
		context.stage?.("allocation");
		paymentAmount = allocation.paymentAmount;
	} catch (error) {
		if (error instanceof PaymentOrderConflictError)
			throw new OrderServiceError(
				"external_order_exists",
				"External order ID already exists",
				409,
			);
		if (error instanceof ReceivingMethodUnavailableError)
			throw new OrderServiceError(
				"payment_target_unavailable",
				error.message,
				503,
			);
		throw error;
	}
	return {
		orderId,
		externalOrderId: input.externalOrderId,
		status: "pending",
		amount: input.amount,
		currency: input.currency,
		paymentAmount,
		paymentAsset: method.code,
		paymentNetwork: method.rail_code,
		receivingMethodId: methodId,
		receiveAddress: method.target_value,
		checkoutUrl: `${new URL(requestUrl).origin}/checkout/${orderId}`,
		expiresAt: new Date(expiresAt).toISOString(),
		...(input.notifyUrl ? { notifyUrl: input.notifyUrl } : {}),
	};
}

function resolveOrderExpiryMs(
	requestedExpiryMs: number | undefined,
	settings: Awaited<ReturnType<typeof loadOperationalSettings>>,
) {
	if (settings.immediateReleaseMode) return settings.fixedExpiryMs;
	const expiresInMs = requestedExpiryMs ?? settings.defaultExpiryMs;
	if (expiresInMs > settings.maxExpiryMs)
		throw new OrderServiceError(
			"expiry_exceeds_limit",
			"Order expiry exceeds the configured maximum",
			422,
		);
	return expiresInMs;
}

function validateMethodCandidateReadiness(
	method: PaymentRouteCandidate | undefined,
	expected: { paymentAsset?: string; paymentNetwork?: string },
): ReceivingMethodReadiness {
	const checkedAt = Date.now();
	if (!method) {
		return {
			receivingMethodId: "unknown",
			ready: false,
			status: "unsupported",
			reasons: [
				{
					code: "METHOD_NOT_FOUND",
					message: "Receiving method does not exist.",
				},
			],
			checkedAt,
		};
	}
	if (!method.connection_id) {
		return {
			receivingMethodId: method.id,
			ready: false,
			status: "missing_connection",
			reasons: [
				{
					code: "MISSING_CONNECTION",
					message: "Configure an enabled payment connection.",
				},
			],
			checkedAt,
		};
	}
	if (
		method.asset_kind === "token" &&
		(!method.contract_address || !method.contract_address.trim())
	) {
		return {
			receivingMethodId: method.id,
			ready: false,
			status: "unsupported",
			reasons: [
				{
					code: "INVALID_ASSET",
					message: "The token contract is not configured.",
				},
			],
			checkedAt,
		};
	}
	if (
		!method.target_value.trim() ||
		!isLocallyValidTarget(method.target_value, method.adapter)
	) {
		return {
			receivingMethodId: method.id,
			ready: false,
			status: "missing_target",
			reasons: [
				{
					code: "INVALID_TARGET",
					message: "The receiving target is invalid.",
				},
			],
			checkedAt,
		};
	}
	if (expected && !expected.paymentAsset && !expected.paymentNetwork)
		return {
			receivingMethodId: method.id,
			ready: true,
			status: "ready",
			reasons: [],
			checkedAt,
		};
	if (
		(expected.paymentAsset && method.code !== expected.paymentAsset) ||
		(expected.paymentNetwork && method.rail_code !== expected.paymentNetwork)
	) {
		return {
			receivingMethodId: method.id,
			ready: false,
			status: "unsupported",
			reasons: [
				{
					code: "METHOD_NOT_FOUND",
					message: "Receiving method does not support this route.",
				},
			],
			checkedAt,
		};
	}
	return {
		receivingMethodId: method.id,
		ready: true,
		status: "ready",
		reasons: [],
		checkedAt,
	};
}

export interface OrderCreationContext {
	apiKeyId?: string;
	apiProtocol?: "gmpay" | "epay";
	stage?: (stage: string) => void;
	cache?: RuntimeCache;
}

async function quotePaymentAmount(
	db: D1Database,
	input: CreateOrderInput,
	assetDecimals: number,
) {
	if (!input.paymentAsset)
		throw new OrderServiceError(
			"payment_asset_required",
			"Payment asset is required for quoting",
			422,
		);
	const quote = await quoteWithExchangeRate(db, {
		amount: input.amount,
		currency: input.currency,
		paymentAsset: input.paymentAsset,
		assetDecimals,
	});
	if (quote) return quote.paymentAmount;
	throw new OrderServiceError(
		"exchange_rate_unavailable",
		"No current exchange rate is available for the requested pair",
		503,
	);
}

export class OrderServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

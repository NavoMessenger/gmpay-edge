import { createReceivingMethodAdapters } from "#/features/payment-settings/server/method-adapter";
import {
	PaymentAttributionAmbiguousError,
	PaymentAttributionNotFoundError,
	resolvePaymentTransactionOrder,
} from "#/features/payments/server/attribution";
import { recordPaymentTransaction } from "#/features/payments/server/process";
import type { PaymentScanMessage } from "#/features/payments/types";
import type {
	Network,
	NormalizedTransaction,
	PaymentAdapter,
} from "#/integrations/chains/types";
import { providerRetryDelayMs } from "#/integrations/provider-errors";
import {
	isObservedProviderAdapter,
	providerOperationDurationMs,
	recordProviderOperation,
} from "#/integrations/provider-observability";
import type { RuntimeConfig } from "#/server/runtime-config";

const scannableOrderStatuses = new Set([
	"pending",
	"confirming",
	"partially_paid",
	"paid",
	"overpaid",
]);

export async function handlePaymentScan(
	message: Message<PaymentScanMessage>,
	env: Env,
	runtime?: RuntimeConfig,
	adapterCache?: Map<string, ReceivingAdaptersPromise>,
	discoveryCache?: PaymentDiscoveryCache,
	transactionCache?: PaymentTransactionCache,
): Promise<void> {
	const payment = await env.DB.prepare(
		`SELECT ops.asset_code, ops.target_value, o.provider_order_id,
		 o.payment_scan_cursor, o.status, o.created_at,
		 EXISTS(SELECT 1 FROM order_payments op
		  WHERE op.order_id = o.id AND op.status IN ('detected','confirming'))
		  AS has_unsettled_payments
		 FROM order_payment_snapshots ops
		 JOIN orders o ON o.id = ops.order_id
		 WHERE ops.order_id = ? AND ops.receiving_method_id = ? LIMIT 1`,
	)
		.bind(message.body.orderId, message.body.receivingMethodId)
		.first<{
			asset_code: string;
			target_value: string;
			provider_order_id: string | null;
			payment_scan_cursor: string | null;
			status: string;
			created_at: number;
			has_unsettled_payments: number;
		}>();
	if (!payment) {
		message.ack();
		return;
	}
	// Re-check eligibility at consumption time because the order or its payments
	// may have reached a terminal state after this message was queued.
	if (
		!scannableOrderStatuses.has(payment.status) ||
		((payment.status === "paid" || payment.status === "overpaid") &&
			payment.has_unsettled_payments === 0)
	) {
		message.ack();
		return;
	}
	const scan: AuthoritativePaymentScan = {
		...message.body,
		address: payment.target_value,
		...(payment.provider_order_id
			? { providerOrderId: payment.provider_order_id }
			: {}),
		...(payment.payment_scan_cursor
			? { sinceBlock: payment.payment_scan_cursor }
			: {}),
		sinceTimestamp: new Date(payment.created_at),
		refreshOnly: payment.status === "paid" || payment.status === "overpaid",
	};
	let candidates: Awaited<ReturnType<typeof createReceivingMethodAdapters>>;
	try {
		const load = () =>
			createReceivingMethodAdapters(
				env.DB,
				message.body.receivingMethodId,
				runtime,
			);
		if (!adapterCache) candidates = await load();
		else {
			const key = message.body.receivingMethodId;
			let pending = adapterCache.get(key);
			if (!pending) {
				pending = load();
				adapterCache.set(key, pending);
			}
			candidates = await pending;
		}
	} catch {
		await recordPaymentScanIssue(env.DB, message.body, "configuration");
		message.retry();
		return;
	}
	if (!candidates.length) {
		await recordPaymentScanIssue(env.DB, message.body, "configuration");
		message.retry();
		return;
	}
	let failoverCount = 0;
	let earliestCooldownMs = Number.POSITIVE_INFINITY;
	for (const [index, candidate] of candidates.entries()) {
		if (candidate.connectionId) {
			const cooldownMs = await paymentConnectionCooldownMs(
				env.DB,
				candidate.connectionId,
			);
			if (cooldownMs > 0) {
				earliestCooldownMs = Math.min(earliestCooldownMs, cooldownMs);
				continue;
			}
		}
		const startedAt = performance.now();
		let transactions: NormalizedTransaction[];
		try {
			transactions = await scanTransactions(
				env.DB,
				scan,
				payment.asset_code,
				candidate.adapter,
				candidate.subscription,
				discoveryCache,
				JSON.stringify([
					candidate.connectionId,
					candidate.adapter.network,
					scan.address,
					payment.asset_code,
					scan.providerOrderId ?? null,
				]),
				transactionCache,
				candidate.connectionId,
			);
			if (isObservedProviderAdapter(candidate.adapter.id))
				recordProviderOperation({
					adapter: candidate.adapter.id,
					operation: "payment_scan",
					outcome: "success",
					status: transactions.length ? "ok" : "empty",
					errorCode: null,
					durationMs: providerOperationDurationMs(startedAt),
					failoverCount,
				});
		} catch (error) {
			const kind = candidate.adapter.classifyError(error);
			const retryDelayMs =
				kind === "rate_limit"
					? providerRetryDelayMs(error, message.attempts)
					: undefined;
			const retryable = candidate.adapter.isRetryable(kind);
			const willFailover = retryable && index < candidates.length - 1;
			if (willFailover) failoverCount += 1;
			if (isObservedProviderAdapter(candidate.adapter.id))
				recordProviderOperation({
					adapter: candidate.adapter.id,
					operation: "payment_scan",
					outcome: "failure",
					status: "error",
					errorCode: kind,
					durationMs: providerOperationDurationMs(startedAt),
					failoverCount,
				});
			if (candidate.connectionId)
				await recordPaymentScanObservation(
					env.DB,
					candidate.connectionId,
					kind,
					retryDelayMs,
				);
			if (kind === "rate_limit") {
				earliestCooldownMs = Math.min(
					earliestCooldownMs,
					retryDelayMs ?? 30_000,
				);
				continue;
			}
			if (!retryable) {
				await recordPaymentScanIssue(env.DB, message.body, kind);
				message.ack();
				return;
			}
			continue;
		}
		if (candidate.connectionId)
			await recordPaymentScanObservation(env.DB, candidate.connectionId, null);
		await processScannedTransactions(
			env,
			message.body.orderId,
			transactions,
			runtime,
		);
		await advancePaymentScanCursor(
			env.DB,
			message.body.orderId,
			transactions,
			candidate.adapter.scanCursor?.(),
		);
		message.ack();
		return;
	}
	if (Number.isFinite(earliestCooldownMs)) {
		message.retry({
			delaySeconds: Math.max(1, Math.ceil(earliestCooldownMs / 1000)),
		});
		return;
	}
	await recordPaymentScanIssue(env.DB, message.body, "connections_unavailable");
	message.retry();
}

type ReceivingAdaptersPromise = ReturnType<
	typeof createReceivingMethodAdapters
>;

export type PaymentDiscoveryCache = Map<
	string,
	{
		sinceBlock?: bigint;
		sinceTimestamp?: number;
		transactions: Promise<NormalizedTransaction[]>;
	}
>;

export type PaymentTransactionCache = Map<
	string,
	Promise<NormalizedTransaction | null>
>;

export async function scanTransactions(
	db: D1Database,
	message: AuthoritativePaymentScan,
	assetCode: string,
	adapter: PaymentAdapter<unknown>,
	subscription?: {
		connectionId: string;
		adapter: PaymentAdapter<unknown>;
	},
	discoveryCache?: PaymentDiscoveryCache,
	discoveryKey?: string,
	transactionCache?: PaymentTransactionCache,
	connectionId?: string,
) {
	const pushed: NormalizedTransaction[] = [];
	const subscriptionAdapter = subscription?.adapter ?? adapter;
	const subscriptionController = new AbortController();
	let subscriptionTask: Promise<void> | undefined;
	if (!message.refreshOnly && subscriptionAdapter.subscribeTransactions) {
		// WSS connections are opt-in and consumed for a bounded queue-task
		// window. They run alongside the authoritative HTTP poll rather than
		// adding a fixed delay after it. A dropped socket cannot lose a payment.
		const subscriptionWindowMs = 5_000;
		subscriptionTask = subscriptionAdapter
			.subscribeTransactions({
				address: message.address,
				assetCode,
				signal: AbortSignal.any([
					subscriptionController.signal,
					AbortSignal.timeout(subscriptionWindowMs),
				]),
				onTransaction: (transaction) => {
					pushed.push(transaction);
				},
			})
			.then(() => undefined)
			.catch(async (error: unknown) => {
				if (subscription)
					await recordPaymentScanObservation(
						db,
						subscription.connectionId,
						subscriptionAdapter.classifyError(error),
					);
				// Subscription transport is an optimization. The HTTP poll below
				// remains the recovery path when a provider rejects or drops WSS.
			});
	}
	try {
		const discover = async () =>
			message.providerOrderId
				? [
						await adapter.getTransaction(message.providerOrderId, {
							address: message.address,
							assetCode,
						}),
					].filter(
						(transaction): transaction is NonNullable<typeof transaction> =>
							transaction !== null,
					)
				: await adapter.findTransactions({
						address: message.address,
						assetCode,
						...(message.sinceBlock
							? { sinceBlock: BigInt(message.sinceBlock) }
							: {}),
						...(message.sinceTimestamp
							? { sinceTimestamp: message.sinceTimestamp }
							: {}),
					});
		const requestedSinceBlock = message.sinceBlock
			? BigInt(message.sinceBlock)
			: undefined;
		const requestedSinceTimestamp = message.sinceTimestamp?.getTime();
		const cachedDiscovery =
			discoveryKey && discoveryCache
				? discoveryCache.get(discoveryKey)
				: undefined;
		let discovered: NormalizedTransaction[] = [];
		if (!message.refreshOnly) {
			let discoveredPromise =
				cachedDiscovery &&
				coversScanRange(
					cachedDiscovery.sinceBlock,
					requestedSinceBlock,
					cachedDiscovery.sinceTimestamp,
					requestedSinceTimestamp,
				)
					? cachedDiscovery.transactions
					: undefined;
			if (!discoveredPromise) {
				discoveredPromise = discover();
				if (discoveryKey && discoveryCache)
					discoveryCache.set(discoveryKey, {
						sinceBlock: requestedSinceBlock,
						sinceTimestamp: requestedSinceTimestamp,
						transactions: discoveredPromise,
					});
			}
			discovered = await discoveredPromise;
		}
		const pending = await refreshPendingPaymentTransactions(
			db,
			message.orderId,
			adapter,
			transactionCache,
			connectionId,
		);
		return mergeScannedTransactions(discovered, pushed, pending);
	} finally {
		subscriptionController.abort();
		await subscriptionTask;
	}
}

function coversScanRange(
	cachedBlock?: bigint,
	requestedBlock?: bigint,
	cachedTimestamp?: number,
	requestedTimestamp?: number,
) {
	const coversBlock =
		cachedBlock == null ||
		(requestedBlock != null && cachedBlock <= requestedBlock);
	const coversTimestamp =
		cachedTimestamp == null ||
		(requestedTimestamp != null && cachedTimestamp <= requestedTimestamp);
	return coversBlock && coversTimestamp;
}

type AuthoritativePaymentScan = PaymentScanMessage & {
	address: string;
	providerOrderId?: string;
	sinceBlock?: string;
	sinceTimestamp?: Date;
	refreshOnly?: boolean;
};

export async function refreshPendingPaymentTransactions(
	db: D1Database,
	orderId: string,
	adapter: PaymentAdapter<unknown>,
	transactionCache?: PaymentTransactionCache,
	connectionId?: string,
) {
	const rows = await db
		.prepare(
			`SELECT bt.network, bt.tx_hash, bt.event_index, bt.from_address,
			 bt.to_address, bt.asset_code, bt.amount_units, bt.block_number,
			 bt.block_hash, bt.confirmations, bt.status, bt.observed_at
			 FROM order_payments op JOIN blockchain_transactions bt
			 ON op.transaction_id = bt.network || ':' || bt.tx_hash || ':' || bt.event_index
			 WHERE op.order_id = ? AND op.status IN ('detected', 'confirming')`,
		)
		.bind(orderId)
		.all<{
			network: Network;
			tx_hash: string;
			event_index: number;
			from_address: string;
			to_address: string;
			asset_code: string;
			amount_units: string;
			block_number: string;
			block_hash: string;
			confirmations: number;
			status: string;
			observed_at: number;
		}>();
	const refreshed: NormalizedTransaction[] = [];
	for (const row of rows.results) {
		const stored: NormalizedTransaction = {
			network: row.network,
			hash: row.tx_hash,
			eventIndex: row.event_index,
			from: row.from_address,
			to: row.to_address,
			assetCode: row.asset_code,
			amountUnits: BigInt(row.amount_units),
			blockNumber: BigInt(row.block_number),
			blockHash: row.block_hash,
			confirmations: row.confirmations,
			timestamp: new Date(row.observed_at),
			success: true,
			canonical: true,
		};
		const cacheKey = JSON.stringify([
			connectionId ?? adapter.id,
			stored.network,
			stored.hash,
			stored.eventIndex,
		]);
		let currentPromise = transactionCache?.get(cacheKey);
		if (!currentPromise) {
			currentPromise = findCurrentTransactionEvent(adapter, stored).then(
				(transaction) => transaction ?? null,
			);
			transactionCache?.set(cacheKey, currentPromise);
		}
		const current = (await currentPromise) ?? undefined;
		if (current) {
			if (row.status === "missing")
				await db
					.prepare(
						"UPDATE blockchain_transactions SET status = 'pending', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ? AND status = 'missing'",
					)
					.bind(Date.now(), row.network, row.tx_hash, row.event_index)
					.run();
			refreshed.push(current);
		} else if (row.status === "missing")
			refreshed.push({
				...stored,
				confirmations: 0,
				canonical: false,
			});
		else
			await db
				.prepare(
					"UPDATE blockchain_transactions SET status = 'missing', updated_at = ? WHERE network = ? AND tx_hash = ? AND event_index = ?",
				)
				.bind(Date.now(), row.network, row.tx_hash, row.event_index)
				.run();
	}
	return refreshed;
}

async function findCurrentTransactionEvent(
	adapter: PaymentAdapter<unknown>,
	stored: NormalizedTransaction,
) {
	const direct = await adapter.getTransaction(stored.hash, {
		address: stored.to,
		assetCode: stored.assetCode,
		eventIndex: stored.eventIndex,
	});
	return sameTransactionEvent(direct, stored) ? direct : undefined;
}

function sameTransactionEvent(
	candidate: NormalizedTransaction | null | undefined,
	stored: NormalizedTransaction,
) {
	return (
		candidate?.network === stored.network &&
		candidate.hash === stored.hash &&
		candidate.eventIndex === stored.eventIndex
	);
}

function mergeScannedTransactions(...groups: NormalizedTransaction[][]) {
	const merged = new Map<string, NormalizedTransaction>();
	for (const transaction of groups.flat())
		merged.set(
			`${transaction.network}:${transaction.hash}:${transaction.eventIndex}`,
			transaction,
		);
	return [...merged.values()];
}

export async function advancePaymentScanCursor(
	db: D1Database,
	orderId: string,
	transactions: Array<{ blockNumber: bigint }>,
	scannedThrough?: bigint,
) {
	if (!transactions.length && scannedThrough == null) return null;
	const cursor = transactions.reduce(
		(maximum, transaction) =>
			transaction.blockNumber > maximum ? transaction.blockNumber : maximum,
		scannedThrough ?? 0n,
	);
	await db
		.prepare(
			`UPDATE orders SET payment_scan_cursor = CASE
			 WHEN payment_scan_cursor IS NULL OR CAST(payment_scan_cursor AS INTEGER) < CAST(? AS INTEGER)
			 THEN ? ELSE payment_scan_cursor END
			 WHERE id = ?`,
		)
		.bind(cursor.toString(), cursor.toString(), orderId)
		.run();
	return cursor;
}

export async function processScannedTransactions(
	env: Env,
	orderId: string,
	transactions: Parameters<typeof recordPaymentTransaction>[2][],
	runtime?: RuntimeConfig,
) {
	let skippedPreviouslyAttributed = 0;
	let skippedAmbiguous = 0;
	for (const transaction of transactions) {
		try {
			const attribution = await resolvePaymentTransactionOrder(
				env.DB,
				transaction,
				orderId,
			);
			await recordPaymentTransaction(
				env,
				attribution.orderId,
				transaction,
				runtime,
			);
			if (attribution.orderId !== orderId) skippedPreviouslyAttributed += 1;
		} catch (error) {
			if (
				!(error instanceof PaymentAttributionAmbiguousError) &&
				!(error instanceof PaymentAttributionNotFoundError)
			)
				throw error;
			skippedAmbiguous += 1;
		}
	}
	return { skippedPreviouslyAttributed, skippedAmbiguous };
}

async function recordPaymentScanIssue(
	db: D1Database,
	message: PaymentScanMessage,
	kind: string,
) {
	await db
		.prepare(
			`INSERT INTO audit_logs
			 (id, action, target_type, target_id, after, created_at)
			 VALUES (?, 'payment.scan_failed', 'order', ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			message.orderId,
			JSON.stringify({
				receivingMethodId: message.receivingMethodId,
				kind,
			}),
			Date.now(),
		)
		.run();
}

export async function recordPaymentScanObservation(
	db: D1Database,
	connectionId: string,
	errorCode: string | null,
	retryAfterMs?: number,
) {
	const now = Date.now();
	const rateLimited = errorCode === "rate_limit";
	await db
		.prepare(
			`UPDATE payment_ingresses SET last_payment_scan_at = ?,
				 last_payment_scan_error_code = ?,
				 rate_limited_until = CASE WHEN ? THEN ? ELSE NULL END,
				 consecutive_rate_limits = CASE WHEN ? THEN consecutive_rate_limits + 1 ELSE 0 END,
				 last_retry_after_ms = CASE WHEN ? THEN ? ELSE NULL END,
				 last_provider_success_at = CASE WHEN ? IS NULL THEN ? ELSE last_provider_success_at END,
				 updated_at = ? WHERE id = ?
				 AND EXISTS (
				  SELECT 1 FROM payment_rails rail
				  WHERE rail.code = payment_ingresses.rail_code AND rail.kind = 'chain'
				 )`,
		)
		.bind(
			now,
			errorCode,
			rateLimited,
			rateLimited ? now + (retryAfterMs ?? 30_000) : null,
			rateLimited,
			rateLimited,
			retryAfterMs ?? null,
			errorCode,
			now,
			now,
			connectionId,
		)
		.run();
}

async function paymentConnectionCooldownMs(
	db: D1Database,
	connectionId: string,
) {
	const row = await db
		.prepare(
			"SELECT rate_limited_until FROM payment_ingresses WHERE id = ? LIMIT 1",
		)
		.bind(connectionId)
		.first<{ rate_limited_until: number | null }>();
	return Math.max(0, (row?.rate_limited_until ?? 0) - Date.now());
}

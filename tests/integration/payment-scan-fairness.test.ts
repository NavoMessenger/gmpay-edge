import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	advancePaymentScanCursor,
	refreshPendingPaymentTransactions,
	scanTransactions,
} from "#/server/queue";
import { runMaintenance } from "#/server/scheduled";
import { MockTronAdapter } from "../fixtures/mock-tron-adapter";
import { applyMigrations } from "./migrations";

describe("payment scan scheduling fairness", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const dependencies = {
		expire: vi.fn().mockResolvedValue(0),
		recoverWebhooks: vi.fn().mockResolvedValue({ queued: 0, failed: 0 }),
	};

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-payment-scan-fairness" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("does not advance a scan lease or expose details when Queue rejects the batch", async () => {
		const sendBatch = vi.fn().mockRejectedValue(new Error("queue unavailable"));
		await expect(
			runMaintenance(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"*/1 * * * *",
				dependencies,
			),
		).rejects.toMatchObject({
			code: "queue_enqueue_failed",
			status: 502,
			message: "Payment Queue rejected the scheduled scan batch",
		});
		const leased = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM orders WHERE last_payment_scan_at IS NOT NULL",
			)
			.first<{ count: number }>();
		expect(leased?.count).toBe(0);
		const run = await db
			.prepare(
				"SELECT error_code FROM operation_task_runs WHERE task = 'payment_scan_enqueue' ORDER BY started_at DESC, id DESC LIMIT 1",
			)
			.first<{ error_code: string | null }>();
		expect(run?.error_code).toBe("queue_enqueue_failed");
	});

	it("rotates through active orders instead of starving later rows", async () => {
		const scanned: string[] = [];
		for (let run = 0; run < 3; run += 1) {
			await db
				.prepare(
					"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
				)
				.run();
			const sendBatch = vi.fn().mockImplementation(async (messages) => {
				scanned.push(
					...scheduledScanOrders(messages).map((scan) => scan.orderId),
				);
			});
			await runMaintenance(
				{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
				"*/1 * * * *",
				dependencies,
			);
		}
		expect(scanned).toEqual(["order-a", "order-b", "order-c"]);
	});

	it("backs off healthy active Webhook sources and restores normal scans when degraded", async () => {
		const now = Date.now();
		await db.batch([
			db.prepare("UPDATE orders SET status = 'expired', updated_at = 0"),
			db
				.prepare(
					`UPDATE orders SET status = 'pending', expires_at = ?,
					 last_payment_scan_at = ?, updated_at = ? WHERE id = 'order-a'`,
				)
				.bind(now + 600_000, now - 5 * 60_000, now),
			db
				.prepare(
					`INSERT INTO payment_ingresses
					 (id, name, type, transport, provider, network, external_network, external_source_id,
					  config_encrypted, mode, enabled, health_status, created_at, updated_at)
					 VALUES ('alchemy-tron', 'Payment event push', 'provider_webhook', 'webhook', 'alchemy', 'tron', 'TRON_MAINNET',
					  'alchemy-tron-source', 'encrypted', 'active', 1, 'healthy', ?, ?)`,
				)
				.bind(now, now),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const env = {
			DB: db,
			PAYMENT_QUEUE: { sendBatch },
		} as unknown as Env;

		await runMaintenance(env, "*/1 * * * *", dependencies);
		expect(sendBatch).not.toHaveBeenCalled();

		await db.batch([
			db.prepare(
				"UPDATE payment_ingresses SET health_status = 'degraded' WHERE id = 'alchemy-tron'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
		]);
		await runMaintenance(env, "*/1 * * * *", dependencies);
		expect(sendBatch).toHaveBeenCalledOnce();
		expect(scheduledScanOrders(sendBatch.mock.calls[0]?.[0] ?? [])).toEqual([
			{ orderId: "order-a", receivingMethodId: "method" },
		]);

		await db.prepare("DELETE FROM payment_ingresses").run();
	});

	it("advances provider cursors monotonically and preserves empty scans", async () => {
		await expect(
			advancePaymentScanCursor(db, "order-a", []),
		).resolves.toBeNull();
		await advancePaymentScanCursor(db, "order-a", [{ blockNumber: 100n }]);
		await advancePaymentScanCursor(db, "order-a", [{ blockNumber: 90n }]);
		await advancePaymentScanCursor(db, "order-a", [
			{ blockNumber: 99n },
			{ blockNumber: 101n },
		]);
		const order = await db
			.prepare("SELECT payment_scan_cursor FROM orders WHERE id = 'order-a'")
			.first<{ payment_scan_cursor: string | null }>();
		expect(order?.payment_scan_cursor).toBe("101");
	});

	it("keeps the persisted provider cursor in D1 for the Queue consumer", async () => {
		await db.batch([
			db.prepare("UPDATE orders SET last_payment_scan_at = NULL"),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await runMaintenance(
			{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
			"*/1 * * * *",
			dependencies,
		);
		const message = sendBatch.mock.calls[0]?.[0]?.[0]?.body;
		expect(message).toMatchObject({ kind: "payment.scan_batch" });
		expect(
			scheduledScanOrders(sendBatch.mock.calls[0]?.[0] ?? []),
		).toContainEqual({ orderId: "order-a", receivingMethodId: "method" });
		expect(message).not.toHaveProperty("sinceBlock");
		const stored = await db
			.prepare("SELECT payment_scan_cursor FROM orders WHERE id = 'order-a'")
			.first<{ payment_scan_cursor: string | null }>();
		expect(stored?.payment_scan_cursor).toBe("101");
	});

	it("refreshes older confirming payments after the cursor advances", async () => {
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					"INSERT INTO blockchain_transactions (id, network, tx_hash, event_index, from_address, to_address, asset_code, amount_units, block_number, block_hash, confirmations, status, observed_at, created_at, updated_at) VALUES ('bt-pending', 'tron', 'pending-hash', 0, 'from', 'TAddressa', 'TRX', '1', '50', 'old-block', 1, 'pending', ?, ?, ?)",
				)
				.bind(now, now, now),
			db
				.prepare(
					"INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, created_at, updated_at) VALUES ('op-pending', 'order-a', 'tron:pending-hash:0', '1', 1, 'confirming', ?, ?, ?)",
				)
				.bind(now, now, now),
		]);
		const adapter = new MockTronAdapter();
		adapter.record({
			network: "tron",
			hash: "pending-hash",
			eventIndex: 0,
			from: "from",
			to: "TAddressa",
			assetCode: "TRX",
			amountUnits: 1n,
			blockNumber: 50n,
			blockHash: "new-block",
			confirmations: 5,
			timestamp: new Date(now),
			success: true,
			canonical: true,
		});
		await expect(
			refreshPendingPaymentTransactions(db, "order-a", adapter),
		).resolves.toMatchObject([
			{ hash: "pending-hash", confirmations: 5, blockHash: "new-block" },
		]);
	});

	it("reuses a wider address and asset discovery scan for later cursors", async () => {
		const adapter = new MockTronAdapter();
		const findTransactions = vi.spyOn(adapter, "findTransactions");
		const discoveryCache = new Map();
		const base = {
			kind: "payment.scan" as const,
			version: 1 as const,
			receivingMethodId: "method",
			address: "TSharedAddress",
		};
		await scanTransactions(
			db,
			{ ...base, orderId: "missing-a", sinceBlock: "10" },
			"TRX",
			adapter,
			undefined,
			discoveryCache,
			"shared-group",
		);
		await scanTransactions(
			db,
			{ ...base, orderId: "missing-b", sinceBlock: "20" },
			"TRX",
			adapter,
			undefined,
			discoveryCache,
			"shared-group",
		);
		expect(findTransactions).toHaveBeenCalledOnce();
	});

	it("deduplicates pending transaction refreshes within one queue invocation", async () => {
		const adapter = new MockTronAdapter();
		const getTransaction = vi.spyOn(adapter, "getTransaction");
		const transactionCache = new Map();
		await refreshPendingPaymentTransactions(
			db,
			"order-a",
			adapter,
			transactionCache,
			"connection",
		);
		await refreshPendingPaymentTransactions(
			db,
			"order-a",
			adapter,
			transactionCache,
			"connection",
		);
		expect(getTransaction).toHaveBeenCalledOnce();
	});

	it("only schedules recent paid orders that still have unsettled payments", async () => {
		const now = Date.now();
		await db.batch([
			db.prepare("UPDATE orders SET status = 'expired', updated_at = 0"),
			db.prepare(
				"UPDATE receiving_methods SET enabled = 0 WHERE id = 'method'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '2' WHERE key = 'payments.scan_batch_size'",
			),
			db.prepare(
				"UPDATE system_settings SET value = '0' WHERE key = 'runtime.last_payment_scan_at'",
			),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, paid_at, version, created_at, updated_at) VALUES ('order-recent-paid-unsettled', 'recent-paid-unsettled', 'paid', '100', 'USD', 2, 'asset', '1', ?, ?, 1, ?, ?)",
				)
				.bind(now - 1, now - 60_000, now, now),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, paid_at, version, created_at, updated_at) VALUES ('order-recent-paid-final', 'recent-paid-final', 'paid', '100', 'USD', 2, 'asset', '1', ?, ?, 1, ?, ?)",
				)
				.bind(now - 1, now - 60_000, now + 1, now + 1),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, paid_at, version, created_at, updated_at) VALUES ('order-old-paid', 'old-paid', 'paid', '100', 'USD', 2, 'asset', '1', ?, ?, 1, ?, ?)",
				)
				.bind(now - 1, now - 25 * 3_600_000, now, now),
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES ('order-recent-expired', 'recent-expired', 'expired', '100', 'USD', 2, 'asset', '0', ?, 1, ?, ?)",
				)
				.bind(now - 1, now, now),
		]);
		await db.batch([
			paymentSnapshot(
				db,
				"order-recent-paid-unsettled",
				"TRecentPaidUnsettled",
				now,
			),
			paymentSnapshot(db, "order-recent-paid-final", "TRecentPaidFinal", now),
			paymentSnapshot(db, "order-old-paid", "TOldPaid", now),
			paymentSnapshot(db, "order-recent-expired", "TRecentExpired", now),
			db
				.prepare(
					"INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, created_at, updated_at) VALUES ('op-recent-paid-unsettled', 'order-recent-paid-unsettled', 'tron:recent-paid-unsettled:0', '1', 0, 'confirming', ?, ?, ?)",
				)
				.bind(now, now, now),
			db
				.prepare(
					"INSERT INTO order_payments (id, order_id, transaction_id, amount_units, confirmations, status, detected_at, confirmed_at, created_at, updated_at) VALUES ('op-recent-paid-final', 'order-recent-paid-final', 'tron:recent-paid-final:0', '1', 20, 'confirmed', ?, ?, ?, ?)",
				)
				.bind(now, now, now, now),
		]);
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		await runMaintenance(
			{ DB: db, PAYMENT_QUEUE: { sendBatch } } as unknown as Env,
			"*/1 * * * *",
			dependencies,
		);
		expect(
			scheduledScanOrders(
				sendBatch.mock.calls.flatMap(([messages]) => messages),
			).map((message) => message.orderId),
		).toEqual(["order-recent-paid-unsettled"]);
	});
});

function scheduledScanOrders(
	messages: Array<{ body: { kind: string; orders?: unknown } }>,
) {
	return messages.flatMap((message) =>
		message.body.kind === "payment.scan_batch" &&
		Array.isArray(message.body.orders)
			? (message.body.orders as Array<{
					orderId: string;
					receivingMethodId: string;
				}>)
			: [],
	);
}

function paymentSnapshot(
	db: D1Database,
	orderId: string,
	targetValue: string,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO order_payment_snapshots
			 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
			  asset_id, asset_code, decimals, target_value, connection_id, adapter,
			  required_confirmations, expected_amount_units, created_at)
			 VALUES (?, 'method', 'Primary TRX', 'tron', 'chain', 'asset', 'TRX', 6,
			  ?, 'connection', 'tron', 1, '1000000', ?)`,
		)
		.bind(orderId, targetValue, now);
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset', 'tron', 'TRX', 'TRX', 'native', 6, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, enabled, health_status, created_at, updated_at) VALUES ('connection', 'tron', 'TRON', 'rpc', 'https://api.trongrid.io', 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 1, created_at = ?, updated_at = ? WHERE id = 'asset'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, enabled, created_at, updated_at) VALUES ('method', 'Primary TRX', 'tron', 'address', 'TAddressa', 'TAddressa', 1, ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('payments.scan_batch_size', '1', 0, ?, ?)",
			)
			.bind(now, now),
		...(["a", "b", "c"] as const).flatMap((suffix, index) => [
			db
				.prepare(
					"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, created_at, updated_at) VALUES (?, ?, 'pending', '100', 'USD', 2, 'asset', '0', ?, ?, ?)",
				)
				.bind(
					`order-${suffix}`,
					`merchant-${suffix}`,
					now + 600_000,
					now + index,
					now + index,
				),
			db
				.prepare(
					`INSERT INTO order_payment_snapshots
					 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind,
					  asset_id, asset_code, decimals, target_value, connection_id, adapter,
					  required_confirmations, expected_amount_units, created_at)
					 VALUES (?, 'method', 'Primary TRX', 'tron', 'chain', 'asset', 'TRX', 6,
					  ?, 'connection', 'tron', 1, '1000000', ?)`,
				)
				.bind(`order-${suffix}`, `TAddress${suffix}`, now + index),
		]),
	]);
}

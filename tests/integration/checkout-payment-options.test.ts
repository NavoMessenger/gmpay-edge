import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	listCheckoutPaymentOptions,
	selectCheckoutPaymentOption,
} from "#/features/checkout/server/payment-options";
import { selectCheckoutPaymentOptionForRequest } from "#/features/checkout/server/request-actions";
import { createOrder } from "#/features/orders/server/create";
import { listPaymentCandidates } from "#/features/payment-settings/server/payment-candidates";
import { allocateUniqueReceivingMethodAndSnapshot } from "#/features/payment-settings/server/receiving-method-locks";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

const orderId = "26071306234512345678";
const cnyOrderId = "26071306234512345679";
const methodId = "4dc360b6-1d7a-4a69-a103-5cafce84e531";

describe("checkout receiving method selection", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: Env;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "checkout-payment-options-v2" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		env = { DB: db } as Env;
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("lists only ready receiving methods and atomically creates the snapshot and lock", async () => {
		const counters = createDatastoreCounters();
		await expect(
			listCheckoutPaymentOptions(instrumentD1(db, counters), orderId),
		).resolves.toMatchObject({
			selectable: true,
			options: expect.arrayContaining([
				{
					paymentMethodId: "asset-usdt-tron",
					asset: "USDT",
					network: "tron",
					networkName: "TRON",
					railKind: "chain",
					amount: "12.5",
					current: false,
				},
				{
					paymentMethodId: "asset-usdc-tron",
					asset: "USDC",
					network: "tron",
					networkName: "TRON",
					railKind: "chain",
					amount: "12.5",
					current: false,
				},
			]),
		});
		expect(counters).toMatchObject({
			d1Prepare: 2,
			d1StatementFirst: 1,
			d1StatementAll: 1,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		const selectCounters = createDatastoreCounters();
		await expect(
			selectCheckoutPaymentOptionForRequest(
				{ ...env, DB: instrumentD1(db, selectCounters) },
				{
					orderId,
					network: "tron",
					paymentMethodId: "asset-usdt-tron",
				},
				"203.0.113.10",
			),
		).resolves.toMatchObject({
			asset: "USDT",
			network: "tron",
			paymentAmount: "12.5",
		});
		expect(selectCounters).toMatchObject({
			d1Prepare: 14,
			d1StatementFirst: 4,
			d1StatementAll: 2,
			d1StatementRun: 1,
			d1Batch: 2,
		});
		const warmCounters = createDatastoreCounters();
		await expect(
			selectCheckoutPaymentOptionForRequest(
				{ ...env, DB: instrumentD1(db, warmCounters) },
				{
					orderId,
					network: "tron",
					paymentMethodId: "asset-usdt-tron",
				},
				"203.0.113.10",
			),
		).resolves.toMatchObject({
			asset: "USDT",
			network: "tron",
			paymentAmount: "12.5",
		});
		expect(warmCounters).toMatchObject({
			d1Prepare: 3,
			d1StatementFirst: 3,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
		const state = await db
			.prepare(
				`SELECT o.payment_asset_id, o.version,
				 ops.receiving_method_id, ops.target_value,
				 (SELECT COUNT(*) FROM receiving_method_locks l
				  WHERE l.order_id = o.id AND l.released_at IS NULL) AS locks
				 FROM orders o JOIN order_payment_snapshots ops ON ops.order_id = o.id
				 WHERE o.id = ?`,
			)
			.bind(orderId)
			.first<Record<string, string | number | null>>();
		expect(state).toEqual({
			payment_asset_id: "asset-usdt-tron",
			version: 1,
			receiving_method_id: methodId,
			target_value: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
			locks: 1,
		});
	});

	it("stops a rejected option request at the D1 rate limiter", async () => {
		const input = {
			orderId: "26071306234512349998",
			network: "tron",
			paymentMethodId: "asset-usdt-tron",
		};
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await expect(
				selectCheckoutPaymentOptionForRequest(env, input, "203.0.113.11"),
			).rejects.toMatchObject({ code: "order_not_found", status: 404 });
		}
		const counters = createDatastoreCounters();
		await expect(
			selectCheckoutPaymentOptionForRequest(
				{ ...env, DB: instrumentD1(db, counters) },
				input,
				"203.0.113.11",
			),
		).rejects.toMatchObject({
			code: "payment_option_rate_limited",
			status: 429,
		});
		expect(counters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("keeps payment options available with the latest expired exchange rate", async () => {
		await expect(
			listCheckoutPaymentOptions(db, cnyOrderId),
		).resolves.toMatchObject({
			selectable: true,
			options: expect.arrayContaining([
				expect.objectContaining({
					paymentMethodId: "asset-usdt-tron",
					asset: "USDT",
					network: "tron",
					amount: "0.147488",
				}),
			]),
			unavailableReason: null,
		});
	});

	it("stops checkout option loading after one order miss", async () => {
		const counters = createDatastoreCounters();
		await expect(
			listCheckoutPaymentOptions(
				instrumentD1(db, counters),
				"26071306234512349999",
			),
		).resolves.toBeNull();
		expect(counters).toMatchObject({
			d1Prepare: 1,
			d1StatementFirst: 1,
			d1StatementAll: 0,
			d1StatementRun: 0,
			d1Batch: 0,
		});
	});

	it("keeps an existing order payment snapshot immutable", async () => {
		await expect(
			listCheckoutPaymentOptions(db, orderId),
		).resolves.toMatchObject({
			selectable: false,
			options: [expect.objectContaining({ current: true, network: "tron" })],
		});
		await expect(
			selectCheckoutPaymentOption(env.DB, {
				orderId,
				network: "tron",
				paymentMethodId: "asset-usdt-tron",
			}),
		).resolves.toMatchObject({ asset: "USDT", network: "tron" });
		await expect(
			selectCheckoutPaymentOption(env.DB, {
				orderId,
				network: "polygon",
				paymentMethodId: "asset-usdt-tron",
			}),
		).rejects.toMatchObject({
			code: "payment_snapshot_immutable",
			status: 409,
		});
	});
});

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('tron', 'TRON', 'chain', 'tron', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, contract_address, created_at, updated_at) VALUES ('asset-usdt-tron', 'tron', 'USDT', 'USDT', 'token', 6, 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-tron', 'tron', 'TronGrid', 'rpc', 'https://api.trongrid.io', 10, 1, 'healthy', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 20, created_at = ?, updated_at = ? WHERE id = 'asset-usdt-tron'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, contract_address, created_at, updated_at) VALUES ('asset-usdc-tron', 'tron', 'USDC', 'USDC', 'token', 6, 'TUSDCContract1111111111111111111111', ?, ?)",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE payment_assets SET default_confirmations = 20, created_at = ?, updated_at = ? WHERE id = 'asset-usdc-tron'",
			)
			.bind(now, now),
		db
			.prepare(
				"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at) VALUES (?, 'Primary USDT', 'tron', 'address', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj', 10, 1, ?, ?)",
			)
			.bind(methodId, now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-usdt-tron', ?, 'asset-usdt-tron', ?, ?)",
			)
			.bind(methodId, now, now),
		db
			.prepare(
				"INSERT OR IGNORE INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('link-usdc-tron', ?, 'asset-usdc-tron', ?, ?)",
			)
			.bind(methodId, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'option-order', 'pending', '1250', 'USD', 2, NULL, '0', ?, 0, ?, ?)",
			)
			.bind(orderId, now + 900_000, now, now),
		db
			.prepare(
				"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, payment_asset_id, received_amount_units, expires_at, version, created_at, updated_at) VALUES (?, 'cny-option-order', 'pending', '100', 'CNY', 2, NULL, '0', ?, 0, ?, ?)",
			)
			.bind(cnyOrderId, now + 900_000, now, now),
		db.prepare(
			"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('rate-usd-cny', 'fiat', 'USD', 'CNY', '6.78025', '6.78025', 'test', 0, 1, 1, 1, 1)",
		),
	]);
}

describe("network-based allocation safety", () => {
	let miniflare: Miniflare;
	let db: D1Database;
	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "network-selection-safety" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
		await db.batch([
			db.prepare("UPDATE receiving_methods SET name = 'usdt-tron-1'"),
			db.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('polygon', 'Polygon', 'chain', 'evm', 1, 1)",
			),
			db.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, contract_address, created_at, updated_at) VALUES ('asset-usdt-polygon', 'polygon', 'USDT', 'USDT', 'token', 6, '0x1111111111111111111111111111111111111111', 1, 1)",
			),
			db.prepare(
				"INSERT INTO payment_ingresses (id, rail_code, name, type, endpoint, priority, enabled, health_status, created_at, updated_at) VALUES ('connection-polygon', 'polygon', 'Polygon', 'rpc', 'https://polygon.example', 10, 1, 'healthy', 1, 1)",
			),
			db
				.prepare(
					"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at) VALUES ('tron-backup', 'usdt-tron-2', 'tron', 'address', ?, ?, 20, 1, 1, 1)",
				)
				.bind(`T${"A".repeat(33)}`, `T${"A".repeat(33)}`),
			...[1, 2].map((index) =>
				db
					.prepare(
						"INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, sort_order, enabled, created_at, updated_at) VALUES (?, ?, 'polygon', 'address', ?, ?, ?, 1, 1, 1)",
					)
					.bind(
						`polygon-${index}`,
						`usdt-p-${index}`,
						`0x${String(index).repeat(40)}`,
						`0x${String(index).repeat(40)}`,
						index,
					),
			),
		]);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await miniflare.dispose();
	});
	const selection = {
		orderId,
		network: "tron",
		paymentMethodId: "asset-usdt-tron",
	};

	it("groups four addresses into two networks without leaking address metadata", async () => {
		const result = await listCheckoutPaymentOptions(db, orderId);
		expect(new Set(result?.options.map((option) => option.network))).toEqual(
			new Set(["polygon", "tron"]),
		);
		expect(
			result?.options.filter((option) => option.asset === "USDT"),
		).toHaveLength(2);
		for (const option of result?.options ?? []) {
			expect(option).not.toHaveProperty("receivingMethodId");
			expect(option).not.toHaveProperty("receivingMethodName");
		}
		expect(JSON.stringify(result)).not.toContain("usdt-p-1");
	});
	it("does not multiply quote reads when more addresses use the same assets", async () => {
		const single = createDatastoreCounters();
		await db
			.prepare("UPDATE receiving_methods SET enabled = 0 WHERE id != ?")
			.bind(methodId)
			.run();
		await listCheckoutPaymentOptions(instrumentD1(db, single), cnyOrderId);
		await db.prepare("UPDATE receiving_methods SET enabled = 1").run();
		const multiple = createDatastoreCounters();
		await listCheckoutPaymentOptions(instrumentD1(db, multiple), cnyOrderId);
		expect(multiple.d1StatementFirst).toBe(single.d1StatementFirst);
		expect(multiple.d1Prepare).toBe(single.d1Prepare);
		expect(multiple.d1StatementAll).toBe(1);
	});
	it("excludes unhealthy networks and rejects a selection from an old list", async () => {
		await listCheckoutPaymentOptions(db, orderId);
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'unhealthy' WHERE rail_code = 'tron'",
			)
			.run();
		expect(
			(await listCheckoutPaymentOptions(db, orderId))?.options.every(
				(option) => option.network === "polygon",
			),
		).toBe(true);
		await expect(
			selectCheckoutPaymentOption(db, selection),
		).rejects.toMatchObject({ code: "payment_option_unavailable" });
		expect(
			await db
				.prepare("SELECT COUNT(*) AS count FROM receiving_method_locks")
				.first(),
		).toEqual({ count: 0 });
	});
	it("distributes orders among valid addresses and excludes invalid or limited addresses", async () => {
		await db
			.prepare(
				"UPDATE receiving_methods SET max_amount_minor = '100' WHERE id = ?",
			)
			.bind(methodId)
			.run();
		const result = await selectCheckoutPaymentOption(db, selection);
		expect(result.order.receive_address).toBe(`T${"A".repeat(33)}`);
		expect(
			await db
				.prepare(
					"SELECT receiving_method_id FROM order_payment_snapshots WHERE order_id = ?",
				)
				.bind(orderId)
				.first(),
		).toEqual({ receiving_method_id: "tron-backup" });
	});
	it("allows only one snapshot, lock and audit record for concurrent confirmations", async () => {
		const results = await Promise.all([
			selectCheckoutPaymentOption(db, selection),
			selectCheckoutPaymentOption(db, selection),
		]);
		expect(results[0]?.order.receive_address).toBe(
			results[1]?.order.receive_address,
		);
		expect(results[0]?.paymentAmount).toBe(results[1]?.paymentAmount);
		for (const table of ["order_payment_snapshots", "receiving_method_locks"])
			expect(
				await db
					.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE order_id = ?`)
					.bind(orderId)
					.first(),
			).toEqual({ count: 1 });
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'checkout.receiving_method_selected'",
				)
				.first(),
		).toEqual({ count: 1 });
		await expect(
			selectCheckoutPaymentOption(db, {
				...selection,
				network: "polygon",
				paymentMethodId: "asset-usdt-polygon",
			}),
		).rejects.toMatchObject({ code: "payment_snapshot_immutable" });
	});
	it("serializes competing asset selections without leaving a losing lock", async () => {
		const results = await Promise.allSettled([
			selectCheckoutPaymentOption(db, selection),
			selectCheckoutPaymentOption(db, {
				...selection,
				paymentMethodId: "asset-usdc-tron",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM receiving_method_locks WHERE order_id = ?",
				)
				.bind(orderId)
				.first(),
		).toEqual({ count: 1 });
	});
	it("rolls the allocation back if its audit record cannot be committed", async () => {
		await db
			.prepare(
				"CREATE TRIGGER reject_selection_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'selection audit unavailable'); END",
			)
			.run();
		await expect(selectCheckoutPaymentOption(db, selection)).rejects.toThrow(
			"selection audit unavailable",
		);
		expect(
			await db
				.prepare("SELECT payment_asset_id, version FROM orders WHERE id = ?")
				.bind(orderId)
				.first(),
		).toEqual({ payment_asset_id: null, version: 0 });
		expect(
			await db
				.prepare("SELECT COUNT(*) AS count FROM receiving_method_locks")
				.first(),
		).toEqual({ count: 0 });
	});
	it("checks the current target and healthy connection even for a prepared candidate", async () => {
		const candidate = (
			await listPaymentCandidates(db, {
				receivingMethodId: methodId,
				paymentMethodId: "asset-usdt-tron",
			})
		)[0];
		if (!candidate) throw new Error("candidate fixture is missing");
		await db
			.prepare(
				"UPDATE payment_ingresses SET enabled = 0 WHERE id = 'connection-tron'",
			)
			.run();
		const now = Date.now();
		await expect(
			allocateUniqueReceivingMethodAndSnapshot(db, {
				orderId,
				receivingMethodId: methodId,
				paymentMethodId: candidate.payment_method_id,
				expectedAmountUnits: "12500000",
				decimals: 6,
				checkoutAmountDecimals: 4,
				expiresAt: now + 900000,
				maximumAttempts: 1,
				prepared: {
					now,
					reusableAt: now + 900000,
					method: { ...candidate, asset_id: candidate.payment_method_id },
				},
				existingOrder: { expectedVersion: 0 },
			}),
		).rejects.toMatchObject({ reason: "not_ready" });
		expect(
			await db
				.prepare("SELECT COUNT(*) AS count FROM receiving_method_locks")
				.first(),
		).toEqual({ count: 0 });
	});
	it("revalidates routing when directly creating an order after addresses are disabled", async () => {
		await listPaymentCandidates(db, { network: "tron" });
		await db
			.prepare(
				"UPDATE receiving_methods SET enabled = 0 WHERE rail_code = 'tron'",
			)
			.run();
		await expect(
			createOrder(
				db,
				{
					externalOrderId: "cache-test",
					amount: "1",
					currency: "USD",
					paymentAsset: "USDT",
					paymentNetwork: "tron",
				},
				"https://pay.example",
			),
		).rejects.toMatchObject({ code: "receiving_method_not_found" });
	});
	it("tries another address after the first address exhausts its amount slots", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const now = Date.now();
		await db.batch(
			Array.from({ length: 100 }, (_, index) =>
				db
					.prepare(
						"INSERT INTO orders (id, external_order_id, status, amount_minor, currency, currency_decimals, received_amount_units, expires_at, created_at, updated_at) VALUES (?, ?, 'pending', '1250', 'USD', 2, '0', ?, ?, ?)",
					)
					.bind(`slot-${index}`, `slot-${index}`, now + 900000, now, now),
			),
		);
		await db.batch(
			Array.from({ length: 100 }, (_, index) => {
				const units = String(12500000 + index * 100);
				return db
					.prepare(
						"INSERT INTO receiving_method_locks (id, receiving_method_id, asset_id, order_id, expected_amount_units, collision_key, expires_at, reusable_at, created_at) VALUES (?, ?, 'asset-usdt-tron', ?, ?, ?, ?, ?, ?)",
					)
					.bind(
						`slot-lock-${index}`,
						methodId,
						`slot-${index}`,
						units,
						`${methodId}:asset-usdt-tron:${units}`,
						now + 900000,
						now + 900000,
						now,
					);
			}),
		);
		const selected = await selectCheckoutPaymentOption(db, selection);
		expect(selected.order.receive_address).toBe(`T${"A".repeat(33)}`);
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) AS count FROM receiving_method_locks WHERE order_id = ?",
				)
				.bind(orderId)
				.first(),
		).toEqual({ count: 1 });
	}, 20000);
	it("excludes an invalid target while keeping another address on its network usable", async () => {
		await db
			.prepare(
				"UPDATE receiving_methods SET target_value = 'invalid' WHERE id = ?",
			)
			.bind(methodId)
			.run();
		expect(
			(await listCheckoutPaymentOptions(db, orderId))?.options.some(
				(option) => option.network === "tron",
			),
		).toBe(true);
		expect(
			(await selectCheckoutPaymentOption(db, selection)).order.receive_address,
		).toBe(`T${"A".repeat(33)}`);
	});
	it("does not treat a database error as a reason to try another address", async () => {
		await db
			.prepare(
				"CREATE TRIGGER reject_payment_lock BEFORE INSERT ON receiving_method_locks BEGIN SELECT RAISE(ABORT, 'database unavailable'); END",
			)
			.run();
		await expect(selectCheckoutPaymentOption(db, selection)).rejects.toThrow(
			"database unavailable",
		);
		expect(
			await db
				.prepare("SELECT COUNT(*) AS count FROM order_payment_snapshots")
				.first(),
		).toEqual({ count: 0 });
	});
	it("omits malformed quotes without hiding unrelated supported assets", async () => {
		await db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('asset-trx', 'tron', 'TRX', 'TRX', 'native', 6, 1, 1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO receiving_method_assets (id, receiving_method_id, payment_asset_id, created_at, updated_at) VALUES ('trx-link', ?, 'asset-trx', 1, 1)",
			)
			.bind(methodId)
			.run();
		await db
			.prepare(
				"INSERT INTO exchange_rates (id, category, base, quote, raw_rate, rate, source, adjustment_bps, observed_at, expires_at, created_at, updated_at) VALUES ('invalid-trx-rate','crypto','TRX','USD','broken','broken','test',0,1,1,1,1)",
			)
			.run();
		const result = await listCheckoutPaymentOptions(db, orderId);
		expect(result?.options.some((option) => option.asset === "USDT")).toBe(
			true,
		);
		expect(result?.options.some((option) => option.asset === "TRX")).toBe(
			false,
		);
	});

	it("rejects expired or already funded orders without allocating an address", async () => {
		await db
			.prepare("UPDATE orders SET expires_at = 1 WHERE id = ?")
			.bind(orderId)
			.run();
		await expect(
			selectCheckoutPaymentOption(db, selection),
		).rejects.toMatchObject({ code: "order_unavailable" });
		await db
			.prepare(
				"UPDATE orders SET expires_at = ?, received_amount_units = '1' WHERE id = ?",
			)
			.bind(Date.now() + 900000, orderId)
			.run();
		await expect(
			selectCheckoutPaymentOption(db, selection),
		).rejects.toMatchObject({ code: "order_unavailable" });
		expect(
			await db
				.prepare("SELECT COUNT(*) AS count FROM receiving_method_locks")
				.first(),
		).toEqual({ count: 0 });
	});
});

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
import { updateReceivingMethod } from "#/features/payment-settings/server/update-receiving-method";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const context = {
	integrationConfigSecret: "fixture-encryption-key",
	actorUserId: null,
	requestId: null,
	ipAddress: null,
};
const input = {
	id: "method",
	name: "Updated",
	minAmount: "1",
	maxAmount: "100",
};

describe("receiving method update", () => {
	let mf: Miniflare;
	let db: D1Database;
	let originalCiphertext: string;
	beforeAll(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "receiving-update" },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('okpay', 'OKPay', 'wallet', 'okpay', 1, 1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO payment_assets (id, rail_code, code, symbol, kind, decimals, created_at, updated_at) VALUES ('okpay-usdt', 'okpay', 'USDT', 'USDT', 'external', 8, 1, 1)",
			)
			.run();
	});
	beforeEach(async () => {
		await db.batch([
			db.prepare("DELETE FROM order_payment_snapshots"),
			db.prepare("DELETE FROM orders"),
			db.prepare("DELETE FROM receiving_methods"),
			db.prepare("DELETE FROM audit_logs"),
		]);
		originalCiphertext = await encryptSecret(
			JSON.stringify({ apiKey: "old-token" }),
			context.integrationConfigSecret,
		);
		await db
			.prepare(`INSERT INTO receiving_methods (id, name, rail_code, target_type, target_value, normalized_target_value, target_metadata, config_encrypted, enabled, created_at, updated_at)
		 VALUES ('method', 'Original', 'okpay', 'provider', '12345', '12345', '{"shopId":"12345"}', ?, 1, 1, 1)`)
			.bind(originalCiphertext)
			.run();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(() => mf.dispose());

	async function read() {
		return db
			.prepare(
				"SELECT name, target_value, normalized_target_value, target_metadata, config_encrypted, enabled FROM receiving_methods WHERE id = 'method'",
			)
			.first<{
				name: string;
				target_value: string;
				normalized_target_value: string;
				target_metadata: string;
				config_encrypted: string;
				enabled: number;
			}>();
	}
	function healthy() {
		return vi.spyOn(OkPayAdapter.prototype, "healthCheck").mockResolvedValue({
			healthy: true,
			latencyMs: 1,
			checkedAt: new Date(),
		});
	}

	it("preserves a blank token and edits ordinary fields without a provider request", async () => {
		const health = healthy();
		await expect(
			updateReceivingMethod(
				db,
				{ ...input, configuration: { shopId: "12345", apiKey: "" } },
				context,
			),
		).resolves.toMatchObject({
			configurationChanged: false,
			limitsChanged: true,
		});
		expect(await read()).toMatchObject({
			name: "Updated",
			config_encrypted: originalCiphertext,
			enabled: 1,
		});
		expect(health).not.toHaveBeenCalled();
	});
	it("verifies replacement credentials, encrypts them, and never audits or returns the token", async () => {
		const health = healthy();
		const result = await updateReceivingMethod(
			db,
			{
				...input,
				configuration: { shopId: "67890", apiKey: " replacement-token " },
			},
			context,
		);
		const row = await read();
		if (!row) throw new Error("Expected receiving method");
		expect(row).toMatchObject({
			target_value: "67890",
			normalized_target_value: "67890",
			target_metadata: '{"shopId":"67890"}',
			enabled: 1,
		});
		expect(
			JSON.parse(
				await decryptSecret(
					row.config_encrypted,
					context.integrationConfigSecret,
				),
			),
		).toEqual({ apiKey: " replacement-token " });
		expect(health.mock.contexts[0]).toMatchObject({
			config: { shopId: "67890", apiKey: " replacement-token " },
		});
		const audit = await db
			.prepare("SELECT before, after FROM audit_logs")
			.all();
		expect(JSON.stringify({ result, audit })).not.toMatch(
			/replacement-token|old-token|config_encrypted/,
		);
		expect(audit.results).toHaveLength(1);
	});
	it("retains the original configuration when replacement verification fails", async () => {
		vi.spyOn(OkPayAdapter.prototype, "healthCheck").mockResolvedValue({
			healthy: false,
			latencyMs: 1,
			checkedAt: new Date(),
			detail: "provider secret detail",
		});
		await expect(
			updateReceivingMethod(
				db,
				{ ...input, configuration: { shopId: "12345", apiKey: "bad-token" } },
				context,
			),
		).rejects.toMatchObject({
			code: "receiving_method_provider_authentication_failed",
			status: 409,
		});
		expect(await read()).toMatchObject({
			name: "Original",
			config_encrypted: originalCiphertext,
			enabled: 1,
		});
		expect(
			(await db.prepare("SELECT id FROM audit_logs").all()).results,
		).toHaveLength(0);
	});
	it("requires a new token when changing the shop", async () => {
		const health = healthy();
		await expect(
			updateReceivingMethod(
				db,
				{ ...input, configuration: { shopId: "67890" } },
				context,
			),
		).rejects.toMatchObject({
			code: "receiving_method_configuration_required",
		});
		expect(health).not.toHaveBeenCalled();
	});
	it("fails closed on concurrent credential replacement and does not write a false audit", async () => {
		vi.spyOn(OkPayAdapter.prototype, "healthCheck").mockImplementation(
			async () => {
				await db
					.prepare(
						"UPDATE receiving_methods SET config_encrypted = 'changed-concurrently' WHERE id = 'method'",
					)
					.run();
				return { healthy: true, latencyMs: 1, checkedAt: new Date() };
			},
		);
		await expect(
			updateReceivingMethod(
				db,
				{ ...input, configuration: { shopId: "12345", apiKey: "new-token" } },
				context,
			),
		).rejects.toMatchObject({
			code: "receiving_method_configuration_conflict",
		});
		expect(await read()).toMatchObject({
			name: "Original",
			config_encrypted: "changed-concurrently",
		});
		expect(
			(await db.prepare("SELECT id FROM audit_logs").all()).results,
		).toHaveLength(0);
	});
	it("preserves the shop identity for hosted orders while allowing same-shop key rotation", async () => {
		healthy();
		await db
			.prepare(
				"INSERT INTO orders (id, external_order_id, amount_minor, currency, currency_decimals, provider_order_id, expires_at, created_at, updated_at) VALUES ('order', 'external', '100', 'USD', 2, 'hosted-order', 9999999999999, 1, 1)",
			)
			.run();
		await db
			.prepare(`INSERT INTO order_payment_snapshots
		 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals, target_value, adapter, required_confirmations, expected_amount_units, created_at)
		 VALUES ('order', 'method', 'Original', 'okpay', 'wallet', 'okpay-usdt', 'USDT', 8, '12345', 'okpay', 1, '100000000', 1)`)
			.run();
		await expect(
			updateReceivingMethod(
				db,
				{
					...input,
					configuration: { shopId: "67890", apiKey: "another-shop" },
				},
				context,
			),
		).rejects.toMatchObject({
			code: "receiving_method_configuration_conflict",
		});
		expect(await read()).toMatchObject({
			target_value: "12345",
			config_encrypted: originalCiphertext,
		});
		await expect(
			updateReceivingMethod(
				db,
				{
					...input,
					configuration: { shopId: "12345", apiKey: "rotated-token" },
				},
				context,
			),
		).resolves.toMatchObject({ configurationChanged: true });
	});

	it("protects an allocated order before its provider request finishes", async () => {
		healthy();
		await db
			.prepare(
				"INSERT INTO orders (id, external_order_id, amount_minor, currency, currency_decimals, expires_at, created_at, updated_at) VALUES ('allocating', 'external', '100', 'USD', 2, 9999999999999, 1, 1)",
			)
			.run();
		await db
			.prepare(`INSERT INTO order_payment_snapshots
		 (order_id, receiving_method_id, receiving_method_name, rail_code, rail_kind, asset_id, asset_code, decimals, target_value, adapter, required_confirmations, expected_amount_units, created_at)
		 VALUES ('allocating', 'method', 'Original', 'okpay', 'wallet', 'okpay-usdt', 'USDT', 8, '12345', 'okpay', 1, '100000000', 1)`)
			.run();
		await expect(
			updateReceivingMethod(
				db,
				{ ...input, configuration: { shopId: "67890", apiKey: "new-token" } },
				context,
			),
		).rejects.toMatchObject({
			code: "receiving_method_configuration_conflict",
		});
		await db
			.prepare("UPDATE orders SET status = 'failed' WHERE id = 'allocating'")
			.run();
		await expect(
			updateReceivingMethod(
				db,
				{ ...input, configuration: { shopId: "67890", apiKey: "new-token" } },
				context,
			),
		).resolves.toMatchObject({ configurationChanged: true });
	});
	it("returns a structured not-found error", async () => {
		await expect(
			updateReceivingMethod(db, { ...input, id: "missing" }, context),
		).rejects.toMatchObject({
			code: "receiving_method_not_found",
			status: 404,
		});
	});
});

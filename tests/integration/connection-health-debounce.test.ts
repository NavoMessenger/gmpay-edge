import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	refreshEnabledPaymentConnectionHealth,
	testPaymentConnection,
} from "#/features/payment-settings/server/connection-health";
import type { PaymentAdapter } from "#/integrations/chains/types";
import { applyMigrations } from "./migrations";

describe("scheduled payment connection health debounce", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmpay-edge-health-debounce" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO payment_rails (code, name, kind, adapter, created_at, updated_at) VALUES ('test-chain', 'Test Chain', 'chain', 'evm', 1, 1)",
			)
			.run();
	});

	beforeEach(async () => {
		await db
			.prepare(
				`INSERT INTO payment_ingresses
				 (id, rail_code, name, type, endpoint, enabled, health_status, consecutive_health_failures, created_at, updated_at)
				 VALUES ('connection', 'test-chain', 'Test RPC', 'rpc', 'https://rpc.example', 1, 'healthy', 0, 1, 1)
				 ON CONFLICT(id) DO UPDATE SET health_status = 'healthy',
				 consecutive_health_failures = 0, last_error_code = NULL`,
			)
			.run();
	});

	afterAll(async () => miniflare.dispose());

	it("only marks a healthy connection unhealthy after three consecutive automatic failures", async () => {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			await refresh(false);
			const state = await stateOfConnection();
			expect(state.consecutive_health_failures).toBe(attempt);
			expect(state.health_status).toBe(attempt === 3 ? "unhealthy" : "healthy");
		}
	});

	it("keeps an unknown connection unknown until a successful automatic check", async () => {
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'unknown' WHERE id = 'connection'",
			)
			.run();
		await refresh(false);
		await refresh(false);
		await refresh(false);
		expect(await stateOfConnection()).toMatchObject({
			health_status: "unknown",
			consecutive_health_failures: 3,
		});
		await refresh(true);
		expect(await stateOfConnection()).toEqual({
			health_status: "healthy",
			consecutive_health_failures: 0,
			last_error_code: null,
		});
	});

	it("restores an unhealthy connection on the first successful automatic check", async () => {
		await db
			.prepare(
				"UPDATE payment_ingresses SET health_status = 'unhealthy', consecutive_health_failures = 3 WHERE id = 'connection'",
			)
			.run();
		await refresh(true);
		expect(await stateOfConnection()).toEqual({
			health_status: "healthy",
			consecutive_health_failures: 0,
			last_error_code: null,
		});
	});

	it("uses a failed manual test as an immediate unhealthy verdict", async () => {
		await testPaymentConnection(db, "connection", {
			createAdapter: async () => failedAdapter(),
		});
		expect(await stateOfConnection()).toMatchObject({
			health_status: "unhealthy",
			consecutive_health_failures: 3,
			last_error_code: "health_check_failed",
		});
		await testPaymentConnection(db, "connection", {
			createAdapter: async () => healthyAdapter(),
		});
		expect(await stateOfConnection()).toEqual({
			health_status: "healthy",
			consecutive_health_failures: 0,
			last_error_code: null,
		});
	});

	async function refresh(healthy: boolean) {
		return refreshEnabledPaymentConnectionHealth(db, 20, async () => [
			{
				id: "connection",
				adapter: healthAdapter(healthy),
			},
		]);
	}

	function healthAdapter(healthy: boolean) {
		return {
			healthCheck: async () => ({
				healthy,
				latencyMs: 4,
				checkedAt: new Date(),
			}),
		} as unknown as PaymentAdapter<unknown>;
	}

	function failedAdapter() {
		return healthAdapter(false);
	}

	function healthyAdapter() {
		return healthAdapter(true);
	}

	async function stateOfConnection() {
		const row = await db
			.prepare(
				"SELECT health_status, consecutive_health_failures, last_error_code FROM payment_ingresses WHERE id = 'connection'",
			)
			.first<{
				health_status: string;
				consecutive_health_failures: number;
				last_error_code: string | null;
			}>();
		if (!row) throw new Error("Test connection was not created");
		return row;
	}
});

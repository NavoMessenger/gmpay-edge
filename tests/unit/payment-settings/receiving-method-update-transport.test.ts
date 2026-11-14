import { beforeEach, describe, expect, it, vi } from "vitest";
import { systemPermission } from "#/features/access/system-rbac";
import { paymentSettingsError } from "#/features/payment-settings/errors";
import {
	createReceivingMethodFn,
	updateReceivingMethodFn,
} from "#/features/payment-settings/server/methods";
import { decryptSecret } from "#/lib/secrets";

const mocks = vi.hoisted(() => ({ context: vi.fn(), update: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate = (input: unknown): unknown => input;
		const builder = {
			validator: (validator: (input: unknown) => unknown) => {
				validate = validator;
				return builder;
			},
			handler:
				(handler: (context: { data: unknown }) => Promise<unknown>) =>
				(context: { data: unknown }) =>
					handler({ data: validate(context.data) }),
		};
		return builder;
	},
}));
vi.mock("#/features/payment-settings/server/admin-context", () => ({
	adminContext: mocks.context,
}));
vi.mock("#/features/payment-settings/server/update-receiving-method", () => ({
	updateReceivingMethod: mocks.update,
}));

const data = {
	id: "method",
	name: "OKPay",
	configuration: { shopId: "12345", apiKey: "fixture-token" },
};

describe("receiving method update transport", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.context.mockResolvedValue({
			db: {},
			runtime: { integrationConfigSecret: "fixture-secret" },
			user: { id: "operator" },
			request: new Request("https://pay.example"),
		});
	});
	it("preserves expected error codes as plain data across the client transport", async () => {
		mocks.update.mockRejectedValue(
			paymentSettingsError("receiving_method_provider_authentication_failed"),
		);
		const result = await updateReceivingMethodFn({ data });
		expect(JSON.parse(JSON.stringify(result))).toEqual({
			saved: false,
			code: "receiving_method_provider_authentication_failed",
		});
		expect(JSON.stringify(result)).not.toMatch(
			/fixture-token|fixture-secret|stack/,
		);
		expect(mocks.context).toHaveBeenCalledWith(
			systemPermission("receiving_methods", "update"),
		);
	});
	it("returns successful updates without credentials", async () => {
		mocks.update.mockResolvedValue({
			id: "method",
			limitsChanged: false,
			configurationChanged: true,
		});
		await expect(updateReceivingMethodFn({ data })).resolves.toEqual({
			saved: true,
			id: "method",
			limitsChanged: false,
			configurationChanged: true,
		});
	});
	it("preserves exact token bytes through the update validator", async () => {
		mocks.update.mockResolvedValue({
			id: "method",
			limitsChanged: false,
			configurationChanged: true,
		});
		await updateReceivingMethodFn({
			data: {
				...data,
				configuration: { shopId: "12345", apiKey: " padded-token " },
			},
		});
		expect(mocks.update).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				configuration: { shopId: "12345", apiKey: " padded-token " },
			}),
			expect.anything(),
		);
	});

	it("preserves exact token bytes through create validation, parsing and encryption", async () => {
		const statements: Array<{ sql: string; values: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				const statement = {
					sql,
					values: [] as unknown[],
					bind(...values: unknown[]) {
						statement.values = values;
						return statement;
					},
					async all() {
						return {
							results: [
								{
									id: "okpay-usdt",
									asset_code: "USDT",
									decimals: 8,
									code: "okpay",
									kind: "wallet",
								},
							],
						};
					},
				};
				statements.push(statement);
				return statement;
			},
			batch: vi.fn().mockResolvedValue([]),
		};
		mocks.context.mockResolvedValue({
			db,
			runtime: { integrationConfigSecret: "fixture-secret" },
			user: { id: "operator" },
			request: new Request("https://pay.example"),
		});
		const result = await createReceivingMethodFn({
			data: {
				name: "OKPay",
				paymentMethodIds: ["okpay-usdt"],
				configuration: { shopId: " 12345 ", apiKey: " padded-token " },
			},
		});
		const inserted = statements.find((statement) =>
			statement.sql.includes("INSERT INTO receiving_methods"),
		);
		const ciphertext = inserted?.values[7];
		if (typeof ciphertext !== "string")
			throw new Error("Expected encrypted credentials");
		expect(
			JSON.parse(await decryptSecret(ciphertext, "fixture-secret")),
		).toEqual({ apiKey: " padded-token " });
		expect(JSON.stringify(result)).not.toContain("padded-token");
		expect(mocks.context).toHaveBeenCalledWith(
			systemPermission("receiving_methods", "create"),
		);
	});

	it("does not reach persistence when authorization is denied", async () => {
		mocks.context.mockRejectedValue(new Error("denied"));
		await expect(updateReceivingMethodFn({ data })).rejects.toThrow("denied");
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

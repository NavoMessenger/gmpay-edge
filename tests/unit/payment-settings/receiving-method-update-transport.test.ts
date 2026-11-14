import { beforeEach, describe, expect, it, vi } from "vitest";
import { systemPermission } from "#/features/access/system-rbac";
import { paymentSettingsError } from "#/features/payment-settings/errors";
import { updateReceivingMethodFn } from "#/features/payment-settings/server/methods";

const mocks = vi.hoisted(() => ({ context: vi.fn(), update: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		const builder = {
			validator: () => builder,
			handler: (handler: unknown) => handler,
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
	it("does not reach persistence when authorization is denied", async () => {
		mocks.context.mockRejectedValue(new Error("denied"));
		await expect(updateReceivingMethodFn({ data })).rejects.toThrow("denied");
		expect(mocks.update).not.toHaveBeenCalled();
	});
});

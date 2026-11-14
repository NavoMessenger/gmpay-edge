import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import createFixture from "../../fixtures/providers/okpay-create-payment.json";
import statusFixture from "../../fixtures/providers/okpay-payment-status.json";
import signingFixture from "../../fixtures/providers/okpay-signing-vectors.json";

describe("OKPay adapter", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("creates a signed hosted checkout", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const fetchMock = vi.fn().mockResolvedValue(Response.json(createFixture));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			adapter().createHostedPayment({
				orderId: "order-1",
				amount: "3.5",
				assetCode: "USDT",
				callbackUrl: "https://edge.example/api/providers/okpay/notify",
				description: "Order 1",
				returnUrl: "https://merchant.example/return",
			}),
		).resolves.toEqual({
			providerOrderId: "ok-order",
			paymentUrl: "https://pay.example/order",
		});

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.okaypay.me/shop/payLink");
		const body = new URLSearchParams(String(init.body));
		expect(body.get("id")).toBe("12345");
		expect(body.get("callback_url")).toBe(
			"https://edge.example/api/providers/okpay/notify",
		);
		expect(body.get("unique_id")).toBe("order-1");
		expect(body.get("timestamp")).toMatch(/^\d{10}$/);
		expect(body.get("nonce")).toMatch(/^[0-9a-f-]{36}$/);
		expect(body.get("sign")).toMatch(/^[A-F0-9]{64}$/);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "provider_operation",
				adapter: "okpay",
				operation: "create_hosted_payment",
				outcome: "success",
				requestCount: 1,
			}),
		);
	});

	it("checks and normalizes a completed hosted payment", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json(statusFixture)),
		);

		await expect(
			adapter().checkHostedPayment("ok-order"),
		).resolves.toMatchObject({
			hash: "ok-order",
			assetCode: "USDT",
			amountUnits: 350_000_000n,
			to: "12345",
			success: true,
		});
	});

	it("keeps a pending hosted payment pending when amount fields are absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						order_id: "pending-order",
						status: 0,
						unique_id: "merchant-pending-order",
					}),
				),
			),
		);

		await expect(
			adapter().checkHostedPayment("pending-order"),
		).resolves.toBeNull();
	});

	it("rejects an unsafe hosted checkout URL", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						order_id: "provider-order",
						pay_url: "javascript:alert(1)",
						status: 0,
					}),
				),
			),
		);
		await expect(
			adapter().createHostedPayment({
				orderId: "order-unsafe",
				amount: "1.00",
				assetCode: "USDT",
				description: "Unsafe URL",
			}),
		).rejects.toThrow("safe pay URL");
	});

	it("ignores a completed provider response with a non-positive amount", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						amount: "-1",
						coin: "USDT",
						order_id: "negative-order",
						status: 1,
						unique_id: "order-negative",
					}),
				),
			),
		);

		expect(await adapter().checkHostedPayment("negative-order")).toBeNull();
	});

	it("rejects numeric callback amounts instead of risking precision loss", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						amount: 1.25,
						coin: "USDT",
						order_id: "numeric-order",
						status: 1,
						unique_id: "order-numeric",
					}),
				),
			),
		);
		await expect(
			adapter().checkHostedPayment("numeric-order"),
		).rejects.toThrow();
	});

	it("verifies signed callbacks and extracts nested notification data", async () => {
		const instance = adapter();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					signedResponse({
						order_id: "unused",
						pay_url: "https://pay",
						status: 0,
					}),
				),
			),
		);
		await instance.createHostedPayment({
			orderId: "order-1",
			amount: "3.5",
			assetCode: "USDT",
			description: "Order 1",
		});
		const callback = {
			status: "success",
			code: 200,
			data: {
				amount: "3.5",
				coin: "USDT",
				order_id: "ok-order",
				pay_user_id: 123456789,
				status: 1,
				type: "deposit",
				unique_id: "order-1",
			},
			id: 12345,
			sign: "DF84D29D014B24D5C00935389203D3FC17C120A309577CB206D9D4F9BAAB3048",
		};
		expect(instance.verifyCallback(callback)).toBe(true);
		expect(instance.parseCallback(callback)).toEqual({
			amount: "3.5",
			assetCode: "USDT",
			providerOrderId: "ok-order",
			orderId: "order-1",
		});
	});

	it("matches the official nested and zero-value signing vectors", () => {
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: "TESTtoken123456789abcdefghijABCD",
		});
		expect(
			instance.verifyCallback({
				status: "success",
				code: 200,
				data: {
					amount: "100.5",
					coin: "USDT",
					order_id: "abc123def456",
					pay_user_id: 123456789,
					status: 1,
					type: "deposit",
					unique_id: "ORDER-20260628-001",
				},
				id: 10001,
				sign: "64B09C8847849FA6921D8FFBDF8E406D4A8EA623E53970712350F61783403F7D",
			}),
		).toBe(true);
		expect(
			new OkPayAdapter({
				shopId: "7",
				apiKey: "TESTtoken123456789abcdefghijABCD",
			}).verifyCallback({
				a: "0",
				b: 0,
				c: "",
				d: null,
				e: false,
				f: "hello",
				id: 7,
				nest: { x: "1", y: "2" },
				sign: "8BC0AF979075038025DDD51B6F4A2E6CF3FF9B5B5371EB2268D303F89883E92A",
			}),
		).toBe(true);
	});

	it.each(signingFixture.vectors)("matches the official SDK vector $name", ({
		input,
		signature,
	}) => {
		const instance = new OkPayAdapter({
			shopId: String(input.id),
			apiKey: signingFixture.token,
		});
		expect(instance.verifyCallback({ ...input, sign: signature })).toBe(true);
	});

	it("binds nested sign fields instead of allowing unsigned additions", () => {
		const vector = signingFixture.vectors.find(
			({ name }) => name === "ordinary-object",
		);
		if (!vector) throw new Error("Missing ordinary object fixture");
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: signingFixture.token,
		});
		expect(
			instance.verifyCallback({
				...vector.input,
				data: { amount: "1", sign: "unsigned-field" },
				sign: vector.signature,
			}),
		).toBe(false);
	});

	it.each(
		signingFixture.collisions,
	)("rejects ambiguous flattened paths: $name", ({ input, signature }) => {
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: signingFixture.token,
		});
		expect(instance.verifyCallback({ ...input, sign: signature })).toBe(false);
	});

	it("rejects colliding paths even when the duplicate-key base has a matching HMAC", () => {
		const input = { id: "10001", data: { amount: "1" }, "data.amount": "2" };
		const sign = bytesToHex(
			hmac(
				sha256,
				utf8ToBytes(signingFixture.token),
				utf8ToBytes("data.amount=1&data.amount=2&id=10001"),
			),
		).toUpperCase();
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: signingFixture.token,
		});
		expect(instance.verifyCallback({ ...input, sign })).toBe(false);
	});

	it.each([
		undefined,
		null,
		123,
		{},
		"G".repeat(64),
		` ${createFixture.sign}`,
	])("rejects malformed or non-string signatures: %s", (sign) => {
		expect(adapter().verifyCallback({ ...createFixture, sign })).toBe(false);
	});

	it.each([
		"lowercase",
		"mixed-case",
	])("accepts a valid %s hexadecimal signature", (style) => {
		const lower = createFixture.sign.toLowerCase();
		const sign =
			style === "lowercase"
				? lower
				: [...lower]
						.map((char, index) => (index % 2 ? char.toUpperCase() : char))
						.join("");
		expect(adapter().verifyCallback({ ...createFixture, sign })).toBe(true);
	});

	it("rejects Unicode ligatures that uppercase into hexadecimal characters", () => {
		const vector = signingFixture.vectors.find(
			({ name }) => name === "official-callback",
		);
		if (!vector) throw new Error("Missing official callback fixture");
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: signingFixture.token,
		});
		expect(
			instance.verifyCallback({
				...vector.input,
				sign: vector.signature.replace("FF", "ﬀ"),
			}),
		).toBe(false);
	});

	it("accepts a signed array success response with a lowercase signature", async () => {
		const vector = signingFixture.vectors.find(
			({ name }) => name === "balance-response",
		);
		if (!vector) throw new Error("Missing balance fixture");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					...vector.input,
					sign: vector.signature.toLowerCase(),
				}),
			),
		);
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: signingFixture.token,
		});
		await expect(instance.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
	});

	it("preserves the exact token bytes as the SDK does", async () => {
		const token = " padded-test-token ";
		const input = { id: "10001", data: { amount: "1" } };
		const sign = bytesToHex(
			hmac(sha256, utf8ToBytes(token), utf8ToBytes("data.amount=1&id=10001")),
		).toUpperCase();
		const instance = new OkPayAdapter({ shopId: "10001", apiKey: token });
		expect(instance.config.apiKey).toBe(token);
		expect(instance.verifyCallback({ ...input, sign })).toBe(true);
	});

	it("sends balance and payLink signatures matching the official SDK including raw special values", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1782680000000);
		vi.spyOn(crypto, "randomUUID").mockReturnValue(
			"00000000-0000-4000-8000-000000000000",
		);
		const fetchMock = vi
			.fn()
			.mockImplementation(async () =>
				Response.json(signingFixture.hostedResponse),
			);
		vi.stubGlobal("fetch", fetchMock);
		const instance = new OkPayAdapter({
			shopId: "10001",
			apiKey: signingFixture.token,
		});
		await expect(instance.healthCheck()).resolves.toMatchObject({
			healthy: true,
		});
		await expect(
			instance.createHostedPayment({
				orderId: "audit-order",
				amount: "100.50",
				assetCode: "USDT",
				description: "空 格+&=%汉字😀",
				callbackUrl: "https://merchant.example/callback?a=1&b=%20",
				returnUrl: "https://merchant.example/return?a=1&b=中 文",
			}),
		).resolves.toMatchObject({ providerOrderId: "fixture-order" });
		for (const [index, name] of ["wire-balance", "wire-paylink"].entries()) {
			const vector = signingFixture.vectors.find(
				(entry) => entry.name === name,
			);
			if (!vector) throw new Error("Missing wire fixture");
			const init = fetchMock.mock.calls[index]?.[1] as RequestInit;
			const fields = Object.fromEntries(new URLSearchParams(String(init.body)));
			expect(fields).toEqual({ ...vector.input, sign: vector.signature });
			expect(Object.values(fields)).not.toContain(signingFixture.token);
		}
	});

	it("redacts unexpected provider failures from health details", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("provider-secret-and-url")),
		);

		const health = await adapter().healthCheck();

		expect(health).toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: network",
		});
		expect(health.detail).not.toContain("provider-secret-and-url");
	});

	it("classifies a non-JSON provider outage from its HTTP status", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
		);

		await expect(adapter().healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: network",
		});
	});

	it.each([
		"身份认证失败",
		"未授权",
		"请求已过期, 请检查 timestamp",
		"请求重复 (nonce 已使用)",
		"缺少有效的 timestamp 参数",
		"缺少有效的 nonce 参数 (8-128 位字符串)",
	])("records documented provider rejection %s without changing classification", async (msg) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(Response.json({ status: "warning", msg })),
		);
		await expect(adapter().healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: permanent",
		});
		expect(warn).toHaveBeenCalledWith({
			event: "okpay_request_rejected",
			operation: "balance",
			httpStatus: 200,
			providerStatus: "warning",
			providerCode: null,
			providerMessage: msg,
		});
	});
	it("drops arbitrary provider details, status and credential-bearing codes at the logging boundary", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					status: "secret",
					code: "token=secret",
					msg: "身份认证失败 token=secret https://private.example",
					data: { apiKey: "secret" },
					id: "12345",
					sign: "private-signature",
				}),
			),
		);
		await adapter().healthCheck();
		expect(warn).toHaveBeenCalledWith({
			event: "okpay_request_rejected",
			operation: "balance",
			httpStatus: 200,
			providerStatus: "unrecognized",
			providerCode: null,
			providerMessage: "unrecognized",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|private|12345/);
	});
	it("retains bounded numeric error codes and error status", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					status: "error",
					code: "429",
					msg: "unique_id 重复",
				}),
			),
		);
		await expect(adapter().healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: rate_limit",
		});
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				providerStatus: "error",
				providerCode: "429",
				providerMessage: "unique_id 重复",
			}),
		);
	});
	it("logs HTTP rejection metadata without reading or logging a non-JSON response body", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const response = new Response("credential=secret https://private.example", {
			status: 403,
		});
		const json = vi.spyOn(response, "json");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
		await expect(adapter().healthCheck()).resolves.toMatchObject({
			healthy: false,
			detail: "OKPay health check failed: authentication",
		});
		expect(warn).toHaveBeenCalledWith({
			event: "okpay_request_rejected",
			operation: "balance",
			httpStatus: 403,
		});
		expect(json).not.toHaveBeenCalled();
	});

	it("rejects a forged successful provider response", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ ...createFixture, sign: "0".repeat(64) }),
				),
		);

		await expect(
			adapter().createHostedPayment({
				orderId: "forged-order",
				amount: "1",
				assetCode: "USDT",
				description: "Forged response",
			}),
		).rejects.toThrow();
	});
});

function adapter() {
	return new OkPayAdapter({
		shopId: "12345",
		apiKey: "secret",
		apiUrl: "https://api.okaypay.me/shop",
		assetDecimals: { USDT: 8 },
	});
}

function signedResponse(data: Record<string, unknown>) {
	const response = { status: "success", code: 200, data, id: 12345 };
	const fields = Object.entries({
		code: response.code,
		...Object.fromEntries(
			Object.entries(data).map(([key, value]) => [`data.${key}`, value]),
		),
		id: response.id,
		status: response.status,
	});
	const base = fields
		.filter(
			([, value]) => value !== null && value !== undefined && value !== "",
		)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, value]) => `${key}=${String(value)}`)
		.join("&");
	return {
		...response,
		sign: bytesToHex(
			hmac(sha256, utf8ToBytes("secret"), utf8ToBytes(base)),
		).toUpperCase(),
	};
}

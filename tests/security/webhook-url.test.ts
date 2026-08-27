import { describe, expect, it } from "vitest";
import {
	assertSafeResolvedWebhookUrl,
	isSafeWebhookUrl,
	resolveWebhookHostname,
} from "#/lib/webhook-url";

describe("webhook URL validation", () => {
	it("accepts public HTTPS endpoints", () => {
		expect(isSafeWebhookUrl("https://merchant.example/webhooks/gmpay")).toBe(
			true,
		);
	});

	it.each([
		"http://merchant.example/webhook",
		"https://localhost/webhook",
		"https://127.0.0.1/webhook",
		"https://10.0.0.4/webhook",
		"https://192.168.1.3/webhook",
		"https://203.0.113.10/webhook",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/webhook",
		"https://[::ffff:127.0.0.1]/webhook",
		"https://[::ffff:10.0.0.4]/webhook",
		"https://[::ffff:100.64.0.1]/webhook",
		"https://[::ffff:169.254.169.254]/webhook",
		"https://[::ffff:172.16.0.1]/webhook",
		"https://[::ffff:192.168.1.3]/webhook",
		"https://[::ffff:224.0.0.1]/webhook",
		"https://user:password@merchant.example/webhook",
	])("rejects unsafe endpoint %s", (url) => {
		expect(isSafeWebhookUrl(url)).toBe(false);
	});

	it("fails closed when DNS includes a private or reserved address", async () => {
		await expect(
			assertSafeResolvedWebhookUrl(
				"https://merchant.example/webhook",
				async () => ["93.184.216.34", "127.0.0.1"],
			),
		).resolves.toBe(false);
		await expect(
			assertSafeResolvedWebhookUrl(
				"https://merchant.example/webhook",
				async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
			),
		).resolves.toBe(true);
		await expect(
			assertSafeResolvedWebhookUrl(
				"https://merchant.example/webhook",
				async () => [],
			),
		).resolves.toBe(false);
	});

	it("falls back to Google DNS when Cloudflare DNS is unavailable", async () => {
		let calls = 0;
		const fetcher = async (input: RequestInfo | URL) => {
			calls += 1;
			if (String(input).includes("cloudflare-dns.com"))
				return new Response("", { status: 503 });
			return Response.json({
				Status: 0,
				Answer: [{ type: 1, data: "104.21.87.111" }],
			});
		};
		await expect(
			resolveWebhookHostname("merchant.example", fetcher),
		).resolves.toEqual(["104.21.87.111"]);
		expect(calls).toBe(4);
	});

	it("falls back to Quad9 DNS when the first two resolvers are unavailable", async () => {
		const fetcher = async (input: RequestInfo | URL) => {
			if (!String(input).includes("dns.quad9.net"))
				return new Response("", { status: 503 });
			return Response.json({
				Status: 0,
				Answer: [{ type: 1, data: "104.21.87.111" }],
			});
		};
		await expect(
			resolveWebhookHostname("merchant.example", fetcher),
		).resolves.toEqual(["104.21.87.111"]);
	});
});

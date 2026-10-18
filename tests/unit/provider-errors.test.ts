import { afterEach, describe, expect, it, vi } from "vitest";
import {
	providerRetryDelayMs,
	retryAfterMs,
} from "#/integrations/provider-errors";

afterEach(() => vi.restoreAllMocks());

describe("provider retry delays", () => {
	it("parses delta seconds and HTTP dates without exceeding ten minutes", () => {
		expect(
			retryAfterMs(new Response(null, { headers: { "retry-after": "45" } })),
		).toBe(45_000);
		expect(
			retryAfterMs(
				new Response(null, {
					headers: { "retry-after": "Wed, 21 Oct 2037 07:28:00 GMT" },
				}),
				0,
			),
		).toBe(600_000);
	});

	it("prefers provider guidance and otherwise applies bounded backoff", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		expect(providerRetryDelayMs({ status: 429, retryAfterMs: 12_345 }, 1)).toBe(
			12_345,
		);
		expect(providerRetryDelayMs({ status: 429 }, 1)).toBe(30_000);
		expect(providerRetryDelayMs({ status: 429 }, 4)).toBe(240_000);
		expect(providerRetryDelayMs({ status: 429 }, 20)).toBe(600_000);
	});
});

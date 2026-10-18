const maximumRetryDelayMs = 10 * 60_000;
const providerRequestIntervalMs = 200;
const providerNextRequestAt = new Map<string, number>();

export interface ProviderRateLimitError {
	readonly status: number;
	readonly retryAfterMs?: number;
}

export function retryAfterMs(response: Response, now = Date.now()) {
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.min(maximumRetryDelayMs, Math.ceil(seconds * 1000));
	const date = Date.parse(value);
	if (!Number.isFinite(date)) return undefined;
	return Math.min(maximumRetryDelayMs, Math.max(0, date - now));
}

export function providerRetryDelayMs(error: unknown, attempt = 1) {
	if (isProviderRateLimitError(error) && error.retryAfterMs != null)
		return clampRetryDelay(error.retryAfterMs);
	const exponent = Math.max(0, Math.min(5, attempt - 1));
	const base = Math.min(maximumRetryDelayMs, 30_000 * 2 ** exponent);
	return Math.min(
		maximumRetryDelayMs,
		Math.round(base * (0.9 + Math.random() * 0.2)),
	);
}

export async function paceProviderRequest(providerKey: string) {
	if (
		import.meta.env.MODE === "test" ||
		(typeof process !== "undefined" &&
			(process.env.NODE_ENV === "test" || process.env.VITEST))
	)
		return;
	const now = Date.now();
	const scheduledAt = Math.max(
		now,
		providerNextRequestAt.get(providerKey) ?? 0,
	);
	providerNextRequestAt.set(
		providerKey,
		scheduledAt + providerRequestIntervalMs,
	);
	if (scheduledAt > now)
		await new Promise((resolve) => setTimeout(resolve, scheduledAt - now));
}

function isProviderRateLimitError(
	error: unknown,
): error is ProviderRateLimitError {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		(error as { status?: unknown }).status === 429
	);
}

function clampRetryDelay(value: number) {
	return Math.min(maximumRetryDelayMs, Math.max(0, Math.ceil(value)));
}

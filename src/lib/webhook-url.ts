import { z } from "zod";

const blockedHostnames = new Set([
	"0.0.0.0",
	"localhost",
	"localhost.localdomain",
	"metadata.google.internal",
	"169.254.169.254",
	"[::]",
	"[::1]",
]);

export function isSafeWebhookUrl(value: string) {
	return isSafePublicUrl(value, ["https:"]);
}

export function isSafePublicUrl(
	value: string,
	allowedProtocols: readonly string[],
) {
	try {
		const url = new URL(value);
		if (
			!allowedProtocols.includes(url.protocol) ||
			url.username ||
			url.password
		)
			return false;
		const hostname = url.hostname.toLowerCase();
		if (
			blockedHostnames.has(hostname) ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal") ||
			hostname.endsWith(".localhost")
		)
			return false;
		return !isPrivateIpv4(hostname) && !isPrivateIpv6(hostname);
	} catch {
		return false;
	}
}

const dnsResponseSchema = z.object({
	Status: z.number().int(),
	Answer: z
		.array(
			z.object({
				type: z.number().int(),
				data: z.string(),
			}),
		)
		.optional(),
});

export type WebhookHostnameResolver = (hostname: string) => Promise<string[]>;

export type ResolvedWebhookUrlSafety =
	| "safe"
	| "dns_resolution_failed"
	| "unsafe";

export class WebhookDnsUnavailableError extends Error {
	constructor() {
		super("Webhook DNS resolver temporarily unavailable");
		this.name = "WebhookDnsUnavailableError";
	}
}

export async function classifyResolvedWebhookUrl(
	value: string,
	resolveHostname: WebhookHostnameResolver,
): Promise<ResolvedWebhookUrlSafety> {
	if (!isSafeWebhookUrl(value)) return "unsafe";
	const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "");
	if (isIpAddress(hostname))
		return isPublicIpAddress(hostname) ? "safe" : "unsafe";
	const addresses = await resolveHostname(hostname);
	if (addresses.length === 0) return "dns_resolution_failed";
	return addresses.every(isPublicIpAddress) ? "safe" : "unsafe";
}

export async function assertSafeResolvedWebhookUrl(
	value: string,
	resolveHostname: WebhookHostnameResolver,
) {
	return (await classifyResolvedWebhookUrl(value, resolveHostname)) === "safe";
}

export async function resolveWebhookHostname(
	hostname: string,
	fetcher: typeof fetch = fetch,
) {
	let hadSuccessfulResponse = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		for (const resolver of ["cloudflare", "google", "quad9"] as const) {
			const results = await Promise.allSettled(
				(["A", "AAAA"] as const).map((type) =>
					queryDns(resolver, hostname, type, fetcher),
				),
			);
			if (results.every((result) => result.status === "rejected")) {
				console.warn(
					JSON.stringify({
						event: "webhook_dns_resolver_unavailable",
						resolver,
						attempt: attempt + 1,
						failures: results.map((result) =>
							result.status === "rejected" && result.reason instanceof Error
								? result.reason.name
								: "unknown",
						),
					}),
				);
			}
			const addresses = results.flatMap((result) => {
				if (result.status === "fulfilled") {
					hadSuccessfulResponse = true;
					return result.value;
				}
				return [];
			});
			if (addresses.length > 0) return [...new Set(addresses)];
		}
		if (attempt < 2)
			await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
	}
	if (!hadSuccessfulResponse) throw new WebhookDnsUnavailableError();
	return [];
}

async function queryDns(
	resolver: "cloudflare" | "google" | "quad9",
	hostname: string,
	type: "A" | "AAAA",
	fetcher: typeof fetch,
) {
	const url =
		resolver === "cloudflare"
			? `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`
			: resolver === "google"
				? `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`
				: `https://dns.quad9.net/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
	const response = await fetcher(url, {
		headers: { accept: "application/dns-json" },
		redirect: "error",
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) throw new Error("DNS resolver request failed");
	const body = (await response.json()) as unknown;
	const result = dnsResponseSchema.parse(body);
	if (result.Status !== 0) return [];
	return (result.Answer ?? [])
		.filter((answer) => answer.type === 1 || answer.type === 28)
		.map((answer) => answer.data);
}

function isIpAddress(hostname: string) {
	return (
		isPrivateIpv4(hostname) ||
		parseIpv6(hostname) !== null ||
		/^\d+(?:\.\d+){3}$/.test(hostname)
	);
}

function isPublicIpAddress(address: string) {
	if (/^\d+(?:\.\d+){3}$/.test(address)) return !isPrivateIpv4(address);
	if (parseIpv6(address) !== null) return !isPrivateIpv6(address);
	return false;
}

function isPrivateIpv4(hostname: string) {
	const parts = hostname.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part)))
		return false;
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255)) return true;
	return isPrivateIpv4Octets(octets);
}

function isPrivateIpv4Octets(octets: number[]) {
	const [a, b, c] = octets;
	if (a === undefined || b === undefined || c === undefined) return true;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113) ||
		a >= 224
	);
}

function isPrivateIpv6(hostname: string) {
	const address = parseIpv6(hostname.replace(/^\[|\]$/g, "").toLowerCase());
	if (address === null) return false;
	const upper96 = address >> 32n;
	if (upper96 === 0n || upper96 === 0xffffn) {
		const ipv4 = Number(address & 0xffff_ffffn);
		return isPrivateIpv4Octets([
			(ipv4 >>> 24) & 255,
			(ipv4 >>> 16) & 255,
			(ipv4 >>> 8) & 255,
			ipv4 & 255,
		]);
	}
	return (
		address === 0n ||
		address === 1n ||
		address >> 64n === 0x100n ||
		address >> 80n === 0x2001_0002n ||
		address >> 96n === 0x2001_0db8n ||
		address >> 121n === 0x7en ||
		address >> 118n === 0x3fan ||
		address >> 120n === 0xffn
	);
}

function parseIpv6(value: string) {
	if (!value.includes(":")) return null;
	const halves = value.split("::");
	if (halves.length > 2) return null;
	const left = halves[0]?.split(":").filter(Boolean) ?? [];
	const right = halves[1]?.split(":").filter(Boolean) ?? [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
	const groups = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right,
	];
	if (
		groups.length !== 8 ||
		groups.some((part) => !/^[\da-f]{1,4}$/.test(part))
	)
		return null;
	return groups.reduce(
		(result, part) => (result << 16n) | BigInt(`0x${part}`),
		0n,
	);
}

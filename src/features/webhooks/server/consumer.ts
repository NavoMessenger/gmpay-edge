import { toGmpayStatus } from "#/features/orders/gmpay-status";
import type { WebhookDeliveryResult } from "#/features/webhooks/server/delivery";
import {
	deliverWebhook,
	retryDelayMs,
} from "#/features/webhooks/server/delivery";
import {
	type WebhookJsonObject,
	type WebhookQueueMessage,
	webhookJsonObjectSchema,
} from "#/features/webhooks/types";
import { unitsToDecimal } from "#/lib/money";
import { decryptSecret } from "#/lib/secrets";
import { minorToDecimal } from "#/lib/units";
import {
	classifyResolvedWebhookUrl,
	isSafeWebhookUrl,
	resolveWebhookHostname,
	WebhookDnsUnavailableError,
	type WebhookHostnameResolver,
} from "#/lib/webhook-url";
import { redactAuditValue } from "#/server/audit-redaction";
import { loadOperationalSettings } from "#/server/operational-settings";
import type { RuntimeCache } from "#/server/runtime/types";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";

const webhookDnsCacheTtlSeconds = 10 * 60;
const webhookDnsCacheDiagnostic =
	"回调域名 DNS 服务暂时不可用，已使用最近验证的公网 DNS 解析结果继续投递。";

export interface WebhookQueueMessageLike {
	body: WebhookQueueMessage;
	attempts: number;
	id: string;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

export async function processWebhookMessage(
	db: D1Database,
	message: WebhookQueueMessageLike,
	fetcher: typeof fetch = fetch,
	queue?: Pick<Queue<WebhookQueueMessage>, "send">,
	context: {
		settings?: Awaited<ReturnType<typeof loadOperationalSettings>>;
		runtime?: RuntimeConfig;
		resolveHostname?: WebhookHostnameResolver;
		cache?: Pick<RuntimeCache, "get" | "put">;
	} = {},
) {
	const settings = context.settings ?? (await loadOperationalSettings(db));
	const attempt = message.body.attempt;
	const startedAt = Date.now();
	const leaseUntil = startedAt + settings.webhookTimeoutMs + 5_000;
	const claimed = await db
		.prepare(
			`UPDATE webhook_deliveries
			 SET status = 'delivering', attempt_count = ?, next_attempt_at = ?, updated_at = ?
			 WHERE id = ? AND (
			  (status IN ('queued', 'failed') AND attempt_count < ?)
			  OR (status = 'delivering' AND next_attempt_at <= ?)
			 )`,
		)
		.bind(
			attempt,
			leaseUntil,
			startedAt,
			message.body.deliveryId,
			attempt,
			startedAt,
		)
		.run();
	if ((claimed.meta.changes ?? 0) !== 1) {
		const current = await db
			.prepare(
				"SELECT status, attempt_count, next_attempt_at FROM webhook_deliveries WHERE id = ?",
			)
			.bind(message.body.deliveryId)
			.first<{
				status: string;
				attempt_count: number;
				next_attempt_at: number | null;
			}>();
		if (
			!current ||
			current.status === "succeeded" ||
			current.status === "dead" ||
			(current.status === "failed" && current.attempt_count >= attempt)
		) {
			message.ack();
		} else {
			const delay = Math.max(
				1,
				Math.ceil(
					((current.next_attempt_at ?? startedAt + 5_000) - startedAt) / 1000,
				),
			);
			message.retry({ delaySeconds: delay });
		}
		return { success: false as const, errorCode: "delivery_not_claimed" };
	}
	let result: WebhookDeliveryResult;
	try {
		const delivery = await resolveWebhookDelivery(
			db,
			message.body,
			context.runtime,
		);
		const resolveHostname =
			context.resolveHostname ??
			(fetcher === fetch ? resolveWebhookHostname : undefined);
		const dnsCacheDiagnostic = resolveHostname
			? await assertSafeWebhookDeliveryHostname(
					delivery.url,
					resolveHostname,
					context.cache,
				)
			: undefined;
		result = await deliverWebhook(delivery, fetcher, settings.webhookTimeoutMs);
		if (dnsCacheDiagnostic)
			result = { ...result, diagnosticDetail: dnsCacheDiagnostic };
	} catch (error) {
		result = preflightFailureResult(error, startedAt);
	}
	const now = Date.now();
	await db
		.prepare(
			"INSERT OR IGNORE INTO webhook_attempts (id, delivery_id, attempt, request_id, response_status, duration_ms, error_code, diagnostic_detail, response_excerpt, request_snapshot, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			crypto.randomUUID(),
			message.body.deliveryId,
			attempt,
			message.id,
			result.status ?? null,
			result.durationMs,
			result.errorCode ?? null,
			result.diagnosticDetail ?? null,
			redactResponseExcerpt(result.responseExcerpt),
			result.requestSnapshot ? JSON.stringify(result.requestSnapshot) : null,
			now,
		)
		.run();
	if (result.success) {
		await db
			.prepare(
				"UPDATE webhook_deliveries SET status = 'succeeded', completed_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'delivering' AND attempt_count = ?",
			)
			.bind(now, now, message.body.deliveryId, attempt)
			.run();
		message.ack();
		return result;
	}
	if (attempt >= settings.webhookMaxAttempts) {
		await db
			.prepare(
				"UPDATE webhook_deliveries SET status = 'dead', completed_at = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'delivering' AND attempt_count = ?",
			)
			.bind(now, now, message.body.deliveryId, attempt)
			.run();
		message.ack();
		return result;
	}
	const delayMs = Math.min(
		3_600_000,
		Math.max(retryDelayMs(attempt), result.retryAfterMs ?? 0),
	);
	const nextAttemptAt = now + delayMs;
	const delaySeconds = Math.ceil(delayMs / 1_000);
	await db
		.prepare(
			"UPDATE webhook_deliveries SET status = 'failed', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'delivering' AND attempt_count = ?",
		)
		.bind(nextAttemptAt, now, message.body.deliveryId, attempt)
		.run();
	if (!queue) {
		message.retry({ delaySeconds });
		return result;
	}
	try {
		await queue.send(
			{
				kind: "webhook.delivery",
				version: 1,
				deliveryId: message.body.deliveryId,
				eventId: message.body.eventId,
				attempt: attempt + 1,
			},
			{ delaySeconds },
		);
		await db
			.prepare(
				"UPDATE webhook_deliveries SET next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'failed' AND attempt_count = ?",
			)
			.bind(nextAttemptAt + 5 * 60_000, now, message.body.deliveryId, attempt)
			.run();
	} catch {
		// D1 remains due at nextAttemptAt; Cron outbox recovery will enqueue it.
	}
	message.ack();
	return result;
}

const webhookPreflightDiagnostics = {
	webhook_dns_resolution_failed:
		"无法解析回调域名的公网 DNS 记录，请检查域名解析后重试。",
	webhook_dns_resolution_unavailable:
		"回调域名 DNS 服务暂时不可用，系统将自动重试，请稍后查看投递结果。",
	webhook_url_unsafe:
		"回调地址必须是可公开访问的 HTTPS 地址，且不能指向私有或保留网络。",
	webhook_signing_secret_unavailable:
		"回调签名密钥不可用，请检查运行时密钥配置和 API 密钥记录。",
	webhook_signing_secret_decryption_failed:
		"无法解密回调签名密钥，请检查密钥轮换或运行时加密配置。",
	webhook_event_payload_invalid: "回调事件数据无效，无法生成发送内容。",
	webhook_configuration_invalid: "回调投递配置不完整，无法生成发送请求。",
} as const;

type WebhookPreflightErrorCode = keyof typeof webhookPreflightDiagnostics;

class WebhookPreflightError extends Error {
	constructor(readonly code: WebhookPreflightErrorCode) {
		super(code);
	}
}

function failWebhookPreflight(code: WebhookPreflightErrorCode): never {
	throw new WebhookPreflightError(code);
}

function preflightFailureResult(error: unknown, startedAt: number) {
	const errorCode =
		error instanceof WebhookPreflightError
			? error.code
			: "webhook_configuration_invalid";
	return {
		success: false as const,
		durationMs: Date.now() - startedAt,
		errorCode,
		diagnosticDetail: webhookPreflightDiagnostics[errorCode],
	};
}

async function assertSafeWebhookDeliveryHostname(
	url: string,
	resolveHostname: WebhookHostnameResolver,
	cache?: Pick<RuntimeCache, "get" | "put">,
) {
	if (!isSafeWebhookUrl(url)) failWebhookPreflight("webhook_url_unsafe");
	const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	let resolvedAddresses: string[] | undefined;
	let safety: Awaited<ReturnType<typeof classifyResolvedWebhookUrl>>;
	try {
		safety = await classifyResolvedWebhookUrl(url, async (name) => {
			resolvedAddresses = await resolveHostname(name);
			return resolvedAddresses;
		});
	} catch (error) {
		if (error instanceof WebhookDnsUnavailableError) {
			const cachedAddresses = await loadSafeWebhookDnsCache(cache, hostname);
			if (cachedAddresses) {
				safety = await classifyResolvedWebhookUrl(
					url,
					async () => cachedAddresses,
				);
				if (safety === "safe") return webhookDnsCacheDiagnostic;
			}
		}
		failWebhookPreflight(
			error instanceof WebhookDnsUnavailableError
				? "webhook_dns_resolution_unavailable"
				: "webhook_dns_resolution_failed",
		);
	}
	if (safety === "dns_resolution_failed")
		failWebhookPreflight("webhook_dns_resolution_failed");
	if (safety === "unsafe") failWebhookPreflight("webhook_url_unsafe");
	if (resolvedAddresses)
		await storeSafeWebhookDnsCache(cache, hostname, resolvedAddresses);
}

function webhookDnsCacheKey(hostname: string) {
	return `webhook-dns-safe:v1:${hostname}`;
}

async function loadSafeWebhookDnsCache(
	cache: Pick<RuntimeCache, "get" | "put"> | undefined,
	hostname: string,
) {
	if (!cache) return null;
	try {
		const raw = await cache.get(webhookDnsCacheKey(hostname));
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		if (
			typeof value !== "object" ||
			value === null ||
			!("hostname" in value) ||
			!("addresses" in value) ||
			!("verifiedAt" in value) ||
			value.hostname !== hostname ||
			!Array.isArray(value.addresses) ||
			value.addresses.length === 0 ||
			value.addresses.some((address) => typeof address !== "string") ||
			typeof value.verifiedAt !== "number" ||
			!Number.isFinite(value.verifiedAt) ||
			Date.now() - value.verifiedAt > webhookDnsCacheTtlSeconds * 1_000
		)
			return null;
		return value.addresses;
	} catch {
		return null;
	}
}

async function storeSafeWebhookDnsCache(
	cache: Pick<RuntimeCache, "get" | "put"> | undefined,
	hostname: string,
	addresses: string[],
) {
	if (!cache) return;
	await cache
		.put(
			webhookDnsCacheKey(hostname),
			JSON.stringify({ hostname, addresses, verifiedAt: Date.now() }),
			{ expirationTtl: webhookDnsCacheTtlSeconds },
		)
		.catch(() => undefined);
}

export function redactResponseExcerpt(value: string | undefined) {
	if (!value) return null;
	try {
		return JSON.stringify(redactAuditValue(JSON.parse(value)));
	} catch {
		return "[REDACTED_UNPARSEABLE]";
	}
}

async function resolveWebhookDelivery(
	db: D1Database,
	message: WebhookQueueMessage,
	sharedRuntime?: RuntimeConfig,
) {
	const row = await db
		.prepare(
			`SELECT e.payload, o.notify_url AS url, o.api_protocol,
			 o.id AS order_id, o.external_order_id, o.amount_minor,
			 o.currency_decimals, ops.expected_amount_units, ops.decimals,
			 o.description, o.metadata,
			 o.status, k.pid, k.secret_encrypted,
			 COALESCE(ops.target_value, '') AS receive_address,
			 COALESCE(ops.asset_code, '') AS token
			 FROM webhook_deliveries d
			 JOIN webhook_events e ON e.id = d.event_id
			 JOIN orders o ON o.id = d.order_id
			 JOIN api_keys k ON k.id = d.api_key_id
			 LEFT JOIN order_payment_snapshots ops ON ops.order_id = o.id
			 WHERE d.id = ? AND e.id = ? LIMIT 1`,
		)
		.bind(message.deliveryId, message.eventId)
		.first<{
			payload: string;
			url: string;
			api_protocol: "gmpay" | "epay" | null;
			order_id: string;
			external_order_id: string;
			amount_minor: string;
			currency_decimals: number;
			expected_amount_units: string | null;
			decimals: number | null;
			description: string | null;
			metadata: string | null;
			status: import("#/features/orders/schema").OrderStatus;
			pid: string;
			secret_encrypted: string;
			receive_address: string;
			token: string;
		}>();
	if (!row) failWebhookPreflight("webhook_configuration_invalid");
	if (!row.api_protocol) failWebhookPreflight("webhook_configuration_invalid");
	// Validate again at delivery time so a compromised stored row cannot turn the
	// queue worker into an SSRF proxy.
	if (!isSafeWebhookUrl(row.url)) failWebhookPreflight("webhook_url_unsafe");
	let runtime: RuntimeConfig;
	try {
		runtime = sharedRuntime ?? (await loadRuntimeConfig(db));
	} catch {
		failWebhookPreflight("webhook_signing_secret_unavailable");
	}
	if (!runtime.apiKeyPepper)
		failWebhookPreflight("webhook_signing_secret_unavailable");
	let payload: WebhookJsonObject;
	try {
		payload = webhookJsonObjectSchema.parse(JSON.parse(row.payload));
	} catch {
		failWebhookPreflight("webhook_event_payload_invalid");
	}
	const transaction = webhookJsonObjectSchema.safeParse(payload.transaction);
	const metadata = parseMetadata(row.metadata);
	const amount = minorToDecimal(row.amount_minor, row.currency_decimals);
	const paymentAmount =
		row.expected_amount_units !== null && row.decimals !== null
			? unitsToDecimal(BigInt(row.expected_amount_units), row.decimals)
			: "0";
	let secret: string;
	try {
		secret = await decryptSecret(row.secret_encrypted, runtime.apiKeyPepper);
	} catch {
		failWebhookPreflight("webhook_signing_secret_decryption_failed");
	}
	const base = {
		...message,
		url: row.url,
		secret,
		payload,
	};
	if (row.api_protocol === "gmpay")
		return {
			...base,
			protocol: "gmpay" as const,
			gmpay: {
				pid: row.pid,
				trade_id: row.order_id,
				order_id: row.external_order_id,
				amount,
				actual_amount: paymentAmount,
				receive_address: row.receive_address,
				token: row.token,
				block_transaction_id: String(
					transaction.success ? (transaction.data.hash ?? "") : "",
				),
				status: toGmpayStatus(row.status),
			},
		};
	return {
		...base,
		protocol: "epay" as const,
		epay: {
			pid: row.pid,
			trade_no: row.order_id,
			out_trade_no: row.external_order_id,
			type: metadata.epayType ?? "alipay",
			name: row.description ?? row.external_order_id,
			money: amount,
			trade_status: epayTradeStatus(row.status),
			...(metadata.epayParam ? { param: metadata.epayParam } : {}),
		},
	};
}

function parseMetadata(value: string | null) {
	try {
		const parsed: unknown = value ? JSON.parse(value) : null;
		if (!parsed || typeof parsed !== "object") return {};
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

function epayTradeStatus(
	status: import("#/features/orders/schema").OrderStatus,
) {
	if (status === "paid" || status === "overpaid") return "TRADE_SUCCESS";
	if (status === "refunded") return "TRADE_REFUNDED";
	if (status === "cancelled" || status === "expired" || status === "failed")
		return "TRADE_CLOSED";
	return "WAIT_BUYER_PAY";
}

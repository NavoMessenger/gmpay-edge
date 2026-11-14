import { paymentSettingsError } from "#/features/payment-settings/errors";
import { parseReceivingUsdLimits } from "#/features/payment-settings/receiving-method-limits";
import { parseReceivingProviderConfiguration } from "#/features/payment-settings/server/provider-config";
import { OkPayAdapter } from "#/integrations/wallets/okpay";
import { encryptSecret } from "#/lib/secrets";

export async function updateReceivingMethod(
	db: D1Database,
	input: {
		id: string;
		name: string;
		minAmount?: string;
		maxAmount?: string;
		configuration?: { shopId: string; apiKey?: string };
	},
	context: {
		integrationConfigSecret: string;
		actorUserId: string | null;
		requestId: string | null;
		ipAddress: string | null;
	},
) {
	const current = await db
		.prepare(
			`SELECT name, rail_code, target_value, config_encrypted,
		 min_amount_minor, max_amount_minor FROM receiving_methods WHERE id = ?`,
		)
		.bind(input.id)
		.first<{
			name: string;
			rail_code: string;
			target_value: string;
			config_encrypted: string | null;
			min_amount_minor: string | null;
			max_amount_minor: string | null;
		}>();
	if (!current) throw paymentSettingsError("receiving_method_not_found");
	const limits = parseReceivingUsdLimits(input.minAmount, input.maxAmount);
	const minAmountMinor = limits.min?.toString() ?? null;
	const maxAmountMinor = limits.max?.toString() ?? null;
	const limitsChanged =
		current.min_amount_minor !== minAmountMinor ||
		current.max_amount_minor !== maxAmountMinor;
	let targetValue = current.target_value;
	let encryptedConfiguration = current.config_encrypted;
	let configurationChanged = false;
	if (input.configuration) {
		if (current.rail_code !== "okpay")
			throw paymentSettingsError("receiving_method_configuration_required");
		const shopChanged = input.configuration.shopId !== current.target_value;
		if (shopChanged || input.configuration.apiKey) {
			// The old secret never leaves this server-side boundary. A new shop
			// requires its own key instead of silently reusing another shop's token.
			const apiKey = input.configuration.apiKey;
			if (!apiKey)
				throw paymentSettingsError("receiving_method_configuration_required");
			const target = parseReceivingProviderConfiguration("okpay", {
				shopId: input.configuration.shopId,
				apiKey,
			});
			const adapter = new OkPayAdapter({
				shopId: target.targetValue,
				...target.credentials,
			});
			const health = await adapter.healthCheck();
			if (!health.healthy)
				throw paymentSettingsError(
					"receiving_method_provider_authentication_failed",
				);
			targetValue = target.targetValue;
			encryptedConfiguration = await encryptSecret(
				JSON.stringify(target.credentials),
				context.integrationConfigSecret,
			);
			configurationChanged = true;
		}
	}
	const now = Date.now();
	const [result] = await db.batch([
		db
			.prepare(`UPDATE receiving_methods SET name = ?, min_amount_minor = ?, max_amount_minor = ?,
		 target_value = ?, normalized_target_value = CASE WHEN ? THEN ? ELSE normalized_target_value END, config_encrypted = ?, target_metadata = CASE WHEN ? THEN json_object('shopId', ?) ELSE target_metadata END, updated_at = ?
		 WHERE id = ? AND target_value = ? AND config_encrypted IS ?
		 AND (? = target_value OR NOT EXISTS (
		  SELECT 1 FROM order_payment_snapshots ops JOIN orders o ON o.id = ops.order_id
		  WHERE ops.receiving_method_id = receiving_methods.id AND (o.provider_order_id IS NOT NULL OR o.status IN ('pending', 'confirming', 'partially_paid'))
		 ))`)
			.bind(
				input.name,
				minAmountMinor,
				maxAmountMinor,
				targetValue,
				configurationChanged,
				targetValue,
				encryptedConfiguration,
				configurationChanged,
				targetValue,
				now,
				input.id,
				current.target_value,
				current.config_encrypted,
				targetValue,
			),
		db
			.prepare(`INSERT INTO audit_logs
		 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, before, after, created_at)
		 SELECT ?, ?, 'receiving_method.updated', 'receiving_method', ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
			.bind(
				crypto.randomUUID(),
				context.actorUserId,
				input.id,
				context.requestId,
				context.ipAddress,
				JSON.stringify({
					name: current.name,
					minAmountMinor: current.min_amount_minor,
					maxAmountMinor: current.max_amount_minor,
				}),
				JSON.stringify({
					name: input.name,
					minAmountMinor,
					maxAmountMinor,
					limitsChanged,
					configurationChanged,
				}),
				now,
			),
	]);
	// Keep a hosted order bound to the shop that created it. The guard shares
	// the update transaction so a concurrent order cannot bypass this invariant.
	if (result?.meta.changes !== 1)
		throw paymentSettingsError("receiving_method_configuration_conflict");
	return { id: input.id, limitsChanged, configurationChanged };
}

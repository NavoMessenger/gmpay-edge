import { z } from "zod";
import { getCheckoutOrderWithDatabase } from "#/features/checkout/server/checkout-order";
import { createOrder } from "#/features/orders/server/create";
import { inlinePaymentOptions } from "./inline-query";

export const telegramPaymentAmount = z.object({
	amount: z
		.string()
		.trim()
		.regex(/^\d+(?:\.\d{1,8})?$/),
	currency: z.string().trim().length(3).default("USD"),
});

export async function listPaymentNetworks(
	db: D1Database,
	amount: string,
	currency: string,
) {
	const result = await inlinePaymentOptions(db, { amount, currency });
	return [...new Map(result.map((item) => [item.network, item])).values()].map(
		(item) => ({ network: item.network, networkName: item.network }),
	);
}

export async function listPaymentAssets(
	db: D1Database,
	amount: string,
	currency: string,
	network: string,
) {
	return (await inlinePaymentOptions(db, { amount, currency })).filter(
		(item) => item.network === network,
	);
}

export async function createTelegramPaymentOrder(
	db: D1Database,
	input: {
		amount: string;
		currency: string;
		receivingMethodId: string;
		paymentAsset: string;
		paymentNetwork: string;
		botId: string;
		telegramUserId: string;
	},
	baseUrl: string,
) {
	return createOrder(
		db,
		{
			externalOrderId: `tg-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
			amount: input.amount,
			currency: input.currency,
			receivingMethodId: input.receivingMethodId,
			paymentAsset: input.paymentAsset,
			paymentNetwork: input.paymentNetwork,
			metadata: {
				source: "telegram_bot",
				botId: input.botId,
				telegramUserId: input.telegramUserId,
			},
		},
		baseUrl,
	);
}

export async function getTelegramPaymentDetails(
	db: D1Database,
	orderId: string,
) {
	return getCheckoutOrderWithDatabase(db, orderId);
}

export function paymentQrValue(details: {
	network?: string;
	token?: string;
	actual_amount?: string;
	receive_address?: string;
}) {
	const address = details.receive_address ?? "";
	const amount = details.actual_amount ?? "";
	if (!address) return "";
	if (
		details.network === "ethereum" ||
		details.network === "polygon" ||
		details.network === "bsc" ||
		details.network === "base"
	)
		return `ethereum:${address}?value=${amount}`;
	if (details.network === "solana") return `solana:${address}?amount=${amount}`;
	if (details.network === "tron") return `tron:${address}?amount=${amount}`;
	if (details.network === "ton")
		return `ton://transfer/${address}?amount=${amount}`;
	return address;
}

export function paymentQrUrl(value: string) {
	return `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=12&data=${encodeURIComponent(value)}`;
}

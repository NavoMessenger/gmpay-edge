import { createFileRoute } from "@tanstack/react-router";
import { handleGmpayOptionsRequest } from "#/features/orders/server/gmpay-api";
import { getEnv } from "#/server/db.server";

export const Route = createFileRoute(
	"/payments/gmpay/v1/order/payment-options",
)({
	server: {
		handlers: {
			GET: ({ request }) => handleGmpayOptionsRequest(request, getEnv()),
		},
	},
});

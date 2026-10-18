// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutOrder } from "#/features/checkout/checkout-model";
import type { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";
import { CheckoutPage } from "#/features/checkout/pages/checkout";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	options: vi.fn(),
	select: vi.fn(),
	submit: vi.fn(),
	success: vi.fn(),
	error: vi.fn(),
}));
vi.mock("#/features/checkout/server/functions", () => ({
	getCheckoutOrderFn: api.get,
	listCheckoutPaymentOptionsFn: api.options,
	selectCheckoutPaymentOptionFn: api.select,
	submitCheckoutTransactionFn: api.submit,
}));
vi.mock("sonner", () => ({
	toast: { success: api.success, error: api.error },
}));
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("#/context/site-brand-provider", () => ({
	useSiteBrand: () => ({
		name: "GMPay Edge",
		title: "GMPay Edge",
		logoUrl: "/logo.svg",
	}),
}));
vi.mock("#/layouts/components/locale-switch", () => ({
	LocaleSwitch: () => null,
}));
vi.mock("#/layouts/components/theme-switch", () => ({
	ThemeSwitch: () => null,
}));
vi.mock("#/features/checkout/components/order-summary-card", () => ({
	OrderSummaryCard: () => null,
}));
vi.mock("#/features/checkout/components/payment-review-dialog", () => ({
	PaymentReviewDialog: () => null,
}));
vi.mock("#/features/checkout/components/step-progress", () => ({
	StepProgress: () => null,
}));
vi.mock("#/features/checkout/components/select-payment-option-panel", () => ({
	SelectPaymentOptionPanel: ({
		onConfirm,
		options,
		busy,
	}: ComponentProps<typeof SelectPaymentOptionPanel>) => (
		<button
			type="button"
			disabled={busy}
			onClick={() => {
				const option = options[0];
				if (option) onConfirm(option);
			}}
		>
			Choose network
		</button>
	),
}));
vi.mock("#/features/checkout/components/payment-details-panel", () => ({
	PaymentDetailsPanel: ({ order }: { order: CheckoutOrder }) => (
		<p>
			{order.receive_address} {order.actual_amount} {order.token}
		</p>
	),
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const now = Date.parse("2026-10-18T10:00:00Z");
const initial: CheckoutOrder = {
	trade_id: "26071306234512345678",
	amount: "12.5",
	currency: "USD",
	status: 4,
	status_detail: "pending",
	expiration_time: new Date(now + 900000).toISOString(),
	version: 0,
};
const selected: CheckoutOrder = {
	...initial,
	status: 1,
	version: 1,
	token: "USDT",
	network: "tron",
	actual_amount: "12.5001",
	receive_address: "TSelectedAddress",
};
describe("checkout confirmation and refresh recovery", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let client: QueryClient;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		vi.resetAllMocks();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity } },
		});
		api.options.mockResolvedValue({
			selectable: true,
			options: [
				{
					network: "tron",
					networkName: "TRON",
					paymentMethodId: "asset-usdt-tron",
					asset: "USDT",
					railKind: "chain",
					amount: "12.5",
					current: false,
				},
			],
		});
		api.select.mockResolvedValue({ order: selected });
		api.get.mockResolvedValue(selected);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		client.clear();
		container.remove();
		vi.useRealTimers();
	});
	async function render(order = initial) {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<CheckoutPage
						initialOrder={order}
						initialNow={now}
						orderId={initial.trade_id}
					/>
				</QueryClientProvider>,
			),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
	}
	it("retains a committed payment when the following refresh fails", async () => {
		api.get.mockRejectedValue(new Error("offline"));
		await render();
		await act(async () => container.querySelector("button")?.click());
		expect(api.select).toHaveBeenCalledWith({
			data: {
				orderId: initial.trade_id,
				network: "tron",
				paymentMethodId: "asset-usdt-tron",
			},
		});
		expect(container.textContent).toContain("TSelectedAddress 12.5001 USDT");
		expect(container.textContent).toContain("Unable to refresh the order");
		expect(api.success).toHaveBeenCalledOnce();
		expect(api.error).not.toHaveBeenCalled();
		expect(api.options).toHaveBeenCalledOnce();
	});
	it("does not let an older in-flight order response erase a new payment snapshot", async () => {
		let finish: ((order: CheckoutOrder) => void) | undefined;
		api.get.mockImplementationOnce(
			() =>
				new Promise<CheckoutOrder>((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		await act(async () => container.querySelector("button")?.click());
		expect(container.textContent).toContain("TSelectedAddress");
		await act(async () => {
			finish?.(initial);
			await Promise.resolve();
		});
		expect(container.textContent).toContain("TSelectedAddress");
		expect(api.get).toHaveBeenCalledTimes(2);
	});
	it("backs off failed visible polling and clears the message after recovery", async () => {
		api.get.mockRejectedValue(new Error("offline"));
		await render(selected);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(api.get).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("TSelectedAddress");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(api.get).toHaveBeenCalledTimes(1);
		api.get.mockResolvedValue(selected);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(api.get).toHaveBeenCalledTimes(2);
		expect(container.textContent).not.toContain("Unable to refresh the order");
	});
	it("submits only one allocation while a confirmation is pending", async () => {
		let finish: ((value: { order: CheckoutOrder }) => void) | undefined;
		api.select.mockImplementationOnce(
			() =>
				new Promise<{ order: CheckoutOrder }>((resolve) => {
					finish = resolve;
				}),
		);
		await render();
		await act(async () => {
			container.querySelector("button")?.click();
			container.querySelector("button")?.click();
		});
		expect(api.select).toHaveBeenCalledOnce();
		await act(async () => {
			finish?.({ order: selected });
		});
		expect(container.textContent).toContain("TSelectedAddress");
	});
});

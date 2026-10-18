// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
type Props = ComponentProps<typeof SelectPaymentOptionPanel>;
const options: Props["options"] = [
	{
		paymentMethodId: "asset-usdt-polygon",
		asset: "USDT",
		network: "polygon",
		networkName: "Polygon",
		railKind: "chain",
		amount: "5.8257",
		current: false,
	},
	{
		paymentMethodId: "asset-usdt-tron",
		asset: "USDT",
		network: "tron",
		networkName: "TRON",
		railKind: "chain",
		amount: "5.8257",
		current: false,
	},
	{
		paymentMethodId: "asset-usdc-tron",
		asset: "USDC",
		network: "tron",
		networkName: "TRON",
		railKind: "chain",
		amount: "5.8257",
		current: false,
	},
];

describe("checkout network and asset selection", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	afterEach(async () => {
		if (root) await act(async () => root.unmount());
		container?.remove();
	});
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	async function render(overrides: Partial<Props> = {}) {
		await act(async () =>
			root.render(
				<SelectPaymentOptionPanel
					busy={false}
					onConfirm={vi.fn()}
					options={options}
					{...overrides}
				/>,
			),
		);
	}
	it("shows the standard network and an estimated amount instead of operator address names", async () => {
		const confirm = vi.fn();
		await render({ onConfirm: confirm });
		expect(container.textContent).toContain("Polygon");
		expect(container.textContent).toContain("5.8257 USDT");
		const button = [...container.querySelectorAll("button")].find(
			(node) => node.textContent === "Confirm",
		);
		expect(button).toBeDefined();
		await act(async () => button?.click());
		expect(confirm).toHaveBeenCalledWith(options[0]);
		expect(confirm.mock.calls[0]?.[0]).not.toHaveProperty("receivingMethodId");
	});
	it("retains a supported asset and falls back when the selected network disappears", async () => {
		await render();
		await render({
			options: options.filter((option) => option.network === "tron"),
		});
		const comboboxes = container.querySelectorAll('[role="combobox"]');
		expect(comboboxes[0]?.textContent).toContain("TRON");
		expect(comboboxes[1]?.textContent).toContain("USDT");
		await render({ options: options.slice(2) });
		expect(
			container.querySelectorAll('[role="combobox"]')[1]?.textContent,
		).toContain("USDC");
	});
	it("disables both selectors and confirmation while an allocation is in flight", async () => {
		const confirm = vi.fn();
		await render({ busy: true, onConfirm: confirm });
		for (const node of container.querySelectorAll("button"))
			expect(node.disabled).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});
	it("shows retry feedback and blocks confirmation when options cannot refresh", async () => {
		const retry = vi.fn();
		await render({ failed: true, onRetry: retry });
		expect(container.textContent).toContain(
			"Payment options could not be refreshed",
		);
		const button = [...container.querySelectorAll("button")].find(
			(node) => node.textContent === "Retry",
		);
		await act(async () => button?.click());
		expect(retry).toHaveBeenCalledOnce();
		expect(
			[...container.querySelectorAll("button")].find(
				(node) => node.textContent === "Confirm",
			)?.disabled,
		).toBe(true);
	});
	it("handles no eligible networks without an actionable confirm button", async () => {
		await render({ options: [] });
		expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(0);
		expect(
			[...container.querySelectorAll("button")].find(
				(node) => node.textContent === "Confirm",
			),
		).toBeUndefined();
	});
});

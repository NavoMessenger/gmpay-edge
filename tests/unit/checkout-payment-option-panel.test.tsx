// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { SelectPaymentOptionPanel } from "#/features/checkout/components/select-payment-option-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no scrolling layout; Radix scrolls the selected option on keyboard open.
beforeAll(() => {
	HTMLElement.prototype.scrollIntoView = vi.fn();
});
type Props = ComponentProps<typeof SelectPaymentOptionPanel>;
type Option = Props["options"][number];
const options: [Option, Option, Option] = [
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

describe("checkout asset-first payment selection", () => {
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
		expect(comboboxes[0]?.textContent).toContain("USDT");
		expect(comboboxes[1]?.textContent).toContain("TRON");
		await render({ options: options.slice(2) });
		expect(
			container.querySelectorAll('[role="combobox"]')[0]?.textContent,
		).toContain("USDC");
	});
	async function openSelect(index: number) {
		const trigger = container.querySelectorAll('[role="combobox"]')[index];
		if (!trigger) throw new Error("Missing selector");
		await act(async () =>
			trigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			),
		);
		return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
	}
	async function choose(index: number, label: string) {
		const items = await openSelect(index);
		const item = items.find((item) => item.textContent === label);
		if (!item) throw new Error(`Missing ${label}`);
		await act(async () =>
			item.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			),
		);
	}
	async function closeSelect() {
		await act(async () =>
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
	}
	function button(label: string) {
		const node = [...container.querySelectorAll("button")].find(
			(node) => node.textContent === label,
		);
		if (!node) throw new Error(`Missing ${label}`);
		return node;
	}
	it("deduplicates assets before displaying the selected asset's networks", async () => {
		await render();
		expect(
			container
				.querySelectorAll('[role="combobox"]')[0]
				?.getAttribute("aria-label"),
		).toBe("Currency");
		expect((await openSelect(0)).map((node) => node.textContent)).toEqual([
			"USDT",
			"USDC",
		]);
		await closeSelect();
		expect((await openSelect(1)).map((node) => node.textContent)).toEqual([
			"Polygon",
			"TRON",
		]);
		await closeSelect();
		await choose(0, "USDC");
		expect((await openSelect(1)).map((node) => node.textContent)).toEqual([
			"TRON",
		]);
	});
	it("preserves a compatible network across currencies and submits its own quote and ID", async () => {
		const confirm = vi.fn();
		const priced = options.map((option, index) => ({
			...option,
			amount: `${index + 1}.25`,
		}));
		await render({ options: priced, onConfirm: confirm });
		await choose(1, "TRON");
		await choose(0, "USDC");
		expect(container.textContent).toContain("3.25 USDC");
		await act(async () => button("Confirm").click());
		expect(confirm).toHaveBeenLastCalledWith(priced[2]);
		await choose(0, "USDT");
		expect(
			container.querySelectorAll('[role="combobox"]')[1]?.textContent,
		).toBe("TRON");
	});
	it("filters payment kinds by currency and preserves supported kind and network", async () => {
		const exchange: Props["options"][number] = {
			...options[0],
			paymentMethodId: "usdt-binance",
			railKind: "exchange",
			network: "binance",
			networkName: "Binance",
		};
		const wallet: Props["options"][number] = {
			...options[0],
			paymentMethodId: "usdt-okpay",
			railKind: "wallet",
			network: "okpay",
			networkName: "OKPay",
		};
		const exchangeUsdc = {
			...exchange,
			asset: "USDC",
			paymentMethodId: "usdc-binance",
		};
		const confirm = vi.fn();
		await render({
			options: [...options, exchange, wallet, exchangeUsdc],
			onConfirm: confirm,
		});
		expect(container.querySelectorAll("[aria-pressed]")).toHaveLength(3);
		await act(async () => button("Exchanges").click());
		await choose(0, "USDC");
		expect(container.querySelectorAll("[aria-pressed]")).toHaveLength(2);
		expect(button("Exchanges").getAttribute("aria-pressed")).toBe("true");
		expect(container.textContent).toContain("Binance");
		await act(async () => button("Confirm").click());
		expect(confirm).toHaveBeenCalledWith(exchangeUsdc);
		await choose(0, "USDT");
		await act(async () => button("Digital wallets").click());
		expect(
			container.querySelectorAll('[role="combobox"]')[0]?.textContent,
		).toBe("USDT");
		await choose(0, "USDC");
		expect(container.textContent).toContain("TRON");
		expect(button("Blockchain networks").getAttribute("aria-pressed")).toBe(
			"true",
		);
	});
	it("clears invalid choices on refresh and does not restore removed selections", async () => {
		await render();
		await choose(0, "USDC");
		await render({ options: options.slice(0, 2) });
		expect(
			container.querySelectorAll('[role="combobox"]')[0]?.textContent,
		).toBe("USDT");
		await render();
		expect(
			container.querySelectorAll('[role="combobox"]')[0]?.textContent,
		).toBe("USDT");
		expect(container.querySelectorAll("[aria-pressed]")).toHaveLength(0);
	});
	it("deduplicates network options and defaults to the first returned quote", async () => {
		const confirm = vi.fn();
		await render({
			options: [
				...options,
				{ ...options[0], paymentMethodId: "duplicate", amount: "99" },
			],
			onConfirm: confirm,
		});
		expect((await openSelect(1)).map((node) => node.textContent)).toEqual([
			"Polygon",
			"TRON",
		]);
		await closeSelect();
		await act(async () => button("Confirm").click());
		expect(confirm).toHaveBeenCalledWith(options[0]);
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

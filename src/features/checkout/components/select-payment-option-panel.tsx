import { ArrowLeft, Building2, Link2, WalletCards } from "lucide-react";
import { useEffect, useState } from "react";
import { AssetLabel, NetworkLabel } from "#/components/crypto-icons/labels";
import { Button } from "#/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { listCheckoutPaymentOptionsFn } from "#/features/checkout/server/functions";
import { m } from "#/paraglide/messages";

type Option = NonNullable<
	Awaited<ReturnType<typeof listCheckoutPaymentOptionsFn>>
>["options"][number];
type RailKind = Option["railKind"];

export function SelectPaymentOptionPanel({
	busy,
	loading,
	onBack,
	onConfirm,
	options,
	unavailableReason,
	failed,
	onRetry,
}: {
	failed?: boolean;
	onRetry?: () => void;
	busy: boolean;
	loading?: boolean;
	onBack?: () => void;
	onConfirm: (option: Option) => void;
	options: Option[];
	unavailableReason?: "rate_unavailable" | "payment_method_unavailable" | null;
}) {
	const kinds = [...new Set(options.map((option) => option.railKind))];
	const [preferredKind, setKind] = useState<RailKind | "">("");
	const [preferredNetwork, setNetwork] = useState("");
	const [preferredAsset, setAsset] = useState("");
	const kind = kinds.find((value) => value === preferredKind) ?? kinds[0] ?? "";
	const kindOptions = options.filter((option) => option.railKind === kind);
	const networks = [
		...new Map(
			kindOptions.map((option) => [
				option.network,
				{ id: option.network, name: option.networkName },
			]),
		).values(),
	];
	const network =
		networks.find((value) => value.id === preferredNetwork)?.id ??
		networks[0]?.id ??
		"";
	const assets = kindOptions.filter((option) => option.network === network);
	const selected =
		assets.find((option) => option.asset === preferredAsset) ?? assets[0];
	const paymentMethodId = selected?.paymentMethodId ?? "";

	useEffect(() => {
		setKind(kind);
		setNetwork(network);
		setAsset(selected?.asset ?? "");
	}, [kind, network, selected?.asset]);

	return (
		<section className="w-full pb-4">
			<div className="mb-3 flex items-center gap-2">
				{onBack ? (
					<Button
						aria-label={m.checkout_back()}
						className="size-8 rounded-full"
						disabled={busy}
						onClick={onBack}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowLeft />
					</Button>
				) : null}
				<p className="font-semibold text-base">
					{m.checkout_select_payment_method()}
				</p>
			</div>
			{failed ? (
				<div aria-live="polite" className="mb-3 text-sm text-destructive">
					<p>{m.checkout_options_load_failed()}</p>
					<Button
						variant="outline"
						disabled={busy || loading}
						onClick={onRetry}
					>
						{m.checkout_retry()}
					</Button>
				</div>
			) : null}
			{loading ? (
				<p className="py-8 text-center text-muted-foreground text-sm">
					{m.common_loading()}
				</p>
			) : options.length === 0 ? (
				<div className="rounded-xl border bg-muted/30 px-4 py-5 text-center">
					<p className="font-medium">{m.checkout_no_payment_options()}</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{unavailableReason === "rate_unavailable"
							? m.checkout_payment_rate_unavailable_hint()
							: m.checkout_no_payment_options_hint()}
					</p>
				</div>
			) : (
				<>
					{kinds.length > 1 ? (
						<div className="mb-4 grid grid-cols-3 gap-2">
							{kinds.map((value) => (
								<Button
									className="h-auto min-h-16 flex-col gap-1 rounded-xl px-2 py-2"
									key={value}
									onClick={() => {
										setKind(value);
										setNetwork("");
									}}
									disabled={busy}
									variant={kind === value ? "default" : "outline"}
								>
									{kindIcon(value)}
									<span className="text-xs">{kindLabel(value)}</span>
								</Button>
							))}
						</div>
					) : null}
					<div className="mb-4 grid grid-cols-2 gap-2">
						<div className="min-w-0">
							<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
								{kindLabel(kind)}
							</p>
							<Select
								disabled={busy || !networks.length}
								onValueChange={setNetwork}
								value={network}
							>
								<SelectTrigger
									aria-label={kindLabel(kind)}
									className="h-12.5 w-full rounded-xl bg-card"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper">
									{networks.map((method) => (
										<SelectItem key={method.id} value={method.id}>
											<NetworkLabel
												displayName={method.name}
												network={method.id}
											/>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="min-w-0">
							<p className="mb-1.5 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
								{m.common_currency()}
							</p>
							<Select
								disabled={busy || !assets.length}
								onValueChange={(value) =>
									setAsset(
										assets.find((option) => option.paymentMethodId === value)
											?.asset ?? "",
									)
								}
								value={paymentMethodId}
							>
								<SelectTrigger
									aria-label={m.common_currency()}
									className="h-12.5 w-full rounded-xl bg-card"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent position="popper">
									{assets.map((option) => (
										<SelectItem
											key={option.paymentMethodId}
											value={option.paymentMethodId}
										>
											<AssetLabel
												label={option.asset}
												network={option.network}
												symbol={option.asset}
											/>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					{selected ? (
						<div className="mb-4 rounded-xl bg-muted/30 p-3 text-sm">
							<p className="text-muted-foreground">
								{m.checkout_estimated_amount()}
							</p>
							<p className="font-semibold">
								{selected.amount} {selected.asset}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{m.checkout_final_amount_hint()}
							</p>
						</div>
					) : null}
					<Button
						className="h-12 w-full rounded-xl text-base"
						disabled={busy || loading || failed || !selected}
						onClick={() => selected && onConfirm(selected)}
					>
						{m.common_confirm()}
					</Button>
				</>
			)}
		</section>
	);
}

function kindLabel(kind: RailKind | "") {
	if (kind === "chain") return m.nav_networks();
	if (kind === "exchange") return m.nav_exchanges();
	if (kind === "wallet") return m.nav_wallets();
	return m.orders_receiving_type();
}

function kindIcon(kind: RailKind) {
	if (kind === "chain") return <Link2 className="size-5" />;
	if (kind === "exchange") return <Building2 className="size-5" />;
	return <WalletCards className="size-5" />;
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Play } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ProTable } from "#/components/pro/table";
import { ModalForm } from "#/components/pro/form";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { operationsErrorMessage } from "#/features/operations/error-message";
import {
	formatScheduleInterval,
	nextTaskExecutionAt,
	type ScheduledTaskName,
	scheduledTaskCatalog,
} from "#/features/operations/schedule";
import {
	getOperationsOverviewFn,
	runOperationsTaskFn,
	updateOperationScheduleFn,
} from "#/features/operations/server/admin";
import type { OperationsTask } from "#/features/operations/server/run-task";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type TaskRun = Awaited<
	ReturnType<typeof getOperationsOverviewFn>
>["taskRuns"][number];
type TaskRow = {
	task: ScheduledTaskName;
	schedule: string | null;
	manual: boolean;
	run: TaskRun | null;
	nextExecutionAt: string | null;
	intervalMs: number | null;
	configKey: string | null;
};

type TaskName = (typeof scheduledTaskCatalog)[number]["task"];

export function JobsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "task" });
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["admin", "operations"],
		queryFn: () => getOperationsOverviewFn(),
		refetchInterval: 30_000,
	});
	const runTask = useMutation({
		mutationFn: runOperationsTaskFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: ["admin", "operations"] });
			toast.success(m.jobs_task_completed({ task: taskLabel(result.task) }));
		},
		onError: (error) =>
			toast.error(operationsErrorMessage(error, m.jobs_task_failed)),
	});
	const saveSchedule = useMutation({
		mutationFn: updateOperationScheduleFn,
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: ["admin", "operations"] });
			toast.success(m.settings_saved());
		},
		onError: (error) =>
			toast.error(operationsErrorMessage(error, m.jobs_task_failed)),
	});
	const latest = new Map(query.data?.taskRuns.map((run) => [run.task, run]));
	const intervalsMs = query.data?.rateIntervals ?? {
		crypto: 3_600_000,
		fiat: 86_400_000,
		rpcHealth: 3_600_000,
		cleanup: 86_400_000,
		scan: 60_000,
		webhookRecovery: 900_000,
	};
	const rows: TaskRow[] = scheduledTaskCatalog.map((entry) => {
		const run = latest.get(entry.task) ?? null;
		return {
			...entry,
			schedule: taskScheduleLabel(entry.task, intervalsMs),
			run,
			nextExecutionAt: nextTaskExecutionAt(
				entry.task,
				run?.startedAt ?? null,
				intervalsMs,
			),
			intervalMs: taskInterval(entry.task, intervalsMs),
			configKey: taskConfigKey(entry.task),
		};
	});
	const columns: ColumnDef<TaskRow>[] = [
		{
			accessorKey: "task",
			header: m.jobs_task_name(),
			cell: ({ row }) => taskLabel(row.original.task),
			meta: { search: true },
		},
		{
			id: "config",
			header: m.common_actions(),
			cell: ({ row }) => (
				<TaskScheduleControl
					row={row.original}
					onSave={(key, intervalMs) =>
						saveSchedule.mutate({ data: { key, intervalMs } })
					}
				/>
			),
		},
		{
			accessorKey: "schedule",
			header: m.jobs_schedule(),
			cell: ({ row }) => row.original.schedule ?? "—",
		},
		{
			id: "executedAt",
			header: m.jobs_last_execution(),
			cell: ({ row }) =>
				row.original.run ? formatDateTime(row.original.run.startedAt) : "—",
		},
		{
			accessorKey: "nextExecutionAt",
			header: m.jobs_next_execution(),
			cell: ({ row }) =>
				row.original.nextExecutionAt
					? formatDateTime(row.original.nextExecutionAt)
					: "—",
		},
		{
			id: "duration",
			header: m.common_duration(),
			cell: ({ row }) =>
				row.original.run?.durationMs == null
					? "—"
					: `${row.original.run.durationMs} ${m.unit_milliseconds()}`,
		},
		{
			id: "status",
			header: m.common_status(),
			cell: ({ row }) => <TaskStatus status={row.original.run?.status} />,
		},
		{
			id: "error",
			header: m.common_last_error(),
			cell: ({ row }) => taskErrorLabel(row.original.run?.errorCode),
		},
		{
			id: "actions",
			header: m.common_actions(),
			cell: ({ row }) =>
				row.original.manual ? (
					<div className="flex justify-end">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<ProButton
									variant="ghost"
									size="icon-sm"
									tooltip={m.common_actions()}
								>
									<MoreHorizontal />
								</ProButton>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-44">
								<DropdownMenuItem
									disabled={
										runTask.isPending || row.original.run?.status === "running"
									}
									onClick={() =>
										runTask.mutate({
											data: { task: row.original.task as OperationsTask },
										})
									}
								>
									<Play />
									{m.common_run_now()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				) : null,
		},
	];
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				title={m.nav_scheduled_tasks()}
				description={m.jobs_description()}
			/>
			<ProTable
				initialState={tableUrlState.initialState}
				onChange={tableUrlState.onChange}
				className="min-h-0 flex-1"
				columns={columns}
				data={rows}
				loading={query.isLoading}
				onRefresh={() => query.refetch()}
				pagination={false}
				toolbarSearch={{ columnId: "task", placeholder: m.common_search() }}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}

function taskInterval(
	task: TaskName,
	intervals: {
		crypto: number;
		fiat: number;
		rpcHealth: number;
		cleanup: number;
		scan: number;
		webhookRecovery: number;
	},
) {
	if (task === "crypto_rate_sync") return intervals.crypto;
	if (task === "fiat_rate_sync") return intervals.fiat;
	if (task === "rpc_health") return intervals.rpcHealth;
	if (task === "retention_cleanup") return intervals.cleanup;
	if (task === "payment_scan_enqueue") return intervals.scan;
	if (task === "webhook_outbox") return intervals.webhookRecovery;
	return null;
}

function taskConfigKey(task: TaskName) {
	if (task === "payment_scan_enqueue") return "payments.scan_interval_ms";
	if (task === "webhook_outbox") return "payments.webhook_recovery_interval_ms";
	if (task === "rpc_health") return "payments.rpc_health_interval_ms";
	if (task === "retention_cleanup") return "retention.cleanup_interval_ms";
	return null;
}

function TaskScheduleControl({
	row,
	onSave,
}: {
	row: TaskRow;
	onSave: (key: string, intervalMs: number) => void;
}) {
	if (row.task === "crypto_rate_sync" || row.task === "fiat_rate_sync")
		return (
			<Link
				className="text-primary underline"
				to={
					row.task === "crypto_rate_sync"
						? "/admin/payment-settings/rates"
						: "/admin/payment-settings/rates/fiat"
				}
			>
				{m.common_edit()}
			</Link>
		);
	if (!row.configKey || row.intervalMs == null)
		return (
			<span className="text-muted-foreground">
				{m.jobs_schedule_triggered()}
			</span>
		);
	return (
		<ModalForm
			trigger={
				<ProButton variant="ghost" size="icon-sm" tooltip={m.common_edit()}>
					<Pencil />
				</ProButton>
			}
			title={m.jobs_schedule_configure()}
			description={m.jobs_schedule_configure_description()}
			initialValues={{ interval: String(row.intervalMs / 1000) }}
			schema={[
				{
					name: "interval",
					label: m.jobs_schedule_interval_seconds(),
					valueType: "text",
					required: true,
					fieldProps: {
						min: row.task === "payment_scan_enqueue" ? 15 : 60,
						max:
							row.task === "retention_cleanup" || row.task === "rpc_health"
								? 604800
								: 3600,
					},
				},
			]}
			onFinish={async (values) =>
				onSave(row.configKey!, Number(values.interval) * 1000)
			}
		/>
	);
}

function taskScheduleLabel(
	task: TaskName,
	intervalsMs: {
		crypto: number;
		fiat: number;
		rpcHealth: number;
		cleanup: number;
		scan: number;
		webhookRecovery: number;
	},
) {
	if (
		task === "payment_defaults" ||
		task === "order_expiration" ||
		task === "frequent_cleanup"
	)
		return null;
	let intervalMs = 60_000;
	if (task === "crypto_rate_sync") intervalMs = intervalsMs.crypto;
	if (task === "fiat_rate_sync") intervalMs = intervalsMs.fiat;
	if (task === "rpc_health") intervalMs = intervalsMs.rpcHealth;
	if (task === "retention_cleanup") intervalMs = intervalsMs.cleanup;
	if (task === "payment_scan_enqueue") intervalMs = intervalsMs.scan;
	if (task === "webhook_outbox") intervalMs = intervalsMs.webhookRecovery;
	return m.jobs_schedule_every({
		time: formatScheduleInterval(intervalMs, getLocale()),
	});
}

function taskErrorLabel(code: string | null | undefined) {
	if (!code) return "—";
	if (code === "already_running") return m.jobs_error_already_running();
	if (code === "binding_unavailable") return m.jobs_error_binding_unavailable();
	if (code === "timeout") return m.jobs_error_timeout();
	return m.jobs_error_failed();
}

function TaskStatus({ status }: { status: TaskRun["status"] | undefined }) {
	if (!status) return <span className="text-muted-foreground">—</span>;
	return (
		<Badge
			variant={
				status === "failed"
					? "destructive"
					: status === "running"
						? "secondary"
						: "default"
			}
		>
			{status === "failed"
				? m.status_failed()
				: status === "succeeded"
					? m.status_succeeded()
					: m.status_running()}
		</Badge>
	);
}

function taskLabel(task: TaskName | OperationsTask) {
	if (task === "order_expiration") return m.jobs_task_expire_orders();
	if (task === "webhook_outbox") return m.jobs_task_recover_webhooks();
	if (task === "rpc_health") return m.jobs_task_check_rpc();
	if (task === "crypto_rate_sync") return m.jobs_task_sync_crypto_rates();
	if (task === "fiat_rate_sync") return m.jobs_task_sync_fiat_rates();
	if (task === "payment_defaults")
		return m.jobs_task_restore_payment_defaults();
	if (task === "payment_scan_enqueue")
		return m.jobs_task_payment_scan_enqueue();
	if (task === "retention_cleanup") return m.jobs_task_retention_cleanup();
	return m.jobs_task_frequent_cleanup();
}

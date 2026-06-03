import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	createWorkflowManager,
	createWorkflowTool,
	renderWorkflowText,
	WorkflowBrowser,
	type WorkflowJob,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
	const manager = createWorkflowManager();
	const workflowTool = createWorkflowTool({ manager });
	const announcedJobs = new Set<number>();
	let unsubscribeStatus: (() => void) | undefined;

	pi.registerTool(workflowTool);

	pi.registerMessageRenderer(
		"workflow-completion",
		(message, _options, theme) => {
			const details = message.details as
				| { jobId?: number; name?: string; status?: string }
				| undefined;
			const status = details?.status ?? "done";
			const color = status === "done" ? "success" : "warning";
			const jobLabel = details?.jobId ? `#${details.jobId}` : "";
			const name = details?.name ? ` (${details.name})` : "";
			return new Text(
				`${theme.fg(color, `Workflow ${jobLabel}${name} ${status}`)} — main agent notified. Open /workflows for details.`,
				0,
				0,
			);
		},
	);

	pi.registerCommand("workflows", {
		description: "Show live background workflow dashboards",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/workflows requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) =>
					new WorkflowBrowser(manager, tui, theme, done),
			);
		},
	});

	function updateStatus(ctx: ExtensionContext): void {
		const jobs = manager.getJobs();
		const running = jobs.filter((job) => job.status === "running").length;
		if (running > 0) {
			ctx.ui.setStatus(
				"workflow",
				ctx.ui.theme.fg("accent", `workflows:${running}`),
			);
			return;
		}
		ctx.ui.setStatus("workflow", undefined);
	}

	function formatWorkflowCompletion(job: WorkflowJob): string {
		const statusLine =
			job.status === "done"
				? "completed successfully"
				: job.status === "cancelled"
					? "was cancelled"
					: "failed";
		const summary = renderWorkflowText(job.snapshot, true);
		const resultText =
			job.status === "done"
				? `\n\nFinal result:\n${JSON.stringify(job.result, null, 2)}`
				: job.error
					? `\n\nError:\n${job.error}`
					: "";
		const message = `Background workflow #${job.id} (${job.name}) ${statusLine}.\n\n${summary}${resultText}\n\nPlease summarize this workflow outcome for the user and suggest any useful next step. The interactive details remain available in /workflows.`;
		const maxLength = 30_000;
		if (message.length <= maxLength) return message;
		return `${message.slice(0, maxLength)}\n\n[Workflow completion message truncated. Open /workflows for the full result.]`;
	}

	function announceCompletedWorkflow(
		job: WorkflowJob,
		ctx: ExtensionContext,
	): void {
		if (job.status === "running" || announcedJobs.has(job.id)) return;
		announcedJobs.add(job.id);

		const message = formatWorkflowCompletion(job);
		ctx.ui.notify(
			`Workflow #${job.id} ${job.status === "done" ? "completed" : job.status}`,
			job.status === "done" ? "info" : "warning",
		);
		pi.sendMessage(
			{
				customType: "workflow-completion",
				content: message,
				display: true,
				details: {
					jobId: job.id,
					name: job.name,
					status: job.status,
				},
			},
			ctx.isIdle()
				? { triggerTurn: true }
				: { triggerTurn: true, deliverAs: "followUp" },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		const active = pi.getActiveTools();
		if (!active.includes(workflowTool.name)) {
			pi.setActiveTools([...active, workflowTool.name]);
		}

		unsubscribeStatus?.();
		unsubscribeStatus = manager.onChange((job) => {
			updateStatus(ctx);
			announceCompletedWorkflow(job, ctx);
		});
		updateStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		unsubscribeStatus?.();
		unsubscribeStatus = undefined;
		manager.cancelAll();
	});
}

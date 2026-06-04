import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowJob, WorkflowManager } from "../workflow-manager.js";

export function updateWorkflowFooterStatus(ctx: ExtensionContext, manager: WorkflowManager): void {
	const jobs = manager.getJobs();
	const running = jobs.filter((job) => job.status === "running").length;
	if (running > 0) {
		ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", `workflows:${running}`));
		return;
	}
	ctx.ui.setStatus("workflow", undefined);
}

export function sendWorkflowCompletionNotification(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	job: WorkflowJob;
	message: string;
}): void {
	const { pi, ctx, job, message } = input;
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
				runId: job.runId,
				name: job.name,
				status: job.status,
			},
		},
		ctx.isIdle() ? { triggerTurn: true } : { triggerTurn: true, deliverAs: "followUp" },
	);
}

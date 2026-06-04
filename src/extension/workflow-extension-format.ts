import {
	buildWorkflowCompletionPrompt,
	WORKFLOW_COMPLETION_TRUNCATION_NOTICE,
} from "../prompts/workflow-completion.js";
import type { WorkflowJob } from "../workflow-manager.js";
import { renderWorkflowReportText, selectWorkflowReport } from "../workflow-report.js";

export function formatWorkflowCompletion(job: WorkflowJob): string {
	const statusLine =
		job.status === "done"
			? "completed successfully"
			: job.status === "cancelled"
				? "was cancelled"
				: job.status === "interrupted"
					? "was interrupted"
					: "failed";
	const report = renderWorkflowReportText(selectWorkflowReport(job));
	const message = buildWorkflowCompletionPrompt({
		jobId: job.id,
		jobName: job.name,
		statusLine,
		report,
	});
	const maxLength = 30_000;
	if (message.length <= maxLength) return message;
	return `${message.slice(0, maxLength)}\n\n${WORKFLOW_COMPLETION_TRUNCATION_NOTICE}`;
}

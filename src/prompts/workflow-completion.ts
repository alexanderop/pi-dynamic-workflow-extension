export const WORKFLOW_COMPLETION_SUMMARY_INSTRUCTION =
	"Please summarize this workflow outcome for the user and suggest any useful next step. The interactive details remain available in /workflows.";

export const WORKFLOW_COMPLETION_TRUNCATION_NOTICE =
	"[Workflow completion message truncated. Open /workflows for the full result.]";

export function buildWorkflowCompletionPrompt(args: {
	jobId: number;
	jobName: string;
	statusLine: string;
	report: string;
}): string {
	return `Background workflow #${args.jobId} (${args.jobName}) ${args.statusLine}.\n\n${args.report}\n\n${WORKFLOW_COMPLETION_SUMMARY_INSTRUCTION}`;
}

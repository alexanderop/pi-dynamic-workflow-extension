import { readFileSync } from "node:fs";

export const WORKFLOW_TOOL_SCRIPT_DESCRIPTION = [
	"Required raw JavaScript workflow script, with no Markdown fences.",
	"First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] } with literal-only values.",
	"Use phase(title), agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), artifact(name, value, opts), log(message), args, cwd, and budget.",
	"parallel() requires functions, not promises.",
].join(" ");

export const WORKFLOW_TOOL_DESCRIPTION =
	"Execute a deterministic JavaScript workflow that orchestrates multiple isolated Pi subagents.";

export const WORKFLOW_TOOL_PROMPT_SNIPPET =
	"Run a JavaScript orchestration workflow with isolated subagents";

export const WORKFLOW_TOOL_BACKGROUND_FOLLOWUP_INSTRUCTION =
	"Use /workflows to watch progress, navigate agents, cancel, and inspect the final result. End your turn and yield control after starting the background workflow. If the user says nothing, stay idle instead of continuing the task on your own. Do not poll, busy-wait, or re-run it; resume only when the user sends a new message or the extension sends a workflow-completion message. When you receive that message, summarize the outcome for the user and suggest a useful next step.";

export function buildWorkflowToolBackgroundStartMessage(args: {
	name: string;
	id: number;
	scriptPath?: string;
}): string {
	const scriptNote = args.scriptPath
		? ` The reusable workflow script was saved at ${args.scriptPath}.`
		: "";
	return `Workflow ${args.name} started in the background as #${args.id}.${scriptNote} ${WORKFLOW_TOOL_BACKGROUND_FOLLOWUP_INSTRUCTION}`;
}

export const WORKFLOW_TOOL_AUTHORING_PROMPT = readWorkflowToolAuthoringPrompt();

export const WORKFLOW_TOOL_PROMPT_GUIDELINES = [
	WORKFLOW_TOOL_AUTHORING_PROMPT,
] as const;

function readWorkflowToolAuthoringPrompt(): string {
	const candidates = [
		new URL("./workflow-tool.md", import.meta.url),
		new URL("../../../src/prompts/workflow-tool.md", import.meta.url),
	];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return readFileSync(candidate, "utf8").trim();
		} catch (error) {
			lastError = error;
		}
	}
	const reason =
		lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Unable to load workflow tool authoring prompt: ${reason}`);
}

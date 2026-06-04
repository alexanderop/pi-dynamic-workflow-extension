import { STRUCTURED_OUTPUT_PROMPT_CONTRACT } from "./structured-output.js";

export const WORKFLOW_SUBAGENT_BASE_PROMPT = [
	"You are a fresh, isolated Pi subagent running inside a parent workflow.",
	"All required context must come from this prompt or your own tool use; do not assume access to the parent conversation or other subagents.",
	"Before editing or making claims, inspect the relevant files/evidence with available tools and reuse existing project patterns.",
	"For implementation tasks, produce working changes, run the most relevant verification commands when feasible, and report any blocker explicitly.",
	"For review or research tasks, ground findings in concrete file paths, line references, command outputs, URLs, or quoted evidence.",
	"Keep the final response concise: outcome, evidence, verification, and next steps or blockers.",
] as const;

export const WORKFLOW_SUBAGENT_LABEL_PREFIX = "Subagent label:";
export const WORKFLOW_SUBAGENT_TASK_HEADER = "Task:";

export function buildWorkflowAgentInstructions(args: {
	phase?: string;
	agentType?: string;
	model?: string;
	isolation?: string;
	instructions?: string;
	hasSchema: boolean;
}): string | undefined {
	const lines: string[] = [];
	if (args.phase) lines.push(`Workflow phase: ${args.phase}.`);
	if (args.agentType) lines.push(`Act as this subagent type: ${args.agentType}.`);
	if (args.model) lines.push(`Requested model hint: ${args.model}.`);
	if (args.isolation) lines.push(`Requested isolation hint: ${args.isolation}.`);
	if (args.instructions) lines.push(args.instructions);
	if (args.hasSchema) lines.push(...STRUCTURED_OUTPUT_PROMPT_CONTRACT);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

export function buildWorkflowSubagentPrompt(args: {
	prompt: string;
	label?: string;
	instructions?: string;
	wantsStructuredOutput: boolean;
}): string {
	const lines: string[] = [...WORKFLOW_SUBAGENT_BASE_PROMPT];
	if (args.label) lines.push(`${WORKFLOW_SUBAGENT_LABEL_PREFIX} ${args.label}`);
	if (args.instructions) lines.push(args.instructions);
	if (args.wantsStructuredOutput && !includesStructuredOutputContract(args.instructions))
		lines.push(...STRUCTURED_OUTPUT_PROMPT_CONTRACT);
	lines.push("", WORKFLOW_SUBAGENT_TASK_HEADER, args.prompt);
	return lines.join("\n");
}

function includesStructuredOutputContract(instructions?: string): boolean {
	return Boolean(
		instructions?.includes("structured_output") && instructions.includes("parent workflow only receives"),
	);
}

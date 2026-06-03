export type NativeWorkflowMode = "standard" | "quick" | "ultracode";

export const WORKFLOW_PROMPT_INSTRUCTIONS = [
	"Use the workflow tool unless the task is clearly too small or unsuitable for multi-step orchestration.",
	"Generate a deterministic JavaScript workflow that slices the work into clear subagent tasks and returns a JSON-serializable result.",
	"Start the script with literal metadata: export const meta = { name: 'short_snake_case', description: '...', phases: [{ title: '...' }] }; use snake_case, not kebab-case.",
	"Use args for user inputs, validate them near the top, and return JSON-serializable error objects for missing required inputs.",
	"Call phase() before each major group of work and pass { label, phase, schema } to important agent() calls.",
	"Prefer JSON Schema constants for structured subagent outputs, then fan-in with .filter(Boolean) before synthesis.",
	"Use fan-out/fan-in patterns: parallel thunks only for independent work, pipeline for dependent per-item flows, optional adversarial verification, final synthesis.",
	"In each subagent prompt, include repo root/path context, prior findings, constraints, success criteria, verification expectations, and the expected return shape.",
	"For implementation tasks, include test-first/TDD red-green-refactor instructions and drive to working code with relevant tests/builds when feasible.",
	"For review tasks, require finding-first output with severity, file/line evidence, impact, and concrete fix.",
	"Finish implementation workflows with a simplification/refactor phase.",
] as const;

export const MODE_GUIDANCE: Record<NativeWorkflowMode, readonly string[]> = {
	standard: [],
	quick: [
		"Use a concise workflow plan; prefer fewer agents and a lower/smaller budget.",
	],
	ultracode: [
		"Strongly bias toward using the workflow tool unless the task is clearly too small.",
	],
};

export function buildNativeWorkflowPrompt(args: {
	task: string;
	mode: NativeWorkflowMode;
}): string {
	return [
		`Task: ${args.task}`,
		"",
		...WORKFLOW_PROMPT_INSTRUCTIONS,
		...MODE_GUIDANCE[args.mode],
	].join("\n");
}

export type NativeWorkflowInput = {
	text: string;
	source?: "interactive" | "rpc" | "extension";
};

const SPECIAL_TRIGGER = /\b(ultracode|workflow)\b/gi;
export const WORKFLOW_TRIGGER_HIGHLIGHT_START = "\x1b[5;38;2;180;130;255m";
export const WORKFLOW_TRIGGER_HIGHLIGHT_END = "\x1b[25;39m";

export function highlightWorkflowTriggerWords(line: string): string {
	return line.replace(
		SPECIAL_TRIGGER,
		(match) =>
			`${WORKFLOW_TRIGGER_HIGHLIGHT_START}${match}${WORKFLOW_TRIGGER_HIGHLIGHT_END}`,
	);
}

export type NativeWorkflowInputTransform =
	| { action: "continue" }
	| { action: "transform"; text: string };

type NativeWorkflowMode = "standard" | "quick" | "ultracode";

type NativeWorkflowTrigger = {
	mode: NativeWorkflowMode;
	task: string;
};

function matchNativeWorkflowTrigger(
	text: string,
): NativeWorkflowTrigger | undefined {
	const trimmed = text.trim();
	if (trimmed.startsWith("/")) return undefined;

	const quick = /^quick\s+workflow\s+(.+)$/i.exec(trimmed);
	if (quick?.[1]?.trim()) return { mode: "quick", task: quick[1].trim() };

	const ultracode = /^ultracode\s+(.+)$/i.exec(trimmed);
	if (ultracode?.[1]?.trim()) {
		return { mode: "ultracode", task: ultracode[1].trim() };
	}

	const workflow = /^use\s+(?:a\s+)?workflow\s+to\s+(.+)$/i.exec(trimmed);
	if (workflow?.[1]?.trim()) {
		return { mode: "standard", task: workflow[1].trim() };
	}

	return undefined;
}

const WORKFLOW_PROMPT_INSTRUCTIONS = [
	"Decide whether using the workflow tool is appropriate for this task.",
	"If it is, use or generate a deterministic JavaScript workflow that slices the work into clear subagent tasks.",
	"Start the script with literal metadata: export const meta = { name: 'short_snake_case', description: '...', phases: [{ title: '...' }] }; use snake_case, not kebab-case.",
	"Use args for user inputs, validate them near the top, and return JSON-serializable error objects for missing required inputs.",
	"Call phase() before each major group of work and pass { label, phase, schema } to important agent() calls.",
	"Prefer JSON Schema constants for structured subagent outputs, then fan-in with .filter(Boolean) before synthesis.",
	"Use Claude-style fan-out/fan-in patterns: parallel thunks for independent readers, pipeline for per-item flows, optional adversarial verification, final synthesis.",
	"For implementation tasks, include test-first/TDD red-green-refactor instructions.",
	"Finish with a simplification/refactor phase.",
];

const MODE_GUIDANCE: Record<NativeWorkflowMode, string[]> = {
	standard: [],
	quick: [
		"Use a concise workflow plan; prefer fewer agents and a lower/smaller budget.",
	],
	ultracode: [
		"Strongly bias toward using the workflow tool unless the task is clearly too small.",
	],
};

function buildNativeWorkflowPrompt(args: {
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

export function transformNativeWorkflowInput(
	input: NativeWorkflowInput,
): NativeWorkflowInputTransform {
	if (input.source === "extension") return { action: "continue" };

	const trigger = matchNativeWorkflowTrigger(input.text);
	if (!trigger) return { action: "continue" };

	return {
		action: "transform",
		text: buildNativeWorkflowPrompt(trigger),
	};
}

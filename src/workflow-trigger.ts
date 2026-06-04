import { buildNativeWorkflowPrompt, type NativeWorkflowMode } from "./prompts/workflow-trigger.js";

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
		(match) => `${WORKFLOW_TRIGGER_HIGHLIGHT_START}${match}${WORKFLOW_TRIGGER_HIGHLIGHT_END}`,
	);
}

export type NativeWorkflowInputTransform = { action: "continue" } | { action: "transform"; text: string };

type NativeWorkflowTrigger = {
	mode: NativeWorkflowMode;
	task: string;
};

function matchNativeWorkflowTrigger(text: string): NativeWorkflowTrigger | undefined {
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

export function transformNativeWorkflowInput(input: NativeWorkflowInput): NativeWorkflowInputTransform {
	if (input.source === "extension") return { action: "continue" };

	const trigger = matchNativeWorkflowTrigger(input.text);
	if (!trigger) return { action: "continue" };

	return {
		action: "transform",
		text: buildNativeWorkflowPrompt(trigger),
	};
}

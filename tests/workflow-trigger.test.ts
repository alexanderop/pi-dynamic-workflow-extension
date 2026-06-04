import assert from "node:assert/strict";
import { test } from "vitest";
import { buildNativeWorkflowPrompt } from "../src/prompts/workflow-trigger.js";
import {
	highlightWorkflowTriggerWords,
	type NativeWorkflowInputTransform,
	transformNativeWorkflowInput,
	WORKFLOW_TRIGGER_HIGHLIGHT_END,
	WORKFLOW_TRIGGER_HIGHLIGHT_START,
} from "../src/workflow-trigger.js";

function assertTransform(
	result: NativeWorkflowInputTransform,
): asserts result is { action: "transform"; text: string } {
	assert.equal(result.action, "transform");
}

function assertStandardWorkflowPrompt(text: string, task: string): void {
	assert.match(text, new RegExp(task));
	assert.match(text, /workflow tool/i);
	assert.match(text, /deterministic JavaScript workflow/i);
	assert.match(text, /slice/i);
	assert.match(text, /phase\(\)/);
	assert.match(text, /test-first|TDD/i);
	assert.match(text, /simplification|refactor/i);
}

test("native workflow input transforms ultracode tasks into workflow-oriented prompts", () => {
	const result = transformNativeWorkflowInput({
		text: "ultracode add persisted workflow status",
		source: "interactive",
	});

	assertTransform(result);
	assertStandardWorkflowPrompt(result.text, "add persisted workflow status");
});

test("native workflow input transforms quick workflow tasks with smaller budget guidance", () => {
	const result = transformNativeWorkflowInput({
		text: "quick workflow compare parser alternatives",
		source: "interactive",
	});

	assertTransform(result);
	assertStandardWorkflowPrompt(result.text, "compare parser alternatives");
	assert.match(result.text, /fewer agents|lower budget|smaller budget/i);
	assert.match(result.text, /concise workflow plan/i);
});

test("native workflow input transforms use workflow phrasing", () => {
	const withArticle = transformNativeWorkflowInput({
		text: "use a workflow to audit extension event handling",
		source: "rpc",
	});
	assertTransform(withArticle);
	assertStandardWorkflowPrompt(withArticle.text, "audit extension event handling");

	const withoutArticle = transformNativeWorkflowInput({
		text: "use workflow to write regression tests",
		source: "interactive",
	});
	assertTransform(withoutArticle);
	assertStandardWorkflowPrompt(withoutArticle.text, "write regression tests");
});

test("native workflow prompt tells the agent to yield after background launch", () => {
	const prompt = buildNativeWorkflowPrompt({
		task: "audit the repo",
		mode: "standard",
	});

	assert.ok(prompt.includes("After launching a background workflow"));
	assert.ok(prompt.includes("end your turn and yield control"));
	assert.ok(prompt.includes("If the user says nothing, stay idle"));
	assert.ok(prompt.includes("workflow-completion"));
});

test("native workflow input ignores extension-injected trigger text", () => {
	assert.deepEqual(
		transformNativeWorkflowInput({
			text: "ultracode summarize completed workflow",
			source: "extension",
		}),
		{ action: "continue" },
	);
});

test("native workflow input leaves non-trigger text unchanged", () => {
	assert.deepEqual(
		transformNativeWorkflowInput({
			text: "please help me debug this failing test",
			source: "interactive",
		}),
		{ action: "continue" },
	);
});

test("native workflow input leaves slash commands unchanged", () => {
	assert.deepEqual(
		transformNativeWorkflowInput({
			text: "/workflow ultracode add a feature",
			source: "interactive",
		}),
		{ action: "continue" },
	);
});

test("workflow trigger words render with purple terminal blink ANSI styling", () => {
	const highlighted = highlightWorkflowTriggerWords("ultracode this with a quick workflow");

	assert.equal(
		highlighted,
		`${WORKFLOW_TRIGGER_HIGHLIGHT_START}ultracode${WORKFLOW_TRIGGER_HIGHLIGHT_END} this with a quick ${WORKFLOW_TRIGGER_HIGHLIGHT_START}workflow${WORKFLOW_TRIGGER_HIGHLIGHT_END}`,
	);
	assert.ok(highlighted.includes(WORKFLOW_TRIGGER_HIGHLIGHT_START));
	assert.ok(highlighted.includes(WORKFLOW_TRIGGER_HIGHLIGHT_END));
});

test("workflow trigger highlighting respects word boundaries", () => {
	assert.equal(
		highlightWorkflowTriggerWords("myworkflow ultracoder workflow"),
		`myworkflow ultracoder ${WORKFLOW_TRIGGER_HIGHLIGHT_START}workflow${WORKFLOW_TRIGGER_HIGHLIGHT_END}`,
	);
});

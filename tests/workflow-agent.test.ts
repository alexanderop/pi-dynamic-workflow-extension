import assert from "node:assert/strict";
import { test } from "vitest";
import { runWorkflowAgentPrompts, type WorkflowAgentPromptSession } from "../src/agent.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../src/prompts/structured-output.js";
import type { StructuredOutputCapture } from "../src/structured-output.js";

function fakeSession(onPrompt: (prompt: string, count: number) => void | Promise<void>): WorkflowAgentPromptSession & {
	prompts: string[];
	activeToolSets: string[][];
} {
	const prompts: string[] = [];
	const activeToolSets: string[][] = [];
	return {
		prompts,
		activeToolSets,
		async prompt(prompt: string) {
			prompts.push(prompt);
			await onPrompt(prompt, prompts.length);
		},
		setActiveToolsByName(toolNames: string[]) {
			activeToolSets.push(toolNames);
		},
	};
}

test("WorkflowAgent retries once with only structured_output active when it was omitted", async () => {
	const capture: StructuredOutputCapture = { called: false };
	const session = fakeSession((_prompt, count) => {
		if (count === 2) {
			capture.called = true;
			capture.value = { ok: true };
		}
	});

	await runWorkflowAgentPrompts({
		session,
		initialPrompt: "verify finding",
		wantsStructuredOutput: true,
		capture,
	});

	assert.deepEqual(capture.value, { ok: true });
	assert.equal(session.prompts.length, 2);
	assert.match(session.prompts[0] ?? "", /verify finding/);
	assert.match(session.prompts[1] ?? "", /finished without calling structured_output/i);
	assert.match(session.prompts[1] ?? "", /exactly one structured_output/i);
	assert.deepEqual(session.activeToolSets, [[STRUCTURED_OUTPUT_TOOL_NAME]]);
});

test("WorkflowAgent repair leaves capture unset when structured_output is ignored", async () => {
	const capture: StructuredOutputCapture = { called: false };
	const session = fakeSession(() => {});

	await runWorkflowAgentPrompts({
		session,
		initialPrompt: "verify finding",
		wantsStructuredOutput: true,
		capture,
	});

	assert.equal(capture.called, false);
	assert.equal(session.prompts.length, 2);
	assert.deepEqual(session.activeToolSets, [[STRUCTURED_OUTPUT_TOOL_NAME]]);
});

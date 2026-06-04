import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { runWorkflowAgentPrompts, WorkflowAgent, type WorkflowAgentPromptSession } from "../../src/agent.js";
import { STRUCTURED_OUTPUT_TOOL_NAME } from "../../src/prompts/structured-output.js";
import type { StructuredOutputCapture } from "../../src/structured-output.js";
import {
	createFauxWorkflowSessionHarness,
	type FauxWorkflowSessionHarness,
	fauxAssistantMessage,
	fauxToolCall,
} from "./harness.js";

let harness: FauxWorkflowSessionHarness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

function fauxPromptSession(onPrompt: (prompt: string, count: number) => void): WorkflowAgentPromptSession & {
	prompts: string[];
	activeToolSets: string[][];
} {
	const prompts: string[] = [];
	const activeToolSets: string[][] = [];
	return {
		prompts,
		activeToolSets,
		async prompt(prompt) {
			prompts.push(prompt);
			onPrompt(prompt, prompts.length);
		},
		setActiveToolsByName(toolNames) {
			activeToolSets.push(toolNames);
		},
	};
}

test("structured output captured by the faux workflow-agent session ends without repair", async () => {
	const capture: StructuredOutputCapture = { called: false };
	const session = fauxPromptSession((_prompt, count) => {
		if (count === 1) {
			capture.called = true;
			capture.value = { verdict: "ok" };
		}
	});

	await runWorkflowAgentPrompts({
		session,
		initialPrompt: "return a verdict",
		wantsStructuredOutput: true,
		capture,
	});

	assert.deepEqual(capture.value, { verdict: "ok" });
	assert.equal(session.prompts.length, 1);
	assert.deepEqual(session.activeToolSets, []);
});

test("missing structured output triggers exactly one repair turn", async () => {
	const capture: StructuredOutputCapture = { called: false };
	const session = fauxPromptSession((_prompt, count) => {
		if (count === 2) {
			capture.called = true;
			capture.value = { repaired: true };
		}
	});

	await runWorkflowAgentPrompts({
		session,
		initialPrompt: "return a verdict",
		wantsStructuredOutput: true,
		capture,
	});

	assert.deepEqual(capture.value, { repaired: true });
	assert.equal(session.prompts.length, 2);
	assert.deepEqual(session.activeToolSets, [[STRUCTURED_OUTPUT_TOOL_NAME]]);
});

test("WorkflowAgent runs a real Pi session through the faux provider", async () => {
	harness = await createFauxWorkflowSessionHarness({
		responses: [fauxAssistantMessage("faux reply")],
	});
	const agent = new WorkflowAgent({ cwd: harness.cwd, session: harness.session });

	const result = await agent.run("say hello");

	assert.equal(result, "faux reply");
	assert.equal(harness.faux.getPendingResponseCount(), 0);
});

test("WorkflowAgent captures structured output from a faux provider tool call", async () => {
	harness = await createFauxWorkflowSessionHarness({
		responses: [
			fauxAssistantMessage(fauxToolCall(STRUCTURED_OUTPUT_TOOL_NAME, { verdict: "ok" }), {
				stopReason: "toolUse",
			}),
		],
	});
	const agent = new WorkflowAgent({ cwd: harness.cwd, session: harness.session });

	const result = await agent.run("return a verdict", {
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["verdict"],
			properties: { verdict: { type: "string" } },
		},
	});

	assert.deepEqual(result, { verdict: "ok" });
	assert.equal(harness.faux.getPendingResponseCount(), 0);
});

test("WorkflowAgent repairs a faux provider structured-output omission exactly once", async () => {
	harness = await createFauxWorkflowSessionHarness({
		responses: [
			fauxAssistantMessage("I forgot the tool call."),
			fauxAssistantMessage(fauxToolCall(STRUCTURED_OUTPUT_TOOL_NAME, { repaired: true }), {
				stopReason: "toolUse",
			}),
		],
	});
	const agent = new WorkflowAgent({ cwd: harness.cwd, session: harness.session });
	const activity: string[] = [];

	const result = await agent.run("return a verdict", {
		onActivity(event) {
			if (event.type === "log" && event.text) activity.push(event.text);
		},
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["repaired"],
			properties: { repaired: { type: "boolean" } },
		},
	});

	assert.deepEqual(result, { repaired: true });
	assert.equal(harness.faux.state.callCount, 2);
	assert.equal(harness.faux.getPendingResponseCount(), 0);
	assert.equal(activity.filter((message) => message.includes("omitted structured_output")).length, 1);
});

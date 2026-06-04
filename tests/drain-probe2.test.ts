import assert from "node:assert/strict";
import { test } from "vitest";
import {
	runWorkflow,
	type WorkflowAgentLike,
	type WorkflowJournal,
} from "/Users/alexanderopalic/Projects/mypiextension/src/workflow.js";

test("probe2: agent in-flight when runWorkflow settles", async () => {
	let agentSettled = false;
	const journal: WorkflowJournal = {
		getResult: () => undefined,
		appendStarted: () => {},
		appendResult: () => {},
	};
	const agent: WorkflowAgentLike = {
		async run(prompt) {
			await new Promise((r) => setTimeout(r, 60));
			agentSettled = true;
			return `live:${prompt}`;
		},
	};
	const script = `export const meta = { name: 'drain_probe2', description: 'd' }
return await agent('slow')
`;
	await assert.rejects(runWorkflow(script, { agent, journal, timeoutMs: 20 }));
	console.log("AGENT_SETTLED_AT_REJECT", agentSettled);
});

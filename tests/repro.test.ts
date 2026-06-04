import assert from "node:assert/strict";
import { test } from "vitest";
import { createInMemoryWorkflowJournal, runWorkflow, type WorkflowAgentLike } from "../src/workflow.js";

test("pipeline non-index resolution replay", async () => {
	const journal = createInMemoryWorkflowJournal();
	let calls = 0;
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			calls++;
			if (prompt.startsWith("stage1")) {
				const delay = prompt.endsWith("a") ? 20 : 1;
				await new Promise((r) => setTimeout(r, delay));
			}
			return `r:${prompt}`;
		},
	};
	const script = `export const meta = { name: 'pipe_demo', description: 'd' }
const out = await pipeline(
  ['a', 'b'],
  (item) => agent('stage1 ' + item),
  (s, item) => agent('stage2 ' + item + ':' + s)
)
return out
`;
	await runWorkflow(script, { agent, journal, concurrency: 4 });
	const firstCalls = calls;
	console.log("first run calls:", firstCalls);
	await runWorkflow(script, { agent, journal, concurrency: 4 });
	console.log("second run calls:", calls, "(delta:", calls - firstCalls, ")");
	assert.equal(calls, firstCalls, "replay should reuse all cached results");
});

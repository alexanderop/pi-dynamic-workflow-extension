import assert from "node:assert/strict";
import { test } from "vitest";
import {
	runWorkflow,
	type WorkflowAgentLike,
	type WorkflowJournal,
} from "/Users/alexanderopalic/Projects/mypiextension/src/workflow.js";

test("probe: journal writes after reject", async () => {
	const writes: { when: number; key: string }[] = [];
	let settled = -1;
	const journal: WorkflowJournal = {
		getResult: () => undefined,
		appendStarted: () => {},
		appendResult: (r) => {
			writes.push({ when: Date.now(), key: r.key });
		},
	};
	let release: (() => void) | undefined;
	const agent: WorkflowAgentLike = {
		run(prompt) {
			return new Promise((resolve) => {
				release = () => resolve(`live:${prompt}`);
			});
		},
	};
	const script = `export const meta = { name: 'drain_probe', description: 'd' }
return await agent('slow')
`;
	const p = runWorkflow(script, { agent, journal, timeoutMs: 20 });
	await assert.rejects(p);
	settled = Date.now();
	// now release the slow agent AFTER the workflow already rejected
	release?.();
	await new Promise((r) => setTimeout(r, 50));
	console.log("WRITES_AFTER_SETTLE", writes.filter((w) => w.when >= settled).length, "TOTAL", writes.length);
});

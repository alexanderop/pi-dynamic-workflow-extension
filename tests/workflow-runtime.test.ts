import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, type WorkflowAgentLike } from "../src/workflow.js";

const fakeAgent: WorkflowAgentLike = {
	async run(prompt: string): Promise<string> {
		return `result:${prompt}`;
	},
};

test("runWorkflow executes an agent with runtime phases", async () => {
	const result = await runWorkflow(
		`export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
		{ agent: fakeAgent },
	);

	assert.deepEqual(result.phases, ["Scan"]);
	assert.equal(result.agentCount, 1);
	assert.deepEqual(result.result, { scan: "result:scan" });
});

test("runWorkflow supports parallel thunks in input order", async () => {
	const result = await runWorkflow(
		`export const meta = { name: 'parallel_demo', description: 'demo' }
phase('Check')
const items = ['a', 'b', 'c']
const out = await parallel(items.map(item => () => agent('check ' + item)))
return out
`,
		{ agent: fakeAgent, concurrency: 2 },
	);

	assert.deepEqual(result.result, [
		"result:check a",
		"result:check b",
		"result:check c",
	]);
	assert.equal(result.agentCount, 3);
});

test("runWorkflow supports pipeline stages", async () => {
	const result = await runWorkflow(
		`export const meta = { name: 'pipeline_demo', description: 'demo' }
const out = await pipeline(
  ['a', 'b'],
  (item) => agent('inspect ' + item),
  (inspection, item) => agent('summarize ' + item + ': ' + inspection)
)
return out
`,
		{ agent: fakeAgent, concurrency: 2 },
	);

	assert.deepEqual(result.result, [
		"result:summarize a: result:inspect a",
		"result:summarize b: result:inspect b",
	]);
});

test("runWorkflow rejects forgotten awaits in the returned result", async () => {
	await assert.rejects(
		() =>
			runWorkflow(
				`export const meta = { name: 'forgot_await', description: 'demo' }
const scan = agent('scan')
return { scan }
`,
				{ agent: fakeAgent },
			),
		/did you forget to await/,
	);
});

test("runWorkflow reports conditional runtime phases only", async () => {
	const result = await runWorkflow(
		`export const meta = {
  name: 'conditional_demo',
  description: 'demo',
  phases: [{ title: 'Skipped' }, { title: 'Inspect API' }, { title: 'Inspect UI' }]
}
phase('Inspect API')
await agent('api')
if (args.includeUi) {
  phase('Inspect UI')
  await agent('ui')
}
return { ok: true }
`,
		{ agent: fakeAgent, args: { includeUi: true } },
	);

	assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
});

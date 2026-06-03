import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createFileWorkflowJournal,
	createInMemoryWorkflowJournal,
	runWorkflow,
	type WorkflowAgentLike,
} from "../src/workflow.js";

test("runWorkflow reuses journaled agent results on an unchanged rerun", async () => {
	const journal = createInMemoryWorkflowJournal();
	let calls = 0;
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			calls++;
			return `live:${prompt}`;
		},
	};
	const script = `export const meta = { name: 'resume_demo', description: 'demo' }
const first = await agent('first', { label: 'ignored by key' })
const second = await agent('second')
return { first, second }
`;

	const firstRun = await runWorkflow(script, { agent, journal });
	assert.deepEqual(firstRun.result, {
		first: "live:first",
		second: "live:second",
	});
	assert.equal(calls, 2);

	const secondRun = await runWorkflow(script, { agent, journal });
	assert.deepEqual(secondRun.result, firstRun.result);
	assert.equal(calls, 2);
	assert.equal(secondRun.agentCount, 2);
});

test("runWorkflow resumes only the longest unchanged journal prefix", async () => {
	const journal = createInMemoryWorkflowJournal();
	const livePrompts: string[] = [];
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			livePrompts.push(prompt);
			return `live:${prompt}`;
		},
	};

	await runWorkflow(
		`export const meta = { name: 'prefix_demo', description: 'demo' }
const first = await agent('same', { label: 'old label' })
const second = await agent('before edit')
const third = await agent('same tail')
return { first, second, third }
`,
		{ agent, journal },
	);
	assert.deepEqual(livePrompts, ["same", "before edit", "same tail"]);

	const rerun = await runWorkflow(
		`export const meta = { name: 'prefix_demo', description: 'demo' }
const first = await agent('same', { label: 'renamed label' })
const second = await agent('after edit')
const third = await agent('same tail')
return { first, second, third }
`,
		{ agent, journal },
	);

	assert.deepEqual(rerun.result, {
		first: "live:same",
		second: "live:after edit",
		third: "live:same tail",
	});
	assert.deepEqual(livePrompts, [
		"same",
		"before edit",
		"same tail",
		"after edit",
		"same tail",
	]);
});

test("runWorkflow reuses undefined journaled results", async () => {
	const journal = createInMemoryWorkflowJournal();
	let calls = 0;
	const agent: WorkflowAgentLike = {
		async run(): Promise<undefined> {
			calls++;
			return undefined;
		},
	};
	const script = `export const meta = { name: 'undefined_journal_demo', description: 'demo' }
await agent('undefined result')
return 'ok'
`;

	await runWorkflow(script, { agent, journal });
	await runWorkflow(script, { agent, journal });

	assert.equal(calls, 1);
});

test("runWorkflow does not reuse text results for present undefined schemas", async () => {
	const journal = createInMemoryWorkflowJournal();
	let calls = 0;
	const agent: WorkflowAgentLike = {
		async run(_prompt, options): Promise<unknown> {
			calls++;
			return Object.hasOwn(options ?? {}, "schema")
				? { summary: "structured" }
				: "plain text";
		},
	};

	const textScript = `export const meta = { name: 'schema_presence_journal_demo', description: 'demo' }
return await agent('same prompt')
`;
	const structuredScript = `export const meta = { name: 'schema_presence_journal_demo', description: 'demo' }
return await agent('same prompt', { schema: undefined })
`;

	const textRun = await runWorkflow(textScript, { agent, journal });
	const structuredRun = await runWorkflow(structuredScript, { agent, journal });

	assert.equal(textRun.result, "plain text");
	assert.deepEqual(structuredRun.result, { summary: "structured" });
	assert.equal(calls, 2);
});

test("runWorkflow can resume from a persisted journal file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
	const journalPath = join(dir, "journal.jsonl");
	let calls = 0;
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			calls++;
			return `persisted:${prompt}`;
		},
	};
	const script = `export const meta = { name: 'file_journal_demo', description: 'demo' }
return await agent('durable')
`;

	await runWorkflow(script, {
		agent,
		journal: createFileWorkflowJournal(journalPath),
	});
	const replay = await runWorkflow(script, {
		agent,
		journal: createFileWorkflowJournal(journalPath),
	});

	assert.equal(replay.result, "persisted:durable");
	assert.equal(calls, 1);
});

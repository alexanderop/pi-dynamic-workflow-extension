import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createFileWorkflowStore,
	createWorkflowManager,
	type WorkflowAgentLike,
	type WorkflowJob,
} from "../src/index.js";

async function waitForFinished(job: WorkflowJob): Promise<void> {
	while (job.status === "running")
		await new Promise((resolve) => setTimeout(resolve, 5));
}

test("WorkflowManager persists completed jobs and restores them for dashboards", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-store-"));
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			return `done:${prompt}`;
		},
	};
	const store = createFileWorkflowStore(dir);
	const manager = createWorkflowManager({ store });
	const job = manager.start(
		`export const meta = { name: 'persist_jobs', description: 'demo' }
const answer = await agent('inspect')
return { answer }
`,
		{ agent },
	);

	await waitForFinished(job);

	const restored = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});
	const jobs = restored.getJobs();
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0]?.status, "done");
	assert.deepEqual(jobs[0]?.result, { answer: "done:inspect" });
	assert.equal(jobs[0]?.snapshot.doneCount, 1);
});

test("WorkflowManager saves a reusable workflow script file when triggered", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-script-"));
	const script = `export const meta = { name: 'visible_script', description: 'demo' }
return await agent('inspect')
`;
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			return `done:${prompt}`;
		},
	};
	const manager = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});
	const job = manager.start(script, { agent });
	await waitForFinished(job);

	assert.equal(
		job.scriptPath,
		join(dir, "scripts", "visible_script.workflow.js"),
	);
	assert.equal(await readFile(job.scriptPath, "utf8"), script);
});

test("WorkflowManager interrupts running jobs without marking them cancelled", async () => {
	const agent: WorkflowAgentLike = {
		async run(): Promise<string> {
			return new Promise<string>(() => {});
		},
	};
	const manager = createWorkflowManager();
	const job = manager.start(
		`export const meta = { name: 'interrupt_jobs', description: 'demo' }
return await agent('inspect')
`,
		{ agent },
	);

	while (job.snapshot.agents.length === 0)
		await new Promise((resolve) => setTimeout(resolve, 5));

	assert.equal(manager.interrupt(job.id), true);
	assert.equal(job.status, "interrupted");
	assert.equal(manager.interrupt(job.id), false);
});

test("WorkflowManager can resume a restored job from its journal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-resume-"));
	let calls = 0;
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			calls++;
			return `cached:${prompt}`;
		},
	};
	const script = `export const meta = { name: 'resume_jobs', description: 'demo' }
return await agent('inspect')
`;
	const manager = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});
	const original = manager.start(script, { agent });
	await waitForFinished(original);
	assert.equal(calls, 1);

	const restored = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});
	const resumed = restored.resume(original.id, { agent });
	assert.ok(resumed);
	await waitForFinished(resumed);

	assert.equal(resumed.status, "done");
	assert.equal(resumed.result, "cached:inspect");
	assert.equal(calls, 1);
});

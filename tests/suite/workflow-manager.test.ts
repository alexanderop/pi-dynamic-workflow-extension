import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "vitest";
import {
	createFileWorkflowStore,
	createWorkflowManager,
	type WorkflowAgentLike,
	type WorkflowJob,
} from "../../src/index.js";
import { waitForCondition } from "../support/wait.js";

async function waitForFinished(job: WorkflowJob): Promise<void> {
	await waitForCondition(() => job.status !== "running", "timed out waiting for workflow job to finish", {
		describe: () => `status=${job.status}; error=${job.error ?? "none"}`,
	});
}

async function waitForSettled(job: WorkflowJob): Promise<void> {
	await waitForCondition(() => job.finishedAt !== undefined, "timed out waiting for workflow job to settle", {
		timeoutMs: 500,
		describe: () => `status=${job.status}; error=${job.error ?? "none"}`,
	});
}

async function waitForAgentStarted(job: WorkflowJob): Promise<void> {
	await waitForCondition(() => job.snapshot.agents.length > 0, "timed out waiting for workflow agent to start", {
		describe: () => `status=${job.status}; agents=${job.snapshot.agents.length}`,
	});
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

test("WorkflowManager persists workflow artifacts in restored job snapshots", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-artifacts-"));
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			return `done:${prompt}`;
		},
	};
	const store = createFileWorkflowStore(dir);
	const manager = createWorkflowManager({ store });
	const job = manager.start(
		`export const meta = { name: 'persist_artifacts', description: 'demo' }
artifact('review.md', '# Review', { type: 'markdown', description: 'Report' })
return await agent('inspect')
`,
		{ agent },
	);

	await waitForFinished(job);

	const restored = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});
	const jobs = restored.getJobs();
	assert.deepEqual(jobs[0]?.snapshot.artifacts, [
		{
			name: "review.md",
			type: "markdown",
			description: "Report",
			value: "# Review",
		},
	]);
});

test("WorkflowManager skips corrupt persisted workflow manifests", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-corrupt-"));
	const runDir = join(dir, "wf_corrupt");
	await mkdir(runDir, { recursive: true });
	await writeFile(join(runDir, "manifest.json"), "{ not valid json", "utf8");

	const manager = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});

	assert.deepEqual(manager.getJobs(), []);
});

test("WorkflowManager skips persisted workflow manifests with invalid status", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-status-"));
	const runDir = join(dir, "wf_bad_status");
	await mkdir(runDir, { recursive: true });
	await writeFile(
		join(runDir, "manifest.json"),
		JSON.stringify({
			id: 1,
			runId: "wf_bad_status",
			name: "bad_status",
			status: "paused",
			script: "export const meta = { name: 'bad_status', description: 'demo' }\nreturn null\n",
			snapshot: { phases: [], logs: [], agents: [] },
			startedAt: 1,
		}),
		"utf8",
	);

	const manager = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});

	assert.deepEqual(manager.getJobs(), []);
});

test("WorkflowManager skips persisted manifests whose runId does not match their directory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-runid-match-"));
	const runDir = join(dir, "wf_container");
	await mkdir(runDir, { recursive: true });
	await writeFile(
		join(runDir, "manifest.json"),
		JSON.stringify({
			id: 1,
			runId: "wf_other",
			name: "wrong_runid",
			status: "done",
			script: "export const meta = { name: 'wrong_runid', description: 'demo' }\nreturn null\n",
			snapshot: { phases: [], logs: [], agents: [] },
			startedAt: 1,
		}),
		"utf8",
	);

	const manager = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});

	assert.deepEqual(manager.getJobs(), []);
});

test("WorkflowManager skips persisted manifests with unsafe run IDs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-unsafe-load-"));
	const runDir = join(dir, "wf_unsafe_manifest");
	const escapeName = `escape_${basename(dir)}`;
	await mkdir(runDir, { recursive: true });
	await writeFile(
		join(runDir, "manifest.json"),
		JSON.stringify({
			id: 1,
			runId: `../${escapeName}`,
			name: "unsafe_load",
			status: "done",
			script: "export const meta = { name: 'unsafe_load', description: 'demo' }\nreturn null\n",
			snapshot: { phases: [], logs: [], agents: [] },
			startedAt: 1,
		}),
		"utf8",
	);

	const manager = createWorkflowManager({
		store: createFileWorkflowStore(dir),
	});

	assert.deepEqual(manager.getJobs(), []);
	await assert.rejects(access(join(dir, "..", escapeName, "manifest.json")));
});

test("file workflow store rejects unsafe run IDs when saving jobs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-unsafe-save-"));
	const store = createFileWorkflowStore(dir);
	const escapeName = `escape_${basename(dir)}`;
	const job: WorkflowJob = {
		id: 1,
		runId: `../${escapeName}`,
		name: "unsafe_save",
		status: "done",
		script: "export const meta = { name: 'unsafe_save', description: 'demo' }\nreturn null\n",
		snapshot: { phases: [], logs: [], agents: [] },
		startedAt: 1,
	};

	assert.throws(() => store.saveJob(job), /unsafe workflow runId/);
	await assert.rejects(access(join(dir, "..", escapeName, "manifest.json")));
});

test("file workflow store rejects unsafe run IDs when creating journals", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-unsafe-journal-"));
	const store = createFileWorkflowStore(dir);
	const escapeName = `escape_${basename(dir)}`;

	assert.throws(() => store.createJournal(`../${escapeName}`), /unsafe workflow runId/);
	await assert.rejects(access(join(dir, "..", escapeName, "journal.jsonl")));
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

	assert.equal(job.scriptPath, join(dir, "scripts", "visible_script.workflow.js"));
	assert.equal(await readFile(job.scriptPath, "utf8"), script);
});

test("WorkflowManager cancels never-resolving workflows as settled jobs", async () => {
	const agent: WorkflowAgentLike = {
		async run(): Promise<string> {
			return new Promise<string>(() => {});
		},
	};
	const manager = createWorkflowManager();
	const job = manager.start(
		`export const meta = { name: 'cancel_never_resolves', description: 'demo' }
return await agent('inspect')
`,
		{ agent },
	);

	await waitForAgentStarted(job);

	assert.equal(manager.cancel(job.id), true);
	await waitForSettled(job);

	assert.equal(job.status, "cancelled");
	assert.equal(job.error, "Workflow was cancelled");
	assert.equal(manager.cancel(job.id), false);
	assert.equal(
		job.snapshot.agents.some((agent) => agent.status === "running" || agent.status === "queued"),
		false,
	);
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

	await waitForAgentStarted(job);

	assert.equal(manager.interrupt(job.id), true);
	await waitForSettled(job);

	assert.equal(job.status, "interrupted");
	assert.equal(job.error, "Workflow was interrupted");
	assert.equal(manager.interrupt(job.id), false);
	assert.equal(
		job.snapshot.agents.some((agent) => agent.status === "running" || agent.status === "queued"),
		false,
	);
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

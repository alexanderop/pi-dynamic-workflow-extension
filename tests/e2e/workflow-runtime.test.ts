import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "vitest";

interface WorkflowRuntimeE2EState {
	toolResultText?: string;
	job: {
		id: number;
		runId: string;
		name: string;
		description?: string;
		status: string;
		scriptPath?: string;
		args?: unknown;
		result?: unknown;
		error?: string;
		snapshot: {
			name: string;
			phases: string[];
			logs: string[];
			doneCount: number;
			errorCount: number;
			result?: unknown;
			artifacts?: Array<{ name: string; type: string; description?: string; value: unknown }>;
			agents: Array<{
				label?: string;
				phase?: string;
				prompt: string;
				status: string;
				resultPreview?: string;
				resultText?: string;
			}>;
		};
	};
	agentCalls: Array<{ prompt: string; options?: { label?: string; phase?: string } }>;
	persistence: {
		manifestPath: string;
		manifestExists: boolean;
		manifestJobStatus?: string;
		journalPath: string;
		journalExists: boolean;
		scriptPath?: string;
		scriptExists: boolean;
	};
}

function runPiWorkflowRuntimeE2E(options: {
	cwd: string;
	outputPath: string;
	globalWorkflowsDir: string;
}): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolveRun, reject) => {
		const probePath = resolve(process.cwd(), "tests/e2e/workflow-runtime-probe.ts");
		const child = spawn(
			"pi",
			["--mode", "json", "--no-session", "--no-extensions", "-e", probePath, "/e2e-run-workflow"],
			{
				cwd: options.cwd,
				env: {
					...process.env,
					PI_E2E_OUT: options.outputPath,
					PI_E2E_GLOBAL_WORKFLOWS: options.globalWorkflowsDir,
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);

		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) => resolveRun({ code, stderr }));
	});
}

function assertInsideTemp(path: string | undefined, tempDir: string, label: string): void {
	assert.equal(typeof path, "string", `${label} should be recorded`);
	assert.ok(isAbsolute(path), `${label} should be absolute`);
	assert.ok(path.startsWith(`${tempDir}/`), `${label} should stay inside the e2e temp dir: ${path}`);
}

test("Pi runs a deterministic background workflow end-to-end in a temp project", async () => {
	const rawDir = await mkdtemp(join(tmpdir(), "pi-workflow-runtime-e2e-"));
	const dir = await realpath(rawDir);
	const outputPath = join(dir, "runtime-state.json");
	const globalWorkflowsDir = join(dir, "global-workflows");

	try {
		const result = await runPiWorkflowRuntimeE2E({ cwd: dir, outputPath, globalWorkflowsDir });
		assert.equal(result.code, 0, result.stderr);

		const state = JSON.parse(await readFile(outputPath, "utf8")) as WorkflowRuntimeE2EState;

		assert.match(state.toolResultText ?? "", /Workflow e2e_runtime started in the background as #1/);
		assert.equal(state.job.id, 1);
		assert.equal(state.job.name, "e2e_runtime");
		assert.equal(state.job.description, "Runtime end-to-end workflow");
		assert.equal(state.job.status, "done", state.job.error);
		assert.deepEqual(state.job.args, { subject: "tmp-project" });
		assert.deepEqual(state.job.result, { ok: true, answer: "agent-ok", subject: "tmp-project" });

		assert.equal(state.agentCalls.length, 1);
		assert.equal(state.agentCalls[0]?.prompt, "inspect tmp-project");
		assert.equal(state.agentCalls[0]?.options?.label, "worker");

		assert.equal(state.job.snapshot.name, "e2e_runtime");
		assert.deepEqual(state.job.snapshot.phases, ["Run"]);
		assert.ok(state.job.snapshot.logs.includes("started"));
		assert.equal(state.job.snapshot.doneCount, 1);
		assert.equal(state.job.snapshot.errorCount, 0);
		assert.deepEqual(state.job.snapshot.result, state.job.result);
		assert.deepEqual(state.job.snapshot.artifacts, [
			{
				name: "report.md",
				type: "markdown",
				description: "E2E report",
				value: "# E2E OK",
			},
		]);
		assert.equal(state.job.snapshot.agents.length, 1);
		assert.equal(state.job.snapshot.agents[0]?.label, "worker");
		assert.equal(state.job.snapshot.agents[0]?.phase, "Run");
		assert.equal(state.job.snapshot.agents[0]?.status, "done");
		assert.equal(state.job.snapshot.agents[0]?.prompt, "inspect tmp-project");
		assert.equal(state.job.snapshot.agents[0]?.resultText, "agent-ok");

		assert.equal(state.persistence.manifestExists, true);
		assert.equal(state.persistence.manifestJobStatus, "done");
		assert.equal(state.persistence.journalExists, true);
		assert.equal(state.persistence.scriptExists, true);
		assertInsideTemp(state.persistence.manifestPath, dir, "manifest path");
		assertInsideTemp(state.persistence.journalPath, dir, "journal path");
		assertInsideTemp(state.persistence.scriptPath, dir, "script path");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

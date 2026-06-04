import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";

interface LiveWorkflowRuntimeE2EState {
	stage?: string;
	model?: unknown;
	toolRegistered?: boolean;
	activeTools?: string[];
	workflowToolCallCount?: number;
	workflowToolEnded?: boolean;
	workflowToolError?: boolean;
	toolResultText?: string;
	error?: string;
	job?: {
		id: number;
		runId: string;
		name: string;
		description?: string;
		status: string;
		error?: string;
		result?: unknown;
		snapshot?: {
			phases?: string[];
			logs?: string[];
			agents?: Array<{
				label?: string;
				phase?: string;
				status?: string;
				prompt?: string;
				resultText?: string;
				error?: string;
			}>;
		};
	};
}

function runPiLiveWorkflowRuntimeE2E(options: {
	cwd: string;
	outputPath: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolveRun, reject) => {
		const extensionPath = resolve(process.cwd(), "extensions/workflow.ts");
		const probePath = resolve(process.cwd(), "tests/e2e/workflow-runtime-live-probe.ts");
		const args = ["--mode", "json", "--no-session", "--no-extensions", "-e", extensionPath, "-e", probePath];
		const model = process.env.PI_E2E_LIVE_MODEL?.trim();
		if (model) args.push("--model", model);
		args.push("pi-workflow-live-e2e");

		const child = spawn("pi", args, {
			cwd: options.cwd,
			env: {
				...process.env,
				PI_E2E_OUT: options.outputPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) => resolveRun({ code, stdout, stderr }));
	});
}

const shouldRunLive = process.env.PI_E2E_LIVE === "1" && !process.env.CI;

// This is intentionally a real automated E2E path, not a direct unit-style call to
// createWorkflowTool().execute(). It launches the Pi CLI, loads the extension,
// sends a user prompt to a locally authenticated real model, observes that the
// model calls the registered workflow tool, then waits for the background
// workflow and its live subagent call to finish via persisted workflow state.
test.skipIf(!shouldRunLive)(
	"Pi runs the workflow extension with a real locally-authenticated model",
	async () => {
		const rawDir = await mkdtemp(join(tmpdir(), "pi-workflow-live-e2e-"));
		const dir = await realpath(rawDir);
		const outputPath = join(dir, "live-runtime-state.json");

		try {
			const result = await runPiLiveWorkflowRuntimeE2E({ cwd: dir, outputPath });
			assert.equal(result.code, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
			assert.doesNotMatch(result.stderr, /Extension error/i, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
			assert.ok(
				existsSync(outputPath),
				`expected live probe to write ${outputPath}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
			);

			const state = JSON.parse(await readFile(outputPath, "utf8")) as LiveWorkflowRuntimeE2EState;
			assert.equal(state.stage, "done", state.error ?? JSON.stringify(state));
			assert.equal(state.toolRegistered, true);
			assert.equal(state.workflowToolCallCount, 1, JSON.stringify(state));
			assert.equal(state.workflowToolEnded, true, JSON.stringify(state));
			assert.equal(state.workflowToolError, false, JSON.stringify(state));
			assert.match(state.toolResultText ?? "", /Workflow e2e_live_runtime started in the background as #1/);
			assert.ok(state.job, JSON.stringify(state));
			assert.equal(state.job.id, 1);
			assert.equal(state.job.name, "e2e_live_runtime");
			assert.equal(state.job.description, "Live API end-to-end workflow");
			assert.equal(state.job.status, "done", state.job.error);

			const workflowResult = state.job.result as { ok?: unknown; answer?: { status?: unknown } } | undefined;
			assert.equal(workflowResult?.ok, true, JSON.stringify(workflowResult));
			const liveStatus = workflowResult?.answer?.status;
			assert.equal(typeof liveStatus, "string", JSON.stringify(workflowResult));
			assert.match(liveStatus, /^live-agent-ok$/i);

			assert.deepEqual(state.job.snapshot?.phases, ["Run"]);
			assert.ok(state.job.snapshot?.logs?.includes("started live api call"));
			assert.equal(state.job.snapshot?.agents?.length, 1);
			assert.equal(state.job.snapshot?.agents?.[0]?.label, "live-worker");
			assert.equal(state.job.snapshot?.agents?.[0]?.phase, "Run");
			assert.equal(state.job.snapshot?.agents?.[0]?.status, "done");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	180000,
);

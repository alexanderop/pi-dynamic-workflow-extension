import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function runPiE2E(
	outputPath: string,
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"pi",
			[
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"-e",
				"./extensions/workflow.ts",
				"-e",
				"./tests/e2e/probe-extension.ts",
				"/e2e-inspect",
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, PI_E2E_OUT: outputPath },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);

		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code, stderr }));
	});
}

test("Pi loads the workflow extension and exposes its public entry points", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-workflow-e2e-"));
	const outputPath = join(dir, "extension-state.json");

	try {
		const result = await runPiE2E(outputPath);
		assert.equal(result.code, 0, result.stderr);

		const extensionState = JSON.parse(await readFile(outputPath, "utf8")) as {
			commands: string[];
			tools: string[];
		};

		assert.ok(extensionState.tools.includes("workflow"));
		assert.ok(extensionState.commands.includes("workflows"));
		assert.ok(extensionState.commands.includes("workflow-save"));
		assert.ok(extensionState.commands.includes("workflow-resume"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

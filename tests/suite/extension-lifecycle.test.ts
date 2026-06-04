import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { registerWorkflowExtension } from "../../src/extension/register-workflow-extension.js";
import {
	createDeferredWorkflowAgent,
	createResolvingWorkflowAgent,
	createWorkflowExtensionHarness,
	type ExtensionHarness,
	waitForJobStatus,
} from "./harness.js";

const SCRIPT = `export const meta = { name: 'lifecycle_demo', description: 'demo' }
const answer = await agent('inspect')
return { answer, args: args ?? null }
`;

let harness: ExtensionHarness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

test("session_start activates the workflow tool", async () => {
	harness = await createWorkflowExtensionHarness();
	registerWorkflowExtension(harness.pi, harness.deps);

	await harness.startSession();

	assert.ok(harness.activeTools.includes("workflow"));
});

test("session_start attaches a project workflow store", async () => {
	harness = await createWorkflowExtensionHarness();
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();

	await harness.runTool("workflow", { script: SCRIPT });
	const job = harness.manager.getJobs()[0];

	assert.ok(job?.scriptPath?.startsWith(join(harness.ctx.cwd, ".pi", "workflows")));
	await access(join(harness.ctx.cwd, ".pi", "workflows"));
});

test("status shows running workflow count", async () => {
	const agent = createDeferredWorkflowAgent();
	harness = await createWorkflowExtensionHarness({ agent });
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();

	await harness.runTool("workflow", { script: SCRIPT });

	assert.equal(harness.statuses.get("workflow"), "workflows:1");
	harness.manager.interruptAll();
	await waitForJobStatus(harness.manager, "interrupted");
	assert.equal(harness.statuses.get("workflow"), undefined);
});

test("session_shutdown interrupts running workflows", async () => {
	const agent = createDeferredWorkflowAgent();
	harness = await createWorkflowExtensionHarness({ agent });
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();
	await harness.runTool("workflow", { script: SCRIPT });

	await harness.shutdownSession();

	assert.equal(harness.manager.getJobs()[0]?.status, "interrupted");
});

test("completed workflow sends exactly one completion message", async () => {
	const agent = createResolvingWorkflowAgent("done");
	harness = await createWorkflowExtensionHarness({ agent });
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();

	await harness.runTool("workflow", { script: SCRIPT });
	await waitForJobStatus(harness.manager, "done");

	const completionMessages = harness.sentMessages.filter(
		(item) => (item.message as { customType?: string }).customType === "workflow-completion",
	);
	assert.equal(completionMessages.length, 1);
	assert.equal(
		harness.entries.filter((entry) => (entry as { customType?: string }).customType === "workflow-notification-sent")
			.length,
		1,
	);
});

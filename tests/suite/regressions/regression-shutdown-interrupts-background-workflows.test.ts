import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { registerWorkflowExtension } from "../../../src/extension/register-workflow-extension.js";
import { createDeferredWorkflowAgent, createWorkflowExtensionHarness, type ExtensionHarness } from "../harness.js";

const SCRIPT = `export const meta = { name: 'shutdown_interrupts', description: 'shutdown regression' }
return await agent('wait')
`;

let harness: ExtensionHarness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

test("session shutdown interrupts in-flight background workflows", async () => {
	harness = await createWorkflowExtensionHarness({ agent: createDeferredWorkflowAgent() });
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();
	await harness.runTool("workflow", { script: SCRIPT });

	await harness.shutdownSession();

	assert.equal(harness.manager.getJobs()[0]?.status, "interrupted");
});

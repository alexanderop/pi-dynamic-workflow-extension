import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { registerWorkflowExtension } from "../../../src/extension/register-workflow-extension.js";
import {
	createResolvingWorkflowAgent,
	createWorkflowExtensionHarness,
	type ExtensionHarness,
	waitForJobStatus,
} from "../harness.js";

const SCRIPT = `export const meta = { name: 'completion_once', description: 'completion regression' }
return await agent('finish')
`;

let harness: ExtensionHarness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

test("completed background workflow sends one workflow-completion message", async () => {
	harness = await createWorkflowExtensionHarness({ agent: createResolvingWorkflowAgent("done") });
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();

	await harness.runTool("workflow", { script: SCRIPT });
	await waitForJobStatus(harness.manager, "done");

	assert.equal(
		harness.sentMessages.filter(
			(item) => (item.message as { customType?: string }).customType === "workflow-completion",
		).length,
		1,
	);
});

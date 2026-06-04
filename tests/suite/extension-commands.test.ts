import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { registerWorkflowExtension } from "../../src/extension/register-workflow-extension.js";
import {
	createResolvingWorkflowAgent,
	createWorkflowExtensionHarness,
	type ExtensionHarness,
	waitForJobStatus,
} from "./harness.js";

const SCRIPT = `export const meta = { name: 'saved_demo', description: 'Saved demo' }
const answer = await agent('inspect ' + (args ?? ''))
return { answer, args: args ?? null }
`;

const UPDATED_SCRIPT = `export const meta = { name: 'saved_demo_updated', description: 'Updated saved demo' }
const answer = await agent('updated ' + (args ?? ''))
return { answer, args: args ?? null }
`;

let harness: ExtensionHarness | undefined;

afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

async function registeredHarness() {
	harness = await createWorkflowExtensionHarness({ agent: createResolvingWorkflowAgent("done") });
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();
	return harness;
}

test("/workflow-save saves a workflow job as a global workflow command", async () => {
	const h = await registeredHarness();
	await h.runTool("workflow", { script: SCRIPT });
	await waitForJobStatus(h.manager, "done");

	await h.runCommand("workflow-save", "1 my-saved");

	assert.equal(h.deps.globalWorkflowLibrary.get("my-saved")?.script, SCRIPT.trim());
	assert.ok(h.commands.has("my-saved"));
});

test("/workflow-list reports saved workflows", async () => {
	const h = await registeredHarness();
	h.deps.globalWorkflowLibrary.save(SCRIPT, "listed-workflow");

	await h.runCommand("workflow-list");

	assert.match(h.notifications.at(-1)?.message ?? "", /\/listed-workflow/);
});

test("/workflow-delete deletes a saved workflow after confirmation", async () => {
	const h = await registeredHarness();
	h.deps.globalWorkflowLibrary.save(SCRIPT, "delete-me");
	h.confirmResult = true;

	await h.runCommand("workflow-delete", "delete-me");

	assert.equal(h.deps.globalWorkflowLibrary.get("delete-me"), undefined);
	assert.match(h.notifications.at(-1)?.message ?? "", /Deleted saved workflow \/delete-me/);
});

test("/workflow-edit updates script text from the fake editor", async () => {
	const h = await registeredHarness();
	h.deps.globalWorkflowLibrary.save(SCRIPT, "edit-me");
	h.editorResults.push(UPDATED_SCRIPT);

	await h.runCommand("workflow-edit", "edit-me");

	assert.equal(h.deps.globalWorkflowLibrary.get("edit-me")?.script, UPDATED_SCRIPT);
	assert.match(h.notifications.at(-1)?.message ?? "", /Updated \/edit-me/);
});

test("/workflow-refresh registers new workflow files", async () => {
	const h = await registeredHarness();
	h.deps.globalWorkflowLibrary.save(SCRIPT, "new-file");
	assert.equal(h.commands.has("new-file"), false);

	await h.runCommand("workflow-refresh");

	assert.equal(h.commands.has("new-file"), true);
});

test("a saved workflow command starts a new background job with command args as args", async () => {
	harness = await createWorkflowExtensionHarness({ agent: createResolvingWorkflowAgent("done") });
	harness.deps.globalWorkflowLibrary.save(SCRIPT, "run-saved");
	registerWorkflowExtension(harness.pi, harness.deps);
	await harness.startSession();

	await harness.runCommand("run-saved", "target project");

	const job = harness.manager.getJobs()[0];
	assert.equal(job?.args, "target project");
	assert.equal(job?.name, "saved_demo");
});

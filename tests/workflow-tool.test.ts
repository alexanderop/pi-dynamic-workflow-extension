import assert from "node:assert/strict";
import test from "node:test";
import {
	createWorkflowTool,
	normalizeWorkflowToolArgs,
} from "../src/workflow-tool.js";

test("normalizeWorkflowToolArgs accepts legacy raw string", () => {
	assert.deepEqual(
		normalizeWorkflowToolArgs(
			"export const meta = { name: 'x', description: 'y' }",
		),
		{
			script: "export const meta = { name: 'x', description: 'y' }",
		},
	);
});

test("workflow tool has explicit prompt guidelines", () => {
	const tool = createWorkflowTool();
	assert.equal(tool.name, "workflow");
	assert.ok(tool.promptGuidelines?.length);
	for (const guideline of tool.promptGuidelines ?? [])
		assert.match(guideline, /workflow/);
	assert.ok(
		tool.promptGuidelines?.some((guideline) =>
			guideline.includes("parallel() takes functions"),
		),
	);
});

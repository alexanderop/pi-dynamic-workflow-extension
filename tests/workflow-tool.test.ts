import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowAgentLike, WorkflowSnapshot } from "../src/index.js";
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

test("foreground workflow tool treats a successful null agent result as done", async () => {
	const agent: WorkflowAgentLike = {
		async run(): Promise<null> {
			return null;
		},
	};
	const tool = createWorkflowTool({ agent, background: false });

	const result = await (tool.execute as any)(
		"call-1",
		{
			script: `export const meta = { name: 'null_agent', description: 'demo' }
return await agent('inspect')
`,
		},
		undefined,
		undefined,
		{ cwd: process.cwd() },
	);

	const snapshot = result.details as WorkflowSnapshot;
	assert.equal(snapshot.agents[0]?.status, "done");
	assert.equal(snapshot.doneCount, 1);
	assert.equal(snapshot.errorCount, 0);
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
	assert.ok(
		tool.promptGuidelines?.some(
			(guideline) =>
				guideline.includes("do not poll") &&
				guideline.includes("workflow-completion"),
		),
	);
});

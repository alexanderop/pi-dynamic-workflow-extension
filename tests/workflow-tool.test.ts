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
	assert.equal(tool.promptGuidelines?.length, 1);
	const guideline = tool.promptGuidelines?.[0] ?? "";
	const normalizedGuideline = guideline.toLowerCase();
	assert.match(guideline, /workflow/);
	assert.ok(normalizedGuideline.includes("workflow overview"));
	assert.ok(
		guideline.includes("deterministic JavaScript orchestration script"),
	);
	assert.ok(normalizedGuideline.includes("workflow script contract"));
	assert.ok(guideline.includes("do not poll"));
	assert.ok(guideline.includes("workflow-completion"));
	assert.ok(normalizedGuideline.includes("workflow primitive reference"));
	assert.ok(guideline.includes("declare function parallel"));
	assert.ok(guideline.includes("Pass thunks/functions, not promises"));
	assert.ok(guideline.includes("structured_output"));
	assert.ok(normalizedGuideline.includes("workflow authoring rules"));
	assert.ok(guideline.includes("merge parallel findings"));
	assert.ok(guideline.includes("Avoid structured output"));
	assert.ok(normalizedGuideline.includes("workflow example"));
	assert.ok(guideline.includes("export const meta"));
	assert.ok(guideline.includes("prompt_quality_audit"));
	assert.ok(guideline.includes("await parallel"));
});

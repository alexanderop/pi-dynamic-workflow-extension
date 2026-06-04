import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkflowAgentLike, WorkflowSnapshot } from "../../src/index.js";
import {
	buildWorkflowToolBackgroundStartMessage,
	WORKFLOW_TOOL_BACKGROUND_FOLLOWUP_INSTRUCTION,
} from "../../src/prompts/workflow-tool.js";
import { createWorkflowTool, normalizeWorkflowToolArgs } from "../../src/workflow-tool.js";

test("normalizeWorkflowToolArgs accepts legacy raw string", () => {
	assert.deepEqual(normalizeWorkflowToolArgs("export const meta = { name: 'x', description: 'y' }"), {
		script: "export const meta = { name: 'x', description: 'y' }",
	});
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

test("foreground workflow tool exposes artifacts in live and completion snapshots", async () => {
	const updates: WorkflowSnapshot[] = [];
	const agent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			assert.ok(
				updates.some((snapshot) => snapshot.artifacts?.[0]?.name === "review.md"),
				"expected an artifact update before the agent completed",
			);
			return `done:${prompt}`;
		},
	};
	const tool = createWorkflowTool({ agent, background: false });

	const result = await (tool.execute as any)(
		"call-1",
		{
			script: `export const meta = { name: 'tool_artifact', description: 'demo' }
artifact('review.md', '# Review', { type: 'markdown', description: 'Report' })
return await agent('inspect')
`,
		},
		undefined,
		(update: { details?: WorkflowSnapshot }) => {
			if (update.details) updates.push(update.details);
		},
		{ cwd: process.cwd() },
	);

	const snapshot = result.details as WorkflowSnapshot;
	assert.deepEqual(snapshot.artifacts, [
		{
			name: "review.md",
			type: "markdown",
			description: "Report",
			value: "# Review",
		},
	]);
});

test("workflow tool has explicit prompt guidelines", () => {
	const tool = createWorkflowTool();
	assert.equal(tool.name, "workflow");
	assert.equal(tool.promptGuidelines?.length, 1);
	const guideline = tool.promptGuidelines?.[0] ?? "";
	const normalizedGuideline = guideline.toLowerCase();
	assert.match(guideline, /workflow/);
	assert.ok(normalizedGuideline.includes("workflow overview"));
	assert.ok(guideline.includes("deterministic JavaScript orchestration script"));
	assert.ok(normalizedGuideline.includes("workflow script contract"));
	assert.ok(normalizedGuideline.includes("do not poll"));
	assert.ok(guideline.includes("yield control"));
	assert.ok(guideline.includes("stay idle"));
	assert.ok(guideline.includes("workflow-completion"));
	assert.ok(normalizedGuideline.includes("workflow primitive reference"));
	assert.ok(guideline.includes("declare function parallel"));
	assert.ok(guideline.includes("declare function artifact"));
	assert.ok(guideline.includes("ArtifactOptions"));
	assert.ok(guideline.includes("safe relative names"));
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

test("background workflow start message tells the agent to stay idle", () => {
	const message = buildWorkflowToolBackgroundStartMessage({
		name: "demo",
		id: 7,
	});

	assert.ok(WORKFLOW_TOOL_BACKGROUND_FOLLOWUP_INSTRUCTION.includes("yield control"));
	assert.ok(message.includes("Workflow demo started in the background as #7"));
	assert.ok(message.includes("stay idle"));
	assert.ok(message.includes("resume only"));
	assert.ok(message.includes("workflow-completion"));
});

import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowJob } from "../src/workflow-manager.js";
import {
	renderWorkflowReportText,
	selectWorkflowReport,
} from "../src/workflow-report.js";

function job(): WorkflowJob {
	return {
		id: 7,
		runId: "wf_report",
		name: "portfolio_research",
		description: "Research a portfolio",
		status: "done",
		script:
			"export const meta = { name: 'portfolio_research', description: 'x' };\nawait agent('x')",
		startedAt: 1_000,
		finishedAt: 66_000,
		result: { ok: true, summary: "Finished" },
		snapshot: {
			name: "portfolio_research",
			description: "Research a portfolio",
			phases: ["Guardrails", "Research"],
			logs: [],
			agents: [
				{
					id: 1,
					label: "guardrails",
					phase: "Guardrails",
					prompt: "check rules",
					status: "done",
					startedAt: 1_000,
					endedAt: 4_000,
					toolCount: 0,
				},
				{
					id: 2,
					label: "research",
					phase: "Research",
					prompt: "research",
					status: "done",
					startedAt: 5_000,
					endedAt: 65_000,
					toolCount: 3,
					resultPreview: "Useful result",
				},
			],
			agentCount: 2,
			runningCount: 0,
			doneCount: 2,
			errorCount: 0,
			toolCount: 3,
			durationMs: 65_000,
			result: { ok: true, summary: "Finished" },
		},
	};
}

test("workflow completion report summarizes artifacts", () => {
	const report = selectWorkflowReport({
		...job(),
		snapshot: {
			...job().snapshot,
			artifacts: [
				{
					name: "review.md",
					type: "markdown",
					description: "Human report",
					value: "# Review",
				},
			],
		},
	});

	assert.deepEqual(report.artifacts, [
		{ name: "review.md", type: "markdown", description: "Human report" },
	]);
	const text = renderWorkflowReportText(report);
	assert.match(text, /Artifacts/);
	assert.match(text, /review\.md/);
	assert.match(text, /markdown/);
	assert.match(text, /Human report/);
});

test("workflow completion report summarizes status, phases, agents, tools, and result", () => {
	const report = selectWorkflowReport(job());
	assert.equal(report.durationMs, 65_000);
	assert.equal(report.toolCount, 3);
	assert.deepEqual(
		report.phases.map((phase) => `${phase.label}:${phase.done}/${phase.total}`),
		["Guardrails:1/1", "Research:1/1"],
	);

	const text = renderWorkflowReportText(report);
	assert.match(text, /Workflow portfolio_research done/);
	assert.match(text, /Duration: 1m5s/);
	assert.match(text, /Tools: 3/);
	assert.match(text, /Phases/);
	assert.match(text, /#2\s+✓\s+research\s+Research\s+1m/);
	assert.match(text, /Final result preview/);
});

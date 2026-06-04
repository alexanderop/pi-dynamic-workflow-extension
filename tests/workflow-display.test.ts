import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
	cloneWorkflowSnapshot,
	renderWorkflowLines,
	type WorkflowAgentSnapshot,
	type WorkflowSnapshot,
} from "../src/display.js";
import { WorkflowDashboard } from "../src/workflow-dashboard.js";

function agent(overrides: Partial<WorkflowAgentSnapshot> = {}): WorkflowAgentSnapshot {
	return {
		id: 1,
		label: "repo inventory",
		phase: "Scan",
		prompt: "inspect",
		status: "done",
		...overrides,
	};
}

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	return {
		name: "inspect_project",
		description: "Inspect project",
		phases: ["Scan", "Review"],
		currentPhase: undefined,
		logs: [],
		agents: [agent()],
		agentCount: 1,
		runningCount: 0,
		doneCount: 1,
		errorCount: 0,
		...overrides,
	};
}

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

test("renderWorkflowLines hides empty phase rows", () => {
	const lines = renderWorkflowLines(snapshot());
	assert.ok(lines.some((line) => line.includes("Scan 1/1")));
	assert.ok(!lines.some((line) => line.includes("Review 0/0")));
});

test("renderWorkflowLines includes registered workflow artifacts", () => {
	const lines = renderWorkflowLines(
		snapshot({
			artifacts: [
				{
					name: "review.md",
					type: "markdown",
					description: "Human report",
					value: "# Review",
				},
			],
		}),
		true,
	);

	assert.ok(lines.some((line) => line.includes("Artifacts")));
	assert.ok(lines.some((line) => line.includes("review.md")));
	assert.ok(lines.some((line) => line.includes("markdown")));
	assert.ok(lines.some((line) => line.includes("Human report")));
});

test("cloneWorkflowSnapshot deep-clones workflow artifacts", () => {
	const original = snapshot({
		artifacts: [
			{
				name: "findings.json",
				type: "json",
				value: { nested: { count: 1 } },
			},
		],
	});

	const cloned = cloneWorkflowSnapshot(original);
	cloned.artifacts?.push({ name: "extra.txt", type: "text", value: "extra" });
	const clonedArtifact = cloned.artifacts?.[0];
	assert.ok(clonedArtifact);
	(clonedArtifact.value as { nested: { count: number } }).nested.count = 2;

	assert.equal(original.artifacts?.length, 1);
	assert.deepEqual(original.artifacts?.[0]?.value, { nested: { count: 1 } });
	assert.notEqual(cloned.artifacts, original.artifacts);
	assert.notEqual(cloned.artifacts?.[0]?.value, original.artifacts?.[0]?.value);
});

test("WorkflowDashboard keeps lines within width", () => {
	const dashboard = new WorkflowDashboard(
		snapshot({
			currentPhase: "Review",
			agents: [
				agent(),
				agent({
					id: 2,
					label: "a very long module summary label that should be clipped",
					phase: "Review",
					status: "running",
				}),
			],
			runningCount: 1,
			doneCount: 1,
			agentCount: 2,
		}),
		theme,
		false,
	);

	const lines = dashboard.render(72);
	assert.ok(lines.length > 0);
	for (const line of lines) assert.ok(visibleWidth(line) <= 72, line);
});

test("WorkflowDashboard renders artifact summaries", () => {
	const dashboard = new WorkflowDashboard(
		snapshot({
			artifacts: [
				{
					name: "review.md",
					type: "markdown",
					description: "Human report",
					value: "# Review",
				},
			],
		}),
		theme,
		true,
	);

	const text = dashboard.render(96).join("\n");
	assert.match(text, /Artifacts/);
	assert.match(text, /review\.md/);
	assert.match(text, /markdown/);
});

test("WorkflowDashboard has narrow fallback", () => {
	const lines = new WorkflowDashboard(snapshot(), theme, true).render(30);
	assert.ok(lines.some((line) => line.includes("Workflow completed")));
	for (const line of lines) assert.ok(visibleWidth(line) <= 30, line);
});

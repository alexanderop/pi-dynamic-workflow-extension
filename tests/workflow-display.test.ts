import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderWorkflowLines,
	type WorkflowAgentSnapshot,
	type WorkflowSnapshot,
} from "../src/display.js";
import { WorkflowDashboard } from "../src/workflow-dashboard.js";

function agent(
	overrides: Partial<WorkflowAgentSnapshot> = {},
): WorkflowAgentSnapshot {
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

test("WorkflowDashboard has narrow fallback", () => {
	const lines = new WorkflowDashboard(snapshot(), theme, true).render(30);
	assert.ok(lines.some((line) => line.includes("Workflow completed")));
	for (const line of lines) assert.ok(visibleWidth(line) <= 30, line);
});

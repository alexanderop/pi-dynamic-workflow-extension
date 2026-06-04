import assert from "node:assert/strict";
import { test } from "vitest";
import { createWorkflowSnapshot } from "../src/display.js";
import {
	applyWorkflowSnapshotFailure,
	applyWorkflowSnapshotSuccess,
	createWorkflowSnapshotEventHandlers,
} from "../src/workflow-snapshot-events.js";
import type { WorkflowResult } from "../src/workflow.js";

test("workflow snapshot event handlers project runtime events into dashboard state", () => {
	const snapshot = createWorkflowSnapshot({ name: "project_events", description: "demo" });
	let emits = 0;
	let time = 100;
	const handlers = createWorkflowSnapshotEventHandlers(snapshot, {
		emit: () => {
			emits++;
		},
		now: () => time++,
	});

	handlers.onPhase?.("Inspect");
	handlers.onLog?.("started");
	handlers.onArtifact?.({ name: "report.md", type: "markdown", value: "# Report" });
	handlers.onAgentStart?.({
		id: 1,
		label: "inspect:repo",
		phase: "Inspect",
		prompt: "inspect",
		model: "test/model",
	});
	handlers.onAgentActivity?.({
		id: 1,
		label: "inspect:repo",
		type: "tool",
		toolName: "read",
		argsPreview: "README.md",
	});
	handlers.onAgentEnd?.({
		id: 1,
		label: "inspect:repo",
		phase: "Inspect",
		result: { ok: true },
	});

	assert.equal(emits, 6);
	assert.equal(snapshot.currentPhase, "Inspect");
	assert.deepEqual(snapshot.phases, ["Inspect"]);
	assert.deepEqual(snapshot.logs, ["started"]);
	assert.equal(snapshot.artifacts?.[0]?.name, "report.md");
	assert.equal(snapshot.agents[0]?.status, "done");
	assert.equal(snapshot.agents[0]?.startedAt, 100);
	assert.equal(snapshot.agents[0]?.endedAt, 101);
	assert.equal(snapshot.agents[0]?.toolCount, 1);
	assert.equal(snapshot.agents[0]?.resultText, '{\n  "ok": true\n}');
});

test("applyWorkflowSnapshotSuccess finalizes unfinished agents and result fields", () => {
	const snapshot = createWorkflowSnapshot({ name: "success_events", description: "demo" });
	snapshot.currentPhase = "Run";
	snapshot.agents.push({
		id: 1,
		label: "worker",
		prompt: "work",
		status: "running",
		startedAt: 1,
		toolCount: 0,
		activity: [],
	});
	const result: WorkflowResult = {
		meta: { name: "success_events", description: "demo" },
		result: { done: true },
		phases: ["Run"],
		logs: [],
		agentCount: 1,
		estimatedTokens: 10,
		artifacts: [{ name: "result.json", type: "json", value: { done: true } }],
	};

	applyWorkflowSnapshotSuccess(snapshot, result, () => 50);

	assert.equal(snapshot.currentPhase, undefined);
	assert.deepEqual(snapshot.result, { done: true });
	assert.equal(snapshot.artifacts?.[0]?.name, "result.json");
	assert.equal(snapshot.agents[0]?.status, "done");
	assert.equal(snapshot.agents[0]?.endedAt, 50);
});

test("applyWorkflowSnapshotFailure records errors and marks unfinished agents", () => {
	const snapshot = createWorkflowSnapshot({ name: "failure_events", description: "demo" });
	snapshot.agents.push({
		id: 1,
		label: "worker",
		prompt: "work",
		status: "running",
		startedAt: 1,
		toolCount: 0,
		activity: [],
	});

	applyWorkflowSnapshotFailure(snapshot, "error", "failed", () => 75);

	assert.deepEqual(snapshot.logs, ["[error] failed"]);
	assert.equal(snapshot.agents[0]?.status, "error");
	assert.equal(snapshot.agents[0]?.endedAt, 75);

	snapshot.agents[0]!.status = "running";
	snapshot.agents[0]!.endedAt = undefined;
	applyWorkflowSnapshotFailure(snapshot, "interrupted", "interrupted", () => 80);

	assert.equal(snapshot.agents[0]?.status, "skipped");
	assert.equal(snapshot.agents[0]?.endedAt, 80);
});

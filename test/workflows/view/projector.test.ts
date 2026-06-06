import { describe, expect, it } from "vitest";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import {
  buildChooserView,
  buildMonitorView,
  chooserCounts,
} from "#src/workflows/view/projector.ts";

const agent = (overrides: Partial<WorkflowAgentProgress>): WorkflowAgentProgress => ({
  type: "workflow_agent",
  index: 0,
  label: "review:tests",
  agentId: "agent_1",
  agentType: "general-purpose",
  model: "fake-model",
  state: "queued",
  queuedAt: 0,
  attempt: 1,
  phaseTitle: "Review",
  promptPreview: "review tests",
  ...overrides,
});

const runState = (overrides: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  runId: "wf_test",
  taskId: "task_test",
  workflowName: "test-workflow",
  status: "created",
  script: "return null;",
  scriptPath: "/tmp/wf_test/script.js",
  phases: [],
  logs: [],
  workflowProgress: [],
  agentCount: 0,
  totalTokens: 0,
  totalToolCalls: 0,
  startTime: 0,
  ...overrides,
});

describe("buildMonitorView", () => {
  it("should count done as terminal-success agents over visible agent rows", () => {
    const run = runState({
      agentCount: 99,
      phases: [{ title: "Review" }],
      workflowProgress: [
        agent({ index: 0, label: "a", state: "done", phaseTitle: "Review" }),
        agent({ index: 1, label: "b", state: "running", phaseTitle: "Review" }),
        agent({ index: 2, label: "c", state: "failed", phaseTitle: "Review" }),
      ],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 0, now: 1000 });

    expect(view.header.doneAgents).toBe(1);
    expect(view.header.totalAgents).toBe(3);
  });

  it("should omit model and metric fields when agent data is missing", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [
        agent({
          state: "done",
          model: "unknown",
          tokens: undefined,
          toolCalls: undefined,
          lastProgressAt: undefined,
        }),
      ],
    });

    const [row] = buildMonitorView(run, { selectedPhaseIndex: 0 }).selectedPhaseAgents;

    expect(row?.modelLabel).toBeUndefined();
    expect(row?.tokens).toBeUndefined();
    expect(row?.toolCalls).toBeUndefined();
  });

  it("should expose idle duration when an agent is running without metrics", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [agent({ state: "running", tokens: undefined, lastProgressAt: 28_000 })],
    });

    const [row] = buildMonitorView(run, {
      selectedPhaseIndex: 0,
      now: 100_000,
    }).selectedPhaseAgents;

    expect(row?.tokens).toBeUndefined();
    expect(row?.idleMs).toBe(72_000);
  });

  it("should include only the selected phase agents in the monitor view", () => {
    const run = runState({
      phases: [{ title: "Review" }, { title: "Author" }],
      workflowProgress: [
        agent({ index: 0, label: "review:a", phaseTitle: "Review" }),
        agent({ index: 1, label: "author:a", phaseTitle: "Author" }),
      ],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 1 });

    expect(view.selectedPhaseAgents.map((row) => row.label)).toEqual(["author:a"]);
  });

  it("should keep unphased agents visible when declared phases have no matching agents", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [agent({ index: 0, label: "legacy:unphased", phaseTitle: undefined })],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 0 });

    expect(view.header.totalAgents).toBe(1);
    expect(view.phases[0]).toMatchObject({
      title: "Review",
      totalAgents: 1,
      doneAgents: 0,
    });
    expect(view.selectedPhaseAgents.map((row) => row.label)).toEqual(["legacy:unphased"]);
  });

  it("should omit the description when the run has none", () => {
    const view = buildMonitorView(runState(), { selectedPhaseIndex: 0 });

    expect(view.header.description).toBeUndefined();
  });

  it("should expose the full prompt on agent rows for the prompt reader", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [agent({ phaseTitle: "Review", prompt: "x".repeat(500) })],
    });

    const [row] = buildMonitorView(run, { selectedPhaseIndex: 0 }).selectedPhaseAgents;

    expect(row?.fullPrompt).toHaveLength(500);
  });
});

describe("buildChooserView", () => {
  it("should build a chooser model with running and completed counts", () => {
    const runs = [
      runState({
        runId: "wf_hard",
        workflowName: "hardening_slice_and_author",
        status: "running",
        agentCount: 8,
        totalTokens: 266_100,
      }),
      runState({ runId: "wf_done", workflowName: "finished", status: "completed", agentCount: 4 }),
    ];

    const view = buildChooserView(runs, { now: 1000 });

    expect(view.runningCount).toBe(1);
    expect(view.completedCount).toBe(1);
    expect(view.rows[0]?.tokens).toBe(266_100);
    expect(view.rows[0]?.agentCount).toBe(8);
  });

  it("should default the chooser selection to the newest running workflow", () => {
    const runs = [
      runState({ runId: "wf_old", workflowName: "old", status: "running", startTime: 10 }),
      runState({ runId: "wf_done", workflowName: "done", status: "completed", startTime: 99 }),
      runState({ runId: "wf_new", workflowName: "new", status: "running", startTime: 50 }),
    ];

    const view = buildChooserView(runs, { now: 1000 });

    expect(view.rows[view.defaultSelectedIndex]?.workflowName).toBe("new");
  });

  it("should omit the chooser token total when no tokens were recorded", () => {
    const runs = [runState({ status: "running", totalTokens: 0 })];

    const view = buildChooserView(runs, { now: 1000 });

    expect(view.rows[0]?.tokens).toBeUndefined();
  });

  it("should count running and completed workflows", () => {
    const counts = chooserCounts([
      runState({ status: "running" }),
      runState({ status: "paused" }),
      runState({ status: "completed" }),
      runState({ status: "failed" }),
    ]);

    expect(counts).toEqual({ running: 2, completed: 1 });
  });
});

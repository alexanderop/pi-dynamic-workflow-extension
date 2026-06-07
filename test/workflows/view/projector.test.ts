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

  it("should expose the agent thinking level as a compact display label", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [agent({ state: "running", thinkingLevel: "high" })],
    });

    const [row] = buildMonitorView(run, { selectedPhaseIndex: 0 }).selectedPhaseAgents;

    expect(row?.thinkingLevel).toBe("high");
    expect(row?.thinkingLevelLabel).toBe("thinking high");
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

  it("should label a running agent without telemetry as no live events instead of idle", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [agent({ state: "running", tokens: undefined, lastProgressAt: 28_000 })],
    });

    const [row] = buildMonitorView(run, {
      selectedPhaseIndex: 0,
      now: 100_000,
    }).selectedPhaseAgents;

    expect(row?.tokens).toBeUndefined();
    expect(row?.idleMs).toBeUndefined();
    expect(row?.noTelemetryMs).toBe(72_000);
  });

  it("should project a running agent live tool event as current tool activity", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [
        agent({
          state: "running",
          activityState: "using_tool",
          currentToolName: "read",
          currentToolCallId: "tool_1",
          lastEventAt: 42_000,
          lastEventLabel: "using read",
          lastEventType: "tool_start",
          observedLiveEvents: 1,
          telemetryAvailable: true,
          toolCalls: 1,
          lastProgressAt: 42_000,
        }),
      ],
    });

    const [row] = buildMonitorView(run, { selectedPhaseIndex: 0, now: 43_000 }).selectedPhaseAgents;

    expect(row).toMatchObject({
      activityState: "using_tool",
      activityLabel: "using read",
      currentToolName: "read",
      lastEventLabel: "using read",
      toolCalls: 1,
    });
    expect(row?.idleMs).toBeUndefined();
    expect(row?.noTelemetryMs).toBeUndefined();
  });

  it("should expose idle duration only after live telemetry has been observed", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      workflowProgress: [
        agent({
          state: "running",
          tokens: undefined,
          toolCalls: undefined,
          lastToolName: "Read",
          lastProgressAt: 28_000,
        }),
      ],
    });

    const [row] = buildMonitorView(run, {
      selectedPhaseIndex: 0,
      now: 100_000,
    }).selectedPhaseAgents;

    expect(row?.idleMs).toBe(72_000);
    expect(row?.noTelemetryMs).toBeUndefined();
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

  it("should collapse repeated phase rows while preserving first-seen order", () => {
    const run = runState({
      phases: [{ title: "Scout" }, { title: "Verify" }],
      workflowProgress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        { type: "workflow_phase", index: 1, title: "Verify" },
        { type: "workflow_phase", index: 2, title: "Synthesize" },
        { type: "workflow_phase", index: 3, title: "Scout" },
        agent({ index: 0, label: "verify:a", phaseTitle: "Verify" }),
      ],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 0 });

    expect(view.phases.map((phase) => phase.title)).toEqual(["Scout", "Verify", "Synthesize"]);
  });

  it("should deduplicate repeated agent progress rows by stable agent identity for counts and selected rows", () => {
    const duplicate = agent({
      index: 7,
      agentId: "agent_duplicate",
      label: "verify:duplicate",
      phaseTitle: "Verify",
      state: "running",
    });
    const run = runState({
      phases: [{ title: "Verify" }],
      workflowProgress: [
        { type: "workflow_phase", index: 0, title: "Verify" },
        duplicate,
        { ...duplicate, state: "done", tokens: 123, toolCalls: 1 },
        agent({ index: 8, agentId: "agent_unique", label: "verify:unique", phaseTitle: "Verify" }),
      ],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 0 });

    expect(view.header.totalAgents).toBe(2);
    expect(view.header.doneAgents).toBe(1);
    expect(view.phases[0]).toMatchObject({ totalAgents: 2, doneAgents: 1 });
    expect(view.selectedPhaseAgents.map((row) => row.label)).toEqual([
      "verify:duplicate",
      "verify:unique",
    ]);
  });

  it("should count failed agents distinctly from completed agents in phase rows", () => {
    const run = runState({
      phases: [{ title: "Verify", agentCount: 6 }],
      workflowProgress: [
        agent({ index: 0, label: "verify:1", state: "done", phaseTitle: "Verify" }),
        agent({ index: 1, label: "verify:2", state: "done", phaseTitle: "Verify" }),
        agent({ index: 2, label: "verify:3", state: "done", phaseTitle: "Verify" }),
        agent({ index: 3, label: "verify:4", state: "done", phaseTitle: "Verify" }),
        agent({ index: 4, label: "verify:5", state: "done", phaseTitle: "Verify" }),
        agent({ index: 5, label: "verify:6", state: "failed", phaseTitle: "Verify" }),
      ],
    });

    const [phase] = buildMonitorView(run, { selectedPhaseIndex: 0 }).phases;

    expect(phase).toMatchObject({ doneAgents: 5, failedAgents: 1, totalAgents: 6 });
  });

  it("should use planned phase agent counts before agent labels exist", () => {
    const run = runState({
      phases: [
        { title: "Discover public sources", agentCount: 6 },
        { title: "Extract evidence-backed claims", agentCount: 6 },
      ],
      workflowProgress: [],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 0 });

    expect(view.header).toMatchObject({ doneAgents: 0, totalAgents: 12 });
    expect(
      view.phases.map(({ title, doneAgents, totalAgents }) => ({ title, doneAgents, totalAgents })),
    ).toEqual([
      { title: "Discover public sources", doneAgents: 0, totalAgents: 6 },
      { title: "Extract evidence-backed claims", doneAgents: 0, totalAgents: 6 },
    ]);
    expect(view.selectedPhaseAgents).toEqual([]);
  });

  it("should expose phase metadata and planned agents before queued rows exist", () => {
    const run = runState({
      defaultModel: "openai-codex/gpt-5.5",
      phases: [
        {
          title: "Adversarially verify claims",
          detail: "Check claims against independent evidence",
          model: "openai-codex/gpt-5.5-high",
          agentCount: 3,
          agents: [
            { label: "verify-official-personal-sites", model: "openai-codex/gpt-5.5" },
            { label: "verify-professional-work", agentType: "researcher" },
          ],
        },
      ],
      workflowProgress: [],
    });

    const [phase] = buildMonitorView(run, { selectedPhaseIndex: 0 }).phases;

    expect(phase).toMatchObject({
      title: "Adversarially verify claims",
      detail: "Check claims against independent evidence",
      modelLabel: "openai-codex/gpt-5.5-high",
      doneAgents: 0,
      totalAgents: 3,
      remainingPlannedAgents: 1,
      plannedAgents: [
        { label: "verify-official-personal-sites", modelLabel: "openai-codex/gpt-5.5" },
        {
          label: "verify-professional-work",
          modelLabel: "openai-codex/gpt-5.5-high",
          agentType: "researcher",
        },
      ],
    });
  });

  it("should hide planned placeholders once matching real agent rows are queued", () => {
    const run = runState({
      phases: [
        {
          title: "Verify",
          agentCount: 2,
          agents: [{ label: "verify-official" }, { label: "verify-professional" }],
        },
      ],
      workflowProgress: [agent({ index: 0, label: "verify-official", phaseTitle: "Verify" })],
    });

    const [phase] = buildMonitorView(run, { selectedPhaseIndex: 0 }).phases;

    expect(phase?.plannedAgents.map((row) => row.label)).toEqual(["verify-professional"]);
    expect(phase?.remainingPlannedAgents).toBe(0);
  });

  it("should let actual agent rows exceed the planned phase count", () => {
    const run = runState({
      phases: [{ title: "Review", agentCount: 1 }],
      workflowProgress: [
        agent({ index: 0, label: "review:a", phaseTitle: "Review" }),
        agent({ index: 1, label: "review:b", phaseTitle: "Review" }),
      ],
    });

    const view = buildMonitorView(run, { selectedPhaseIndex: 0 });

    expect(view.header.totalAgents).toBe(2);
    expect(view.phases[0]).toMatchObject({ doneAgents: 0, totalAgents: 2 });
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

  it("should expose a compact artifact directory label from the run script path", () => {
    const view = buildMonitorView(
      runState({
        runId: "wf_debug",
        scriptPath: "/Users/alex/project/.pi/workflows/wf_debug/script.js",
      }),
      { selectedPhaseIndex: 0 },
    );

    expect(view.header.artifactDir).toBe(".pi/workflows/wf_debug/");
  });

  it("should fall back to the script copy directory for non-standard run paths", () => {
    const view = buildMonitorView(
      runState({ runId: "wf_debug", scriptPath: "/tmp/wf_debug/script.js" }),
      { selectedPhaseIndex: 0 },
    );

    expect(view.header.artifactDir).toBe("/tmp/wf_debug/");
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

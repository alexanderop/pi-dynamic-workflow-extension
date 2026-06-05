import { describe, expect, it } from "vitest";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { projectWorkflowsView } from "#src/workflows/view/projector.ts";

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

describe("workflow TUI projector", () => {
  it("should build run rows and selected details from manifest state", () => {
    const view = projectWorkflowsView(
      [
        runState({ runId: "wf_old", workflowName: "old-review", status: "running", agentCount: 1 }),
        runState({
          runId: "wf_new",
          workflowName: "repo-audit",
          status: "completed",
          agentCount: 3,
          durationMs: 72_000,
        }),
      ],
      { selectedRunIndex: 1, savedWorkflowCount: 2 },
    );

    expect(view.savedWorkflowCount).toBe(2);
    expect(view.runs).toMatchObject([
      { runId: "wf_old", workflowName: "old-review", status: "running", agentCount: 1 },
      {
        runId: "wf_new",
        workflowName: "repo-audit",
        status: "completed",
        agentCount: 3,
        durationLabel: "1m 12s",
      },
    ]);
    expect(view.selectedRun?.runId).toBe("wf_new");
  });

  it("should summarize phase progress from agent rows without reading transcript state", () => {
    const view = projectWorkflowsView([
      runState({
        phases: [{ title: "Review" }, { title: "Verify" }],
        workflowProgress: [
          { type: "workflow_phase", index: 0, title: "Review" },
          agent({ index: 0, label: "review:a", state: "done", phaseTitle: "Review" }),
          agent({ index: 1, label: "review:b", state: "running", phaseTitle: "Review" }),
          agent({ index: 2, label: "verify:a", state: "failed", phaseTitle: "Verify" }),
        ],
        agentCount: 3,
      }),
    ]);

    expect(view.selectedRun?.phases).toEqual([
      {
        title: "Review",
        totalAgents: 2,
        doneAgents: 1,
        runningAgents: 1,
        failedAgents: 0,
        stoppedAgents: 0,
      },
      {
        title: "Verify",
        totalAgents: 1,
        doneAgents: 0,
        runningAgents: 0,
        failedAgents: 1,
        stoppedAgents: 0,
      },
    ]);
  });
});

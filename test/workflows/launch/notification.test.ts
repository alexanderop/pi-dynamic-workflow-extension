import { describe, expect, it } from "vitest";
import { toTaskNotification, toTerminalOutput } from "#src/workflows/launch/notification.ts";
import type { WorkflowFailure, WorkflowRunState } from "#src/workflows/run/model.ts";

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "wf_test",
    taskId: "task_test",
    workflowName: "notify",
    status: "completed",
    script: "export const meta = {};",
    scriptPath: "/tmp/script.js",
    phases: [],
    logs: [],
    workflowProgress: [],
    agentCount: 2,
    totalTokens: 10,
    totalToolCalls: 3,
    startTime: 0,
    ...overrides,
  } as WorkflowRunState;
}

describe("workflow launch notification", () => {
  it("should default usage durationMs to zero when the run has no duration", () => {
    const output = toTerminalOutput(runState({ durationMs: undefined }), "/tmp/out.json");

    expect(output.usage.durationMs).toBe(0);
  });

  it("should truncate inline results when the truncation suffix itself exceeds the budget", () => {
    const notification = toTaskNotification(
      runState({ result: "x".repeat(500) }),
      "/very/long/output/path/that/makes/the/truncation/suffix/exceed/max/chars.json",
      "tiny",
      5,
    );

    expect(notification.details.result.length).toBe(5);
    expect(notification.details.result).toBe("\n[tru");
  });

  it("should render an empty inline result when a non-serializable result stringifies to undefined", () => {
    const notification = toTaskNotification(
      runState({ result: () => undefined }),
      "/tmp/out.json",
      "fn-result",
    );

    expect(notification.details.result).toBe("");
  });

  it("should format agent-scoped failures with the failing agent id", () => {
    const failures: WorkflowFailure[] = [
      { scope: "agent", agentId: "a123", message: "agent boom" },
    ];
    const notification = toTaskNotification(
      runState({ status: "failed", failures }),
      "/tmp/out.json",
      "agent-failure",
    );

    expect(notification.details.failures).toEqual(["agent a123 failed: agent boom"]);
  });

  it("should format pipeline-scoped failures with the failing pipeline index", () => {
    const failures: WorkflowFailure[] = [
      { scope: "pipeline", pipelineIndex: 2, message: "pipe boom" },
    ];
    const notification = toTaskNotification(
      runState({ status: "failed", failures }),
      "/tmp/out.json",
      "pipeline-failure",
    );

    expect(notification.details.failures).toEqual(["pipeline[2] failed: pipe boom"]);
  });

  it("should preserve the run duration when the run reports a positive duration", () => {
    const output = toTerminalOutput(runState({ durationMs: 1234 }), "/tmp/out.json");

    expect(output.usage.durationMs).toBe(1234);
  });

  it("should truncate inline results and keep the truncation suffix when it fits the budget", () => {
    const notification = toTaskNotification(
      runState({ result: "y".repeat(500) }),
      "/tmp/out.json",
      "fits",
      100,
    );

    expect(notification.details.result.length).toBe(100);
    expect(notification.details.result).toContain("truncated");
    expect(notification.details.result).toContain("/tmp/out.json");
    expect(notification.details.result.startsWith("yyy")).toBe(true);
  });

  it("should fall back to the scope label when a failure carries no agent id or pipeline index", () => {
    const failures: WorkflowFailure[] = [
      { scope: "agent", message: "agent without id" },
      { scope: "pipeline", message: "pipeline without index" },
      { scope: "run", message: "run boom" },
    ];
    const notification = toTaskNotification(
      runState({ status: "failed", failures }),
      "/tmp/out.json",
      "fallback-failure",
    );

    expect(notification.details.failures).toEqual([
      "agent failed: agent without id",
      "pipeline failed: pipeline without index",
      "run failed: run boom",
    ]);
  });
});

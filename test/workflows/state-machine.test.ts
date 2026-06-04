import { describe, expect, it } from "vitest";
import {
  canTransitionAgent,
  canTransitionRun,
  replayAgentEvents,
  replayRunEvents,
  transitionAgent,
  transitionRun,
} from "../../src/workflows/state-machine.ts";
import type { Result } from "../../src/workflows/result.ts";
import type { WorkflowAgentEvent, WorkflowRunEvent } from "../../src/workflows/state-machine.ts";
import type { WorkflowAgentProgress, WorkflowRunState } from "../../src/workflows/types.ts";

describe("transitionRun", () => {
  it("should move a run through start, pause, resume, and completion states", () => {
    const completed = runThrough(runState({ status: "created" }), [
      { type: "run_start_requested", now: 100 },
      { type: "run_started", now: 110 },
      { type: "run_pause_requested", now: 120 },
      { type: "run_paused", now: 130 },
      { type: "run_resume_requested", now: 140 },
      { type: "run_resumed", now: 150 },
      { type: "run_complete_requested", now: 160 },
      { type: "run_completed", now: 210, result: { ok: true } },
    ]);

    expect(completed).toMatchObject({
      status: "completed",
      startTime: 110,
      durationMs: 100,
      result: { ok: true },
    });
  });

  it("should reject invalid transitions and keep terminal runs immutable", () => {
    expect(
      canTransitionRun(runState({ status: "running" }), {
        type: "run_pause_requested",
        now: 100,
      }),
    ).toBe(true);
    expect(
      canTransitionRun(runState({ status: "created" }), { type: "run_paused", now: 100 }),
    ).toBe(false);
    expect(
      transitionRun(runState({ status: "created" }), { type: "run_paused", now: 100 }),
    ).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowTransitionError", currentState: "created" },
    });

    expect(
      transitionRun(runState({ status: "completed" }), {
        type: "run_stop_requested",
        now: 100,
      }),
    ).toMatchObject({
      status: "error",
      error: { currentState: "completed", eventType: "run_stop_requested" },
    });
  });

  it("should record failures through the failing terminal path", () => {
    const failed = runThrough(runState({ status: "running", startTime: 50 }), [
      {
        type: "run_fail_requested",
        now: 75,
        failure: { scope: "run", message: "boom" },
      },
      {
        type: "run_failed",
        now: 100,
        failure: { scope: "run", message: "terminal" },
      },
    ]);

    expect(failed).toMatchObject({
      status: "failed",
      durationMs: 50,
      failures: [
        { scope: "run", message: "boom" },
        { scope: "run", message: "terminal" },
      ],
    });
  });

  it("should measure startup failures from the first failure transition when never started", () => {
    const failed = runThrough(runState({ status: "created" }), [
      {
        type: "run_fail_requested",
        now: 75,
        failure: { scope: "run", message: "startup failed" },
      },
      {
        type: "run_failed",
        now: 100,
        failure: { scope: "run", message: "terminal" },
      },
    ]);

    expect(failed).toMatchObject({
      status: "failed",
      startTime: 75,
      durationMs: 25,
    });
  });

  it("should measure startup stops from the start request when never started", () => {
    const stopped = runThrough(runState({ status: "created" }), [
      { type: "run_start_requested", now: 100 },
      { type: "run_stop_requested", now: 125 },
      { type: "run_stopped", now: 140 },
    ]);

    expect(stopped).toMatchObject({
      status: "stopped",
      startTime: 100,
      durationMs: 40,
    });
  });

  it("should stop replaying run events when one transition is invalid", () => {
    const result = replayRunEvents(runState({ status: "created" }), [
      { type: "run_start_requested", now: 100 },
      { type: "run_paused", now: 110 },
      { type: "run_started", now: 120 },
    ]);

    expect(result).toMatchObject({
      status: "error",
      error: {
        currentState: "starting",
        eventType: "run_paused",
      },
    });
  });
});

describe("transitionAgent", () => {
  it("should move an agent from queued to running to done", () => {
    const done = agentThrough(agentProgress({ state: "queued" }), [
      { type: "agent_started", now: 100 },
      {
        type: "agent_succeeded",
        now: 145,
        resultPreview: "finished",
        tokens: 12,
        toolCalls: 2,
      },
    ]);

    expect(done).toMatchObject({
      state: "done",
      startedAt: 100,
      lastProgressAt: 145,
      durationMs: 45,
      resultPreview: "finished",
      tokens: 12,
      toolCalls: 2,
    });
  });

  it("should reject late agent results after stop", () => {
    expect(
      canTransitionAgent(agentProgress({ state: "stopped" }), {
        type: "agent_succeeded",
        now: 120,
        resultPreview: "late",
      }),
    ).toBe(false);
    expect(
      transitionAgent(agentProgress({ state: "stopped" }), {
        type: "agent_succeeded",
        now: 120,
        resultPreview: "late",
      }),
    ).toMatchObject({
      status: "error",
      error: { currentState: "stopped", eventType: "agent_succeeded" },
    });
  });

  it("should restart failed or stopped agents with a new id and attempt", () => {
    expect(
      canTransitionAgent(agentProgress({ state: "failed" }), {
        type: "agent_restarted",
        now: 200,
        agentId: "agent_new",
      }),
    ).toBe(true);
    const restarted = transitionAgent(
      agentProgress({
        state: "failed",
        agentId: "agent_old",
        attempt: 1,
        startedAt: 100,
        durationMs: 25,
        resultPreview: "boom",
      }),
      { type: "agent_restarted", now: 200, agentId: "agent_new" },
    );

    expect(restarted).toMatchObject({
      status: "ok",
      value: {
        state: "queued",
        agentId: "agent_new",
        queuedAt: 200,
        attempt: 2,
      },
    });
    const value = unwrap(restarted);
    expect(value.startedAt).toBeUndefined();
    expect(value.durationMs).toBeUndefined();
    expect(value.resultPreview).toBeUndefined();
  });

  it("should stop replaying agent events when one transition is invalid", () => {
    const result = replayAgentEvents(agentProgress({ state: "queued" }), [
      { type: "agent_started", now: 100 },
      { type: "agent_stopped", now: 110 },
      { type: "agent_succeeded", now: 120 },
    ]);

    expect(result).toMatchObject({
      status: "error",
      error: {
        currentState: "stopped",
        eventType: "agent_succeeded",
      },
    });
  });
});

function runThrough(state: WorkflowRunState, events: WorkflowRunEvent[]): WorkflowRunState {
  return unwrap(replayRunEvents(state, events));
}

function agentThrough(
  agent: WorkflowAgentProgress,
  events: WorkflowAgentEvent[],
): WorkflowAgentProgress {
  return unwrap(replayAgentEvents(agent, events));
}

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
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
  };
}

function agentProgress(overrides: Partial<WorkflowAgentProgress> = {}): WorkflowAgentProgress {
  return {
    type: "workflow_agent",
    index: 0,
    label: "scan",
    agentId: "agent_test",
    agentType: "general-purpose",
    model: "default",
    state: "queued",
    queuedAt: 90,
    attempt: 1,
    promptPreview: "Scan the repo",
    ...overrides,
  };
}

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.status === "ok") return result.value;
  throw new Error("Expected Result to be ok.");
}

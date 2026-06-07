import { describe, expect, it } from "vitest";
import { array, assert, constantFrom, integer, oneof, property, record } from "fast-check";
import {
  canTransitionAgent,
  canTransitionRun,
  replayAgentEvents,
  replayRunEvents,
  transitionAgent,
  transitionRun,
} from "#src/workflows/run/state-machine.ts";
import type { Result } from "#src/workflows/result.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState, WorkflowRunStatus } from "#src/workflows/run/model.ts";
import type { WorkflowAgentEvent, WorkflowRunEvent } from "#src/workflows/run/state-machine.ts";

const propertyRuns = { numRuns: 200 };

const runStatusArbitrary = constantFrom<WorkflowRunStatus>(
  "created",
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
  "completing",
  "completed",
  "failing",
  "failed",
  "stopping",
  "stopped",
);
const agentStateArbitrary = constantFrom<WorkflowAgentProgress["state"]>(
  "queued",
  "running",
  "done",
  "failed",
  "stopped",
);
const failureArbitrary = record({
  scope: constantFrom<"run" | "agent" | "pipeline">("run", "agent", "pipeline"),
  message: constantFrom("boom", "terminal", "stopped", "invalid"),
});
const runEventArbitrary = integer({ min: 1, max: 10_000 }).chain((now) =>
  oneof(
    constantFrom<WorkflowRunEvent>(
      { type: "run_start_requested", now },
      { type: "run_started", now },
      { type: "run_pause_requested", now },
      { type: "run_paused", now },
      { type: "run_resume_requested", now },
      { type: "run_resumed", now },
      { type: "run_complete_requested", now },
      { type: "run_completed", now, result: { ok: true } },
      { type: "run_stop_requested", now },
      { type: "run_stopped", now },
    ),
    failureArbitrary.map(
      (failure): WorkflowRunEvent => ({ type: "run_fail_requested", now, failure }),
    ),
    failureArbitrary.map((failure): WorkflowRunEvent => ({ type: "run_failed", now, failure })),
  ),
);
const agentEventArbitrary = integer({ min: 1, max: 10_000 }).chain((now) =>
  constantFrom<WorkflowAgentEvent>(
    { type: "agent_started", now },
    { type: "agent_succeeded", now, resultPreview: "ok", tokens: 1, toolCalls: 1 },
    { type: "agent_failed", now, resultPreview: "boom" },
    { type: "agent_stopped", now },
    { type: "agent_restarted", now, agentId: `agent_${now}` },
  ),
);

describe("workflow state machine properties", () => {
  it("should make terminal run states reject every run event", () => {
    assert(
      property(
        constantFrom<WorkflowRunStatus>("completed", "failed", "stopped"),
        runEventArbitrary,
        (status, event) => {
          const state = runState({ status });

          expect(canTransitionRun(state, event)).toBe(false);
          expect(transitionRun(state, event)).toMatchObject({
            status: "error",
            error: { currentState: status, eventType: event.type },
          });
        },
      ),
      propertyRuns,
    );
  });

  it("should keep replayRunEvents equivalent to applying run transitions until the first error", () => {
    assert(
      property(
        runStatusArbitrary,
        array(runEventArbitrary, { maxLength: 20 }),
        (status, events) => {
          const initial = runState({ status });

          expect(replayRunEvents(initial, events)).toEqual(manualRunReplay(initial, events));
        },
      ),
      propertyRuns,
    );
  });

  it("should reject late terminal agent result, failure, and stop events", () => {
    assert(
      property(
        constantFrom<WorkflowAgentProgress["state"]>("done", "failed", "stopped"),
        constantFrom<WorkflowAgentEvent>(
          { type: "agent_succeeded", now: 100, resultPreview: "late" },
          { type: "agent_failed", now: 100, resultPreview: "late" },
          { type: "agent_stopped", now: 100 },
        ),
        (state, event) => {
          const agent = agentProgress({ state });

          expect(canTransitionAgent(agent, event)).toBe(false);
          expect(transitionAgent(agent, event)).toMatchObject({
            status: "error",
            error: { currentState: state, eventType: event.type },
          });
        },
      ),
      propertyRuns,
    );
  });

  it("should keep replayAgentEvents equivalent to applying agent transitions until the first error", () => {
    assert(
      property(
        agentStateArbitrary,
        array(agentEventArbitrary, { maxLength: 20 }),
        (state, events) => {
          const initial = agentProgress({ state });

          expect(replayAgentEvents(initial, events)).toEqual(manualAgentReplay(initial, events));
        },
      ),
      propertyRuns,
    );
  });
});

function manualRunReplay(
  initial: WorkflowRunState,
  events: WorkflowRunEvent[],
): Result<WorkflowRunState, unknown> {
  let current = initial;
  for (const event of events) {
    const result = transitionRun(current, event);
    if (result.status === "error") return result;
    current = result.value;
  }
  return { status: "ok", value: current };
}

function manualAgentReplay(
  initial: WorkflowAgentProgress,
  events: WorkflowAgentEvent[],
): Result<WorkflowAgentProgress, unknown> {
  let current = initial;
  for (const event of events) {
    const result = transitionAgent(current, event);
    if (result.status === "error") return result;
    current = result.value;
  }
  return { status: "ok", value: current };
}

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
    runId: "wf_property",
    taskId: "task_property",
    workflowName: "property-workflow",
    status: "created",
    script: "return null;",
    scriptPath: "/tmp/wf_property/script.js",
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
    agentId: "agent_property",
    agentType: "general-purpose",
    model: "default",
    state: "queued",
    queuedAt: 0,
    attempt: 1,
    promptPreview: "Scan the repo",
    ...overrides,
  };
}

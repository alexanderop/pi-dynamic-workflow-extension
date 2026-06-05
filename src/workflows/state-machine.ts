import { err, ok, type Result } from "./result.ts";
import type { WorkflowAgentProgress, WorkflowFailure, WorkflowRunState } from "./types.ts";

export type WorkflowRunEvent =
  | { type: "run_start_requested"; now: number }
  | { type: "run_started"; now: number }
  | { type: "run_pause_requested"; now: number }
  | { type: "run_paused"; now: number }
  | { type: "run_resume_requested"; now: number }
  | { type: "run_resumed"; now: number }
  | { type: "run_complete_requested"; now: number }
  | { type: "run_completed"; now: number; result?: unknown }
  | { type: "run_fail_requested"; now: number; failure: WorkflowFailure }
  | { type: "run_failed"; now: number; failure: WorkflowFailure }
  | { type: "run_stop_requested"; now: number }
  | { type: "run_stopped"; now: number };

export type WorkflowAgentEvent =
  | { type: "agent_started"; now: number }
  | {
      type: "agent_succeeded";
      now: number;
      resultPreview?: string;
      tokens?: number;
      toolCalls?: number;
    }
  | { type: "agent_failed"; now: number; resultPreview?: string }
  | { type: "agent_stopped"; now: number }
  | { type: "agent_restarted"; now: number; agentId: string };

export interface WorkflowTransitionError {
  readonly _tag: "WorkflowTransitionError";
  readonly message: string;
  readonly currentState: string;
  readonly eventType: string;
}

type WorkflowRunEventType = WorkflowRunEvent["type"];
type WorkflowAgentEventType = WorkflowAgentEvent["type"];
type TransitionTable<TState extends string, TEvent extends string> = {
  readonly [State in TState]?: Partial<Record<TEvent, TState>>;
};

const runTransitions: TransitionTable<WorkflowRunState["status"], WorkflowRunEventType> = {
  created: {
    run_start_requested: "starting",
    run_fail_requested: "failing",
  },
  starting: {
    run_started: "running",
    run_fail_requested: "failing",
    run_stop_requested: "stopping",
  },
  running: {
    run_pause_requested: "pausing",
    run_complete_requested: "completing",
    run_fail_requested: "failing",
    run_stop_requested: "stopping",
  },
  pausing: {
    run_paused: "paused",
    run_fail_requested: "failing",
    run_stop_requested: "stopping",
  },
  paused: {
    run_resume_requested: "resuming",
    run_fail_requested: "failing",
    run_stop_requested: "stopping",
  },
  resuming: {
    run_resumed: "running",
    run_fail_requested: "failing",
    run_stop_requested: "stopping",
  },
  completing: {
    run_completed: "completed",
    run_fail_requested: "failing",
    run_stop_requested: "stopping",
  },
  failing: {
    run_fail_requested: "failing",
    run_failed: "failed",
  },
  completed: {},
  failed: {},
  stopped: {},
  stopping: {
    run_fail_requested: "failing",
    run_stopped: "stopped",
  },
};

const agentTransitions: TransitionTable<WorkflowAgentProgress["state"], WorkflowAgentEventType> = {
  queued: {
    agent_started: "running",
    agent_stopped: "stopped",
  },
  running: {
    agent_succeeded: "done",
    agent_failed: "failed",
    agent_stopped: "stopped",
  },
  done: {},
  failed: {
    agent_restarted: "queued",
  },
  stopped: {
    agent_restarted: "queued",
  },
};

export function transitionRun(
  state: WorkflowRunState,
  event: WorkflowRunEvent,
): Result<WorkflowRunState, WorkflowTransitionError> {
  const nextStatus = nextRunStatus(state.status, event.type);
  if (!nextStatus) return invalidRunTransition(state, event);

  const nextState = { ...state, status: nextStatus };

  switch (event.type) {
    case "run_start_requested":
      return ok({ ...nextState, startTime: event.now });
    case "run_started":
      return ok({ ...nextState, startTime: event.now });
    case "run_pause_requested":
      return ok(nextState);
    case "run_paused":
      return ok(nextState);
    case "run_resume_requested":
      return ok(nextState);
    case "run_resumed":
      return ok(nextState);
    case "run_complete_requested":
      return ok(nextState);
    case "run_completed":
      return ok({
        ...nextState,
        timestamp: new Date(event.now).toISOString(),
        durationMs: event.now - state.startTime,
        result: event.result,
      });
    case "run_fail_requested":
      return ok({
        ...nextState,
        startTime: state.startTime || event.now,
        failures: appendFailure(state.failures, event.failure),
      });
    case "run_failed":
      return ok({
        ...nextState,
        timestamp: new Date(event.now).toISOString(),
        durationMs: event.now - state.startTime,
        failures: appendFailure(state.failures, event.failure),
      });
    case "run_stop_requested":
      return ok(nextState);
    case "run_stopped":
      return ok({
        ...nextState,
        timestamp: new Date(event.now).toISOString(),
        durationMs: event.now - state.startTime,
      });
  }
}

export function transitionAgent(
  agent: WorkflowAgentProgress,
  event: WorkflowAgentEvent,
): Result<WorkflowAgentProgress, WorkflowTransitionError> {
  const nextState = nextAgentState(agent.state, event.type);
  if (!nextState) return invalidAgentTransition(agent, event);

  const nextAgent = { ...agent, state: nextState };

  switch (event.type) {
    case "agent_started":
      return ok({
        ...nextAgent,
        startedAt: event.now,
        lastProgressAt: event.now,
      });
    case "agent_succeeded":
      return ok({
        ...nextAgent,
        lastProgressAt: event.now,
        durationMs: event.now - (agent.startedAt ?? event.now),
        resultPreview: event.resultPreview,
        tokens: event.tokens,
        toolCalls: event.toolCalls,
      });
    case "agent_failed":
      return ok({
        ...nextAgent,
        lastProgressAt: event.now,
        durationMs: event.now - (agent.startedAt ?? event.now),
        resultPreview: event.resultPreview,
      });
    case "agent_stopped":
      return ok({
        ...nextAgent,
        lastProgressAt: event.now,
        durationMs: event.now - (agent.startedAt ?? event.now),
      });
    case "agent_restarted":
      return ok({
        ...nextAgent,
        agentId: event.agentId,
        queuedAt: event.now,
        attempt: agent.attempt + 1,
        startedAt: undefined,
        lastProgressAt: undefined,
        durationMs: undefined,
        lastToolName: undefined,
        lastToolSummary: undefined,
        resultPreview: undefined,
        tokens: undefined,
        toolCalls: undefined,
      });
  }
}

export function canTransitionRun(state: WorkflowRunState, event: WorkflowRunEvent): boolean {
  return nextRunStatus(state.status, event.type) !== undefined;
}

export function canTransitionAgent(
  agent: WorkflowAgentProgress,
  event: WorkflowAgentEvent,
): boolean {
  return nextAgentState(agent.state, event.type) !== undefined;
}

export function replayRunEvents(
  state: WorkflowRunState,
  events: WorkflowRunEvent[],
): Result<WorkflowRunState, WorkflowTransitionError> {
  let current = state;
  for (const event of events) {
    const result = transitionRun(current, event);
    if (result.status === "error") return result;
    current = result.value;
  }
  return ok(current);
}

export function replayAgentEvents(
  agent: WorkflowAgentProgress,
  events: WorkflowAgentEvent[],
): Result<WorkflowAgentProgress, WorkflowTransitionError> {
  let current = agent;
  for (const event of events) {
    const result = transitionAgent(current, event);
    if (result.status === "error") return result;
    current = result.value;
  }
  return ok(current);
}

export function isTerminalRunStatus(status: WorkflowRunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

export function isTerminalAgentState(state: WorkflowAgentProgress["state"]): boolean {
  return state === "done" || state === "failed" || state === "stopped";
}

function nextRunStatus(
  status: WorkflowRunState["status"],
  eventType: WorkflowRunEventType,
): WorkflowRunState["status"] | undefined {
  return runTransitions[status]?.[eventType];
}

function nextAgentState(
  state: WorkflowAgentProgress["state"],
  eventType: WorkflowAgentEventType,
): WorkflowAgentProgress["state"] | undefined {
  return agentTransitions[state]?.[eventType];
}

function appendFailure(
  failures: WorkflowRunState["failures"],
  failure: WorkflowFailure,
): WorkflowFailure[] {
  if (failures?.some((existing) => sameFailure(existing, failure))) return failures;
  return [...(failures ?? []), failure];
}

function sameFailure(left: WorkflowFailure, right: WorkflowFailure): boolean {
  return (
    left.scope === right.scope &&
    left.message === right.message &&
    left.agentId === right.agentId &&
    left.pipelineIndex === right.pipelineIndex
  );
}

function invalidRunTransition(
  state: WorkflowRunState,
  event: WorkflowRunEvent,
): Result<WorkflowRunState, WorkflowTransitionError> {
  return err({
    _tag: "WorkflowTransitionError",
    message: `Cannot apply ${event.type} while run is ${state.status}.`,
    currentState: state.status,
    eventType: event.type,
  });
}

function invalidAgentTransition(
  agent: WorkflowAgentProgress,
  event: WorkflowAgentEvent,
): Result<WorkflowAgentProgress, WorkflowTransitionError> {
  return err({
    _tag: "WorkflowTransitionError",
    message: `Cannot apply ${event.type} while agent is ${agent.state}.`,
    currentState: agent.state,
    eventType: event.type,
  });
}

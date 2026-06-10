// State-transition wrappers for a launched run: merging live runtime state
// into the persisted run state and building the terminal (completed/stopped/
// failed) states through the run state machine. "Where does a run become
// `failed`?" is answered here, not in the launcher.
import { ok, type Result } from "#src/workflows/result.ts";
import {
  transitionRun,
  type WorkflowRunEvent,
  type WorkflowTransitionError,
} from "#src/workflows/run/state-machine.ts";
import type {
  WorkflowProgressEntry,
  WorkflowRunState,
  WorkflowRunStatus,
} from "#src/workflows/run/model.ts";
import type { WorkflowRuntimeState } from "#src/workflows/script/model.ts";

export function completeRunState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  now: number,
  outputPath: string,
): Result<WorkflowRunState, WorkflowTransitionError> {
  const transitioned = applyRunTransitions(
    mergeRuntimeState(initialState, runtimeState),
    { type: "run_complete_requested", now },
    { type: "run_completed", now, result: runtimeState.result },
  );
  if (transitioned.status === "error") return transitioned;
  return ok({ ...transitioned.value, outputPath });
}

export function stopRunState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  now: number,
  outputPath: string,
): Result<WorkflowRunState, WorkflowTransitionError> {
  const transitioned = applyRunTransitions(
    mergeRuntimeState(initialState, runtimeState),
    { type: "run_stop_requested", now },
    { type: "run_stopped", now },
  );
  if (transitioned.status === "error") return transitioned;
  return ok({ ...transitioned.value, result: runtimeState.result, outputPath });
}

export function failRunState(
  initialState: WorkflowRunState,
  message: string,
  now: number,
  outputPath: string,
  runtimeState?: WorkflowRuntimeState,
): Result<WorkflowRunState, WorkflowTransitionError> {
  const failure = { scope: "run" as const, message };
  const state =
    runtimeState === undefined ? initialState : mergeRuntimeState(initialState, runtimeState);
  const transitioned = applyRunTransitions(
    state,
    { type: "run_fail_requested", now, failure },
    { type: "run_failed", now, failure },
  );
  if (transitioned.status === "error") return transitioned;
  return ok({ ...transitioned.value, outputPath });
}

export function mergeRuntimeState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  statusOverride?: WorkflowRunStatus,
): WorkflowRunState {
  return {
    ...initialState,
    ...(statusOverride === undefined ? {} : { status: statusOverride }),
    phases:
      initialState.phases.length === 0
        ? runtimeState.phases.map((phase) => ({ title: phase.title }))
        : initialState.phases,
    logs: runtimeState.logs,
    workflowProgress: runtimeState.workflowProgress,
    agentCount: countAgents(runtimeState.workflowProgress),
    totalTokens: sumProgressNumber(runtimeState.workflowProgress, "tokens"),
    totalToolCalls: sumProgressNumber(runtimeState.workflowProgress, "toolCalls"),
  };
}

function applyRunTransitions(
  state: WorkflowRunState,
  ...events: readonly WorkflowRunEvent[]
): Result<WorkflowRunState, WorkflowTransitionError> {
  let current = state;
  for (const event of events) {
    const transitioned = transitionRun(current, event);
    if (transitioned.status === "error") return transitioned;
    current = transitioned.value;
  }
  return ok(current);
}

function countAgents(progress: WorkflowProgressEntry[]): number {
  return progress.filter((entry) => entry.type === "workflow_agent").length;
}

function sumProgressNumber(progress: WorkflowProgressEntry[], key: "tokens" | "toolCalls"): number {
  return progress.reduce((sum, entry) => {
    if (entry.type !== "workflow_agent") return sum;
    return sum + (entry[key] ?? 0);
  }, 0);
}

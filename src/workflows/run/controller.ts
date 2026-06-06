import { err, ok, type Result } from "#src/workflows/result.ts";
import { transitionAgent, transitionRun, type WorkflowTransitionError } from "./state-machine.ts";
import type { WorkflowProgressEntry, WorkflowRunState } from "./model.ts";
import { WorkflowRunStore, type WorkflowRunStoreError } from "./store.ts";

export interface WorkflowRunControllerOptions {
  readonly store: WorkflowRunStore;
  readonly now?: () => number;
  readonly control: WorkflowRunExecutionControl;
}

export interface WorkflowRunExecutionControl {
  pause(): void;
  resume(): void;
  stopRun(): void;
  stopAgent(agentId: string): void;
}

export type WorkflowRunControllerError =
  | WorkflowRunStoreError
  | WorkflowTransitionError
  | WorkflowRunControlOperationError;

export interface WorkflowRunControlOperationError {
  readonly _tag: "WorkflowRunControlOperationError";
  readonly message: string;
  readonly runId: string;
  readonly operation: "pause" | "resume" | "stop" | "stop-agent";
  readonly cause: unknown;
}

export class WorkflowRunController {
  readonly #store: WorkflowRunStore;
  readonly #now: () => number;
  readonly #control: WorkflowRunExecutionControl;

  constructor(options: WorkflowRunControllerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#control = options.control;
  }

  async pause(runId: string): Promise<Result<WorkflowRunState, WorkflowRunControllerError>> {
    const current = await this.#store.readRun(runId);
    if (current.status === "error") return current;

    const pauseRequested = transitionRun(current.value, {
      type: "run_pause_requested",
      now: this.#now(),
    });
    if (pauseRequested.status === "error") return pauseRequested;

    try {
      this.#control.pause();
    } catch (cause) {
      return err(controlOperationError(runId, "pause", cause));
    }

    const paused = transitionRun(pauseRequested.value, { type: "run_paused", now: this.#now() });
    if (paused.status === "error") return paused;

    const written = await this.#store.writeRun(paused.value);
    if (written.status === "error") return written;
    return ok(paused.value);
  }

  async resume(runId: string): Promise<Result<WorkflowRunState, WorkflowRunControllerError>> {
    const current = await this.#store.readRun(runId);
    if (current.status === "error") return current;

    const resumeRequested = transitionRun(current.value, {
      type: "run_resume_requested",
      now: this.#now(),
    });
    if (resumeRequested.status === "error") return resumeRequested;

    try {
      this.#control.resume();
    } catch (cause) {
      return err(controlOperationError(runId, "resume", cause));
    }

    const resumed = transitionRun(resumeRequested.value, { type: "run_resumed", now: this.#now() });
    if (resumed.status === "error") return resumed;

    const written = await this.#store.writeRun(resumed.value);
    if (written.status === "error") return written;
    return ok(resumed.value);
  }

  async stopRun(runId: string): Promise<Result<WorkflowRunState, WorkflowRunControllerError>> {
    const current = await this.#store.readRun(runId);
    if (current.status === "error") return current;

    const stopRequested = transitionRun(current.value, {
      type: "run_stop_requested",
      now: this.#now(),
    });
    if (stopRequested.status === "error") return stopRequested;

    try {
      this.#control.stopRun();
    } catch (cause) {
      return err(controlOperationError(runId, "stop", cause));
    }

    const stopped = transitionRun(stopRequested.value, { type: "run_stopped", now: this.#now() });
    if (stopped.status === "error") return stopped;

    const written = await this.#store.writeRun(stopped.value);
    if (written.status === "error") return written;
    return ok(stopped.value);
  }

  async stopAgent(
    runId: string,
    agentId: string,
  ): Promise<Result<WorkflowRunState, WorkflowRunControllerError>> {
    const current = await this.#store.readRun(runId);
    if (current.status === "error") return current;

    const progressIndex = current.value.workflowProgress.findIndex(
      (entry) => entry.type === "workflow_agent" && entry.agentId === agentId,
    );
    const progress = current.value.workflowProgress[progressIndex];
    if (progress === undefined || progress.type !== "workflow_agent") {
      return err({
        _tag: "WorkflowTransitionError",
        message: `Workflow agent '${agentId}' was not found in run '${runId}'.`,
        currentState: "missing",
        eventType: "agent_stopped",
      });
    }

    const stoppedAgent = transitionAgent(progress, { type: "agent_stopped", now: this.#now() });
    if (stoppedAgent.status === "error") return stoppedAgent;

    try {
      this.#control.stopAgent(agentId);
    } catch (cause) {
      return err(controlOperationError(runId, "stop-agent", cause));
    }

    const workflowProgress: WorkflowProgressEntry[] = [...current.value.workflowProgress];
    workflowProgress[progressIndex] = stoppedAgent.value;
    const stoppedRun = { ...current.value, workflowProgress };
    const written = await this.#store.writeRun(stoppedRun);
    if (written.status === "error") return written;
    return ok(stoppedRun);
  }
}

function controlOperationError(
  runId: string,
  operation: "pause" | "resume" | "stop" | "stop-agent",
  cause: unknown,
): WorkflowRunControlOperationError {
  return {
    _tag: "WorkflowRunControlOperationError",
    message: `Could not ${operation} workflow run '${runId}'.`,
    runId,
    operation,
    cause,
  };
}

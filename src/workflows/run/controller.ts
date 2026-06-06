import { err, ok, type Result } from "../result.ts";
import { transitionRun, type WorkflowTransitionError } from "./state-machine.ts";
import type { WorkflowRunState } from "./model.ts";
import { WorkflowRunStore, type WorkflowRunStoreError } from "./store.ts";

export interface WorkflowRunControllerOptions {
  readonly store: WorkflowRunStore;
  readonly now?: () => number;
  readonly control: WorkflowRunExecutionControl;
}

export interface WorkflowRunExecutionControl {
  pause(): void;
  resume(): void;
}

export type WorkflowRunControllerError =
  | WorkflowRunStoreError
  | WorkflowTransitionError
  | WorkflowRunControlOperationError;

export interface WorkflowRunControlOperationError {
  readonly _tag: "WorkflowRunControlOperationError";
  readonly message: string;
  readonly runId: string;
  readonly operation: "pause" | "resume";
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
}

function controlOperationError(
  runId: string,
  operation: "pause" | "resume",
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

// Background execution of a launched workflow run: deferring the script run,
// persisting live manifests while it progresses, and writing the terminal
// artifacts (output file, final manifest, task notification) when it settles.
// Source selection lives in source.ts; terminal-state builders in run-state.ts.
import { errorMessage } from "#src/workflows/guards.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { tryRunWorkflowScript } from "#src/workflows/script/runtime.ts";
import { toTaskNotification, toTerminalOutput } from "./notification.ts";
import { completeRunState, failRunState, mergeRuntimeState, stopRunState } from "./run-state.ts";
import type { WorkflowLaunchOperations } from "./operations.ts";
import type {
  WorkflowLaunchBackgroundError,
  WorkflowLaunchPersistenceError,
  WorkflowRunStateObserver,
  WorkflowTerminalNotificationError,
  WorkflowTerminalNotifier,
} from "./model.ts";
import type { WorkflowRunState, WorkflowRunStatus } from "#src/workflows/run/model.ts";
import type {
  WorkflowRuntimeControl,
  WorkflowRuntimeOptions,
  WorkflowRuntimeState,
} from "#src/workflows/script/model.ts";

export interface BackgroundExecutionOptions {
  readonly source: string;
  readonly initialState: WorkflowRunState;
  readonly rootDir: string;
  readonly operations: WorkflowLaunchOperations;
  readonly now: () => number;
  readonly defer: (start: () => void) => void;
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly onRunStateChange?: WorkflowRunStateObserver;
  readonly inlineResultMaxChars?: number;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly onComplete?: () => void;
}

export function startBackgroundExecution(
  options: BackgroundExecutionOptions,
): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  return new Promise((resolve) => {
    options.defer(() => {
      void executeWorkflowInBackground(options)
        .finally(() => options.onComplete?.())
        .then(resolve)
        .catch((cause) => resolve(err(backgroundError(options.initialState.runId, cause))));
    });
  });
}

export function notifyRunStateChange(
  observer: WorkflowRunStateObserver | undefined,
  state: WorkflowRunState,
): void {
  try {
    observer?.(state);
  } catch {
    // UI observers are best-effort and must not affect workflow execution.
  }
}

async function executeWorkflowInBackground({
  source,
  initialState,
  rootDir,
  operations,
  now,
  outputPath,
  summarySource,
  notifyTerminal,
  onRunStateChange,
  inlineResultMaxChars,
  runtimeOptions,
}: BackgroundExecutionOptions): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  let runtimeControl: WorkflowRuntimeControl | undefined;
  const getLiveStatus = (): WorkflowRunStatus | undefined => deriveLiveStatus(runtimeControl);
  const liveManifest = createLiveManifestPersister({
    initialState,
    rootDir,
    operations,
    getLiveStatus,
  });
  const runtimeResult = await tryRunWorkflowScript(source, {
    ...runtimeOptions,
    onControlReady: (control) => {
      runtimeControl = control;
      runtimeOptions.onControlReady?.(control);
    },
    onStateChange: (runtimeState) => {
      runtimeOptions.onStateChange?.(runtimeState);
      notifyRunStateChange(
        onRunStateChange,
        mergeRuntimeState(initialState, runtimeState, getLiveStatus()),
      );
      liveManifest.persist(runtimeState);
    },
  });
  await liveManifest.flush();

  const finalize = (
    terminalState: Result<WorkflowRunState, { readonly message: string }>,
  ): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> =>
    finalizeRun(terminalState, {
      runId: initialState.runId,
      outputPath,
      summarySource,
      notifyTerminal,
      onRunStateChange,
      inlineResultMaxChars,
      rootDir,
      operations,
    });

  if (runtimeResult.status === "ok") {
    const terminalState =
      runtimeResult.value.stopped === true
        ? stopRunState(initialState, runtimeResult.value, now(), outputPath)
        : completeRunState(initialState, runtimeResult.value, now(), outputPath);
    return finalize(terminalState);
  }

  const failed = failRunState(
    initialState,
    runtimeResult.error.message,
    now(),
    outputPath,
    runtimeResult.error.partialState,
  );
  const finalized = await finalize(failed);
  if (finalized.status === "error") return finalized;
  return err(backgroundError(initialState.runId, runtimeResult.error));
}

interface FinalizeRunOptions {
  readonly runId: string;
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly onRunStateChange?: WorkflowRunStateObserver;
  readonly inlineResultMaxChars?: number;
  readonly rootDir: string;
  readonly operations: WorkflowLaunchOperations;
}

/**
 * The shared tail of every terminal path: persist the terminal artifacts,
 * notify observers, and wrap any failure as a background error. Success,
 * stop, and failure branches differ only in which state builder ran before.
 */
async function finalizeRun(
  terminalState: Result<WorkflowRunState, { readonly message: string }>,
  options: FinalizeRunOptions,
): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  if (terminalState.status === "error") {
    return err(backgroundError(options.runId, terminalState.error));
  }

  const terminal = await writeTerminalArtifacts({
    state: terminalState.value,
    outputPath: options.outputPath,
    summarySource: options.summarySource,
    notifyTerminal: options.notifyTerminal,
    inlineResultMaxChars: options.inlineResultMaxChars,
    rootDir: options.rootDir,
    operations: options.operations,
  });
  if (terminal.status === "error") return err(backgroundError(options.runId, terminal.error));

  notifyRunStateChange(options.onRunStateChange, terminalState.value);
  return ok(terminalState.value);
}

function createLiveManifestPersister({
  initialState,
  rootDir,
  operations,
  getLiveStatus,
}: {
  readonly initialState: WorkflowRunState;
  readonly rootDir: string;
  readonly operations: WorkflowLaunchOperations;
  readonly getLiveStatus: () => WorkflowRunStatus | undefined;
}): {
  readonly persist: (runtimeState: WorkflowRuntimeState) => void;
  readonly flush: () => Promise<void>;
} {
  let tail = Promise.resolve();

  return {
    persist: (runtimeState) => {
      const state = mergeRuntimeState(initialState, runtimeState, getLiveStatus());
      tail = tail
        .then(async () => {
          await operations.writeRun({ rootDir, state });
          return undefined;
        })
        .catch(() => undefined);
    },
    flush: async () => {
      await tail;
    },
  };
}

interface TerminalArtifactsOptions {
  readonly state: WorkflowRunState;
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly inlineResultMaxChars?: number;
  readonly rootDir: string;
  readonly operations: WorkflowLaunchOperations;
}

async function writeTerminalArtifacts({
  state,
  outputPath,
  summarySource,
  notifyTerminal,
  inlineResultMaxChars,
  rootDir,
  operations,
}: TerminalArtifactsOptions): Promise<
  Result<void, WorkflowLaunchPersistenceError | WorkflowTerminalNotificationError>
> {
  const output = await operations.writeTerminalOutput({
    outputPath,
    output: toTerminalOutput(state, outputPath),
  });
  if (output.status === "error") return output;

  const persisted = await operations.writeRun({ rootDir, state });
  if (persisted.status === "error") return persisted;

  if (notifyTerminal !== undefined) {
    const notification = toTaskNotification(state, outputPath, summarySource, inlineResultMaxChars);
    try {
      await notifyTerminal(notification);
    } catch (cause) {
      return err({
        _tag: "WorkflowTerminalNotificationError",
        message: `Could not enqueue terminal notification for workflow run '${state.runId}'.`,
        cause,
      });
    }
  }

  return ok(undefined);
}

/**
 * Derives the status a *live* (non-terminal) manifest write should record from
 * the runtime control. The live persister fires on every scheduler progress
 * event, including ones emitted by in-flight agents that settle after the run
 * was paused or stopped. Without this, {@link mergeRuntimeState} would always
 * re-stamp `initialState.status` (`"running"`) and clobber a `paused`/`stopped`
 * status the controller wrote to disk. Returning `undefined` leaves the merged
 * status untouched (the run is still running). Terminal writes go through the
 * state-machine builders, not this path, so only the in-flight states matter.
 */
function deriveLiveStatus(
  control: WorkflowRuntimeControl | undefined,
): WorkflowRunStatus | undefined {
  if (control === undefined) return undefined;
  if (control.isStopped()) return "stopped";
  if (control.isPaused()) return "paused";
  return undefined;
}

function backgroundError(runId: string, cause: unknown): WorkflowLaunchBackgroundError {
  return {
    _tag: "WorkflowLaunchBackgroundError",
    message: errorMessage(cause),
    runId,
    cause,
  };
}

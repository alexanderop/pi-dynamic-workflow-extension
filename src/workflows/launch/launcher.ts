import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { buildWorkflowJournalResultCache } from "#src/workflows/journal/store.ts";
import { tryParseWorkflowScript } from "#src/workflows/script/parser.ts";
import { tryRunWorkflowScript } from "#src/workflows/script/runtime.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { registerWorkflowRunControl } from "#src/workflows/run/control-registry.ts";
import {
  workflowRunJournalPath,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
} from "#src/workflows/run/root-dir.ts";
import { transitionRun } from "#src/workflows/run/state-machine.ts";
import {
  personalSavedWorkflowDir,
  projectSavedWorkflowDir,
} from "#src/workflows/saved/resolver.ts";
import { toTaskNotification, toTerminalOutput } from "./notification.ts";
import {
  defaultWorkflowLaunchOperations,
  persistenceError,
  type WorkflowLaunchOperations,
} from "./operations.ts";
import { WORKFLOW_SCRIPT_MAX_LENGTH } from "./model.ts";
import type {
  WorkflowLaunch,
  WorkflowLaunchBackgroundError,
  WorkflowLaunchError,
  WorkflowLaunchInvalidRequestError,
  WorkflowLaunchOptions,
  WorkflowLaunchPersistenceError,
  WorkflowLaunchRequest,
  WorkflowRunStateObserver,
  WorkflowTerminalNotificationError,
  WorkflowTerminalNotifier,
} from "./model.ts";
import type { WorkflowProgressEntry, WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowRuntimeOptions, WorkflowRuntimeState } from "#src/workflows/script/model.ts";

export {
  workflowRunJournalPath,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
};

export type {
  WorkflowLaunch,
  WorkflowLaunchBackgroundError,
  WorkflowLaunchError,
  WorkflowLaunchInvalidRequestError,
  WorkflowLaunchOptions,
  WorkflowLaunchParseError,
  WorkflowLaunchPersistenceError,
  WorkflowLaunchRequest,
  WorkflowTaskNotification,
  WorkflowTaskNotificationDetails,
  WorkflowRunStateObserver,
  WorkflowTaskUsage,
  WorkflowTerminalNotifier,
  WorkflowTerminalOutput,
} from "./model.ts";
export type {
  WorkflowSavedWorkflowError,
  WorkflowSavedWorkflowInvalidError,
  WorkflowSavedWorkflowInvalidNameError,
  WorkflowSavedWorkflowLocations,
  WorkflowSavedWorkflowNotFoundError,
  WorkflowSavedWorkflowReadError,
} from "#src/workflows/saved/resolver.ts";

export async function launchWorkflow(
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
): Promise<Result<WorkflowLaunch, WorkflowLaunchError>> {
  const operations = options.operations ?? defaultWorkflowLaunchOperations;
  const source = await loadLaunchSource(request, options, operations);
  if (source.status === "error") return source;

  const parsed = tryParseWorkflowScript(source.value.script);
  if (parsed.status === "error") {
    return err({
      _tag: "WorkflowLaunchParseError",
      message: parsed.error.message,
      cause: parsed.error,
    });
  }

  const resume = await loadResumeCache(request, options.rootDir, operations);
  if (resume.status === "error") return resume;

  const now = options.now ?? Date.now;
  const taskId = (options.createTaskId ?? randomTaskId)();
  const runId = (options.createRunId ?? randomRunId)();
  const scriptPath = workflowRunScriptPath(options.rootDir, runId);
  const transcriptDir = workflowRunTranscriptDir(options.rootDir, runId);
  const outputPath = workflowRunOutputPath(options.rootDir, runId);
  const journalPath = workflowRunJournalPath(options.rootDir, runId);
  const summarySource =
    /* v8 ignore next -- parser guarantees meta.description is a non-empty string */
    parsed.value.meta.description ?? request.description ?? parsed.value.meta.name;
  const initialState: WorkflowRunState = {
    runId,
    taskId,
    sessionId: options.sessionId,
    triggerSource: options.triggerSource,
    workflowName: parsed.value.meta.name,
    /* v8 ignore next -- parser guarantees meta.description is a non-empty string */
    description: parsed.value.meta.description ?? request.description,
    status: "running",
    defaultModel: parsed.value.meta.model ?? options.defaultModel,
    script: source.value.script,
    scriptPath,
    phases: (parsed.value.meta.phases ?? []).map((phase) => ({ title: phase.title })),
    logs: [],
    workflowProgress: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    startTime: now(),
  };

  const prepared = await operations.prepareRunFiles({
    rootDir: options.rootDir,
    runId,
    script: source.value.script,
    initialState,
  });
  if (prepared.status === "error") return prepared;
  notifyRunStateChange(options.onRunStateChange, initialState);

  let unregisterRuntimeControl: (() => void) | undefined;
  const completion = startBackgroundExecution({
    source: source.value.script,
    initialState,
    rootDir: options.rootDir,
    operations,
    now,
    defer: options.defer ?? defaultDefer,
    outputPath,
    summarySource,
    notifyTerminal: options.notifyTerminal,
    onRunStateChange: options.onRunStateChange,
    inlineResultMaxChars: options.inlineResultMaxChars,
    runtimeOptions: {
      args: request.args,
      agentRunner: options.agentRunner,
      schedulerRunner: options.schedulerRunner,
      maxConcurrentAgents: options.maxConcurrentAgents,
      maxTotalAgents: options.maxTotalAgents,
      budgetTotal: options.budgetTotal,
      defaultModel: options.defaultModel,
      onControlReady: (control) => {
        unregisterRuntimeControl = registerWorkflowRunControl(runId, control);
        options.onRuntimeControlReady?.(control);
      },
      cwd: options.cwd ?? workflowProjectCwdFromRootDir(options.rootDir),
      journal: operations.createJournal(journalPath),
      replayCache: resume.value,
    },
    onComplete: () => {
      unregisterRuntimeControl?.();
    },
  });

  return ok({
    taskId,
    runId,
    scriptPath,
    transcriptDir,
    confirmation: formatLaunchConfirmation({ taskId, runId, scriptPath, transcriptDir }),
    completion,
  });
}

function workflowProjectCwdFromRootDir(rootDir: string): string {
  return dirname(dirname(rootDir));
}

async function loadResumeCache(
  request: WorkflowLaunchRequest,
  rootDir: string,
  operations: WorkflowLaunchOperations,
): Promise<
  Result<
    ReturnType<typeof buildWorkflowJournalResultCache> | undefined,
    WorkflowLaunchPersistenceError
  >
> {
  if (request.resumeFromRunId === undefined) return ok(undefined);

  const journalPath = workflowRunJournalPath(rootDir, request.resumeFromRunId);
  try {
    const events = await operations.readJournalEvents(journalPath);
    return ok(buildWorkflowJournalResultCache(events));
  } catch (cause) {
    return err(persistenceError(journalPath, cause));
  }
}

async function loadLaunchSource(
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
  operations: WorkflowLaunchOperations,
): Promise<Result<{ readonly kind: "script"; readonly script: string }, WorkflowLaunchError>> {
  const selected = selectLaunchSource(request);
  if (selected.status === "error") return selected;

  switch (selected.value.kind) {
    case "script":
      return ok(selected.value);
    case "name": {
      const resolved = await operations.resolveSavedWorkflowByName(selected.value.name, {
        projectDir:
          options.savedWorkflowDirs?.projectDir ?? projectSavedWorkflowDir(options.rootDir),
        personalDir: options.savedWorkflowDirs?.personalDir ?? personalSavedWorkflowDir(),
      });
      if (resolved.status === "error") return resolved;
      return ok({ kind: "script", script: resolved.value.source });
    }
    case "scriptPath": {
      const source = await operations.readSavedWorkflowScriptPath(selected.value.scriptPath);
      if (source.status === "error") return source;
      return ok({ kind: "script", script: source.value });
    }
  }
}

function selectLaunchSource(
  request: WorkflowLaunchRequest,
): Result<
  | { readonly kind: "script"; readonly script: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "scriptPath"; readonly scriptPath: string },
  WorkflowLaunchInvalidRequestError
> {
  if (request.scriptPath !== undefined)
    return ok({ kind: "scriptPath", scriptPath: request.scriptPath });

  if (request.script !== undefined) {
    if (request.script.length === 0) {
      return err({
        _tag: "WorkflowLaunchInvalidRequestError",
        message: "Workflow launch script must not be empty.",
      });
    }
    if (request.script.length > WORKFLOW_SCRIPT_MAX_LENGTH) {
      return err({
        _tag: "WorkflowLaunchInvalidRequestError",
        message: `Workflow launch script must not exceed ${WORKFLOW_SCRIPT_MAX_LENGTH} characters.`,
      });
    }
    return ok({ kind: "script", script: request.script });
  }

  if (request.name !== undefined) return ok({ kind: "name", name: request.name });

  return err({
    _tag: "WorkflowLaunchInvalidRequestError",
    message: "Workflow launch requires one of script, name, or scriptPath.",
  });
}

interface BackgroundExecutionOptions {
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

function startBackgroundExecution({
  source,
  initialState,
  rootDir,
  operations,
  now,
  defer,
  outputPath,
  summarySource,
  notifyTerminal,
  onRunStateChange,
  inlineResultMaxChars,
  runtimeOptions,
  onComplete,
}: BackgroundExecutionOptions): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  return new Promise((resolve) => {
    defer(() => {
      void executeWorkflowInBackground({
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
      })
        .finally(() => onComplete?.())
        .then(resolve)
        .catch((cause) => resolve(err(backgroundError(initialState.runId, cause))));
    });
  });
}

interface ExecuteWorkflowInBackgroundOptions {
  readonly source: string;
  readonly initialState: WorkflowRunState;
  readonly rootDir: string;
  readonly operations: WorkflowLaunchOperations;
  readonly now: () => number;
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly onRunStateChange?: WorkflowRunStateObserver;
  readonly inlineResultMaxChars?: number;
  readonly runtimeOptions: WorkflowRuntimeOptions;
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
}: ExecuteWorkflowInBackgroundOptions): Promise<
  Result<WorkflowRunState, WorkflowLaunchBackgroundError>
> {
  const liveManifest = createLiveManifestPersister({ initialState, rootDir, operations });
  const runtimeResult = await tryRunWorkflowScript(source, {
    ...runtimeOptions,
    onStateChange: (runtimeState) => {
      runtimeOptions.onStateChange?.(runtimeState);
      notifyRunStateChange(onRunStateChange, mergeRuntimeState(initialState, runtimeState));
      liveManifest.persist(runtimeState);
    },
  });
  await liveManifest.flush();

  if (runtimeResult.status === "ok") {
    const terminalState =
      runtimeResult.value.stopped === true
        ? stopRunState(initialState, runtimeResult.value, now(), outputPath)
        : completeRunState(initialState, runtimeResult.value, now(), outputPath);
    const terminal = await writeTerminalArtifacts({
      state: terminalState,
      outputPath,
      summarySource,
      notifyTerminal,
      inlineResultMaxChars,
      rootDir,
      operations,
    });
    if (terminal.status === "error")
      return err(backgroundError(initialState.runId, terminal.error));
    notifyRunStateChange(onRunStateChange, terminalState);
    return ok(terminalState);
  }

  const failed = failRunState(
    initialState,
    runtimeResult.error.message,
    now(),
    outputPath,
    runtimeResult.error.partialState,
  );
  const terminal = await writeTerminalArtifacts({
    state: failed,
    outputPath,
    summarySource,
    notifyTerminal,
    inlineResultMaxChars,
    rootDir,
    operations,
  });
  if (terminal.status === "error") return err(backgroundError(initialState.runId, terminal.error));
  notifyRunStateChange(onRunStateChange, failed);
  return err(backgroundError(initialState.runId, runtimeResult.error));
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

function createLiveManifestPersister({
  initialState,
  rootDir,
  operations,
}: {
  readonly initialState: WorkflowRunState;
  readonly rootDir: string;
  readonly operations: WorkflowLaunchOperations;
}): {
  readonly persist: (runtimeState: WorkflowRuntimeState) => void;
  readonly flush: () => Promise<void>;
} {
  let tail = Promise.resolve();

  return {
    persist: (runtimeState) => {
      const state = mergeRuntimeState(initialState, runtimeState);
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

function notifyRunStateChange(
  observer: WorkflowRunStateObserver | undefined,
  state: WorkflowRunState,
): void {
  try {
    observer?.(state);
  } catch {
    // UI observers are best-effort and must not affect workflow execution.
  }
}

function completeRunState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  now: number,
  outputPath: string,
): WorkflowRunState {
  const withRuntimeState = mergeRuntimeState(initialState, runtimeState);
  const completing = transitionRun(withRuntimeState, { type: "run_complete_requested", now });
  /* v8 ignore start -- defensive: a running run always accepts run_complete_requested */
  if (completing.status === "error") throw new Error(completing.error.message);
  /* v8 ignore stop */
  const completed = transitionRun(completing.value, {
    type: "run_completed",
    now,
    result: runtimeState.result,
  });
  /* v8 ignore start -- defensive: a completing run always accepts run_completed */
  if (completed.status === "error") throw new Error(completed.error.message);
  /* v8 ignore stop */
  return { ...completed.value, outputPath };
}

function stopRunState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  now: number,
  outputPath: string,
): WorkflowRunState {
  const withRuntimeState = mergeRuntimeState(initialState, runtimeState);
  const stopping = transitionRun(withRuntimeState, { type: "run_stop_requested", now });
  /* v8 ignore start -- defensive: a running run always accepts run_stop_requested */
  if (stopping.status === "error") throw new Error(stopping.error.message);
  /* v8 ignore stop */
  const stopped = transitionRun(stopping.value, { type: "run_stopped", now });
  /* v8 ignore start -- defensive: a stopping run always accepts run_stopped */
  if (stopped.status === "error") throw new Error(stopped.error.message);
  /* v8 ignore stop */
  return { ...stopped.value, result: runtimeState.result, outputPath };
}

function failRunState(
  initialState: WorkflowRunState,
  message: string,
  now: number,
  outputPath: string,
  runtimeState?: WorkflowRuntimeState,
): WorkflowRunState {
  const failure = { scope: "run" as const, message };
  const state =
    runtimeState === undefined ? initialState : mergeRuntimeState(initialState, runtimeState);
  const failing = transitionRun(state, { type: "run_fail_requested", now, failure });
  /* v8 ignore start -- defensive: a running run always accepts run_fail_requested */
  if (failing.status === "error") throw new Error(failing.error.message);
  /* v8 ignore stop */
  const failed = transitionRun(failing.value, { type: "run_failed", now, failure });
  /* v8 ignore start -- defensive: a failing run always accepts run_failed */
  if (failed.status === "error") throw new Error(failed.error.message);
  /* v8 ignore stop */
  return { ...failed.value, outputPath };
}

function mergeRuntimeState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
): WorkflowRunState {
  return {
    ...initialState,
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

function countAgents(progress: WorkflowProgressEntry[]): number {
  return progress.filter((entry) => entry.type === "workflow_agent").length;
}

function sumProgressNumber(progress: WorkflowProgressEntry[], key: "tokens" | "toolCalls"): number {
  return progress.reduce((sum, entry) => {
    if (entry.type !== "workflow_agent") return sum;
    return sum + (entry[key] ?? 0);
  }, 0);
}

function formatLaunchConfirmation({
  taskId,
  runId,
  scriptPath,
  transcriptDir,
}: {
  readonly taskId: string;
  readonly runId: string;
  readonly scriptPath: string;
  readonly transcriptDir: string;
}): string {
  return [
    `Workflow launched in background. Task ID: ${taskId}`,
    `Run ID: ${runId}`,
    `Script file: ${scriptPath}`,
    `Transcript dir: ${transcriptDir}`,
    "You will be notified when it completes. Use /workflows to watch live progress.",
  ].join("\n");
}

function backgroundError(runId: string, cause: unknown): WorkflowLaunchBackgroundError {
  return {
    _tag: "WorkflowLaunchBackgroundError",
    message: errorMessage(cause),
    runId,
    cause,
  };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (hasMessage(cause)) return cause.message;
  return String(cause);
}

function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function defaultDefer(start: () => void): void {
  setImmediate(start);
}

function randomTaskId(): string {
  return `task_${randomBytes(6).toString("hex")}`;
}

function randomRunId(): string {
  return `wf_${randomBytes(8).toString("hex")}`;
}

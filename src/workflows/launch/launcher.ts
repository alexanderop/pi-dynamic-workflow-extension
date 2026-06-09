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
import {
  transitionRun,
  type WorkflowRunEvent,
  type WorkflowTransitionError,
} from "#src/workflows/run/state-machine.ts";
import { isScriptPathWithinRoot, projectSavedWorkflowDir } from "#src/workflows/saved/resolver.ts";
import { toTaskNotification, toTerminalOutput } from "./notification.ts";
import {
  defaultWorkflowLaunchOperations,
  persistenceError,
  type WorkflowLaunchOperations,
} from "./operations.ts";
import {
  DEFAULT_WORKFLOW_FEATURES,
  workflowFeatureKeys,
  type WorkflowFeatureDecision,
  type WorkflowFeatureFlags,
} from "#src/workflows/features/registry.ts";
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
import type {
  WorkflowProgressEntry,
  WorkflowRunState,
  WorkflowRunStatus,
} from "#src/workflows/run/model.ts";
import type {
  WorkflowRuntimeControl,
  WorkflowRuntimeOptions,
  WorkflowRuntimeState,
} from "#src/workflows/script/model.ts";

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

/**
 * Domain-layer guard for `resumeFromRunId`. The Pi tool schema also enforces
 * this shape, but the launcher must not trust callers: the id is interpolated
 * into a journal file path, so a traversal value (`../../etc/...`) would read an
 * arbitrary journal. Mirrors the tool-layer TypeBox pattern.
 */
const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

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

  if (
    request.resumeFromRunId !== undefined &&
    !WORKFLOW_RUN_ID_PATTERN.test(request.resumeFromRunId)
  ) {
    return err({
      _tag: "WorkflowLaunchInvalidRequestError",
      message: `Workflow resumeFromRunId '${request.resumeFromRunId}' is not a valid run id.`,
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
    parsed.value.meta.description ?? request.description ?? parsed.value.meta.name;
  const launchFeatures = resolveLaunchFeatures(options);
  const initialState: WorkflowRunState = {
    runId,
    taskId,
    sessionId: options.sessionId,
    triggerSource: options.triggerSource,
    workflowName: parsed.value.meta.name,
    description: parsed.value.meta.description ?? request.description,
    args: request.args,
    status: "running",
    defaultModel: launchFeatures.features.experimentalModelRouting
      ? (parsed.value.meta.model ?? options.defaultModel)
      : options.defaultModel,
    defaultThinkingLevel: parsed.value.meta.thinkingLevel ?? options.defaultThinkingLevel,
    features: launchFeatures.features,
    featureDecisions: launchFeatures.decisions,
    script: source.value.script,
    scriptPath,
    phases: (parsed.value.meta.phases ?? []).map((phase) => ({
      title: phase.title,
      ...(phase.detail === undefined ? {} : { detail: phase.detail }),
      ...(phase.model === undefined ? {} : { model: phase.model }),
      ...(phase.thinkingLevel === undefined ? {} : { thinkingLevel: phase.thinkingLevel }),
      ...(phase.agentCount === undefined ? {} : { agentCount: phase.agentCount }),
      ...(phase.agents === undefined ? {} : { agents: phase.agents }),
    })),
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
      defaultModel: launchFeatures.features.experimentalModelRouting
        ? (parsed.value.meta.model ?? options.defaultModel)
        : options.defaultModel,
      defaultThinkingLevel: parsed.value.meta.thinkingLevel ?? options.defaultThinkingLevel,
      availableModels: options.availableModels,
      features: launchFeatures.features,
      featureDecisions: launchFeatures.decisions,
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

function resolveLaunchFeatures(options: WorkflowLaunchOptions): {
  readonly features: WorkflowFeatureFlags;
  readonly decisions: readonly WorkflowFeatureDecision[];
} {
  const features: WorkflowFeatureFlags = {
    ...DEFAULT_WORKFLOW_FEATURES,
    ...options.features,
  };
  if (options.featureDecisions !== undefined) {
    return { features, decisions: options.featureDecisions };
  }

  const decisions = workflowFeatureKeys().map((key): WorkflowFeatureDecision => {
    const value = features[key];
    const source = options.features?.[key] === undefined ? "default" : "override";
    return { key, value, source };
  });
  return { features, decisions };
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
      });
      if (resolved.status === "error") return resolved;
      return ok({ kind: "script", script: resolved.value.source });
    }
    case "scriptPath": {
      const projectRoot = workflowProjectCwdFromRootDir(options.rootDir);
      if (!isScriptPathWithinRoot(projectRoot, selected.value.scriptPath)) {
        return err({
          _tag: "WorkflowLaunchInvalidRequestError",
          message: `Workflow scriptPath '${selected.value.scriptPath}' is outside the workflow project directory '${projectRoot}'.`,
        });
      }
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

  if (runtimeResult.status === "ok") {
    const terminalState =
      runtimeResult.value.stopped === true
        ? stopRunState(initialState, runtimeResult.value, now(), outputPath)
        : completeRunState(initialState, runtimeResult.value, now(), outputPath);
    if (terminalState.status === "error")
      return err(backgroundError(initialState.runId, terminalState.error));
    const terminal = await writeTerminalArtifacts({
      state: terminalState.value,
      outputPath,
      summarySource,
      notifyTerminal,
      inlineResultMaxChars,
      rootDir,
      operations,
    });
    if (terminal.status === "error")
      return err(backgroundError(initialState.runId, terminal.error));
    notifyRunStateChange(onRunStateChange, terminalState.value);
    return ok(terminalState.value);
  }

  const failed = failRunState(
    initialState,
    runtimeResult.error.message,
    now(),
    outputPath,
    runtimeResult.error.partialState,
  );
  if (failed.status === "error") return err(backgroundError(initialState.runId, failed.error));
  const terminal = await writeTerminalArtifacts({
    state: failed.value,
    outputPath,
    summarySource,
    notifyTerminal,
    inlineResultMaxChars,
    rootDir,
    operations,
  });
  if (terminal.status === "error") return err(backgroundError(initialState.runId, terminal.error));
  notifyRunStateChange(onRunStateChange, failed.value);
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

function completeRunState(
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

function stopRunState(
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

function failRunState(
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

function mergeRuntimeState(
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

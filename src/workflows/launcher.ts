import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tryParseWorkflowScript, type WorkflowParseError } from "./parser.ts";
import { err, ok, type Result } from "./result.ts";
import { transitionRun } from "./state-machine.ts";
import { tryRunWorkflowScript, type WorkflowRuntimeOptions } from "./runtime.ts";
import { WorkflowRunStore } from "./run-store.ts";
import type { WorkflowProgressEntry, WorkflowRunState, WorkflowRuntimeState } from "./types.ts";

export interface WorkflowLaunchRequest {
  readonly script?: string;
  readonly name?: string;
  readonly scriptPath?: string;
  readonly args?: unknown;
  readonly resumeFromRunId?: string;
  readonly description?: string;
}

export interface WorkflowLaunchOptions {
  readonly rootDir: string;
  readonly now?: () => number;
  readonly createTaskId?: () => string;
  readonly createRunId?: () => string;
  readonly defer?: (start: () => void) => void;
  readonly agentRunner?: WorkflowRuntimeOptions["agentRunner"];
  readonly maxConcurrentAgents?: number;
  readonly maxTotalAgents?: number;
  readonly budgetTotal?: number | null;
}

export interface WorkflowLaunch {
  readonly taskId: string;
  readonly runId: string;
  readonly scriptPath: string;
  readonly transcriptDir: string;
  readonly confirmation: string;
  readonly completion: Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>>;
}

export type WorkflowLaunchError =
  | WorkflowLaunchInvalidRequestError
  | WorkflowLaunchUnsupportedSourceError
  | WorkflowLaunchParseError
  | WorkflowLaunchPersistenceError;

export interface WorkflowLaunchInvalidRequestError {
  readonly _tag: "WorkflowLaunchInvalidRequestError";
  readonly message: string;
}

export interface WorkflowLaunchUnsupportedSourceError {
  readonly _tag: "WorkflowLaunchUnsupportedSourceError";
  readonly message: string;
  readonly source: "name" | "scriptPath";
}

export interface WorkflowLaunchParseError {
  readonly _tag: "WorkflowLaunchParseError";
  readonly message: string;
  readonly cause: WorkflowParseError;
}

export interface WorkflowLaunchPersistenceError {
  readonly _tag: "WorkflowLaunchPersistenceError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowLaunchBackgroundError {
  readonly _tag: "WorkflowLaunchBackgroundError";
  readonly message: string;
  readonly runId: string;
  readonly cause: unknown;
}

export async function launchWorkflow(
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
): Promise<Result<WorkflowLaunch, WorkflowLaunchError>> {
  const source = selectLaunchSource(request);
  if (source.status === "error") return source;
  if (source.value.kind !== "script") return err(unsupportedSourceError(source.value.kind));

  const parsed = tryParseWorkflowScript(source.value.script);
  if (parsed.status === "error") {
    return err({
      _tag: "WorkflowLaunchParseError",
      message: parsed.error.message,
      cause: parsed.error,
    });
  }

  const now = options.now ?? Date.now;
  const taskId = (options.createTaskId ?? randomTaskId)();
  const runId = (options.createRunId ?? randomRunId)();
  const scriptPath = workflowRunScriptPath(options.rootDir, runId);
  const transcriptDir = workflowRunTranscriptDir(options.rootDir, runId);
  const initialState: WorkflowRunState = {
    runId,
    taskId,
    workflowName: parsed.value.meta.name,
    status: "running",
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

  const prepared = await prepareRunFiles(options.rootDir, runId, source.value.script, initialState);
  if (prepared.status === "error") return prepared;

  const store = new WorkflowRunStore({ rootDir: options.rootDir });
  const completion = startBackgroundExecution({
    source: source.value.script,
    initialState,
    store,
    now,
    defer: options.defer ?? defaultDefer,
    runtimeOptions: {
      args: request.args,
      agentRunner: options.agentRunner,
      maxConcurrentAgents: options.maxConcurrentAgents,
      maxTotalAgents: options.maxTotalAgents,
      budgetTotal: options.budgetTotal,
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

export function workflowRunScriptPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "script.js");
}

export function workflowRunTranscriptDir(rootDir: string, runId: string): string {
  return join(rootDir, runId, "transcripts");
}

function selectLaunchSource(
  request: WorkflowLaunchRequest,
): Result<
  | { readonly kind: "script"; readonly script: string }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "scriptPath"; readonly scriptPath: string },
  WorkflowLaunchInvalidRequestError
> {
  const provided = [
    request.script === undefined ? undefined : "script",
    request.name === undefined ? undefined : "name",
    request.scriptPath === undefined ? undefined : "scriptPath",
  ].filter((kind): kind is "script" | "name" | "scriptPath" => kind !== undefined);

  if (provided.length !== 1) {
    return err({
      _tag: "WorkflowLaunchInvalidRequestError",
      message: "Workflow launch requires exactly one of script, name, or scriptPath.",
    });
  }

  if (provided[0] === "script") {
    if (request.script!.length === 0) {
      return err({
        _tag: "WorkflowLaunchInvalidRequestError",
        message: "Workflow launch script must not be empty.",
      });
    }
    return ok({ kind: "script", script: request.script! });
  }

  if (provided[0] === "name") return ok({ kind: "name", name: request.name! });
  return ok({ kind: "scriptPath", scriptPath: request.scriptPath! });
}

function unsupportedSourceError(
  source: "name" | "scriptPath",
): WorkflowLaunchUnsupportedSourceError {
  return {
    _tag: "WorkflowLaunchUnsupportedSourceError",
    source,
    message:
      source === "name"
        ? "Saved workflow launch by name is not implemented yet."
        : "Workflow launch by scriptPath is not implemented yet.",
  };
}

async function prepareRunFiles(
  rootDir: string,
  runId: string,
  script: string,
  initialState: WorkflowRunState,
): Promise<Result<void, WorkflowLaunchPersistenceError>> {
  try {
    await mkdir(rootDir, { recursive: true });
    await mkdir(join(rootDir, runId));
    await mkdir(workflowRunTranscriptDir(rootDir, runId));
    await writeFile(workflowRunScriptPath(rootDir, runId), script, "utf8");
  } catch (cause) {
    return err(persistenceError(join(rootDir, runId), cause));
  }

  const result = await new WorkflowRunStore({ rootDir }).writeRun(initialState);
  if (result.status === "error") {
    return err(persistenceError(result.error.path, result.error.cause));
  }

  return ok(undefined);
}

interface BackgroundExecutionOptions {
  readonly source: string;
  readonly initialState: WorkflowRunState;
  readonly store: WorkflowRunStore;
  readonly now: () => number;
  readonly defer: (start: () => void) => void;
  readonly runtimeOptions: WorkflowRuntimeOptions;
}

function startBackgroundExecution({
  source,
  initialState,
  store,
  now,
  defer,
  runtimeOptions,
}: BackgroundExecutionOptions): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  return new Promise((resolve) => {
    defer(() => {
      void executeWorkflowInBackground(source, initialState, store, now, runtimeOptions)
        .then(resolve)
        .catch((cause) => resolve(err(backgroundError(initialState.runId, cause))));
    });
  });
}

async function executeWorkflowInBackground(
  source: string,
  initialState: WorkflowRunState,
  store: WorkflowRunStore,
  now: () => number,
  runtimeOptions: WorkflowRuntimeOptions,
): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  const runtimeResult = await tryRunWorkflowScript(source, runtimeOptions);
  if (runtimeResult.status === "ok") {
    const completed = completeRunState(initialState, runtimeResult.value, now());
    const persisted = await store.writeRun(completed);
    if (persisted.status === "error")
      return err(backgroundError(initialState.runId, persisted.error));
    return ok(completed);
  }

  const failed = failRunState(
    initialState,
    runtimeResult.error.message,
    now(),
    runtimeResult.error.partialState,
  );
  const persisted = await store.writeRun(failed);
  if (persisted.status === "error")
    return err(backgroundError(initialState.runId, persisted.error));
  return err(backgroundError(initialState.runId, runtimeResult.error));
}

function completeRunState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  now: number,
): WorkflowRunState {
  const withRuntimeState = mergeRuntimeState(initialState, runtimeState);
  const completing = transitionRun(withRuntimeState, { type: "run_complete_requested", now });
  if (completing.status === "error") throw new Error(completing.error.message);
  const completed = transitionRun(completing.value, {
    type: "run_completed",
    now,
    result: runtimeState.result,
  });
  if (completed.status === "error") throw new Error(completed.error.message);
  return completed.value;
}

function failRunState(
  initialState: WorkflowRunState,
  message: string,
  now: number,
  runtimeState?: WorkflowRuntimeState,
): WorkflowRunState {
  const failure = { scope: "run" as const, message };
  const state =
    runtimeState === undefined ? initialState : mergeRuntimeState(initialState, runtimeState);
  const failing = transitionRun(state, { type: "run_fail_requested", now, failure });
  if (failing.status === "error") throw new Error(failing.error.message);
  const failed = transitionRun(failing.value, { type: "run_failed", now, failure });
  if (failed.status === "error") throw new Error(failed.error.message);
  return failed.value;
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

function persistenceError(path: string, cause: unknown): WorkflowLaunchPersistenceError {
  return {
    _tag: "WorkflowLaunchPersistenceError",
    message: `Could not prepare workflow run storage at '${path}'.`,
    path,
    cause,
  };
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

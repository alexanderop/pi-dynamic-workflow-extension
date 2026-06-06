import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildWorkflowJournalResultCache, WorkflowJournalStore } from "../journal/store.ts";
import { tryParseWorkflowScript } from "../script/parser.ts";
import { tryRunWorkflowScript } from "../script/runtime.ts";
import { err, ok, type Result } from "../result.ts";
import { registerWorkflowRunControl } from "../run/control-registry.ts";
import { WorkflowRunStore } from "../run/store.ts";
import { transitionRun } from "../run/state-machine.ts";
import {
  personalSavedWorkflowDir,
  projectSavedWorkflowDir,
  readSavedWorkflowScriptPath,
  resolveSavedWorkflowByName,
} from "../saved/resolver.ts";
import type {
  WorkflowLaunch,
  WorkflowLaunchBackgroundError,
  WorkflowLaunchError,
  WorkflowLaunchInvalidRequestError,
  WorkflowLaunchOptions,
  WorkflowLaunchPersistenceError,
  WorkflowLaunchRequest,
  WorkflowTaskNotification,
  WorkflowTaskNotificationDetails,
  WorkflowTaskUsage,
  WorkflowTerminalNotificationError,
  WorkflowTerminalNotifier,
  WorkflowTerminalOutput,
} from "./model.ts";
import type { WorkflowFailure, WorkflowProgressEntry, WorkflowRunState } from "../run/model.ts";
import type { WorkflowRuntimeOptions, WorkflowRuntimeState } from "../script/model.ts";

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
} from "../saved/resolver.ts";

export async function launchWorkflow(
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
): Promise<Result<WorkflowLaunch, WorkflowLaunchError>> {
  const source = await loadLaunchSource(request, options);
  if (source.status === "error") return source;

  const parsed = tryParseWorkflowScript(source.value.script);
  if (parsed.status === "error") {
    return err({
      _tag: "WorkflowLaunchParseError",
      message: parsed.error.message,
      cause: parsed.error,
    });
  }

  const resume = await loadResumeCache(request, options.rootDir);
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
  const initialState: WorkflowRunState = {
    runId,
    taskId,
    workflowName: parsed.value.meta.name,
    description: parsed.value.meta.description ?? request.description,
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
  let unregisterRuntimeControl: (() => void) | undefined;
  const completion = startBackgroundExecution({
    source: source.value.script,
    initialState,
    store,
    now,
    defer: options.defer ?? defaultDefer,
    outputPath,
    summarySource,
    notifyTerminal: options.notifyTerminal,
    inlineResultMaxChars: options.inlineResultMaxChars,
    runtimeOptions: {
      args: request.args,
      agentRunner: options.agentRunner,
      schedulerRunner: options.schedulerRunner,
      maxConcurrentAgents: options.maxConcurrentAgents,
      maxTotalAgents: options.maxTotalAgents,
      budgetTotal: options.budgetTotal,
      onControlReady: (control) => {
        unregisterRuntimeControl = registerWorkflowRunControl(runId, control);
        options.onRuntimeControlReady?.(control);
      },
      cwd: options.cwd ?? workflowProjectCwdFromRootDir(options.rootDir),
      journal: new WorkflowJournalStore({ journalPath }),
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

export function workflowRunScriptPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "script.js");
}

export function workflowRunTranscriptDir(rootDir: string, runId: string): string {
  return join(rootDir, runId, "transcripts");
}

export function workflowRunOutputPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "output.json");
}

export function workflowRunJournalPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "journal.jsonl");
}

function workflowProjectCwdFromRootDir(rootDir: string): string {
  return dirname(dirname(rootDir));
}

async function loadResumeCache(
  request: WorkflowLaunchRequest,
  rootDir: string,
): Promise<
  Result<
    ReturnType<typeof buildWorkflowJournalResultCache> | undefined,
    WorkflowLaunchPersistenceError
  >
> {
  if (request.resumeFromRunId === undefined) return ok(undefined);

  const journalPath = workflowRunJournalPath(rootDir, request.resumeFromRunId);
  try {
    const events = await new WorkflowJournalStore({ journalPath }).readEvents();
    return ok(buildWorkflowJournalResultCache(events));
  } catch (cause) {
    return err(persistenceError(journalPath, cause));
  }
}

async function loadLaunchSource(
  request: WorkflowLaunchRequest,
  options: WorkflowLaunchOptions,
): Promise<Result<{ readonly kind: "script"; readonly script: string }, WorkflowLaunchError>> {
  const selected = selectLaunchSource(request);
  if (selected.status === "error") return selected;

  switch (selected.value.kind) {
    case "script":
      return ok(selected.value);
    case "name": {
      const resolved = await resolveSavedWorkflowByName(selected.value.name, {
        projectDir:
          options.savedWorkflowDirs?.projectDir ?? projectSavedWorkflowDir(options.rootDir),
        personalDir: options.savedWorkflowDirs?.personalDir ?? personalSavedWorkflowDir(),
      });
      if (resolved.status === "error") return resolved;
      return ok({ kind: "script", script: resolved.value.source });
    }
    case "scriptPath": {
      const source = await readSavedWorkflowScriptPath(selected.value.scriptPath);
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
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly inlineResultMaxChars?: number;
  readonly runtimeOptions: WorkflowRuntimeOptions;
  readonly onComplete?: () => void;
}

function startBackgroundExecution({
  source,
  initialState,
  store,
  now,
  defer,
  outputPath,
  summarySource,
  notifyTerminal,
  inlineResultMaxChars,
  runtimeOptions,
  onComplete,
}: BackgroundExecutionOptions): Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>> {
  return new Promise((resolve) => {
    defer(() => {
      void executeWorkflowInBackground({
        source,
        initialState,
        store,
        now,
        outputPath,
        summarySource,
        notifyTerminal,
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
  readonly store: WorkflowRunStore;
  readonly now: () => number;
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly inlineResultMaxChars?: number;
  readonly runtimeOptions: WorkflowRuntimeOptions;
}

async function executeWorkflowInBackground({
  source,
  initialState,
  store,
  now,
  outputPath,
  summarySource,
  notifyTerminal,
  inlineResultMaxChars,
  runtimeOptions,
}: ExecuteWorkflowInBackgroundOptions): Promise<
  Result<WorkflowRunState, WorkflowLaunchBackgroundError>
> {
  const runtimeResult = await tryRunWorkflowScript(source, runtimeOptions);
  if (runtimeResult.status === "ok") {
    const completed = completeRunState(initialState, runtimeResult.value, now(), outputPath);
    const terminal = await writeTerminalArtifacts({
      state: completed,
      outputPath,
      summarySource,
      notifyTerminal,
      inlineResultMaxChars,
      store,
    });
    if (terminal.status === "error")
      return err(backgroundError(initialState.runId, terminal.error));
    return ok(completed);
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
    store,
  });
  if (terminal.status === "error") return err(backgroundError(initialState.runId, terminal.error));
  return err(backgroundError(initialState.runId, runtimeResult.error));
}

interface TerminalArtifactsOptions {
  readonly state: WorkflowRunState;
  readonly outputPath: string;
  readonly summarySource: string;
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly inlineResultMaxChars?: number;
  readonly store: WorkflowRunStore;
}

async function writeTerminalArtifacts({
  state,
  outputPath,
  summarySource,
  notifyTerminal,
  inlineResultMaxChars,
  store,
}: TerminalArtifactsOptions): Promise<
  Result<void, WorkflowLaunchPersistenceError | WorkflowTerminalNotificationError>
> {
  try {
    await writeFile(
      outputPath,
      `${JSON.stringify(toTerminalOutput(state, outputPath), null, 2)}\n`,
      "utf8",
    );
  } catch (cause) {
    return err(persistenceError(outputPath, cause));
  }

  const persisted = await store.writeRun(state);
  if (persisted.status === "error") {
    return err(persistenceError(persisted.error.path, persisted.error.cause));
  }

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

function toTerminalOutput(state: WorkflowRunState, outputPath: string): WorkflowTerminalOutput {
  return {
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    status: state.status,
    timestamp: state.timestamp,
    durationMs: state.durationMs,
    outputPath,
    result: state.result,
    failures: state.failures,
    usage: terminalUsage(state),
  };
}

function toTaskNotification(
  state: WorkflowRunState,
  outputPath: string,
  summarySource: string,
  inlineResultMaxChars = 4000,
): WorkflowTaskNotification {
  const result = inlineResult(state.result, outputPath, inlineResultMaxChars);
  const details: WorkflowTaskNotificationDetails = {
    taskId: state.taskId,
    runId: state.runId,
    outputFile: outputPath,
    status: state.status,
    summary: `Dynamic workflow "${summarySource}" ${state.status}`,
    result,
    failures: state.failures?.map(formatFailure),
    usage: terminalUsage(state),
  };

  return {
    customType: "workflow-task-notification",
    display: true,
    content: taskNotificationXml(details),
    details,
  };
}

function terminalUsage(state: WorkflowRunState): WorkflowTaskUsage {
  return {
    agentCount: state.agentCount,
    subagentTokens: state.totalTokens,
    toolUses: state.totalToolCalls,
    durationMs: state.durationMs ?? 0,
  };
}

function inlineResult(result: unknown, outputPath: string, maxChars: number): string {
  const text = result === undefined ? "" : stringifyResult(result);
  if (text.length <= maxChars) return text;

  const suffix = `\n[truncated ${text.length - maxChars} chars, full result in ${outputPath}]`;
  if (suffix.length >= maxChars) return suffix.slice(0, maxChars);
  return `${text.slice(0, maxChars - suffix.length)}${suffix}`;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? "";
}

function taskNotificationXml(details: WorkflowTaskNotificationDetails): string {
  return [
    "<task-notification>",
    `  <task-id>${escapeXml(details.taskId)}</task-id>`,
    `  <output-file>${escapeXml(details.outputFile)}</output-file>`,
    `  <status>${escapeXml(details.status)}</status>`,
    `  <summary>${escapeXml(details.summary)}</summary>`,
    `  <result>${escapeXml(details.result)}</result>`,
    failuresXml(details.failures),
    "  <usage>",
    `    <agent_count>${details.usage.agentCount}</agent_count>`,
    `    <subagent_tokens>${details.usage.subagentTokens}</subagent_tokens>`,
    `    <tool_uses>${details.usage.toolUses}</tool_uses>`,
    `    <duration_ms>${details.usage.durationMs}</duration_ms>`,
    "  </usage>",
    "</task-notification>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function failuresXml(failures: string[] | undefined): string | undefined {
  if (failures === undefined || failures.length === 0) return undefined;
  return [
    "  <failures>",
    ...failures.map((failure) => `    <failure>${escapeXml(failure)}</failure>`),
    "  </failures>",
  ].join("\n");
}

function formatFailure(failure: WorkflowFailure): string {
  if (failure.scope === "agent" && failure.agentId !== undefined)
    return `agent ${failure.agentId} failed: ${failure.message}`;
  if (failure.scope === "pipeline" && failure.pipelineIndex !== undefined)
    return `pipeline[${failure.pipelineIndex}] failed: ${failure.message}`;
  return `${failure.scope} failed: ${failure.message}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function completeRunState(
  initialState: WorkflowRunState,
  runtimeState: WorkflowRuntimeState,
  now: number,
  outputPath: string,
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
  return { ...completed.value, outputPath };
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
  if (failing.status === "error") throw new Error(failing.error.message);
  const failed = transitionRun(failing.value, { type: "run_failed", now, failure });
  if (failed.status === "error") throw new Error(failed.error.message);
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

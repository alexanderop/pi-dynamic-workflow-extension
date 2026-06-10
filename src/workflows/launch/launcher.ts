// Workflow launch entry point: validate the request, allocate ids, build the
// initial run state, persist run files, and kick off background execution.
// The concerns it delegates: source selection (source.ts), background
// execution and terminal artifacts (background.ts), terminal-state builders
// (run-state.ts).
import { randomBytes } from "node:crypto";
import { buildWorkflowJournalResultCache } from "#src/workflows/journal/store.ts";
import { resolveDefaultModel } from "#src/workflows/model-routing/agent-options.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { registerWorkflowRunControl } from "#src/workflows/run/control-registry.ts";
import {
  workflowRunJournalPath,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
} from "#src/workflows/run/root-dir.ts";
import { tryParseWorkflowScript, type ParsedWorkflowScript } from "#src/workflows/script/parser.ts";
import { notifyRunStateChange, startBackgroundExecution } from "./background.ts";
import { loadLaunchSource, workflowProjectCwdFromRootDir } from "./source.ts";
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
import type {
  WorkflowLaunch,
  WorkflowLaunchError,
  WorkflowLaunchOptions,
  WorkflowLaunchPersistenceError,
  WorkflowLaunchRequest,
} from "./model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowRuntimeOptions } from "#src/workflows/script/model.ts";

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

/**
 * Injection seam for the launch entry point. Consumers declaring a
 * `launchWorkflow?: WorkflowLauncher` option track the real signature
 * automatically instead of hand-copying it.
 */
export type WorkflowLauncher = typeof launchWorkflow;

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
  const initialState = buildInitialRunState({
    parsed: parsed.value,
    request,
    options,
    launchFeatures,
    ids: { taskId, runId, scriptPath },
    script: source.value.script,
    startTime: now(),
  });

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
    runtimeOptions: buildRuntimeOptions({
      parsed: parsed.value,
      request,
      options,
      launchFeatures,
      journal: operations.createJournal(journalPath),
      replayCache: resume.value,
      onControlReady: (control) => {
        unregisterRuntimeControl = registerWorkflowRunControl(runId, control);
        options.onRuntimeControlReady?.(control);
      },
    }),
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

interface ResolvedLaunchFeatures {
  readonly features: WorkflowFeatureFlags;
  readonly decisions: readonly WorkflowFeatureDecision[];
}

interface LaunchIds {
  readonly taskId: string;
  readonly runId: string;
  readonly scriptPath: string;
}

function buildInitialRunState({
  parsed,
  request,
  options,
  launchFeatures,
  ids,
  script,
  startTime,
}: {
  readonly parsed: ParsedWorkflowScript;
  readonly request: WorkflowLaunchRequest;
  readonly options: WorkflowLaunchOptions;
  readonly launchFeatures: ResolvedLaunchFeatures;
  readonly ids: LaunchIds;
  readonly script: string;
  readonly startTime: number;
}): WorkflowRunState {
  return {
    runId: ids.runId,
    taskId: ids.taskId,
    sessionId: options.sessionId,
    triggerSource: options.triggerSource,
    workflowName: parsed.meta.name,
    description: parsed.meta.description ?? request.description,
    args: request.args,
    status: "running",
    defaultModel: resolveDefaultModel(parsed.meta, options, launchFeatures.features),
    defaultThinkingLevel: parsed.meta.thinkingLevel ?? options.defaultThinkingLevel,
    features: launchFeatures.features,
    featureDecisions: launchFeatures.decisions,
    script,
    scriptPath: ids.scriptPath,
    phases: (parsed.meta.phases ?? []).map((phase) => ({
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
    startTime,
  };
}

function buildRuntimeOptions({
  parsed,
  request,
  options,
  launchFeatures,
  journal,
  replayCache,
  onControlReady,
}: {
  readonly parsed: ParsedWorkflowScript;
  readonly request: WorkflowLaunchRequest;
  readonly options: WorkflowLaunchOptions;
  readonly launchFeatures: ResolvedLaunchFeatures;
  readonly journal: WorkflowRuntimeOptions["journal"];
  readonly replayCache: WorkflowRuntimeOptions["replayCache"];
  readonly onControlReady: WorkflowRuntimeOptions["onControlReady"];
}): WorkflowRuntimeOptions {
  return {
    args: request.args,
    agentRunner: options.agentRunner,
    schedulerRunner: options.schedulerRunner,
    maxConcurrentAgents: options.maxConcurrentAgents,
    maxTotalAgents: options.maxTotalAgents,
    budgetTotal: options.budgetTotal,
    defaultModel: resolveDefaultModel(parsed.meta, options, launchFeatures.features),
    defaultThinkingLevel: parsed.meta.thinkingLevel ?? options.defaultThinkingLevel,
    availableModels: options.availableModels,
    features: launchFeatures.features,
    featureDecisions: launchFeatures.decisions,
    onControlReady,
    cwd: options.cwd ?? workflowProjectCwdFromRootDir(options.rootDir),
    journal,
    replayCache,
  };
}

function resolveLaunchFeatures(options: WorkflowLaunchOptions): ResolvedLaunchFeatures {
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

function defaultDefer(start: () => void): void {
  setImmediate(start);
}

function randomTaskId(): string {
  return `task_${randomBytes(6).toString("hex")}`;
}

function randomRunId(): string {
  return `wf_${randomBytes(8).toString("hex")}`;
}

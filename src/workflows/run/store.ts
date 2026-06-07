import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "#src/workflows/result.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import { isWorkflowFeatureKey } from "#src/extension/features/registry.ts";
import type {
  WorkflowFeatureDecision,
  WorkflowFeatureDecisionSource,
  WorkflowFeatureFlags,
} from "#src/extension/features/registry.ts";
import type {
  WorkflowFailure,
  WorkflowPhaseProgress,
  WorkflowProgressEntry,
  WorkflowRunPhase,
  WorkflowRunPlannedAgent,
  WorkflowRunState,
  WorkflowRunStatus,
} from "./model.ts";

export interface WorkflowRunStoreOptions {
  rootDir: string;
}

export type WorkflowRunStoreError =
  | WorkflowRunNotFoundError
  | WorkflowRunReadError
  | WorkflowRunWriteError
  | WorkflowRunInvalidError;

export interface WorkflowRunNotFoundError {
  readonly _tag: "WorkflowRunNotFoundError";
  readonly message: string;
  readonly runId: string;
  readonly path: string;
}

export interface WorkflowRunReadError {
  readonly _tag: "WorkflowRunReadError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowRunWriteError {
  readonly _tag: "WorkflowRunWriteError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowRunInvalidError {
  readonly _tag: "WorkflowRunInvalidError";
  readonly message: string;
  readonly path: string;
}

export class WorkflowRunStore {
  readonly #rootDir: string;

  constructor(options: WorkflowRunStoreOptions) {
    this.#rootDir = options.rootDir;
  }

  async listRuns(): Promise<Result<WorkflowRunState[], WorkflowRunStoreError>> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#rootDir, { withFileTypes: true });
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
      return err(readError(this.#rootDir, cause));
    }

    const results = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.#readManifest(entry.name)),
    );
    const runs: WorkflowRunState[] = [];
    for (const result of results) {
      if (result.status === "ok") runs.push(result.value);
    }

    return ok(runs.toSorted(compareRunsNewestFirst));
  }

  async readRun(runId: string): Promise<Result<WorkflowRunState, WorkflowRunStoreError>> {
    const result = await this.#readManifest(runId);
    if (result.status === "error" && isWorkflowRunReadError(result.error)) {
      const cause = result.error.cause;
      if (isNodeError(cause) && cause.code === "ENOENT") {
        const path = manifestPath(this.#rootDir, runId);
        return err({
          _tag: "WorkflowRunNotFoundError",
          message: `Workflow run '${runId}' was not found.`,
          runId,
          path,
        });
      }
    }
    return result;
  }

  async writeRun(state: WorkflowRunState): Promise<Result<void, WorkflowRunWriteError>> {
    const path = manifestPath(this.#rootDir, state.runId);
    try {
      const runDir = join(this.#rootDir, state.runId);
      await mkdir(runDir, { recursive: true });
      const tempPath = join(runDir, `.manifest.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tempPath, path);
      return ok(undefined);
    } catch (cause) {
      return err({
        _tag: "WorkflowRunWriteError",
        message: `Could not write workflow run manifest at '${path}'.`,
        path,
        cause,
      });
    }
  }

  async #readManifest(runId: string): Promise<Result<WorkflowRunState, WorkflowRunStoreError>> {
    const path = manifestPath(this.#rootDir, runId);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (cause) {
      return err(readError(path, cause));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return err({
        _tag: "WorkflowRunInvalidError",
        message: `Workflow run manifest '${path}' is not valid JSON.`,
        path,
      });
    }

    const state = toWorkflowRunState(parsed);
    if (state === undefined) {
      return err({
        _tag: "WorkflowRunInvalidError",
        message: `Workflow run manifest '${path}' does not match the run-state read model.`,
        path,
      });
    }

    return ok(state);
  }
}

export function workflowRunManifestPath(rootDir: string, runId: string): string {
  return manifestPath(rootDir, runId);
}

function manifestPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "manifest.json");
}

function compareRunsNewestFirst(left: WorkflowRunState, right: WorkflowRunState): number {
  return runSortTime(right) - runSortTime(left) || right.runId.localeCompare(left.runId);
}

function runSortTime(run: WorkflowRunState): number {
  return run.startTime || timestampMs(run.timestamp) || 0;
}

function timestampMs(timestamp: string | undefined): number {
  if (timestamp === undefined) return 0;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

function toWorkflowRunState(value: unknown): WorkflowRunState | undefined {
  if (!isRecord(value)) return undefined;

  if (
    isString(value.runId) &&
    isString(value.taskId) &&
    isString(value.workflowName) &&
    isWorkflowRunStatus(value.status) &&
    isString(value.script) &&
    isString(value.scriptPath) &&
    isArray(value.phases) &&
    isArray(value.logs) &&
    isArray(value.workflowProgress) &&
    isNumber(value.agentCount) &&
    isNumber(value.totalTokens) &&
    isNumber(value.totalToolCalls) &&
    isNumber(value.startTime)
  ) {
    return {
      runId: value.runId,
      taskId: value.taskId,
      sessionId: isString(value.sessionId) ? value.sessionId : undefined,
      triggerSource: isWorkflowRunTriggerSource(value.triggerSource)
        ? value.triggerSource
        : undefined,
      workflowName: value.workflowName,
      description: isString(value.description) ? value.description : undefined,
      args: value.args,
      status: value.status,
      defaultModel: isString(value.defaultModel) ? value.defaultModel : undefined,
      defaultThinkingLevel: isWorkflowThinkingLevel(value.defaultThinkingLevel)
        ? value.defaultThinkingLevel
        : undefined,
      features: normalizeWorkflowFeatures(value.features),
      featureDecisions: normalizeFeatureDecisions(value.featureDecisions),
      script: value.script,
      scriptPath: value.scriptPath,
      phases: normalizePhases(value.phases),
      logs: value.logs.filter(isString),
      workflowProgress: normalizeProgress(value.workflowProgress),
      agentCount: value.agentCount,
      totalTokens: value.totalTokens,
      totalToolCalls: value.totalToolCalls,
      startTime: value.startTime,
      timestamp: isString(value.timestamp) ? value.timestamp : undefined,
      durationMs: isNumber(value.durationMs) ? value.durationMs : undefined,
      outputPath: isString(value.outputPath) ? value.outputPath : undefined,
      result: value.result,
      failures: normalizeFailures(value.failures),
    };
  }

  return observedManifestToRunState(value);
}

function observedManifestToRunState(value: Record<string, unknown>): WorkflowRunState | undefined {
  if (
    !isString(value.runId) ||
    !isString(value.name) ||
    !isString(value.script) ||
    !isString(value.scriptPath)
  ) {
    return undefined;
  }

  const snapshot = isRecord(value.snapshot) ? value.snapshot : {};
  const startedAt = isNumber(value.startedAt) ? value.startedAt : 0;
  const finishedAt = isNumber(value.finishedAt) ? value.finishedAt : undefined;
  const phases = normalizeObservedPhases(snapshot.phases);
  const logs = isArray(snapshot.logs) ? snapshot.logs.filter(isString) : [];
  const agents = normalizeObservedAgents(snapshot.agents);
  const error = isString(value.error) ? value.error : undefined;

  return {
    runId: value.runId,
    taskId: isString(value.taskId) ? value.taskId : `task_${String(value.id ?? value.runId)}`,
    sessionId: isString(value.sessionId) ? value.sessionId : undefined,
    triggerSource: isWorkflowRunTriggerSource(value.triggerSource)
      ? value.triggerSource
      : undefined,
    workflowName: value.name,
    description: isString(value.description)
      ? value.description
      : isString(snapshot.description)
        ? snapshot.description
        : undefined,
    args: value.args,
    status: normalizeObservedStatus(value.status),
    defaultModel: isString(value.defaultModel) ? value.defaultModel : undefined,
    defaultThinkingLevel: isWorkflowThinkingLevel(value.defaultThinkingLevel)
      ? value.defaultThinkingLevel
      : undefined,
    features: normalizeWorkflowFeatures(value.features),
    featureDecisions: normalizeFeatureDecisions(value.featureDecisions),
    script: value.script,
    scriptPath: value.scriptPath,
    phases,
    logs,
    workflowProgress: [
      ...phases.map(
        (phase, index): WorkflowPhaseProgress => ({
          type: "workflow_phase",
          index,
          title: phase.title,
        }),
      ),
      ...agents,
    ],
    agentCount: isNumber(snapshot.agentCount) ? snapshot.agentCount : agents.length,
    totalTokens: 0,
    totalToolCalls: isNumber(snapshot.toolCount) ? snapshot.toolCount : 0,
    startTime: startedAt,
    timestamp: startedAt === 0 ? undefined : new Date(startedAt).toISOString(),
    durationMs: isNumber(snapshot.durationMs)
      ? snapshot.durationMs
      : finishedAt === undefined
        ? undefined
        : Math.max(0, finishedAt - startedAt),
    outputPath: isString(value.outputPath) ? value.outputPath : undefined,
    failures: error === undefined ? undefined : [{ scope: "run", message: error }],
  };
}

function normalizeWorkflowFeatures(value: unknown): WorkflowFeatureFlags | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.experimentalModelRouting === "boolean"
    ? { experimentalModelRouting: value.experimentalModelRouting }
    : undefined;
}

function normalizeFeatureDecisions(value: unknown): readonly WorkflowFeatureDecision[] | undefined {
  if (!isArray(value)) return undefined;
  const decisions = value.filter(isWorkflowFeatureDecision);
  return decisions.length === 0 ? undefined : decisions;
}

function isWorkflowFeatureDecision(value: unknown): value is WorkflowFeatureDecision {
  if (!isRecord(value)) return false;
  return (
    isWorkflowFeatureKey(value.key) &&
    typeof value.value === "boolean" &&
    isWorkflowFeatureDecisionSource(value.source) &&
    (value.detail === undefined || isString(value.detail))
  );
}

function isWorkflowFeatureDecisionSource(value: unknown): value is WorkflowFeatureDecisionSource {
  return (
    value === "default" ||
    value === "user" ||
    value === "project" ||
    value === "hook" ||
    value === "env" ||
    value === "cli" ||
    value === "session" ||
    value === "override"
  );
}

function normalizePhases(phases: unknown[]): WorkflowRunPhase[] {
  return phases
    .map((phase): WorkflowRunPhase | undefined => {
      if (!isRecord(phase) || !isString(phase.title)) return undefined;
      return normalizedPhaseFromRecord(phase);
    })
    .filter((phase): phase is WorkflowRunPhase => phase !== undefined);
}

function normalizedPhaseFromRecord(phase: Record<string, unknown>): WorkflowRunPhase {
  const normalized: WorkflowRunPhase = { title: String(phase.title) };
  if (isString(phase.detail)) normalized.detail = phase.detail;
  if (isString(phase.model)) normalized.model = phase.model;
  if (isString(phase.thinkingLevel)) normalized.thinkingLevel = phase.thinkingLevel;
  if (isNonNegativeInteger(phase.agentCount)) normalized.agentCount = phase.agentCount;
  const agents = normalizePlannedAgents(phase.agents);
  if (agents !== undefined) normalized.agents = agents;
  return normalized;
}

function normalizePlannedAgents(value: unknown): WorkflowRunPlannedAgent[] | undefined {
  if (!isArray(value)) return undefined;
  const agents = value
    .map((agent): WorkflowRunPlannedAgent | undefined => {
      if (!isRecord(agent) || !isString(agent.label) || agent.label.length === 0) return undefined;
      const planned: WorkflowRunPlannedAgent = { label: agent.label };
      if (isString(agent.model)) planned.model = agent.model;
      if (isString(agent.thinkingLevel)) planned.thinkingLevel = agent.thinkingLevel;
      if (isString(agent.agentType)) planned.agentType = agent.agentType;
      return planned;
    })
    .filter((agent): agent is WorkflowRunPlannedAgent => agent !== undefined);
  return agents.length === 0 ? undefined : agents;
}

function normalizeProgress(progress: unknown[]): WorkflowProgressEntry[] {
  return progress.filter(isWorkflowProgressEntry);
}

function normalizeFailures(value: unknown): WorkflowFailure[] | undefined {
  if (!isArray(value)) return undefined;
  const failures = value.filter(isWorkflowFailure);
  return failures.length === 0 ? undefined : failures;
}

function normalizeObservedPhases(value: unknown): WorkflowRunPhase[] {
  if (!isArray(value)) return [];
  return value
    .map((phase): WorkflowRunPhase | undefined => {
      if (isString(phase)) return { title: phase };
      if (!isRecord(phase) || !isString(phase.title)) return undefined;
      return normalizedPhaseFromRecord(phase);
    })
    .filter((phase): phase is WorkflowRunPhase => phase !== undefined);
}

function normalizeObservedAgents(value: unknown): WorkflowAgentProgress[] {
  if (!isArray(value)) return [];
  return value
    .map((agent, index): WorkflowAgentProgress | undefined => {
      if (!isRecord(agent)) return undefined;
      const label = isString(agent.label) ? agent.label : `agent:${index}`;
      const startedAt = isNumber(agent.startedAt) ? agent.startedAt : undefined;
      const endedAt = isNumber(agent.endedAt) ? agent.endedAt : undefined;
      return {
        type: "workflow_agent",
        index,
        label,
        agentId: isString(agent.agentId) ? agent.agentId : `agent_${String(agent.id ?? index)}`,
        agentType: isString(agent.agentType) ? agent.agentType : "unknown",
        model: isString(agent.model) ? agent.model : "unknown",
        thinkingLevel: isWorkflowThinkingLevel(agent.thinkingLevel)
          ? agent.thinkingLevel
          : undefined,
        state: normalizeObservedAgentStatus(agent.status),
        queuedAt: startedAt ?? 0,
        startedAt,
        durationMs:
          startedAt === undefined || endedAt === undefined
            ? undefined
            : Math.max(0, endedAt - startedAt),
        lastProgressAt: isNumber(agent.lastProgressAt) ? agent.lastProgressAt : undefined,
        attempt: isNumber(agent.attempt) ? agent.attempt : 1,
        phaseTitle: isString(agent.phase) ? agent.phase : undefined,
        promptPreview: isString(agent.prompt) ? agent.prompt.slice(0, 160) : "",
        prompt: isString(agent.prompt) ? agent.prompt : undefined,
        resultPreview: isString(agent.resultPreview) ? agent.resultPreview : undefined,
        toolCalls: isNumber(agent.toolCount) ? agent.toolCount : undefined,
      };
    })
    .filter((agent): agent is WorkflowAgentProgress => agent !== undefined);
}

function normalizeObservedStatus(status: unknown): WorkflowRunStatus {
  if (status === "error") return "failed";
  if (isWorkflowRunStatus(status)) return status;
  return "failed";
}

function normalizeObservedAgentStatus(status: unknown): WorkflowAgentProgress["state"] {
  if (status === "success") return "done";
  if (status === "error") return "failed";
  if (
    status === "running" ||
    status === "queued" ||
    status === "done" ||
    status === "failed" ||
    status === "stopped"
  ) {
    return status;
  }
  return "failed";
}

function isWorkflowThinkingLevel(
  value: unknown,
): value is NonNullable<WorkflowRunState["defaultThinkingLevel"]> {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return (
    value === "created" ||
    value === "starting" ||
    value === "running" ||
    value === "pausing" ||
    value === "paused" ||
    value === "resuming" ||
    value === "completing" ||
    value === "completed" ||
    value === "failing" ||
    value === "failed" ||
    value === "stopping" ||
    value === "stopped"
  );
}

function isWorkflowRunTriggerSource(
  value: unknown,
): value is NonNullable<WorkflowRunState["triggerSource"]> {
  return value === "ultracode" || value === "manual" || value === "saved" || value === "unknown";
}

function isWorkflowProgressEntry(value: unknown): value is WorkflowProgressEntry {
  if (!isRecord(value) || !isString(value.type)) return false;
  if (value.type === "workflow_phase") {
    return isNumber(value.index) && isString(value.title);
  }
  return (
    value.type === "workflow_agent" &&
    isNumber(value.index) &&
    isString(value.label) &&
    isString(value.agentId) &&
    isString(value.agentType) &&
    isString(value.model) &&
    normalizeObservedAgentStatus(value.state) === value.state &&
    isNumber(value.queuedAt) &&
    isNumber(value.attempt) &&
    isString(value.promptPreview)
  );
}

function isWorkflowFailure(value: unknown): value is WorkflowFailure {
  return (
    isRecord(value) &&
    (value.scope === "run" || value.scope === "agent" || value.scope === "pipeline") &&
    isString(value.message)
  );
}

function readError(path: string, cause: unknown): WorkflowRunReadError {
  return {
    _tag: "WorkflowRunReadError",
    message: `Could not read workflow run storage at '${path}'.`,
    path,
    cause,
  };
}

function isWorkflowRunReadError(error: WorkflowRunStoreError): error is WorkflowRunReadError {
  return error["_tag"] === "WorkflowRunReadError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

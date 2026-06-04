import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "./result.ts";
import type {
  WorkflowAgentProgress,
  WorkflowFailure,
  WorkflowPhaseProgress,
  WorkflowProgressEntry,
  WorkflowRunState,
  WorkflowRunStatus,
} from "./types.ts";

export interface WorkflowRunStoreOptions {
  rootDir: string;
}

export type WorkflowRunStoreError =
  | WorkflowRunNotFoundError
  | WorkflowRunReadError
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

    const runs: WorkflowRunState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = await this.#readManifest(entry.name);
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
      workflowName: value.workflowName,
      status: value.status,
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
    workflowName: value.name,
    status: normalizeObservedStatus(value.status),
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

function normalizePhases(phases: unknown[]): Array<{ title: string }> {
  return phases
    .map((phase) => (isRecord(phase) && isString(phase.title) ? { title: phase.title } : undefined))
    .filter((phase): phase is { title: string } => phase !== undefined);
}

function normalizeProgress(progress: unknown[]): WorkflowProgressEntry[] {
  return progress.filter(isWorkflowProgressEntry);
}

function normalizeFailures(value: unknown): WorkflowFailure[] | undefined {
  if (!isArray(value)) return undefined;
  const failures = value.filter(isWorkflowFailure);
  return failures.length === 0 ? undefined : failures;
}

function normalizeObservedPhases(value: unknown): Array<{ title: string }> {
  if (!isArray(value)) return [];
  return value
    .map((phase) => (isString(phase) ? { title: phase } : undefined))
    .filter((phase): phase is { title: string } => phase !== undefined);
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
        state: normalizeObservedAgentStatus(agent.status),
        queuedAt: startedAt ?? 0,
        startedAt,
        durationMs:
          startedAt === undefined || endedAt === undefined
            ? undefined
            : Math.max(0, endedAt - startedAt),
        attempt: isNumber(agent.attempt) ? agent.attempt : 1,
        phaseTitle: isString(agent.phase) ? agent.phase : undefined,
        promptPreview: isString(agent.prompt) ? agent.prompt.slice(0, 160) : "",
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

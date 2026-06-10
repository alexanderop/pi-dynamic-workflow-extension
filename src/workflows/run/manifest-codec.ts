// Deserialization codecs for run manifests. Two schemas are accepted:
//
// 1. The native manifest this extension writes (`toWorkflowRunState`'s first
//    branch) — field names match WorkflowRunState directly.
// 2. The reverse-engineered Claude Code "observed" manifest
//    (`observedManifestToRunState`) — the snapshot/agents shape captured in
//    spec.md §22 from real Claude Code artifacts. This is the
//    reverse-engineering boundary: changes here should map back to spec.md.
//
// Both normalize defensively because manifests are read back from disk and may
// come from older versions or external runs. File I/O and caching live in store.ts.
import { isRecord } from "#src/workflows/guards.ts";
import { WORKFLOW_THINKING_LEVELS } from "#src/workflows/agent/model.ts";
import type { WorkflowAgentProgress, WorkflowThinkingLevel } from "#src/workflows/agent/model.ts";
import {
  isWorkflowFeatureKey,
  WORKFLOW_FEATURE_DECISION_SOURCES,
} from "#src/workflows/features/registry.ts";
import type {
  WorkflowFeatureDecision,
  WorkflowFeatureDecisionSource,
  WorkflowFeatureFlags,
} from "#src/workflows/features/registry.ts";
import { WORKFLOW_RUN_STATUSES } from "./model.ts";
import type {
  WorkflowFailure,
  WorkflowPhaseProgress,
  WorkflowProgressEntry,
  WorkflowRunPhase,
  WorkflowRunPlannedAgent,
  WorkflowRunState,
  WorkflowRunStatus,
} from "./model.ts";

export function toWorkflowRunState(value: unknown): WorkflowRunState | undefined {
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
  return WORKFLOW_FEATURE_DECISION_SOURCES.includes(value as WorkflowFeatureDecisionSource);
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
        // "unknown" is a sentinel, not a model name — see hasKnownModel in agent/model.ts.
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

function isWorkflowThinkingLevel(value: unknown): value is WorkflowThinkingLevel {
  return WORKFLOW_THINKING_LEVELS.includes(value as WorkflowThinkingLevel);
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return WORKFLOW_RUN_STATUSES.includes(value as WorkflowRunStatus);
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

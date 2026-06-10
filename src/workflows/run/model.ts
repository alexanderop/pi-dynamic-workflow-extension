// Core run-state types shared by the store, state machine, launcher, and views.
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type {
  WorkflowFeatureDecision,
  WorkflowFeatureFlags,
} from "#src/workflows/features/registry.ts";

// Single source of truth for the run-status union: guards derive from this
// array via .includes(), so adding a status here updates type and guards together.
export const WORKFLOW_RUN_STATUSES = [
  "created",
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
  "completing",
  "completed",
  "failing",
  "failed",
  "stopping",
  "stopped",
] as const;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowRunPlannedAgent {
  label: string;
  model?: string;
  thinkingLevel?: string;
  agentType?: string;
}

export interface WorkflowRunPhase {
  title: string;
  detail?: string;
  model?: string;
  thinkingLevel?: string;
  agentCount?: number;
  agents?: WorkflowRunPlannedAgent[];
}

export interface WorkflowRunState {
  runId: string;
  taskId: string;
  sessionId?: string;
  triggerSource?: WorkflowRunTriggerSource;
  workflowName: string;
  description?: string;
  args?: unknown;
  status: WorkflowRunStatus;
  defaultModel?: string;
  defaultThinkingLevel?: WorkflowAgentProgress["thinkingLevel"];
  features?: WorkflowFeatureFlags;
  featureDecisions?: readonly WorkflowFeatureDecision[];
  script: string;
  scriptPath: string;
  phases: WorkflowRunPhase[];
  logs: string[];
  workflowProgress: WorkflowProgressEntry[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  startTime: number;
  timestamp?: string;
  durationMs?: number;
  outputPath?: string;
  result?: unknown;
  failures?: WorkflowFailure[];
}

export type WorkflowRunTriggerSource = "ultracode" | "manual" | "saved" | "unknown";

export type WorkflowProgressEntry = WorkflowPhaseProgress | WorkflowAgentProgress;

export interface WorkflowPhaseProgress {
  type: "workflow_phase";
  index: number;
  title: string;
}

export interface WorkflowFailure {
  scope: "run" | "agent" | "pipeline";
  message: string;
  agentId?: string;
  pipelineIndex?: number;
}

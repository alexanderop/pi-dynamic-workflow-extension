import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";

export type WorkflowRunStatus =
  | "created"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "completing"
  | "completed"
  | "failing"
  | "failed"
  | "stopping"
  | "stopped";

export interface WorkflowRunPlannedAgent {
  label: string;
  model?: string;
  agentType?: string;
}

export interface WorkflowRunPhase {
  title: string;
  detail?: string;
  model?: string;
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
  status: WorkflowRunStatus;
  defaultModel?: string;
  defaultThinkingLevel?: WorkflowAgentProgress["thinkingLevel"];
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

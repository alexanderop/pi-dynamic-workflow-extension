import type { WorkflowAgentProgress } from "../agent/model.ts";

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

export interface WorkflowRunState {
  runId: string;
  taskId: string;
  workflowName: string;
  description?: string;
  status: WorkflowRunStatus;
  script: string;
  scriptPath: string;
  phases: Array<{ title: string }>;
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

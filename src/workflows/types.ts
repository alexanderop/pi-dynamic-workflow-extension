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

export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description?: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  schema?: unknown;
  isolation?: "worktree";
}

export interface WorkflowBudget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowRuntimeState {
  meta: WorkflowMeta;
  phases: WorkflowPhaseProgress[];
  logs: string[];
  agentCalls: Array<{
    prompt: string;
    options: AgentOptions;
  }>;
  workflowProgress: WorkflowProgressEntry[];
  result?: unknown;
}

export interface WorkflowRunState {
  runId: string;
  taskId: string;
  workflowName: string;
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

export interface WorkflowAgentProgress {
  type: "workflow_agent";
  index: number;
  label: string;
  agentId: string;
  agentType: string;
  model: string;
  state: "queued" | "running" | "done" | "failed" | "stopped";
  queuedAt: number;
  attempt: number;
  phaseIndex?: number;
  phaseTitle?: string;
  startedAt?: number;
  lastProgressAt?: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
}

export interface WorkflowFailure {
  scope: "run" | "agent" | "pipeline";
  message: string;
  agentId?: string;
  pipelineIndex?: number;
}

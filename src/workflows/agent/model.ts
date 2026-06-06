export interface AgentOptions {
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  schema?: unknown;
  isolation?: "worktree";
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
  /** Full original prompt for the prompt reader; optional for legacy manifests/snapshots. */
  prompt?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
}

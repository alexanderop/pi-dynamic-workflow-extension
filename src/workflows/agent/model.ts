// Single source of truth for the thinking-level union: guards derive from this
// array via .includes(), so adding a level here updates type and guards together.
export const WORKFLOW_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type WorkflowThinkingLevel = (typeof WORKFLOW_THINKING_LEVELS)[number];

export interface AgentOptions {
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  thinkingLevel?: string;
  schema?: unknown;
  isolation?: "worktree";
}

/**
 * Sentinel contract for agent model labels. `model` is a required string, so
 * placeholders stand in when no real model is known: the scheduler defaults to
 * "default", observed-manifest deserialization fills in "unknown", and legacy
 * snapshots may carry "". Views should hide these rather than render them.
 */
export function hasKnownModel(model: string): boolean {
  return model !== "" && model !== "unknown" && model !== "default";
}

export type WorkflowAgentActivityState =
  | "queued"
  | "starting"
  | "waiting_for_model"
  | "thinking"
  | "streaming"
  | "using_tool"
  | "waiting_for_tool"
  | "finalizing"
  | "no_telemetry"
  | "idle"
  | "done"
  | "failed"
  | "stopped";

export interface WorkflowAgentActivitySummary {
  at: number;
  label: string;
  detail?: string;
  toolName?: string;
  isError?: boolean;
}

export interface WorkflowAgentProgress {
  type: "workflow_agent";
  index: number;
  label: string;
  agentId: string;
  agentType: string;
  model: string;
  thinkingLevel?: string;
  requestedModel?: string;
  requestedThinkingLevel?: string;
  modelFallbackReason?: string;
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
  activityState?: WorkflowAgentActivityState;
  activityLabel?: string;
  lastEventAt?: number;
  lastEventType?: string;
  lastEventLabel?: string;
  currentToolName?: string;
  currentToolCallId?: string;
  turnCount?: number;
  messageUpdateCount?: number;
  observedLiveEvents?: number;
  telemetryAvailable?: boolean;
  recentActivity?: WorkflowAgentActivitySummary[];
  promptPreview: string;
  /** Full original prompt for the prompt reader; optional for legacy manifests/snapshots. */
  prompt?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
}

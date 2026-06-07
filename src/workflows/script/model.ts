import type { AgentOptions } from "#src/workflows/agent/model.ts";
import type { WorkflowAgentRunner } from "#src/workflows/agent/scheduler.ts";
import type { WorkflowAgentJournal, WorkflowJournalKey } from "#src/workflows/journal/model.ts";
import type { WorkflowPhaseProgress, WorkflowProgressEntry } from "#src/workflows/run/model.ts";

export interface WorkflowPlannedAgent {
  label: string;
  model?: string;
  agentType?: string;
}

export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
  agentCount?: number;
  agents?: WorkflowPlannedAgent[];
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  phases?: WorkflowPhase[];
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
  stopped?: boolean;
}

export interface WorkflowRuntimeReplayCache {
  has(key: WorkflowJournalKey): boolean;
  get(key: WorkflowJournalKey): unknown;
}

export interface WorkflowRuntimeControl {
  pause(): void;
  resume(): void;
  stopRun(): void;
  stopAgent(agentId: string): void;
  isPaused(): boolean;
  isStopped(): boolean;
}

export interface WorkflowRuntimeOptions {
  args?: unknown;
  cwd?: string;
  budgetTotal?: number | null;
  defaultModel?: string;
  defaultThinkingLevel?: AgentOptions["thinkingLevel"];
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  agentRunner?: (prompt: string, options: AgentOptions) => Promise<unknown>;
  schedulerRunner?: WorkflowAgentRunner;
  journal?: WorkflowAgentJournal;
  replayCache?: WorkflowRuntimeReplayCache;
  onControlReady?: (control: WorkflowRuntimeControl) => void;
  onStateChange?: (state: WorkflowRuntimeState) => void;
}

export interface WorkflowRuntimeError {
  readonly _tag: "WorkflowRuntimeError";
  readonly message: string;
  readonly cause: unknown;
  readonly partialState?: WorkflowRuntimeState;
}

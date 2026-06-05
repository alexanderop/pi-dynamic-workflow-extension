import type { AgentOptions } from "../agent/model.ts";
import type { WorkflowPhaseProgress, WorkflowProgressEntry } from "../run/model.ts";

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

export interface WorkflowRuntimeOptions {
  args?: unknown;
  budgetTotal?: number | null;
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  agentRunner?: (prompt: string, options: AgentOptions) => Promise<unknown>;
}

export interface WorkflowRuntimeError {
  readonly _tag: "WorkflowRuntimeError";
  readonly message: string;
  readonly cause: unknown;
  readonly partialState?: WorkflowRuntimeState;
}

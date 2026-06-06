import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";

export const AGENT_NOW = 1_000_000;

interface WorkflowAgentBuilderOptions {
  readonly index?: number;
  readonly agentId?: string;
  readonly phase?: string;
  readonly phaseTitle?: string;
  readonly phaseIndex?: number;
  readonly prompt?: string;
  readonly promptPreview?: string;
  readonly agentType?: string;
  readonly model?: string;
  readonly attempt?: number;
  readonly tokens?: number;
  readonly toolCalls?: number;
  readonly tool?: string;
  readonly lastToolName?: string;
  readonly lastToolSummary?: string;
  readonly result?: unknown;
  readonly resultPreview?: string;
  readonly error?: string;
  readonly queuedAt?: number;
  readonly startedAt?: number;
  readonly lastProgressAt?: number;
  readonly durationMs?: number;
}

type WorkflowAgentState = WorkflowAgentProgress["state"];

export const workflowAgent = {
  queued(label: string, options: WorkflowAgentBuilderOptions = {}): WorkflowAgentProgress {
    return buildAgent(label, "queued", options);
  },

  running(label: string, options: WorkflowAgentBuilderOptions = {}): WorkflowAgentProgress {
    return buildAgent(label, "running", options);
  },

  done(label: string, options: WorkflowAgentBuilderOptions = {}): WorkflowAgentProgress {
    return buildAgent(label, "done", options);
  },

  failed(label: string, options: WorkflowAgentBuilderOptions = {}): WorkflowAgentProgress {
    return buildAgent(label, "failed", options);
  },

  stopped(label: string, options: WorkflowAgentBuilderOptions = {}): WorkflowAgentProgress {
    return buildAgent(label, "stopped", options);
  },
};

function buildAgent(
  label: string,
  state: WorkflowAgentState,
  options: WorkflowAgentBuilderOptions,
): WorkflowAgentProgress {
  const prompt = options.prompt ?? `${label} prompt`;
  const phaseTitle = options.phaseTitle ?? options.phase;
  const lastToolName = options.lastToolName ?? options.tool;

  return {
    type: "workflow_agent",
    index: options.index ?? 0,
    label,
    agentId: options.agentId ?? `agent_${options.index ?? 0}`,
    agentType: options.agentType ?? "general-purpose",
    model: options.model ?? "test-model",
    state,
    queuedAt: options.queuedAt ?? AGENT_NOW,
    attempt: options.attempt ?? 1,
    ...(phaseTitle === undefined ? {} : { phaseTitle }),
    ...(options.phaseIndex === undefined ? {} : { phaseIndex: options.phaseIndex }),
    ...(state === "queued" ? {} : { startedAt: options.startedAt ?? AGENT_NOW }),
    ...(state === "running" ? { lastProgressAt: options.lastProgressAt ?? AGENT_NOW } : {}),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(lastToolName === undefined ? {} : { lastToolName }),
    ...(options.lastToolSummary === undefined ? {} : { lastToolSummary: options.lastToolSummary }),
    promptPreview: options.promptPreview ?? preview(prompt),
    prompt,
    ...(resultPreview(options) === undefined ? {} : { resultPreview: resultPreview(options) }),
    ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
    ...(options.toolCalls === undefined ? {} : { toolCalls: options.toolCalls }),
  };
}

function resultPreview(options: WorkflowAgentBuilderOptions): string | undefined {
  if (options.resultPreview !== undefined) return options.resultPreview;
  if (options.error !== undefined) return options.error;
  if (typeof options.result === "string") return options.result;
  if (options.result !== undefined) return JSON.stringify(options.result);
  return undefined;
}

function preview(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

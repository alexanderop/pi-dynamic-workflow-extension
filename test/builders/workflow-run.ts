import type {
  WorkflowFailure,
  WorkflowPhaseProgress,
  WorkflowProgressEntry,
  WorkflowRunState,
  WorkflowRunStatus,
} from "#src/workflows/run/model.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";

export const WORKFLOW_NOW = 1_000_000;

type WorkflowRunPhase = string | { title: string };

interface WorkflowRunBuilderOptions {
  readonly runId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly triggerSource?: WorkflowRunState["triggerSource"];
  readonly description?: string;
  readonly phases?: WorkflowRunPhase[];
  readonly agents?: WorkflowAgentProgress[];
  readonly workflowProgress?: WorkflowProgressEntry[];
  readonly logs?: string[];
  readonly script?: string;
  readonly scriptPath?: string;
  readonly startTime?: number;
  readonly timestamp?: string;
  readonly durationMs?: number;
  readonly outputPath?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly failures?: WorkflowFailure[];
  readonly agentCount?: number;
  readonly totalTokens?: number;
  readonly totalToolCalls?: number;
}

export const workflowRun = {
  running(name: string, options: WorkflowRunBuilderOptions = {}): WorkflowRunState {
    return buildRun(name, "running", options);
  },

  completed(name: string, options: WorkflowRunBuilderOptions = {}): WorkflowRunState {
    return buildRun(name, "completed", {
      durationMs: 0,
      outputPath: `/tmp/wf_test/${options.runId ?? "wf_test"}/output.json`,
      ...options,
    });
  },

  failed(name: string, options: WorkflowRunBuilderOptions = {}): WorkflowRunState {
    const failures = options.failures ?? [
      { scope: "run" as const, message: options.error ?? "workflow failed" },
    ];
    return buildRun(name, "failed", { durationMs: 0, failures, ...options });
  },

  stopped(name: string, options: WorkflowRunBuilderOptions = {}): WorkflowRunState {
    return buildRun(name, "stopped", { durationMs: 0, ...options });
  },

  paused(name: string, options: WorkflowRunBuilderOptions = {}): WorkflowRunState {
    return buildRun(name, "paused", options);
  },
};

function buildRun(
  workflowName: string,
  status: WorkflowRunStatus,
  options: WorkflowRunBuilderOptions,
): WorkflowRunState {
  const runId = options.runId ?? "wf_test";
  const phases = normalizePhases(options.phases ?? []);
  const agents = options.agents ?? [];
  const workflowProgress = options.workflowProgress ?? [
    ...phases.map<WorkflowPhaseProgress>((phase, index) => ({
      type: "workflow_phase",
      index,
      title: phase.title,
    })),
    ...agents.map((agent, index) => ({ ...agent, index })),
  ];

  return {
    runId,
    taskId: options.taskId ?? "task_test",
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.triggerSource === undefined ? {} : { triggerSource: options.triggerSource }),
    workflowName,
    ...(options.description === undefined ? {} : { description: options.description }),
    status,
    script: options.script ?? "return null;",
    scriptPath: options.scriptPath ?? `/tmp/wf_test/${runId}/script.js`,
    phases,
    logs: options.logs ?? [],
    workflowProgress,
    agentCount: options.agentCount ?? countAgents(workflowProgress),
    totalTokens: options.totalTokens ?? sumAgentField(workflowProgress, "tokens"),
    totalToolCalls: options.totalToolCalls ?? sumAgentField(workflowProgress, "toolCalls"),
    startTime: options.startTime ?? WORKFLOW_NOW,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
    ...(options.result === undefined ? {} : { result: options.result }),
    ...(options.failures === undefined ? {} : { failures: options.failures }),
  };
}

function normalizePhases(phases: WorkflowRunPhase[]): Array<{ title: string }> {
  return phases.map((phase) => (typeof phase === "string" ? { title: phase } : phase));
}

function countAgents(entries: WorkflowProgressEntry[]): number {
  return entries.filter((entry) => entry.type === "workflow_agent").length;
}

function sumAgentField(entries: WorkflowProgressEntry[], field: "tokens" | "toolCalls"): number {
  return entries.reduce((sum, entry) => {
    if (entry.type !== "workflow_agent") return sum;
    return sum + (entry[field] ?? 0);
  }, 0);
}

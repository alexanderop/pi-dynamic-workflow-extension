import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState, WorkflowRunStatus } from "#src/workflows/run/model.ts";
import { formatDuration } from "./layout.ts";
import type { ChooserViewModel, MonitorAgentRow, MonitorViewModel } from "./model.ts";

export interface BuildMonitorViewOptions {
  readonly selectedPhaseIndex: number;
  readonly now?: number;
}

export function buildMonitorView(
  run: WorkflowRunState,
  options: BuildMonitorViewOptions,
): MonitorViewModel {
  const now = options.now ?? Date.now();
  const agents = run.workflowProgress.filter(isWorkflowAgentProgress);
  const titles = uniquePhaseTitles(run, agents);
  const phases = titles.map((title) => {
    const phaseAgents = agentsForPhase(agents, title);
    return {
      title,
      totalAgents: phaseAgents.length,
      doneAgents: phaseAgents.filter((agent) => agent.state === "done").length,
    };
  });

  const selectedTitle = phases[options.selectedPhaseIndex]?.title;
  const selectedPhaseAgents =
    selectedTitle === undefined
      ? []
      : agentsForPhase(agents, selectedTitle).map((agent) => toAgentRow(agent, now));

  return {
    header: {
      workflowName: run.workflowName,
      description: run.description,
      doneAgents: agents.filter((agent) => agent.state === "done").length,
      totalAgents: agents.length,
      elapsedLabel: liveDurationLabel(run, now),
    },
    phases,
    selectedPhaseAgents,
  };
}

/** Settled duration when known, otherwise the live elapsed time since start. */
function liveDurationLabel(run: WorkflowRunState, now: number): string {
  return formatDuration(run.durationMs ?? Math.max(0, now - run.startTime));
}

function toAgentRow(agent: WorkflowAgentProgress, now: number): MonitorAgentRow {
  const hasModel = agent.model !== "" && agent.model !== "unknown" && agent.model !== "default";
  const idleMs =
    agent.state === "running" && agent.tokens === undefined && agent.lastProgressAt !== undefined
      ? Math.max(0, now - agent.lastProgressAt)
      : undefined;
  return {
    glyph: agentGlyph(agent.state),
    label: agent.label,
    agentId: agent.agentId,
    state: agent.state,
    modelLabel: hasModel ? agent.model : undefined,
    tokens: agent.tokens !== undefined && agent.tokens > 0 ? agent.tokens : undefined,
    toolCalls: agent.toolCalls !== undefined && agent.toolCalls > 0 ? agent.toolCalls : undefined,
    idleMs,
    fullPrompt: agent.prompt ?? agent.promptPreview,
    promptPreview: agent.promptPreview,
    lastToolName: agent.lastToolName,
    lastToolSummary: agent.lastToolSummary,
    resultPreview: agent.resultPreview,
  };
}

export interface BuildChooserViewOptions {
  readonly now?: number;
}

export function buildChooserView(
  runs: WorkflowRunState[],
  options: BuildChooserViewOptions = {},
): ChooserViewModel {
  const now = options.now ?? Date.now();
  const counts = chooserCounts(runs);
  const defaultSelectedIndex = defaultChooserSelection(runs);
  return {
    runningCount: counts.running,
    completedCount: counts.completed,
    defaultSelectedIndex,
    rows: runs.map((run) => ({
      glyph: chooserGlyph(run.status),
      workflowName: run.workflowName,
      agentCount: run.agentCount,
      tokens: run.totalTokens > 0 ? run.totalTokens : undefined,
      durationLabel: liveDurationLabel(run, now),
      status: run.status,
    })),
  };
}

export function isActiveRun(status: WorkflowRunStatus): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "pausing" ||
    status === "paused" ||
    status === "resuming" ||
    status === "completing"
  );
}

export function chooserCounts(runs: WorkflowRunState[]): { running: number; completed: number } {
  return {
    running: runs.filter((run) => isActiveRun(run.status)).length,
    completed: runs.filter((run) => run.status === "completed").length,
  };
}

export function defaultChooserSelection(runs: WorkflowRunState[]): number {
  let bestIndex = -1;
  let bestStart = -Infinity;
  for (const [index, run] of runs.entries()) {
    if (!isActiveRun(run.status)) continue;
    if (run.startTime > bestStart) {
      bestStart = run.startTime;
      bestIndex = index;
    }
  }
  return bestIndex === -1 ? 0 : bestIndex;
}

function agentGlyph(state: WorkflowAgentProgress["state"]): string {
  if (state === "done") return "✓";
  if (state === "failed") return "!";
  if (state === "stopped") return "■";
  return "●";
}

function chooserGlyph(status: WorkflowRunStatus): string {
  if (isActiveRun(status)) return "↻";
  if (status === "completed") return "✓";
  if (status === "failed" || status === "failing") return "!";
  if (status === "stopped" || status === "stopping") return "■";
  return "●";
}

function uniquePhaseTitles(run: WorkflowRunState, agents: WorkflowAgentProgress[]): string[] {
  const titles = new Set<string>();
  for (const phase of run.phases) titles.add(phase.title);
  for (const progress of run.workflowProgress) {
    if (progress.type === "workflow_phase") titles.add(progress.title);
  }
  for (const agent of agents) {
    if (agent.phaseTitle !== undefined) titles.add(agent.phaseTitle);
  }
  return Array.from(titles);
}

function agentsForPhase(agents: WorkflowAgentProgress[], title: string): WorkflowAgentProgress[] {
  const phaseAgents = agents.filter((agent) => agent.phaseTitle === title);
  if (phaseAgents.length > 0) return phaseAgents;
  return agents.filter((agent) => agent.phaseTitle === undefined);
}

function isWorkflowAgentProgress(
  value: WorkflowRunState["workflowProgress"][number],
): value is WorkflowAgentProgress {
  return value.type === "workflow_agent";
}

import type { WorkflowAgentProgress } from "../agent/model.ts";
import type { WorkflowRunState } from "../run/model.ts";
import type {
  WorkflowPhaseSummary,
  WorkflowRunDetails,
  WorkflowRunRow,
  WorkflowRunsViewModel,
} from "./model.ts";

export interface ProjectWorkflowsViewOptions {
  readonly selectedRunIndex?: number;
  readonly savedWorkflowCount?: number;
}

export function projectWorkflowsView(
  runs: WorkflowRunState[],
  options: ProjectWorkflowsViewOptions = {},
): WorkflowRunsViewModel {
  const rows = runs.map(toRunRow);
  const selectedRunIndex = clampIndex(options.selectedRunIndex ?? 0, rows.length);
  const selectedRun = rows[selectedRunIndex];

  return {
    runs: rows,
    savedWorkflowCount: options.savedWorkflowCount ?? 0,
    selectedRun: selectedRun === undefined ? undefined : toRunDetails(selectedRun),
  };
}

export function toRunDetails(row: WorkflowRunRow): WorkflowRunDetails {
  const agents = row.run.workflowProgress.filter(isWorkflowAgentProgress);
  return {
    ...row,
    phases: summarizePhases(row.run, agents),
    agents,
    logs: row.run.logs,
    failures: row.run.failures?.map((failure) => failure.message) ?? [],
    totalTokens: row.run.totalTokens,
    totalToolCalls: row.run.totalToolCalls,
  };
}

function toRunRow(run: WorkflowRunState): WorkflowRunRow {
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    agentCount: run.agentCount,
    durationLabel: run.durationMs === undefined ? undefined : formatDuration(run.durationMs),
    outputPath: run.outputPath,
    run,
  };
}

function summarizePhases(
  run: WorkflowRunState,
  agents: WorkflowAgentProgress[],
): WorkflowPhaseSummary[] {
  const phaseTitles = uniquePhaseTitles(run, agents);
  return phaseTitles.map((title) => {
    const phaseAgents = agents.filter((agent) => agent.phaseTitle === title);
    return {
      title,
      totalAgents: phaseAgents.length,
      doneAgents: phaseAgents.filter((agent) => agent.state === "done").length,
      runningAgents: phaseAgents.filter((agent) => agent.state === "running").length,
      failedAgents: phaseAgents.filter((agent) => agent.state === "failed").length,
      stoppedAgents: phaseAgents.filter((agent) => agent.state === "stopped").length,
    };
  });
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

function isWorkflowAgentProgress(
  value: WorkflowRunState["workflowProgress"][number],
): value is WorkflowAgentProgress {
  return value.type === "workflow_agent";
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return Math.max(0, Math.min(index, length - 1));
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;

  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

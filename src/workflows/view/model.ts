import type { WorkflowAgentProgress } from "../agent/model.ts";
import type { WorkflowRunState, WorkflowRunStatus } from "../run/model.ts";

export type WorkflowViewFocus = "runs" | "agents" | "details";

export interface WorkflowRunsViewModel {
  runs: WorkflowRunRow[];
  savedWorkflowCount: number;
  selectedRun?: WorkflowRunDetails;
}

export interface WorkflowRunRow {
  runId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  agentCount: number;
  durationLabel?: string;
  outputPath?: string;
  run: WorkflowRunState;
}

export interface WorkflowRunDetails extends WorkflowRunRow {
  phases: WorkflowPhaseSummary[];
  agents: WorkflowAgentProgress[];
  logs: string[];
  failures: string[];
  totalTokens: number;
  totalToolCalls: number;
}

export interface WorkflowPhaseSummary {
  title: string;
  totalAgents: number;
  doneAgents: number;
  runningAgents: number;
  failedAgents: number;
  stoppedAgents: number;
}

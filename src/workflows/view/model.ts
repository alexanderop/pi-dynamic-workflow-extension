import type { WorkflowAgentProgress } from "../agent/model.ts";
import type { WorkflowRunStatus } from "../run/model.ts";

export interface MonitorAgentRow {
  glyph: string;
  label: string;
  state: WorkflowAgentProgress["state"];
  modelLabel?: string;
  tokens?: number;
  toolCalls?: number;
  idleMs?: number;
  fullPrompt: string;
  promptPreview: string;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

export interface MonitorPhaseRow {
  title: string;
  doneAgents: number;
  totalAgents: number;
}

export interface MonitorViewModel {
  header: {
    workflowName: string;
    description?: string;
    doneAgents: number;
    totalAgents: number;
    elapsedLabel: string;
  };
  phases: MonitorPhaseRow[];
  selectedPhaseAgents: MonitorAgentRow[];
}

export interface ChooserRow {
  glyph: string;
  workflowName: string;
  agentCount: number;
  tokens?: number;
  durationLabel: string;
  status: WorkflowRunStatus;
}

export interface ChooserViewModel {
  runningCount: number;
  completedCount: number;
  rows: ChooserRow[];
  defaultSelectedIndex: number;
}

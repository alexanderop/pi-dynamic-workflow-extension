import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunStatus } from "#src/workflows/run/model.ts";

export interface MonitorPlannedAgentRow {
  label: string;
  modelLabel?: string;
  agentType?: string;
}

export interface MonitorAgentRow {
  glyph: string;
  label: string;
  agentId: string;
  state: WorkflowAgentProgress["state"];
  modelLabel?: string;
  thinkingLevelLabel?: string;
  thinkingLevel?: WorkflowAgentProgress["thinkingLevel"];
  tokens?: number;
  toolCalls?: number;
  idleMs?: number;
  noTelemetryMs?: number;
  activityState?: WorkflowAgentProgress["activityState"];
  activityLabel?: string;
  lastEventAt?: number;
  lastEventType?: string;
  lastEventLabel?: string;
  currentToolName?: string;
  fullPrompt: string;
  promptPreview: string;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

export interface MonitorPhaseRow {
  title: string;
  detail?: string;
  modelLabel?: string;
  doneAgents: number;
  failedAgents: number;
  totalAgents: number;
  plannedAgents: MonitorPlannedAgentRow[];
  remainingPlannedAgents: number;
}

export interface MonitorViewModel {
  header: {
    workflowName: string;
    description?: string;
    artifactDir: string;
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

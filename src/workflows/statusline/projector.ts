import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState, WorkflowRunStatus } from "#src/workflows/run/model.ts";
import { formatDuration, formatTokens } from "#src/workflows/view/layout.ts";
import { isActiveRun, isWorkflowAgentProgress } from "#src/workflows/view/projector.ts";

const DEFAULT_STATUSLINE_WIDTH = 80;
const SUMMARY_PHASE_WIDTH = 18;
const SUMMARY_AGENT_WIDTH = 20;

export interface FormatWorkflowStatuslineOptions {
  readonly now?: number;
  readonly maxWidth?: number;
}

export interface SelectWorkflowStatuslineRunOptions {
  readonly sessionId?: string;
}

export function formatWorkflowStatusline(
  run: WorkflowRunState,
  options: FormatWorkflowStatuslineOptions = {},
): string {
  const now = options.now ?? Date.now();
  const agents = run.workflowProgress.filter(isWorkflowAgentProgress);
  const doneAgents = agents.filter((agent) => agent.state === "done").length;
  const totalAgents = agents.length;
  const activeAgent = selectActiveAgent(agents);
  const activePhaseTitle = currentPhaseTitle(run, activeAgent);
  const elapsedMs = run.durationMs ?? Math.max(0, now - run.startTime);
  const summaryParts = [
    `${doneAgents}/${totalAgents}`,
    compactDuration(elapsedMs),
    activePhaseTitle === undefined
      ? undefined
      : truncatePlain(activePhaseTitle, SUMMARY_PHASE_WIDTH),
    activeAgent === undefined ? undefined : activeAgentSummary(activeAgent, agents),
    run.totalTokens > 0 ? `↓${formatTokens(run.totalTokens)}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return compactStatusline({
    maxWidth: options.maxWidth ?? DEFAULT_STATUSLINE_WIDTH,
    name: run.workflowName,
    status: run.status,
    summary: summaryParts.join(" · "),
  });
}

export function selectWorkflowStatuslineRun(
  runs: readonly WorkflowRunState[],
  options: SelectWorkflowStatuslineRunOptions = {},
): WorkflowRunState | undefined {
  return runs
    .filter((run) => isVisibleInSession(run, options.sessionId) && isActiveRun(run.status))
    .toSorted(compareRunsNewestFirst)[0];
}

function compactStatusline({
  maxWidth,
  name,
  status,
  summary,
}: {
  readonly maxWidth: number;
  readonly name: string;
  readonly status: WorkflowRunStatus;
  readonly summary: string;
}): string {
  if (maxWidth < 1) return "";

  const glyphName = `${statusGlyph(status)} ${name}`;
  if (summary.length === 0) return truncatePlain(glyphName, maxWidth);
  if (summary.length >= maxWidth) return truncatePlain(summary, maxWidth);

  const separator = "  ";
  const leftWidth = maxWidth - summary.length - separator.length;
  if (leftWidth < 1) return truncatePlain(summary, maxWidth);

  return `${truncatePlain(glyphName, leftWidth)}${separator}${summary}`;
}

function compactDuration(durationMs: number): string {
  return formatDuration(durationMs).replaceAll(" ", "");
}

function activeAgentSummary(
  activeAgent: WorkflowAgentProgress,
  agents: readonly WorkflowAgentProgress[],
): string {
  const runningAgents = agents.filter((agent) => agent.state === "running");
  const extraRunning =
    activeAgent.state === "running" && runningAgents.length > 1
      ? ` +${runningAgents.length - 1}`
      : "";

  return `${truncatePlain(activeAgent.label, SUMMARY_AGENT_WIDTH)}${extraRunning}`;
}

function selectActiveAgent(
  agents: readonly WorkflowAgentProgress[],
): WorkflowAgentProgress | undefined {
  return (
    newestAgent(agents.filter((agent) => agent.state === "running")) ??
    newestAgent(agents.filter((agent) => agent.state === "queued"))
  );
}

function newestAgent(agents: WorkflowAgentProgress[]): WorkflowAgentProgress | undefined {
  return agents.toSorted(compareAgentActivityNewestFirst)[0];
}

function compareAgentActivityNewestFirst(
  left: WorkflowAgentProgress,
  right: WorkflowAgentProgress,
): number {
  return agentActivityTime(right) - agentActivityTime(left) || right.index - left.index;
}

function agentActivityTime(agent: WorkflowAgentProgress): number {
  return agent.lastProgressAt ?? agent.startedAt ?? agent.queuedAt;
}

function currentPhaseTitle(
  run: WorkflowRunState,
  activeAgent: WorkflowAgentProgress | undefined,
): string | undefined {
  if (activeAgent?.phaseTitle !== undefined) return activeAgent.phaseTitle;

  const phaseEntries = run.workflowProgress.filter((entry) => entry.type === "workflow_phase");
  return phaseEntries.at(-1)?.title ?? (run.phases.length === 1 ? run.phases[0]?.title : undefined);
}

function truncatePlain(text: string, width: number): string {
  if (width < 1) return "";
  const chars = [...text];
  if (chars.length <= width) return text;
  return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function statusGlyph(status: WorkflowRunStatus): string {
  if (isActiveRun(status)) return "○";
  if (status === "completed") return "✓";
  if (status === "failed" || status === "failing") return "!";
  if (status === "stopped" || status === "stopping") return "■";
  return "○";
}

function isVisibleInSession(run: WorkflowRunState, sessionId: string | undefined): boolean {
  return sessionId === undefined || run.sessionId === sessionId;
}

function compareRunsNewestFirst(left: WorkflowRunState, right: WorkflowRunState): number {
  return runSortTime(right) - runSortTime(left) || right.runId.localeCompare(left.runId);
}

function runSortTime(run: WorkflowRunState): number {
  return run.startTime || timestampMs(run.timestamp) || 0;
}

function timestampMs(timestamp: string | undefined): number {
  if (timestamp === undefined) return 0;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

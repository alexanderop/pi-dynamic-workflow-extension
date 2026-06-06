import type { WorkflowRunState, WorkflowRunStatus } from "#src/workflows/run/model.ts";
import { formatDuration, formatTokens } from "#src/workflows/view/layout.ts";
import { isActiveRun, isWorkflowAgentProgress } from "#src/workflows/view/projector.ts";

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
  const summaryParts = [
    `${doneAgents}/${totalAgents} agents done`,
    formatDuration(run.durationMs ?? Math.max(0, now - run.startTime)),
    run.totalTokens > 0 ? `↓ ${formatTokens(run.totalTokens)} tokens` : undefined,
  ].filter((part): part is string => part !== undefined);

  const summary = summaryParts.join(" · ");
  if (options.maxWidth !== undefined) {
    return compactStatusline({
      description: run.description,
      maxWidth: options.maxWidth,
      name: run.workflowName,
      status: run.status,
      summary,
    });
  }

  return [`${statusGlyph(run.status)} ${run.workflowName}`, run.description, summary]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("  ");
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
  description,
  maxWidth,
  name,
  status,
  summary,
}: {
  readonly description?: string;
  readonly maxWidth: number;
  readonly name: string;
  readonly status: WorkflowRunStatus;
  readonly summary: string;
}): string {
  if (maxWidth < 1) return "";
  if (summary.length >= maxWidth) return truncatePlain(summary, maxWidth);

  const separator = "  ";
  const leftWidth = maxWidth - summary.length - separator.length;
  const glyphName = `${statusGlyph(status)} ${name}`;
  if (leftWidth < 1) return truncatePlain(summary, maxWidth);

  if (description === undefined || leftWidth < 24) {
    return `${truncatePlain(glyphName, leftWidth)}${separator}${summary}`;
  }

  const nameWidth = Math.min(26, Math.max(12, Math.floor(leftWidth * 0.32)));
  const descriptionWidth = leftWidth - nameWidth - separator.length;
  if (descriptionWidth < 8) {
    return `${truncatePlain(glyphName, leftWidth)}${separator}${summary}`;
  }

  const left = [
    truncatePlain(glyphName, nameWidth),
    truncatePlain(description, descriptionWidth),
  ].join(separator);
  return `${left}${separator}${summary}`;
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

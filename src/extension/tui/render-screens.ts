// Pure screen renderers for the /workflows TUI. Every function here takes
// (theme, view-model, selection, width) and returns lines — no component
// state, no Pi TUI objects. This finishes the extraction started by
// view/projector.ts and view/navigation.ts (ADR 0010): the component keeps
// only state and input dispatch.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowRunStatus } from "#src/workflows/run/model.ts";
import type {
  ChooserViewModel,
  MonitorAgentRow,
  MonitorPhaseRow,
  MonitorPlannedAgentRow,
  MonitorViewModel,
} from "#src/workflows/view/model.ts";
import { formatIdle, formatTokens } from "#src/workflows/view/layout.ts";
import {
  headerSummaryLine,
  padTo,
  paneInnerWidths,
  titleSegment,
  truncateEllipsis,
  twoPaneBox,
  wordWrap,
} from "#src/extension/tui/layout.ts";
import type { MonitorNavigationState } from "#src/workflows/view/navigation.ts";

export interface WorkflowsComponentTheme {
  fg(
    color:
      | "text"
      | "accent"
      | "muted"
      | "dim"
      | "success"
      | "error"
      | "warning"
      | "border"
      | "borderAccent"
      | "borderMuted"
      | "thinkingOff"
      | "thinkingMinimal"
      | "thinkingLow"
      | "thinkingMedium"
      | "thinkingHigh"
      | "thinkingXhigh",
    text: string,
  ): string;
  bold(text: string): string;
}

export type PendingStopConfirmation =
  | { readonly type: "run"; readonly runId: string; readonly label: string }
  | { readonly type: "resume-run"; readonly runId: string; readonly label: string }
  | {
      readonly type: "agent";
      readonly runId: string;
      readonly agentId: string;
      readonly label: string;
    };

export const PROMPT_VISIBLE_ROWS = 15;
const CHOOSER_VISIBLE_ROWS = 10;
const MIN_LEFT_PANE_WIDTH = 12;
const LEFT_PANE_MAX_FRACTION = 0.4;

export function renderEmptyScreen(theme: WorkflowsComponentTheme, width: number): string[] {
  return [
    clipLine(width, theme.fg("accent", theme.bold("Dynamic workflows"))),
    "",
    clipLine(width, theme.fg("dim", "No workflow runs found in .pi/workflows.")),
    "",
    clipLine(width, theme.fg("dim", "esc close")),
  ];
}

export function renderChooserScreen({
  theme,
  view,
  selectedRunIndex,
  footerText,
  width,
}: {
  readonly theme: WorkflowsComponentTheme;
  readonly view: ChooserViewModel;
  readonly selectedRunIndex: number;
  readonly footerText: string;
  readonly width: number;
}): string[] {
  const lines = [
    clipLine(width, theme.fg("dim", "› /workflows")),
    "",
    clipLine(width, theme.fg("borderAccent", "─".repeat(width))),
    "",
    clipLine(width, `  ${theme.bold(theme.fg("accent", "Dynamic workflows"))}`),
    clipLine(
      width,
      `  ${theme.fg("dim", `${view.runningCount} running · ${view.completedCount} completed`)}`,
    ),
    "",
  ];

  const range = visibleRange(selectedRunIndex, view.rows.length, CHOOSER_VISIBLE_ROWS);
  for (let index = range.start; index < range.end; index += 1) {
    const row = view.rows[index];
    if (row === undefined) continue;
    const selected = index === selectedRunIndex;
    const cursor = selected ? theme.fg("accent", "› ") : "  ";
    const tokens = row.tokens === undefined ? "" : ` · ${formatTokens(row.tokens)} tok`;
    const metrics = theme.fg("dim", `${row.agentCount} agents${tokens} · ${row.durationLabel}`);
    const content = `  ${cursor}${runGlyph(theme, row)} ${selected ? theme.fg("accent", row.workflowName) : row.workflowName}   ${metrics}`;
    lines.push(clipLine(width, content));
  }

  lines.push("", clipLine(width, `  ${theme.fg("dim", footerText)}`));
  return lines;
}

export function renderOverviewScreen({
  theme,
  view,
  nav,
  width,
}: {
  readonly theme: WorkflowsComponentTheme;
  readonly view: MonitorViewModel;
  readonly nav: Pick<MonitorNavigationState, "selectedPhaseIndex">;
  readonly width: number;
}): string[] {
  const header = renderHeader(theme, view, width);

  const phaseRows = view.phases.map((phase, index) =>
    phaseRowLine(theme, phase, index, index === nav.selectedPhaseIndex),
  );
  const selectedPhase = view.phases[nav.selectedPhaseIndex];
  const selectedPhaseTitle = selectedPhase?.title ?? "";
  const rightTitle = `${theme.fg("accent", selectedPhaseTitle)} · ${theme.fg("muted", `${selectedPhase?.totalAgents ?? view.selectedPhaseAgents.length} agents`)}`;
  const leftWidth = clampLeftWidth(phaseRows, width);
  const { rightWidth } = paneInnerWidths(width, leftWidth);
  const agentRows = view.selectedPhaseAgents.map((agent) =>
    overviewAgentRow(theme, agent, rightWidth),
  );
  const plannedRows = plannedAgentLines(theme, selectedPhase, agentRows.length > 0);
  const rightLines = [
    ...phaseMetadataRows(theme, selectedPhase),
    ...(agentRows.length > 0 && plannedRows.length > 0 ? [...agentRows, ""] : agentRows),
    ...plannedRows,
  ];

  return [
    ...header,
    ...twoPaneBox({
      leftTitle: theme.fg("accent", "Phases"),
      rightTitle,
      leftLines: phaseRows,
      rightLines,
      leftWidth,
      width,
      styleBorder: (text) => theme.fg("borderMuted", text),
    }),
  ];
}

export function renderAgentDetailScreen({
  theme,
  view,
  nav,
  width,
}: {
  readonly theme: WorkflowsComponentTheme;
  readonly view: MonitorViewModel;
  readonly nav: Pick<MonitorNavigationState, "selectedPhaseIndex" | "selectedAgentIndex">;
  readonly width: number;
}): string[] {
  const header = renderHeader(theme, view, width);
  const agents = view.selectedPhaseAgents;
  const selected = agents[nav.selectedAgentIndex];

  const selectedPhase = view.phases[nav.selectedPhaseIndex];
  const selectedPhaseTitle = selectedPhase?.title ?? "";
  const leftTitle = `${theme.fg("accent", selectedPhaseTitle)} · ${theme.fg("muted", `${selectedPhase?.totalAgents ?? agents.length} agents`)}`;
  const agentRows = agents.map((agent, index) => {
    const cursor = index === nav.selectedAgentIndex ? theme.fg("accent", "› ") : "  ";
    return `${cursor}${agentGlyph(theme, agent)} ${agent.label}`;
  });
  const detailRows =
    selected === undefined ? ["No agent selected"] : detailSections(theme, selected);
  const leftWidth = clampLeftWidth(agentRows, width);

  return [
    ...header,
    ...twoPaneBox({
      leftTitle,
      rightTitle: theme.fg("accent", selected?.label ?? ""),
      leftLines: agentRows,
      rightLines: detailRows,
      leftWidth,
      width,
      styleBorder: (text) => theme.fg("borderMuted", text),
    }),
  ];
}

export function renderPromptReaderScreen({
  theme,
  agent,
  scroll,
  width,
}: {
  readonly theme: WorkflowsComponentTheme;
  readonly agent: MonitorAgentRow | undefined;
  readonly scroll: number;
  readonly width: number;
}): { readonly lines: string[]; readonly scroll: number; readonly maxScroll: number } {
  const inner = Math.max(1, width - 4);
  const wrapped = wordWrap(agent?.fullPrompt ?? "", inner);
  const pageRows = Math.min(wrapped.length, PROMPT_VISIBLE_ROWS);
  const maxScroll = Math.max(0, wrapped.length - pageRows);
  const clampedScroll = Math.min(scroll, maxScroll);
  const windowLines = wrapped.slice(clampedScroll, clampedScroll + pageRows);

  const title = theme.fg("accent", `Prompt · ${wrapped.length} lines`);
  const border = (text: string): string => theme.fg("borderMuted", text);
  const top = `${border("┌")}${titleSegment(title, Math.max(0, width - 2), border)}${border("┐")}`;
  const body = windowLines.map((line) => `${border("│")} ${padTo(line, inner)} ${border("│")}`);
  const bottom = `${border("└")}${border("─".repeat(Math.max(0, width - 2)))}${border("┘")}`;

  const first = wrapped.length === 0 ? 0 : clampedScroll + 1;
  const last = Math.min(wrapped.length, clampedScroll + pageRows);
  const indicator = `${first}-${last} of ${wrapped.length} ↓`;
  const footer = headerSummaryLine(
    theme.fg("dim", "• x stop · r restart · p pause · esc back · s save"),
    indicator,
    width,
  );

  return { lines: [top, ...body, bottom, footer], scroll: clampedScroll, maxScroll };
}

export function renderStopConfirmation(
  theme: WorkflowsComponentTheme,
  pending: PendingStopConfirmation,
  width: number,
): string[] {
  return [
    clipLine(width, theme.fg("warning", stopConfirmationTitle(pending))),
    clipLine(width, `  ${pending.label}`),
    clipLine(width, theme.fg("dim", "  y confirm · esc cancel")),
  ];
}

function stopConfirmationTitle(pending: PendingStopConfirmation): string {
  if (pending.type === "resume-run") return "Resume stopped workflow?";
  if (pending.type === "run") return "Stop workflow?";
  return "Stop agent?";
}

export function chooserFooterText(selectedRunStatus: WorkflowRunStatus | undefined): string {
  if (selectedRunStatus === "stopped") {
    return "↑/↓ to select · Enter to view · r resume · s save · Esc to close";
  }
  return "↑/↓ to select · Enter to view · s to save · Esc to close";
}

export function monitorFooterText(
  screen: MonitorNavigationState["screen"],
  selectedRunStatus: WorkflowRunStatus | undefined,
): string {
  if (selectedRunStatus === "stopped") {
    return screen === "overview"
      ? "↑↓ select · → detail · r resume · esc back · s save"
      : "↑↓ agent · ↵ prompt · r resume workflow · esc back · s save";
  }
  if (screen === "overview") {
    return "↑↓ select · → detail · x stop workflow · p pause · esc back · s save";
  }
  return "↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save";
}

export function canPauseRun(status: WorkflowRunStatus): boolean {
  return status === "running" || status === "resuming";
}

export function canResumeRun(status: WorkflowRunStatus): boolean {
  return status === "paused" || status === "pausing";
}

function renderHeader(
  theme: WorkflowsComponentTheme,
  view: MonitorViewModel,
  width: number,
): string[] {
  const summary = theme.fg(
    "muted",
    `${view.header.doneAgents}/${view.header.totalAgents} agents · ${view.header.elapsedLabel}`,
  );
  const name = theme.bold(theme.fg("accent", view.header.workflowName));
  const lines = [
    clipLine(width, theme.fg("borderAccent", "─".repeat(width))),
    headerSummaryLine(name, summary, width),
  ];
  if (view.header.description !== undefined && view.header.description.length > 0) {
    lines.push(
      clipLine(width, theme.fg("muted", truncateEllipsis(view.header.description, width))),
    );
  }
  lines.push(
    clipLine(
      width,
      theme.fg("dim", truncateEllipsis(`artifacts dir: ${view.header.artifactDir}`, width)),
    ),
  );
  lines.push("");
  return lines;
}

function phaseRowLine(
  theme: WorkflowsComponentTheme,
  phase: MonitorPhaseRow,
  index: number,
  selected: boolean,
): string {
  const cursor = selected ? theme.fg("accent", "› ") : "  ";
  const complete = phase.totalAgents > 0 && phase.doneAgents === phase.totalAgents;
  const marker = complete
    ? theme.fg("success", "✓")
    : theme.fg(selected ? "accent" : "dim", String(index + 1));
  const title = selected
    ? theme.fg("accent", phase.title)
    : complete
      ? theme.fg("success", phase.title)
      : phase.title;
  const progressText =
    phase.failedAgents > 0
      ? `${phase.doneAgents}/${phase.totalAgents} · ${phase.failedAgents} failed`
      : `${phase.doneAgents}/${phase.totalAgents}`;
  const progress = theme.fg(
    phase.failedAgents > 0 ? "error" : complete ? "success" : "muted",
    progressText,
  );
  return `${cursor}${marker} ${title}  ${progress}`;
}

function plannedAgentLines(
  theme: WorkflowsComponentTheme,
  phase: MonitorPhaseRow | undefined,
  hasAgentRows: boolean,
): string[] {
  const rows = phase?.plannedAgents.map((agent) => plannedAgentRow(theme, agent)) ?? [];
  const note = expectedAgentsNote(phase, hasAgentRows, rows.length > 0);
  if (note !== undefined) rows.push(theme.fg("dim", note));
  return rows;
}

function expectedAgentsNote(
  phase: MonitorPhaseRow | undefined,
  hasAgentRows: boolean,
  hasPlannedRows: boolean,
): string | undefined {
  const remaining = phase?.remainingPlannedAgents ?? 0;
  if (remaining > 0) {
    const qualifier = hasAgentRows || hasPlannedRows ? "more " : "";
    return `${remaining} ${qualifier}agents expected; names appear after enqueue.`;
  }
  if (!hasAgentRows && !hasPlannedRows && (phase?.totalAgents ?? 0) > 0) {
    return `${phase?.totalAgents ?? 0} agents expected; names appear after enqueue.`;
  }
  return undefined;
}

function phaseMetadataRows(
  theme: WorkflowsComponentTheme,
  phase: MonitorPhaseRow | undefined,
): string[] {
  if (phase === undefined) return [];
  const rows: string[] = [];
  if (phase.detail !== undefined && phase.detail.length > 0) {
    rows.push(theme.fg("muted", phase.detail));
  }
  if (phase.modelLabel !== undefined && phase.modelLabel.length > 0) {
    rows.push(theme.fg("dim", `model ${phase.modelLabel}`));
  }
  if (rows.length > 0) rows.push("");
  return rows;
}

function plannedAgentRow(theme: WorkflowsComponentTheme, agent: MonitorPlannedAgentRow): string {
  const details = [agent.modelLabel, agent.agentType]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(" · ");
  const suffix = details.length === 0 ? "" : ` ${theme.fg("dim", details)}`;
  return `${theme.fg("dim", "○")} ${theme.fg("muted", agent.label)}${suffix}`;
}

function overviewAgentRow(
  theme: WorkflowsComponentTheme,
  agent: MonitorAgentRow,
  innerWidth: number,
): string {
  const detailParts: string[] = [];
  if (agent.modelLabel !== undefined) detailParts.push(theme.fg("muted", agent.modelLabel));
  const thinking = thinkingLabel(theme, agent);
  if (thinking !== undefined) detailParts.push(thinking);
  const details = detailParts.length === 0 ? "" : ` ${detailParts.join(" · ")}`;
  const label = agent.state === "done" ? theme.fg("muted", agent.label) : agent.label;
  const left = `${agentGlyph(theme, agent)} ${label}${details}`;
  const metric = agentMetricLabel(theme, agent);
  if (metric === "") return padTo(left, innerWidth);
  return headerSummaryLine(left, metric, innerWidth);
}

function agentMetricLabel(theme: WorkflowsComponentTheme, agent: MonitorAgentRow): string {
  const metricParts: string[] = [];
  if (agent.currentToolName !== undefined) metricParts.push(`using ${agent.currentToolName}`);
  if (agent.tokens !== undefined) metricParts.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls !== undefined && agent.currentToolName === undefined) {
    metricParts.push(`${agent.toolCalls} tools`);
  }
  if (metricParts.length > 0) {
    return theme.fg(
      agent.currentToolName === undefined ? "dim" : "accent",
      metricParts.join(" · "),
    );
  }
  if (agent.idleMs !== undefined) return theme.fg("warning", `idle ${formatIdle(agent.idleMs)}`);
  if (agent.noTelemetryMs !== undefined) {
    return theme.fg("warning", `running ${formatIdle(agent.noTelemetryMs)} · no live events`);
  }
  return "";
}

function detailSections(theme: WorkflowsComponentTheme, agent: MonitorAgentRow): string[] {
  const statusParts = [`${agentGlyph(theme, agent)} ${stateLabel(theme, agent)}`];
  if (agent.modelLabel !== undefined) statusParts.push(theme.fg("muted", agent.modelLabel));
  const thinking = thinkingLabel(theme, agent);
  if (thinking !== undefined) statusParts.push(thinking);
  const status = statusParts.join(" · ");
  const metricsParts: string[] = [];
  if (agent.tokens !== undefined) metricsParts.push(`${formatTokens(agent.tokens)} tok`);
  if (agent.toolCalls !== undefined) metricsParts.push(`${agent.toolCalls} tool calls`);
  if (agent.idleMs !== undefined) metricsParts.push(`idle ${formatIdle(agent.idleMs)}`);
  if (agent.noTelemetryMs !== undefined) {
    metricsParts.push(`running ${formatIdle(agent.noTelemetryMs)} · no live events`);
  }

  const promptLines = splitLines(agent.fullPrompt);
  const previewLines = splitLines(agent.promptPreview);
  const promptHead = theme.fg("accent", `Prompt · ${promptLines.length} lines · ↵ expand`);
  const promptBody =
    promptLines.length <= previewLines.length
      ? previewLines
      : [...previewLines, `… ${promptLines.length - previewLines.length} more lines`];

  const activity =
    agent.lastToolName === undefined
      ? ["No tool activity recorded"]
      : [`${agent.lastToolName}${agent.lastToolSummary ? ` ${agent.lastToolSummary}` : ""}`];
  const activityHead =
    agent.toolCalls === undefined
      ? "Activity"
      : `Activity · last ${activity.length} of ${agent.toolCalls} tool calls`;

  const sections = [status];
  if (metricsParts.length > 0) sections.push(theme.fg("dim", metricsParts.join(" · ")));
  sections.push("", promptHead, ...promptBody.map((line) => theme.fg("muted", `  ${line}`)));
  sections.push(
    "",
    theme.fg("accent", activityHead),
    ...activity.map((line) => theme.fg("muted", `  ${line}`)),
  );
  sections.push(
    "",
    theme.fg("accent", "Outcome"),
    theme.fg(outcomeColor(agent), `  ${outcomeText(agent)}`),
  );
  return sections;
}

function agentGlyph(theme: WorkflowsComponentTheme, agent: MonitorAgentRow): string {
  return theme.fg(agentColor(agent.state), agent.glyph);
}

function stateLabel(theme: WorkflowsComponentTheme, agent: MonitorAgentRow): string {
  return theme.fg(agentColor(agent.state), capitalize(agent.state));
}

function runGlyph(
  theme: WorkflowsComponentTheme,
  row: { readonly glyph: string; readonly status: WorkflowRunStatus },
): string {
  return theme.fg(runColor(row.status), row.glyph);
}

function thinkingLabel(theme: WorkflowsComponentTheme, agent: MonitorAgentRow): string | undefined {
  if (agent.thinkingLevelLabel === undefined) return undefined;
  return theme.fg(thinkingColor(agent.thinkingLevel), agent.thinkingLevelLabel);
}

export function clipLine(width: number, text: string): string {
  if (visibleWidth(text) <= width) return text;
  return truncateToWidth(text, width, "");
}

function clampLeftWidth(rows: string[], width: number): number {
  const widest = rows.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
  const cap = Math.max(MIN_LEFT_PANE_WIDTH, Math.floor(width * LEFT_PANE_MAX_FRACTION));
  return Math.max(MIN_LEFT_PANE_WIDTH, Math.min(widest + 2, cap));
}

function visibleRange(
  selectedIndex: number,
  length: number,
  maxVisible: number,
): { start: number; end: number } {
  if (length <= maxVisible) return { start: 0, end: length };
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), length - maxVisible),
  );
  return { start, end: Math.min(start + maxVisible, length) };
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [""] : text.split(/\r?\n/);
}

type ThemeColor = Parameters<WorkflowsComponentTheme["fg"]>[0];

type AgentState = MonitorAgentRow["state"];

function outcomeColor(agent: MonitorAgentRow): ThemeColor {
  if (agent.state === "failed") return "error";
  if (agent.state === "stopped") return "warning";
  if (agent.state === "done") return "success";
  return "muted";
}

function agentColor(state: AgentState): ThemeColor {
  if (state === "done") return "success";
  if (state === "failed") return "error";
  if (state === "stopped") return "warning";
  if (state === "running") return "accent";
  return "dim";
}

function thinkingColor(thinkingLevel: MonitorAgentRow["thinkingLevel"]): ThemeColor {
  if (thinkingLevel === "off") return "thinkingOff";
  if (thinkingLevel === "minimal") return "thinkingMinimal";
  if (thinkingLevel === "low") return "thinkingLow";
  if (thinkingLevel === "medium") return "thinkingMedium";
  if (thinkingLevel === "high") return "thinkingHigh";
  if (thinkingLevel === "xhigh") return "thinkingXhigh";
  return "muted";
}

function runColor(status: WorkflowRunStatus): ThemeColor {
  if (status === "completed") return "success";
  if (status === "failed" || status === "failing") return "error";
  if (status === "stopped" || status === "stopping") return "warning";
  if (
    canPauseRun(status) ||
    canResumeRun(status) ||
    status === "starting" ||
    status === "completing"
  ) {
    return "accent";
  }
  return "dim";
}

function outcomeText(agent: MonitorAgentRow): string {
  if (agent.state === "running" || agent.state === "queued") return "Still running…";
  if (agent.state === "failed") return agent.resultPreview ?? "Failed";
  if (agent.state === "stopped") return agent.resultPreview ?? "Stopped";
  return agent.resultPreview ?? "Completed";
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

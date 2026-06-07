import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { WorkflowRunState, WorkflowRunStatus } from "#src/workflows/run/model.ts";
import type {
  MonitorAgentRow,
  MonitorPhaseRow,
  MonitorPlannedAgentRow,
  MonitorViewModel,
} from "#src/workflows/view/model.ts";
import {
  formatIdle,
  formatTokens,
  headerSummaryLine,
  padTo,
  paneInnerWidths,
  titleSegment,
  truncateEllipsis,
  twoPaneBox,
  wordWrap,
} from "#src/workflows/view/layout.ts";
import {
  buildChooserView,
  buildMonitorView,
  defaultChooserSelection,
} from "#src/workflows/view/projector.ts";
import {
  clampIndex,
  clampMonitorNavigation,
  enterMonitor,
  escapeMonitor,
  focusInMonitor,
  initialMonitorNavigation,
  moveMonitorSelection,
  type MonitorBounds,
  type MonitorNavigationState,
} from "#src/workflows/view/navigation.ts";

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

export interface WorkflowsTuiComponentOptions {
  readonly runs: WorkflowRunState[];
  readonly savedWorkflowCount?: number;
  readonly theme: WorkflowsComponentTheme;
  readonly now?: () => number;
  readonly onClose?: () => void;
  readonly onPauseRun?: (runId: string) => void;
  readonly onResumeRun?: (runId: string) => void;
  readonly onStopRun?: (runId: string) => void;
  readonly onStopAgent?: (runId: string, agentId: string) => void;
}

const PROMPT_VISIBLE_ROWS = 15;

type PendingStopConfirmation =
  | { readonly type: "run"; readonly runId: string; readonly label: string }
  | {
      readonly type: "agent";
      readonly runId: string;
      readonly agentId: string;
      readonly label: string;
    };

export class WorkflowsTuiComponent implements Component {
  #runs: WorkflowRunState[];
  #theme: WorkflowsComponentTheme;
  #now: () => number;
  #onClose?: () => void;
  #onPauseRun?: (runId: string) => void;
  #onResumeRun?: (runId: string) => void;
  #onStopRun?: (runId: string) => void;
  #onStopAgent?: (runId: string, agentId: string) => void;
  #pendingStop?: PendingStopConfirmation;
  #nav: MonitorNavigationState;
  #promptScroll = 0;
  #promptMaxScroll = Number.MAX_SAFE_INTEGER;
  #cachedWidth?: number;
  #cachedLines?: string[];

  constructor(options: WorkflowsTuiComponentOptions) {
    this.#runs = options.runs;
    this.#theme = options.theme;
    this.#now = options.now ?? (() => Date.now());
    this.#onClose = options.onClose;
    this.#onPauseRun = options.onPauseRun;
    this.#onResumeRun = options.onResumeRun;
    this.#onStopRun = options.onStopRun;
    this.#onStopAgent = options.onStopAgent;
    this.#nav = {
      ...initialMonitorNavigation(options.runs.length),
      selectedRunIndex: defaultChooserSelection(options.runs),
    };
  }

  setRuns(runs: WorkflowRunState[]): void {
    this.#runs = runs;
    this.#nav = clampMonitorNavigation(this.#nav, this.#bounds());
    if (runs.length <= 1 && this.#nav.screen === "chooser") {
      this.#nav = { ...this.#nav, screen: "overview" };
    }
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.#onClose?.();
      return;
    }

    const before = this.#snapshot();

    if (this.#pendingStop !== undefined) {
      this.#handleStopConfirmation(data);
      if (before !== this.#snapshot()) this.invalidate();
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.#handleEscape();
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.#moveSelection(-1);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.#moveSelection(1);
    } else if (matchesKey(data, Key.left)) {
      this.#handleLeft();
    } else if (matchesKey(data, Key.right)) {
      this.#handleRight();
    } else if (matchesKey(data, Key.enter)) {
      this.#handleEnter();
    } else if (data === "p") {
      this.#handlePauseResume();
    } else if (data === "x") {
      this.#requestStopConfirmation();
    }

    if (before !== this.#snapshot()) this.invalidate();
  }

  render(width: number): string[] {
    if (this.#cachedLines !== undefined && this.#cachedWidth === width) return this.#cachedLines;

    const safeWidth = Math.max(1, width);
    if (this.#runs.length === 0) return this.#cache(safeWidth, this.#renderEmpty(safeWidth));
    if (this.#nav.screen === "chooser")
      return this.#cache(safeWidth, this.#renderChooser(safeWidth));
    if (this.#nav.screen === "promptReader")
      return this.#cache(safeWidth, this.#renderPromptReader(safeWidth));

    const lines =
      this.#nav.screen === "agentDetail"
        ? this.#renderAgentDetail(safeWidth)
        : this.#renderOverview(safeWidth);
    lines.push("", this.#line(safeWidth, this.#theme.fg("dim", this.#footerText())));
    if (this.#pendingStop !== undefined) lines.push("", ...this.#renderStopConfirmation(safeWidth));
    return this.#cache(safeWidth, lines);
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedLines = undefined;
  }

  #renderEmpty(width: number): string[] {
    return [
      this.#line(width, this.#theme.fg("accent", this.#theme.bold("Dynamic workflows"))),
      "",
      this.#line(width, this.#theme.fg("dim", "No workflow runs found in .pi/workflows.")),
      "",
      this.#line(width, this.#theme.fg("dim", "esc close")),
    ];
  }

  #renderHeader(view: MonitorViewModel, width: number): string[] {
    const summary = this.#theme.fg(
      "muted",
      `${view.header.doneAgents}/${view.header.totalAgents} agents · ${view.header.elapsedLabel}`,
    );
    const name = this.#theme.bold(this.#theme.fg("accent", view.header.workflowName));
    const lines = [
      this.#line(width, this.#theme.fg("borderAccent", "─".repeat(width))),
      headerSummaryLine(name, summary, width),
    ];
    if (view.header.description !== undefined && view.header.description.length > 0) {
      lines.push(
        this.#line(
          width,
          this.#theme.fg("muted", truncateEllipsis(view.header.description, width)),
        ),
      );
    }
    lines.push("");
    return lines;
  }

  #renderOverview(width: number): string[] {
    const run = this.#selectedRun();
    if (run === undefined) return [this.#line(width, "No run selected")];
    const view = this.#monitorView(run);
    const header = this.#renderHeader(view, width);

    const phaseRows = view.phases.map((phase, index) => {
      const selected = index === this.#nav.selectedPhaseIndex;
      const cursor = selected ? this.#theme.fg("accent", "› ") : "  ";
      const complete = phase.totalAgents > 0 && phase.doneAgents === phase.totalAgents;
      const marker = complete
        ? this.#theme.fg("success", "✓")
        : this.#theme.fg(selected ? "accent" : "dim", String(index + 1));
      const title = selected
        ? this.#theme.fg("accent", phase.title)
        : complete
          ? this.#theme.fg("success", phase.title)
          : phase.title;
      const progress = this.#theme.fg(
        complete ? "success" : "muted",
        `${phase.doneAgents}/${phase.totalAgents}`,
      );
      return `${cursor}${marker} ${title}  ${progress}`;
    });
    const selectedPhase = view.phases[this.#nav.selectedPhaseIndex];
    const selectedPhaseTitle = selectedPhase?.title ?? "";
    const rightTitle = `${this.#theme.fg("accent", selectedPhaseTitle)} · ${this.#theme.fg("muted", `${selectedPhase?.totalAgents ?? view.selectedPhaseAgents.length} agents`)}`;
    const leftWidth = clampLeftWidth(phaseRows, width);
    const { rightWidth } = paneInnerWidths(width, leftWidth);
    const agentRows = view.selectedPhaseAgents.map((agent) =>
      this.#overviewAgentRow(agent, rightWidth),
    );
    const plannedRows =
      selectedPhase?.plannedAgents.map((agent) => this.#plannedAgentRow(agent)) ?? [];
    if ((selectedPhase?.remainingPlannedAgents ?? 0) > 0) {
      const remaining = selectedPhase?.remainingPlannedAgents ?? 0;
      const message =
        agentRows.length > 0 || plannedRows.length > 0
          ? `${remaining} more agents expected; names appear after enqueue.`
          : `${remaining} agents expected; names appear after enqueue.`;
      plannedRows.push(this.#theme.fg("dim", message));
    } else if (
      agentRows.length === 0 &&
      (selectedPhase?.totalAgents ?? 0) > 0 &&
      plannedRows.length === 0
    ) {
      plannedRows.push(
        this.#theme.fg(
          "dim",
          `${selectedPhase?.totalAgents ?? 0} agents expected; names appear after enqueue.`,
        ),
      );
    }
    const rightLines = [
      ...this.#phaseMetadataRows(selectedPhase),
      ...(agentRows.length > 0 && plannedRows.length > 0 ? [...agentRows, ""] : agentRows),
      ...plannedRows,
    ];

    return [
      ...header,
      ...twoPaneBox({
        leftTitle: this.#theme.fg("accent", "Phases"),
        rightTitle,
        leftLines: phaseRows,
        rightLines,
        leftWidth,
        width,
        styleBorder: (text) => this.#theme.fg("borderMuted", text),
      }),
    ];
  }

  #renderAgentDetail(width: number): string[] {
    const run = this.#selectedRun();
    if (run === undefined) return [this.#line(width, "No run selected")];
    const view = this.#monitorView(run);
    const header = this.#renderHeader(view, width);
    const agents = view.selectedPhaseAgents;
    const selected = agents[this.#nav.selectedAgentIndex];

    const selectedPhase = view.phases[this.#nav.selectedPhaseIndex];
    const selectedPhaseTitle = selectedPhase?.title ?? "";
    const leftTitle = `${this.#theme.fg("accent", selectedPhaseTitle)} · ${this.#theme.fg("muted", `${selectedPhase?.totalAgents ?? agents.length} agents`)}`;
    const agentRows = agents.map((agent, index) => {
      const cursor = index === this.#nav.selectedAgentIndex ? this.#theme.fg("accent", "› ") : "  ";
      return `${cursor}${this.#agentGlyph(agent)} ${agent.label}`;
    });
    const detailRows =
      selected === undefined ? ["No agent selected"] : this.#detailSections(selected);
    const leftWidth = clampLeftWidth(agentRows, width);

    return [
      ...header,
      ...twoPaneBox({
        leftTitle,
        rightTitle: this.#theme.fg("accent", selected?.label ?? ""),
        leftLines: agentRows,
        rightLines: detailRows,
        leftWidth,
        width,
        styleBorder: (text) => this.#theme.fg("borderMuted", text),
      }),
    ];
  }

  #detailSections(agent: MonitorAgentRow): string[] {
    const statusParts = [`${this.#agentGlyph(agent)} ${this.#stateLabel(agent)}`];
    if (agent.modelLabel !== undefined) statusParts.push(this.#theme.fg("muted", agent.modelLabel));
    const thinkingLabel = this.#thinkingLabel(agent);
    if (thinkingLabel !== undefined) statusParts.push(thinkingLabel);
    const status = statusParts.join(" · ");
    const metricsParts: string[] = [];
    if (agent.tokens !== undefined) metricsParts.push(`${formatTokens(agent.tokens)} tok`);
    if (agent.toolCalls !== undefined) metricsParts.push(`${agent.toolCalls} tool calls`);
    if (agent.idleMs !== undefined) metricsParts.push(`idle ${formatIdle(agent.idleMs)}`);

    const promptLines = splitLines(agent.fullPrompt);
    const previewLines = splitLines(agent.promptPreview);
    const promptHead = this.#theme.fg("accent", `Prompt · ${promptLines.length} lines · ↵ expand`);
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
    if (metricsParts.length > 0) sections.push(this.#theme.fg("dim", metricsParts.join(" · ")));
    sections.push(
      "",
      promptHead,
      ...promptBody.map((line) => this.#theme.fg("muted", `  ${line}`)),
    );
    sections.push(
      "",
      this.#theme.fg("accent", activityHead),
      ...activity.map((line) => this.#theme.fg("muted", `  ${line}`)),
    );
    sections.push(
      "",
      this.#theme.fg("accent", "Outcome"),
      this.#theme.fg(outcomeColor(agent), `  ${outcomeText(agent)}`),
    );
    return sections;
  }

  #renderPromptReader(width: number): string[] {
    const agent = this.#selectedAgentRow();
    const inner = Math.max(1, width - 4);
    const wrapped = wordWrap(agent?.fullPrompt ?? "", inner);
    const pageRows = Math.min(wrapped.length, PROMPT_VISIBLE_ROWS);
    const maxScroll = Math.max(0, wrapped.length - pageRows);
    this.#promptScroll = Math.min(this.#promptScroll, maxScroll);
    const windowLines = wrapped.slice(this.#promptScroll, this.#promptScroll + pageRows);

    this.#promptMaxScroll = maxScroll;
    const title = this.#theme.fg("accent", `Prompt · ${wrapped.length} lines`);
    const border = (text: string): string => this.#theme.fg("borderMuted", text);
    const top = `${border("┌")}${titleSegment(title, Math.max(0, width - 2), border)}${border("┐")}`;
    const body = windowLines.map((line) => `${border("│")} ${padTo(line, inner)} ${border("│")}`);
    const bottom = `${border("└")}${border("─".repeat(Math.max(0, width - 2)))}${border("┘")}`;

    const first = wrapped.length === 0 ? 0 : this.#promptScroll + 1;
    const last = Math.min(wrapped.length, this.#promptScroll + pageRows);
    const indicator = `${first}-${last} of ${wrapped.length} ↓`;
    const footer = headerSummaryLine(
      this.#theme.fg("dim", "• x stop · r restart · p pause · esc back · s save"),
      indicator,
      width,
    );

    return [top, ...body, bottom, footer];
  }

  #renderChooser(width: number): string[] {
    const view = buildChooserView(this.#runs, { now: this.#now() });
    const lines = [
      this.#line(width, this.#theme.fg("dim", "› /workflows")),
      "",
      this.#line(width, this.#theme.fg("borderAccent", "─".repeat(width))),
      "",
      this.#line(width, `  ${this.#theme.bold(this.#theme.fg("accent", "Dynamic workflows"))}`),
      this.#line(
        width,
        `  ${this.#theme.fg("dim", `${view.runningCount} running · ${view.completedCount} completed`)}`,
      ),
      "",
    ];

    const range = visibleRange(this.#nav.selectedRunIndex, view.rows.length, 10);
    for (let index = range.start; index < range.end; index += 1) {
      const row = view.rows[index];
      if (row === undefined) continue;
      const selected = index === this.#nav.selectedRunIndex;
      const cursor = selected ? this.#theme.fg("accent", "› ") : "  ";
      const tokens = row.tokens === undefined ? "" : ` · ${formatTokens(row.tokens)} tok`;
      const metrics = this.#theme.fg(
        "dim",
        `${row.agentCount} agents${tokens} · ${row.durationLabel}`,
      );
      const content = `  ${cursor}${this.#runGlyph(row)} ${selected ? this.#theme.fg("accent", row.workflowName) : row.workflowName}   ${metrics}`;
      lines.push(this.#line(width, content));
    }

    lines.push(
      "",
      this.#line(
        width,
        `  ${this.#theme.fg("dim", "↑/↓ to select · Enter to view · s to save · Esc to close")}`,
      ),
    );
    return lines;
  }

  #phaseMetadataRows(phase: MonitorPhaseRow | undefined): string[] {
    if (phase === undefined) return [];
    const rows: string[] = [];
    if (phase.detail !== undefined && phase.detail.length > 0) {
      rows.push(this.#theme.fg("muted", phase.detail));
    }
    if (phase.modelLabel !== undefined && phase.modelLabel.length > 0) {
      rows.push(this.#theme.fg("dim", `model ${phase.modelLabel}`));
    }
    if (rows.length > 0) rows.push("");
    return rows;
  }

  #plannedAgentRow(agent: MonitorPlannedAgentRow): string {
    const details = [agent.modelLabel, agent.agentType]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" · ");
    const suffix = details.length === 0 ? "" : ` ${this.#theme.fg("dim", details)}`;
    return `${this.#theme.fg("dim", "○")} ${this.#theme.fg("muted", agent.label)}${suffix}`;
  }

  #overviewAgentRow(agent: MonitorAgentRow, innerWidth: number): string {
    const detailParts: string[] = [];
    if (agent.modelLabel !== undefined) detailParts.push(this.#theme.fg("muted", agent.modelLabel));
    const thinkingLabel = this.#thinkingLabel(agent);
    if (thinkingLabel !== undefined) detailParts.push(thinkingLabel);
    const details = detailParts.length === 0 ? "" : ` ${detailParts.join(" · ")}`;
    const label = agent.state === "done" ? this.#theme.fg("muted", agent.label) : agent.label;
    const left = `${this.#agentGlyph(agent)} ${label}${details}`;
    const metricParts: string[] = [];
    if (agent.tokens !== undefined) metricParts.push(`${formatTokens(agent.tokens)} tok`);
    if (agent.toolCalls !== undefined) metricParts.push(`${agent.toolCalls} tools`);
    const metric =
      metricParts.length > 0
        ? this.#theme.fg("dim", metricParts.join(" · "))
        : agent.idleMs !== undefined
          ? this.#theme.fg("warning", `idle ${formatIdle(agent.idleMs)}`)
          : "";
    if (metric === "") return padTo(left, innerWidth);
    return headerSummaryLine(left, metric, innerWidth);
  }

  #agentGlyph(agent: MonitorAgentRow): string {
    return this.#theme.fg(agentColor(agent.state), agent.glyph);
  }

  #stateLabel(agent: MonitorAgentRow): string {
    return this.#theme.fg(agentColor(agent.state), capitalize(agent.state));
  }

  #runGlyph(row: { readonly glyph: string; readonly status: WorkflowRunStatus }): string {
    return this.#theme.fg(runColor(row.status), row.glyph);
  }

  #thinkingLabel(agent: MonitorAgentRow): string | undefined {
    if (agent.thinkingLevelLabel === undefined) return undefined;
    return this.#theme.fg(thinkingColor(agent.thinkingLevel), agent.thinkingLevelLabel);
  }

  #footerText(): string {
    if (this.#nav.screen === "overview") {
      return "↑↓ select · → detail · x stop workflow · p pause · esc back · s save";
    }
    return "↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save";
  }

  #bounds(): MonitorBounds {
    const run = this.#selectedRun();
    const view = run === undefined ? undefined : this.#monitorView(run);
    return {
      runCount: this.#runs.length,
      phaseCount: view?.phases.length ?? 0,
      agentCount: view?.selectedPhaseAgents.length ?? 0,
    };
  }

  #renderStopConfirmation(width: number): string[] {
    const pending = this.#pendingStop;
    if (pending === undefined) return [];
    const title = pending.type === "run" ? "Stop workflow?" : "Stop agent?";
    return [
      this.#line(width, this.#theme.fg("warning", title)),
      this.#line(width, `  ${pending.label}`),
      this.#line(width, this.#theme.fg("dim", "  y confirm · esc cancel")),
    ];
  }

  #handleEscape(): void {
    if (this.#pendingStop !== undefined) {
      this.#pendingStop = undefined;
      return;
    }

    const result = escapeMonitor(this.#nav, this.#bounds());
    if (result.close === true) {
      this.#onClose?.();
      return;
    }
    if (result.state !== undefined) {
      if (result.state.screen === "agentDetail" && this.#nav.screen === "promptReader") {
        this.#promptScroll = 0;
      }
      this.#nav = result.state;
    }
  }

  #handleLeft(): void {
    this.#nav = focusInMonitor(this.#nav, this.#bounds(), "left");
  }

  #handleRight(): void {
    this.#nav = focusInMonitor(this.#nav, this.#bounds(), "right");
  }

  #handleEnter(): void {
    const next = enterMonitor(this.#nav, this.#bounds());
    if (next.screen === "promptReader" && this.#nav.screen !== "promptReader") {
      this.#promptScroll = 0;
    }
    this.#nav = next;
  }

  #handlePauseResume(): void {
    const run = this.#selectedRun();
    if (run === undefined) return;
    if (canPauseRun(run.status)) this.#onPauseRun?.(run.runId);
    else if (canResumeRun(run.status)) this.#onResumeRun?.(run.runId);
  }

  #requestStopConfirmation(): void {
    const run = this.#selectedRun();
    if (run === undefined) return;

    if (this.#nav.screen === "agentDetail" || this.#nav.screen === "promptReader") {
      const agent = this.#selectedAgentRow();
      if (agent === undefined) return;
      this.#pendingStop = {
        type: "agent",
        runId: run.runId,
        agentId: agent.agentId,
        label: agent.label,
      };
      return;
    }

    this.#pendingStop = { type: "run", runId: run.runId, label: run.workflowName };
  }

  #handleStopConfirmation(data: string): void {
    if (matchesKey(data, Key.escape) || data === "n") {
      this.#pendingStop = undefined;
      return;
    }
    if (data !== "y") return;

    const pending = this.#pendingStop;
    this.#pendingStop = undefined;
    if (pending === undefined) return;
    if (pending.type === "run") this.#onStopRun?.(pending.runId);
    else this.#onStopAgent?.(pending.runId, pending.agentId);
  }

  #moveSelection(direction: -1 | 1): void {
    if (this.#nav.screen === "promptReader") {
      this.#promptScroll = Math.max(
        0,
        Math.min(this.#promptScroll + direction, this.#promptMaxScroll),
      );
      return;
    }
    this.#nav = moveMonitorSelection(this.#nav, this.#bounds(), direction);
  }

  #monitorView(run: WorkflowRunState): MonitorViewModel {
    return buildMonitorView(run, {
      selectedPhaseIndex: this.#nav.selectedPhaseIndex,
      now: this.#now(),
    });
  }

  #selectedRun(): WorkflowRunState | undefined {
    return this.#runs[clampIndex(this.#nav.selectedRunIndex, this.#runs.length)];
  }

  #agents(): MonitorAgentRow[] {
    const run = this.#selectedRun();
    return run === undefined ? [] : this.#monitorView(run).selectedPhaseAgents;
  }

  #selectedAgentRow(): MonitorAgentRow | undefined {
    return this.#agents()[this.#nav.selectedAgentIndex];
  }

  #snapshot(): string {
    const pending =
      this.#pendingStop === undefined
        ? "none"
        : `${this.#pendingStop.type}:${this.#pendingStop.runId}`;
    return `${this.#nav.screen}:${this.#nav.selectedRunIndex}:${this.#nav.selectedPhaseIndex}:${this.#nav.selectedAgentIndex}:${this.#promptScroll}:${pending}`;
  }

  #line(width: number, text: string): string {
    if (visibleWidth(text) <= width) return text;
    return truncateToWidth(text, width, "");
  }

  #cache(width: number, lines: string[]): string[] {
    this.#cachedLines = lines.map((line) => this.#line(width, line));
    this.#cachedWidth = width;
    return this.#cachedLines;
  }
}

function clampLeftWidth(rows: string[], width: number): number {
  const widest = rows.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
  const cap = Math.max(12, Math.floor(width * 0.4));
  return Math.max(12, Math.min(widest + 2, cap));
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

function canPauseRun(status: WorkflowRunStatus): boolean {
  return status === "running" || status === "resuming";
}

function canResumeRun(status: WorkflowRunStatus): boolean {
  return status === "paused" || status === "pausing";
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

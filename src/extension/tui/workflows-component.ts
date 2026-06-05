import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { WorkflowAgentProgress } from "../../workflows/agent/model.ts";
import type { WorkflowRunState } from "../../workflows/run/model.ts";
import type {
  WorkflowRunDetails,
  WorkflowRunsViewModel,
  WorkflowViewFocus,
} from "../../workflows/view/model.ts";
import {
  clampWorkflowViewNavigation,
  cycleWorkflowViewFocus,
  enterWorkflowViewSelection,
  initialWorkflowViewNavigation,
  moveWorkflowViewSelection,
  type WorkflowViewNavigationState,
} from "../../workflows/view/navigation.ts";
import { projectWorkflowsView } from "../../workflows/view/projector.ts";

export interface WorkflowsComponentTheme {
  fg(
    color: "text" | "accent" | "muted" | "dim" | "success" | "error" | "warning",
    text: string,
  ): string;
  bold(text: string): string;
}

export interface WorkflowsTuiComponentOptions {
  readonly runs: WorkflowRunState[];
  readonly savedWorkflowCount?: number;
  readonly theme: WorkflowsComponentTheme;
  readonly onClose?: () => void;
}

export class WorkflowsTuiComponent implements Component {
  #runs: WorkflowRunState[];
  #savedWorkflowCount: number;
  #theme: WorkflowsComponentTheme;
  #navigation: WorkflowViewNavigationState = initialWorkflowViewNavigation();
  #onClose?: () => void;
  #cachedWidth?: number;
  #cachedLines?: string[];

  constructor(options: WorkflowsTuiComponentOptions) {
    this.#runs = options.runs;
    this.#savedWorkflowCount = options.savedWorkflowCount ?? 0;
    this.#theme = options.theme;
    this.#onClose = options.onClose;
  }

  setRuns(runs: WorkflowRunState[]): void {
    this.#runs = runs;
    this.#navigation = clampWorkflowViewNavigation(this.#navigation, this.#bounds());
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.#onClose?.();
      return;
    }

    const bounds = this.#bounds();
    const previous = this.#navigation;

    if (matchesKey(data, Key.up)) {
      this.#navigation = moveWorkflowViewSelection(this.#navigation, bounds, -1);
    } else if (matchesKey(data, Key.down)) {
      this.#navigation = moveWorkflowViewSelection(this.#navigation, bounds, 1);
    } else if (matchesKey(data, Key.tab)) {
      this.#navigation = cycleWorkflowViewFocus(this.#navigation, bounds);
    } else if (matchesKey(data, Key.enter)) {
      this.#navigation = enterWorkflowViewSelection(this.#navigation, bounds);
    }

    if (previous !== this.#navigation) this.invalidate();
  }

  render(width: number): string[] {
    if (this.#cachedLines !== undefined && this.#cachedWidth === width) return this.#cachedLines;

    const safeWidth = Math.max(1, width);
    const view = this.#view();
    const lines: string[] = [
      this.#line(safeWidth, this.#theme.fg("accent", this.#theme.bold("Workflows"))),
      this.#line(safeWidth, this.#subtitle(view)),
      "",
    ];

    if (view.runs.length === 0) {
      lines.push(this.#line(safeWidth, "No workflow runs found in .pi/workflows."));
      lines.push(this.#line(safeWidth, this.#helpText()));
      this.#cachedLines = lines.map((line) => this.#line(safeWidth, line));
      this.#cachedWidth = safeWidth;
      return this.#cachedLines;
    }

    lines.push(...this.#renderRuns(view, safeWidth));
    lines.push("");
    lines.push(...this.#renderProgress(view.selectedRun, safeWidth));
    lines.push("");
    lines.push(...this.#renderAgents(view.selectedRun, safeWidth));
    lines.push("");
    lines.push(...this.#renderDetails(view.selectedRun, safeWidth));
    lines.push("");
    lines.push(this.#line(safeWidth, this.#helpText()));

    this.#cachedLines = lines.map((line) => this.#line(safeWidth, line));
    this.#cachedWidth = safeWidth;
    return this.#cachedLines;
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedLines = undefined;
  }

  #view(): WorkflowRunsViewModel {
    return projectWorkflowsView(this.#runs, {
      selectedRunIndex: this.#navigation.selectedRunIndex,
      savedWorkflowCount: this.#savedWorkflowCount,
    });
  }

  #bounds(): { runCount: number; agentCount: number } {
    const view = this.#view();
    return {
      runCount: view.runs.length,
      agentCount: view.selectedRun?.agents.length ?? 0,
    };
  }

  #subtitle(view: WorkflowRunsViewModel): string {
    const runLabel = `${view.runs.length} run${view.runs.length === 1 ? "" : "s"}`;
    const savedLabel = `${view.savedWorkflowCount} saved workflow${view.savedWorkflowCount === 1 ? "" : "s"}`;
    return this.#theme.fg("dim", `${runLabel} • ${savedLabel}`);
  }

  #renderRuns(view: WorkflowRunsViewModel, width: number): string[] {
    const lines = [this.#sectionTitle("runs", "Runs", width)];
    const range = visibleRange(this.#navigation.selectedRunIndex, view.runs.length, 6);

    for (let index = range.start; index < range.end; index += 1) {
      const row = view.runs[index];
      if (row === undefined) continue;
      const selected = index === this.#navigation.selectedRunIndex;
      const prefix = selected ? "> " : "  ";
      const duration = row.durationLabel === undefined ? "" : ` ${row.durationLabel}`;
      const content = `${prefix}${row.runId}  ${row.status}  ${row.workflowName}  ${row.agentCount} agents${duration}`;
      lines.push(this.#line(width, selected ? this.#theme.fg("accent", content) : content));
    }

    if (range.start > 0 || range.end < view.runs.length) {
      lines.push(
        this.#line(
          width,
          this.#theme.fg("dim", `  (${this.#navigation.selectedRunIndex + 1}/${view.runs.length})`),
        ),
      );
    }

    return lines;
  }

  #renderProgress(run: WorkflowRunDetails | undefined, width: number): string[] {
    const lines = [this.#sectionTitle(undefined, "Progress", width)];
    if (run === undefined) return [...lines, this.#line(width, "  No run selected")];
    if (run.phases.length === 0) return [...lines, this.#line(width, "  No phases recorded")];

    for (const phase of run.phases) {
      const statusParts = [`${phase.doneAgents}/${phase.totalAgents} done`];
      if (phase.runningAgents > 0) statusParts.push(`${phase.runningAgents} running`);
      if (phase.failedAgents > 0) statusParts.push(`${phase.failedAgents} failed`);
      if (phase.stoppedAgents > 0) statusParts.push(`${phase.stoppedAgents} stopped`);
      lines.push(this.#line(width, `  ${phase.title}  ${statusParts.join(" • ")}`));
    }

    return lines;
  }

  #renderAgents(run: WorkflowRunDetails | undefined, width: number): string[] {
    const lines = [this.#sectionTitle("agents", "Agents", width)];
    if (run === undefined) return [...lines, this.#line(width, "  No run selected")];
    if (run.agents.length === 0) return [...lines, this.#line(width, "  No agents recorded")];

    const range = visibleRange(this.#navigation.selectedAgentIndex, run.agents.length, 8);
    for (let index = range.start; index < range.end; index += 1) {
      const agent = run.agents[index];
      if (agent === undefined) continue;
      const selected =
        this.#navigation.focus === "agents" && index === this.#navigation.selectedAgentIndex;
      lines.push(this.#line(width, this.#formatAgentRow(agent, selected)));
    }

    if (range.start > 0 || range.end < run.agents.length) {
      lines.push(
        this.#line(
          width,
          this.#theme.fg(
            "dim",
            `  (${this.#navigation.selectedAgentIndex + 1}/${run.agents.length})`,
          ),
        ),
      );
    }

    return lines;
  }

  #renderDetails(run: WorkflowRunDetails | undefined, width: number): string[] {
    const lines = [this.#sectionTitle("details", "Details", width)];
    if (run === undefined) return [...lines, this.#line(width, "  No run selected")];

    const selectedAgent = run.agents[this.#navigation.selectedAgentIndex];
    lines.push(this.#line(width, `  output: ${run.outputPath ?? "not written yet"}`));
    lines.push(this.#line(width, `  tokens: ${run.totalTokens} • tools: ${run.totalToolCalls}`));

    if (selectedAgent !== undefined) {
      lines.push(
        this.#line(width, `  selected agent: ${selectedAgent.label} (${selectedAgent.state})`),
      );
      if (selectedAgent.lastToolName !== undefined) {
        lines.push(this.#line(width, `  last tool: ${selectedAgent.lastToolName}`));
      }
      if (selectedAgent.resultPreview !== undefined) {
        lines.push(this.#line(width, `  result: ${selectedAgent.resultPreview}`));
      }
    }

    for (const failure of run.failures.slice(0, 2)) {
      lines.push(this.#line(width, this.#theme.fg("error", `  failure: ${failure}`)));
    }

    const latestLog = run.logs.at(-1);
    if (latestLog !== undefined) lines.push(this.#line(width, `  latest log: ${latestLog}`));

    return lines;
  }

  #formatAgentRow(agent: WorkflowAgentProgress, selected: boolean): string {
    const prefix = selected ? "> " : "  ";
    const tool = agent.lastToolName === undefined ? "" : `  ${agent.lastToolName}`;
    const tokens = agent.tokens === undefined ? "" : `  ${agent.tokens} tok`;
    const toolCalls = agent.toolCalls === undefined ? "" : `  ${agent.toolCalls} tools`;
    const row = `${prefix}${agent.state.padEnd(7)} ${agent.label}${tokens}${toolCalls}${tool}`;
    return selected ? this.#theme.fg("accent", row) : row;
  }

  #sectionTitle(focus: WorkflowViewFocus | undefined, title: string, width: number): string {
    const prefix = this.#navigation.focus === focus ? "▶ " : "  ";
    return this.#line(
      width,
      this.#theme.fg(this.#navigation.focus === focus ? "accent" : "muted", `${prefix}${title}`),
    );
  }

  #helpText(): string {
    return this.#theme.fg("dim", "↑↓ select • tab focus • enter inspect • esc close");
  }

  #line(width: number, text: string): string {
    if (visibleWidth(text) <= width) return text;
    return truncateToWidth(text, width, "");
  }
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

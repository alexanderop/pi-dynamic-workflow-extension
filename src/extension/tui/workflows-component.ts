import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { WorkflowAgentProgress } from "../../workflows/agent/model.ts";
import type { WorkflowRunState, WorkflowRunStatus } from "../../workflows/run/model.ts";
import type { WorkflowRunDetails, WorkflowRunsViewModel } from "../../workflows/view/model.ts";
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

type WorkflowTuiScreen = "chooser" | "overview" | "agentDetail" | "promptReader";

export class WorkflowsTuiComponent implements Component {
  #runs: WorkflowRunState[];
  #savedWorkflowCount: number;
  #theme: WorkflowsComponentTheme;
  #onClose?: () => void;
  #screen: WorkflowTuiScreen;
  #selectedRunIndex = 0;
  #selectedPhaseIndex = 0;
  #selectedAgentIndex = 0;
  #cachedWidth?: number;
  #cachedLines?: string[];

  constructor(options: WorkflowsTuiComponentOptions) {
    this.#runs = options.runs;
    this.#savedWorkflowCount = options.savedWorkflowCount ?? 0;
    this.#theme = options.theme;
    this.#onClose = options.onClose;
    this.#screen = options.runs.length === 1 ? "overview" : "chooser";
  }

  setRuns(runs: WorkflowRunState[]): void {
    this.#runs = runs;
    this.#selectedRunIndex = clampIndex(this.#selectedRunIndex, runs.length);
    this.#selectedPhaseIndex = clampIndex(
      this.#selectedPhaseIndex,
      this.#selectedRun()?.phases.length ?? 0,
    );
    this.#selectedAgentIndex = clampIndex(
      this.#selectedAgentIndex,
      this.#selectedPhaseAgents().length,
    );
    if (runs.length === 0) this.#screen = "chooser";
    if (runs.length === 1 && this.#screen === "chooser") this.#screen = "overview";
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.#onClose?.();
      return;
    }

    const previousScreen = this.#screen;
    const previousRun = this.#selectedRunIndex;
    const previousPhase = this.#selectedPhaseIndex;
    const previousAgent = this.#selectedAgentIndex;

    if (matchesKey(data, Key.escape)) {
      this.#handleEscape();
    } else if (matchesKey(data, Key.up)) {
      this.#moveSelection(-1);
    } else if (matchesKey(data, Key.down)) {
      this.#moveSelection(1);
    } else if (matchesKey(data, Key.left)) {
      this.#handleLeft();
    } else if (matchesKey(data, Key.right)) {
      this.#handleRight();
    } else if (matchesKey(data, Key.enter)) {
      this.#handleEnter();
    } else if (matchesKey(data, Key.tab)) {
      this.#handleTab();
    }

    if (
      previousScreen !== this.#screen ||
      previousRun !== this.#selectedRunIndex ||
      previousPhase !== this.#selectedPhaseIndex ||
      previousAgent !== this.#selectedAgentIndex
    ) {
      this.invalidate();
    }
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
      return this.#cache(safeWidth, lines);
    }

    if (this.#screen === "chooser") {
      lines.push(...this.#renderChooser(view, safeWidth));
    } else if (this.#screen === "overview") {
      lines.push(...this.#renderOverview(view.selectedRun, safeWidth));
    } else if (this.#screen === "agentDetail") {
      lines.push(...this.#renderAgentDetail(view.selectedRun, safeWidth));
    } else {
      lines.push(...this.#renderPromptReader(view.selectedRun, safeWidth));
    }

    lines.push("");
    lines.push(this.#line(safeWidth, this.#helpText()));
    return this.#cache(safeWidth, lines);
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedLines = undefined;
  }

  #handleEscape(): void {
    if (this.#screen === "promptReader") {
      this.#screen = "agentDetail";
      return;
    }
    if (this.#screen === "agentDetail") {
      this.#screen = "overview";
      return;
    }
    if (this.#screen === "overview" && this.#runs.length > 1) {
      this.#screen = "chooser";
      return;
    }
    this.#onClose?.();
  }

  #handleLeft(): void {
    if (this.#screen === "overview" && this.#selectedPhaseAgents().length > 0) {
      this.#selectedAgentIndex = clampIndex(
        this.#selectedAgentIndex,
        this.#selectedPhaseAgents().length,
      );
      this.#screen = "agentDetail";
    }
  }

  #handleRight(): void {
    if (this.#screen === "agentDetail" || this.#screen === "promptReader")
      this.#screen = "overview";
  }

  #handleEnter(): void {
    if (this.#screen === "chooser") {
      this.#screen = "overview";
      this.#selectedPhaseIndex = 0;
      this.#selectedAgentIndex = 0;
      return;
    }
    if (this.#screen === "overview" && this.#selectedPhaseAgents().length > 0) {
      this.#screen = "agentDetail";
      return;
    }
    if (this.#screen === "agentDetail" && this.#selectedAgent() !== undefined) {
      this.#screen = "promptReader";
    }
  }

  #handleTab(): void {
    if (this.#screen === "chooser") {
      this.#screen = this.#selectedPhaseAgents().length > 0 ? "agentDetail" : "overview";
    } else if (this.#screen === "overview" && this.#selectedPhaseAgents().length > 0) {
      this.#screen = "agentDetail";
    } else if (this.#screen === "agentDetail") {
      this.#screen = "overview";
    }
  }

  #moveSelection(direction: -1 | 1): void {
    if (this.#screen === "chooser") {
      this.#selectedRunIndex = clampIndex(this.#selectedRunIndex + direction, this.#runs.length);
      this.#selectedPhaseIndex = 0;
      this.#selectedAgentIndex = 0;
      return;
    }
    if (this.#screen === "overview") {
      this.#selectedPhaseIndex = clampIndex(
        this.#selectedPhaseIndex + direction,
        this.#selectedRun()?.phases.length ?? 0,
      );
      this.#selectedAgentIndex = 0;
      return;
    }
    if (this.#screen === "agentDetail") {
      this.#selectedAgentIndex = clampIndex(
        this.#selectedAgentIndex + direction,
        this.#selectedPhaseAgents().length,
      );
    }
  }

  #view(): WorkflowRunsViewModel {
    return projectWorkflowsView(this.#runs, {
      selectedRunIndex: this.#selectedRunIndex,
      savedWorkflowCount: this.#savedWorkflowCount,
    });
  }

  #selectedRun(): WorkflowRunDetails | undefined {
    return this.#view().selectedRun;
  }

  #selectedPhaseAgents(): WorkflowAgentProgress[] {
    const run = this.#selectedRun();
    if (run === undefined) return [];
    const selectedPhase = run.phases[this.#selectedPhaseIndex];
    if (selectedPhase === undefined) return run.agents;
    const phaseAgents = run.agents.filter((agent) => agent.phaseTitle === selectedPhase.title);
    return phaseAgents.length === 0 ? run.agents : phaseAgents;
  }

  #selectedAgent(): WorkflowAgentProgress | undefined {
    return this.#selectedPhaseAgents()[this.#selectedAgentIndex];
  }

  #subtitle(view: WorkflowRunsViewModel): string {
    const runLabel = `${view.runs.length} run${view.runs.length === 1 ? "" : "s"}`;
    const savedLabel = `${view.savedWorkflowCount} saved workflow${view.savedWorkflowCount === 1 ? "" : "s"}`;
    return this.#theme.fg("dim", `${runLabel} • ${savedLabel}`);
  }

  #renderChooser(view: WorkflowRunsViewModel, width: number): string[] {
    const lines = [
      this.#line(width, this.#theme.fg("accent", this.#theme.bold("Choose a workflow"))),
    ];
    const range = visibleRange(this.#selectedRunIndex, view.runs.length, 10);
    for (let index = range.start; index < range.end; index += 1) {
      const row = view.runs[index];
      if (row === undefined) continue;
      const selected = index === this.#selectedRunIndex;
      const prefix = selected ? "› " : "  ";
      const content = `${prefix}${statusGlyph(row.status)} ${row.runId}  ${row.workflowName}  ${row.status}  ${row.agentCount} agents`;
      lines.push(this.#line(width, selected ? this.#theme.fg("accent", content) : content));
    }
    return lines;
  }

  #renderOverview(run: WorkflowRunDetails | undefined, width: number): string[] {
    if (run === undefined) return [this.#line(width, "No run selected")];
    const doneCount = run.agents.filter((agent) => agent.state === "done").length;
    const elapsed = run.durationLabel ?? elapsedSince(run.run.startTime);
    const lines = [
      this.#line(width, "─".repeat(width)),
      this.#line(
        width,
        `${this.#theme.fg("accent", this.#theme.bold(run.workflowName))}  ${doneCount}/${run.agents.length} agents · ${elapsed}`,
      ),
      this.#line(width, this.#theme.fg("dim", `${run.status} · ${run.runId}`)),
      "",
    ];

    if (this.#savedWorkflowCount > 0)
      lines.push(this.#line(width, this.#theme.fg("muted", "Runs")));

    lines.push(
      this.#line(width, this.#theme.fg("muted", "Progress")),
      this.#line(width, this.#theme.fg("muted", "Phases")),
    );

    if (run.phases.length === 0) {
      lines.push(this.#line(width, "  No phases recorded"));
    } else {
      for (const [index, phase] of run.phases.entries()) {
        const selected = index === this.#selectedPhaseIndex;
        const prefix = selected ? "› " : "  ";
        const statusParts = [`${phase.doneAgents}/${phase.totalAgents} done`];
        if (phase.runningAgents > 0) statusParts.push(`${phase.runningAgents} running`);
        if (phase.failedAgents > 0) statusParts.push(`${phase.failedAgents} failed`);
        if (phase.stoppedAgents > 0) statusParts.push(`${phase.stoppedAgents} stopped`);
        lines.push(this.#line(width, `${prefix}${phase.title}  ${statusParts.join(" · ")}`));
      }
    }

    lines.push("");
    lines.push(this.#line(width, this.#theme.fg("muted", "Agents")));
    const phaseAgents = this.#selectedPhaseAgents();
    if (phaseAgents.length === 0) {
      lines.push(this.#line(width, "  No agents recorded"));
    } else {
      for (const agent of phaseAgents.slice(0, 8)) {
        lines.push(this.#line(width, this.#formatOverviewAgentRow(agent)));
      }
    }

    lines.push("");
    lines.push(this.#line(width, this.#theme.fg("muted", "Details")));
    lines.push(this.#line(width, `  output: ${run.outputPath ?? "not written yet"}`));
    lines.push(this.#line(width, `  tokens: ${run.totalTokens} • tools: ${run.totalToolCalls}`));
    return lines;
  }

  #renderAgentDetail(run: WorkflowRunDetails | undefined, width: number): string[] {
    if (run === undefined) return [this.#line(width, "No run selected")];
    const selectedAgent = this.#selectedAgent();
    const phaseAgents = this.#selectedPhaseAgents();
    const lines = [
      this.#line(width, "─".repeat(width)),
      this.#line(width, this.#theme.fg("accent", this.#theme.bold(run.workflowName))),
      this.#line(width, `> ${run.runId}`),
      "",
      this.#line(width, this.#theme.fg("muted", "Agents")),
    ];

    for (const [index, agent] of phaseAgents.entries()) {
      const selected = index === this.#selectedAgentIndex;
      lines.push(this.#line(width, this.#formatDetailAgentRow(agent, selected)));
    }

    if (selectedAgent === undefined) return [...lines, this.#line(width, "  No agent selected")];

    lines.push("");
    lines.push(this.#line(width, this.#theme.fg("accent", this.#theme.bold(selectedAgent.label))));
    lines.push(
      this.#line(
        width,
        `  ${statusGlyph(selectedAgent.state)} ${capitalize(selectedAgent.state)} · ${selectedAgent.model}`,
      ),
    );
    lines.push(this.#line(width, `  ${formatMetrics(selectedAgent)}`));
    lines.push("");
    lines.push(
      this.#line(width, `Prompt · ${lineCount(selectedAgent.promptPreview)} lines · ↵ expand`),
    );
    for (const line of previewLines(selectedAgent.promptPreview, 2)) {
      lines.push(this.#line(width, `  ${line}`));
    }
    lines.push("");
    lines.push(
      this.#line(width, `Activity · last 3 of ${selectedAgent.toolCalls ?? 0} tool calls`),
    );
    for (const activityLine of activityLines(selectedAgent)) {
      lines.push(this.#line(width, `  ${activityLine}`));
    }
    lines.push("");
    lines.push(this.#line(width, "Outcome"));
    lines.push(this.#line(width, `  ${outcomeText(selectedAgent)}`));
    return lines;
  }

  #renderPromptReader(run: WorkflowRunDetails | undefined, width: number): string[] {
    const selectedAgent = this.#selectedAgent();
    if (run === undefined || selectedAgent === undefined)
      return [this.#line(width, "No prompt selected")];
    const promptLines = splitLines(selectedAgent.promptPreview);
    return [
      this.#line(width, `Prompt · ${promptLines.length} lines`),
      ...promptLines.map((line) => this.#line(width, line)),
    ];
  }

  #formatOverviewAgentRow(agent: WorkflowAgentProgress): string {
    const model = agent.model === undefined ? "" : ` ${agent.model}`;
    const metrics = formatMetrics(agent);
    return `  ${statusGlyph(agent.state)} ${agent.label}${model}  ${metrics}`;
  }

  #formatDetailAgentRow(agent: WorkflowAgentProgress, selected: boolean): string {
    const prefix = selected ? "> " : "  ";
    const row = `${prefix}${agent.state.padEnd(7)} ${agent.label}`;
    return selected ? this.#theme.fg("accent", row) : row;
  }

  #helpText(): string {
    if (this.#screen === "chooser")
      return this.#theme.fg("dim", "↑↓ select · enter open · esc close");
    if (this.#screen === "overview") {
      return this.#theme.fg(
        "dim",
        "↑↓ phase · ← detail · x stop workflow · p pause · esc back · s save",
      );
    }
    if (this.#screen === "agentDetail") {
      return this.#theme.fg(
        "dim",
        "↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save",
      );
    }
    return this.#theme.fg("dim", "↑↓ scroll · esc back");
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

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function statusGlyph(status: WorkflowRunStatus | WorkflowAgentProgress["state"]): string {
  if (status === "running" || status === "starting" || status === "resuming") return "↻";
  if (status === "completed" || status === "done") return "✓";
  if (status === "failed" || status === "failing") return "!";
  if (status === "stopped" || status === "stopping") return "■";
  return "●";
}

function elapsedSince(startTime: number): string {
  if (startTime <= 0) return "0s";
  const elapsedMs = Math.max(0, Date.now() - startTime);
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${seconds % 60}s`;
}

function formatMetrics(agent: WorkflowAgentProgress): string {
  const parts: string[] = [];
  if (agent.tokens !== undefined) parts.push(`${agent.tokens} tok`);
  if (agent.toolCalls !== undefined) parts.push(`${agent.toolCalls} tools`);
  if (parts.length === 0 && agent.state === "running") return "Still collecting metrics";
  return parts.join(" · ") || "No metrics yet";
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [""] : text.split(/\r?\n/);
}

function lineCount(text: string): number {
  return splitLines(text).length;
}

function previewLines(text: string, maxLines: number): string[] {
  const lines = splitLines(text);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`];
}

function activityLines(agent: WorkflowAgentProgress): string[] {
  if (agent.lastToolName === undefined) return ["No tool activity recorded"];
  const summary = agent.lastToolSummary === undefined ? "" : ` ${agent.lastToolSummary}`;
  return [`${agent.lastToolName}${summary}`];
}

function outcomeText(agent: WorkflowAgentProgress): string {
  if (agent.state === "running" || agent.state === "queued") return "Still running…";
  if (agent.state === "failed") return agent.resultPreview ?? "Failed";
  if (agent.state === "stopped") return agent.resultPreview ?? "Stopped";
  return agent.resultPreview ?? "Completed";
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

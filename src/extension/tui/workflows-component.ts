// Pi TUI component for /workflows: holds navigation/confirmation/scroll state
// and dispatches keyboard input. All screen rendering is delegated to the pure
// functions in render-screens.ts; view-model projection and selection math live
// in src/workflows/view/ (ADR 0010).
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { MonitorAgentRow, MonitorViewModel } from "#src/workflows/view/model.ts";
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
import {
  canPauseRun,
  canResumeRun,
  chooserFooterText,
  clipLine,
  monitorFooterText,
  renderAgentDetailScreen,
  renderChooserScreen,
  renderEmptyScreen,
  renderOverviewScreen,
  renderPromptReaderScreen,
  renderStopConfirmation,
  type PendingStopConfirmation,
  type WorkflowsComponentTheme,
} from "./render-screens.ts";

export type { WorkflowsComponentTheme } from "./render-screens.ts";

export interface WorkflowsTuiComponentOptions {
  readonly runs: WorkflowRunState[];
  readonly savedWorkflowCount?: number;
  readonly theme: WorkflowsComponentTheme;
  readonly now?: () => number;
  readonly onClose?: () => void;
  readonly onPauseRun?: (runId: string) => void;
  readonly onResumeRun?: (runId: string) => void;
  readonly onResumeStoppedRun?: (runId: string) => void | Promise<void>;
  readonly onStopRun?: (runId: string) => void;
  readonly onStopAgent?: (runId: string, agentId: string) => void;
  readonly onSaveRun?: (runId: string) => void;
}

export class WorkflowsTuiComponent implements Component {
  #runs: WorkflowRunState[];
  #theme: WorkflowsComponentTheme;
  #now: () => number;
  #onClose?: () => void;
  #onPauseRun?: (runId: string) => void;
  #onResumeRun?: (runId: string) => void;
  #onResumeStoppedRun?: (runId: string) => void | Promise<void>;
  #onStopRun?: (runId: string) => void;
  #onStopAgent?: (runId: string, agentId: string) => void;
  #onSaveRun?: (runId: string) => void;
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
    this.#onResumeStoppedRun = options.onResumeStoppedRun;
    this.#onStopRun = options.onStopRun;
    this.#onStopAgent = options.onStopAgent;
    this.#onSaveRun = options.onSaveRun;
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

    const before = this.#stateFingerprint();

    if (this.#pendingStop !== undefined) {
      this.#handleStopConfirmation(data);
      if (before !== this.#stateFingerprint()) this.invalidate();
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
    } else if (data === "r") {
      this.#requestResumeStoppedConfirmation();
    } else if (data === "x") {
      this.#requestStopConfirmation();
    } else if (data === "s") {
      this.#handleSaveRun();
    }

    if (before !== this.#stateFingerprint()) this.invalidate();
  }

  render(width: number): string[] {
    if (this.#cachedLines !== undefined && this.#cachedWidth === width) return this.#cachedLines;

    const safeWidth = Math.max(1, width);
    if (this.#runs.length === 0) {
      return this.#cache(safeWidth, renderEmptyScreen(this.#theme, safeWidth));
    }
    if (this.#nav.screen === "chooser") {
      return this.#cache(
        safeWidth,
        renderChooserScreen({
          theme: this.#theme,
          view: buildChooserView(this.#runs, { now: this.#now() }),
          selectedRunIndex: this.#nav.selectedRunIndex,
          footerText: chooserFooterText(this.#selectedRun()?.status),
          width: safeWidth,
        }),
      );
    }
    if (this.#nav.screen === "promptReader") {
      const reader = renderPromptReaderScreen({
        theme: this.#theme,
        agent: this.#selectedAgentRow(),
        scroll: this.#promptScroll,
        width: safeWidth,
      });
      this.#promptScroll = reader.scroll;
      this.#promptMaxScroll = reader.maxScroll;
      return this.#cache(safeWidth, reader.lines);
    }

    const run = this.#selectedRun();
    const lines =
      run === undefined
        ? [clipLine(safeWidth, "No run selected")]
        : this.#nav.screen === "agentDetail"
          ? renderAgentDetailScreen({
              theme: this.#theme,
              view: this.#monitorView(run),
              nav: this.#nav,
              width: safeWidth,
            })
          : renderOverviewScreen({
              theme: this.#theme,
              view: this.#monitorView(run),
              nav: this.#nav,
              width: safeWidth,
            });
    lines.push(
      "",
      clipLine(
        safeWidth,
        this.#theme.fg("dim", monitorFooterText(this.#nav.screen, this.#selectedRun()?.status)),
      ),
    );
    if (this.#pendingStop !== undefined) {
      lines.push("", ...renderStopConfirmation(this.#theme, this.#pendingStop, safeWidth));
    }
    return this.#cache(safeWidth, lines);
  }

  invalidate(): void {
    this.#cachedWidth = undefined;
    this.#cachedLines = undefined;
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

  #handleSaveRun(): void {
    const run = this.#selectedRun();
    if (run === undefined) return;
    this.#onSaveRun?.(run.runId);
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

  #requestResumeStoppedConfirmation(): void {
    const run = this.#selectedRun();
    if (run === undefined || run.status !== "stopped") return;
    this.#pendingStop = { type: "resume-run", runId: run.runId, label: run.workflowName };
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
    else if (pending.type === "resume-run") this.#onResumeStoppedRun?.(pending.runId);
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

  /**
   * Dirty-check fingerprint: input handlers mutate several independent state
   * fields, so instead of having each handler report "changed", the dispatcher
   * compares this concatenated snapshot before/after. A new render-relevant
   * state field MUST be appended here or its changes will not trigger a
   * re-render.
   */
  #stateFingerprint(): string {
    const pending =
      this.#pendingStop === undefined
        ? "none"
        : `${this.#pendingStop.type}:${this.#pendingStop.runId}`;
    return `${this.#nav.screen}:${this.#nav.selectedRunIndex}:${this.#nav.selectedPhaseIndex}:${this.#nav.selectedAgentIndex}:${this.#promptScroll}:${pending}`;
  }

  #cache(width: number, lines: string[]): string[] {
    this.#cachedLines = lines.map((line) => clipLine(width, line));
    this.#cachedWidth = width;
    return this.#cachedLines;
  }
}

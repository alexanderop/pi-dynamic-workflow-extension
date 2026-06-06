import { stripVTControlCharacters } from "node:util";
import { vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WorkflowsTuiComponent,
  type WorkflowsComponentTheme,
} from "#src/extension/tui/workflows-component.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";

const DEFAULT_WIDTH = 120;
const DEFAULT_NOW = 1_000_000;

const plainTheme: WorkflowsComponentTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

export interface WorkflowsScreenOptions {
  readonly now?: number | (() => number);
  readonly theme?: WorkflowsComponentTheme;
  readonly savedWorkflowCount?: number;
  readonly onClose?: () => void;
  readonly onPauseRun?: (runId: string) => void;
  readonly onResumeRun?: (runId: string) => void;
  readonly onStopRun?: (runId: string) => void;
  readonly onStopAgent?: (runId: string, agentId: string) => void;
}

export function workflowsScreen(
  runs: WorkflowRunState[],
  options: WorkflowsScreenOptions = {},
): WorkflowsScreen {
  return new WorkflowsScreen(runs, options);
}

export class WorkflowsScreen {
  #spies = {
    close: vi.fn<() => void>(),
    pauseRun: vi.fn<(runId: string) => void>(),
    resumeRun: vi.fn<(runId: string) => void>(),
    stopRun: vi.fn<(runId: string) => void>(),
    stopAgent: vi.fn<(runId: string, agentId: string) => void>(),
  };

  #width = DEFAULT_WIDTH;
  #component: WorkflowsTuiComponent;

  constructor(runs: WorkflowRunState[], options: WorkflowsScreenOptions = {}) {
    const numericNow = typeof options.now === "number" ? options.now : DEFAULT_NOW;
    const now = typeof options.now === "function" ? options.now : (): number => numericNow;
    this.#spies = {
      close: vi.fn<() => void>(options.onClose),
      pauseRun: vi.fn<(runId: string) => void>(options.onPauseRun),
      resumeRun: vi.fn<(runId: string) => void>(options.onResumeRun),
      stopRun: vi.fn<(runId: string) => void>(options.onStopRun),
      stopAgent: vi.fn<(runId: string, agentId: string) => void>(options.onStopAgent),
    };
    this.#component = new WorkflowsTuiComponent({
      runs,
      theme: options.theme ?? plainTheme,
      now,
      savedWorkflowCount: options.savedWorkflowCount,
      onClose: this.#spies.close,
      onPauseRun: this.#spies.pauseRun,
      onResumeRun: this.#spies.resumeRun,
      onStopRun: this.#spies.stopRun,
      onStopAgent: this.#spies.stopAgent,
    });
  }

  atWidth(width: number): this {
    this.#width = width;
    return this;
  }

  render(width = this.#width): this {
    this.#width = width;
    this.#component.render(width);
    return this;
  }

  text(): string {
    return this.lines().join("\n");
  }

  plainText(): string {
    return stripVTControlCharacters(this.text());
  }

  lines(): string[] {
    return this.#component.render(this.#width);
  }

  plainLines(): string[] {
    return this.lines().map((line) => stripVTControlCharacters(line));
  }

  press = Object.assign(
    (key: string): this => {
      this.#component.handleInput(key);
      return this;
    },
    {
      up: (): this => this.press("\x1b[A"),
      down: (): this => this.press("\x1b[B"),
      left: (): this => this.press("\x1b[D"),
      right: (): this => this.press("\x1b[C"),
      enter: (): this => this.press("\r"),
      escape: (): this => this.press("\x1b"),
    },
  );

  openSelectedAgent(): this {
    return this.press.right();
  }

  openOriginalPrompt(): this {
    return this.press.enter();
  }

  goBack(): this {
    return this.press.escape();
  }

  requestStopWorkflow(): this {
    return this.press("x");
  }

  requestStopAgent(): this {
    return this.press("x");
  }

  confirm(): this {
    return this.press("y");
  }

  cancel(): this {
    return this.press.escape();
  }

  pauseOrResumeRun(): this {
    return this.press("p");
  }

  shouldShowText(textOrPattern: string | RegExp): this {
    const text = this.plainText();
    if (typeof textOrPattern === "string") {
      this.#assert(
        text.includes(textOrPattern),
        `Expected screen to contain ${JSON.stringify(textOrPattern)}.`,
      );
    } else {
      this.#assert(textOrPattern.test(text), `Expected screen to match ${textOrPattern}.`);
    }
    return this;
  }

  shouldNotShowText(textOrPattern: string | RegExp): this {
    const text = this.plainText();
    if (typeof textOrPattern === "string") {
      this.#assert(
        !text.includes(textOrPattern),
        `Expected screen not to contain ${JSON.stringify(textOrPattern)}.`,
      );
    } else {
      this.#assert(!textOrPattern.test(text), `Expected screen not to match ${textOrPattern}.`);
    }
    return this;
  }

  shouldShowOverview(): this {
    return this.shouldShowText("┌ Phases");
  }

  shouldShowRunChooser(): this {
    return this.shouldShowText("Dynamic workflows").shouldShowText("Enter to view");
  }

  shouldShowAgentDetail(label: string): this {
    return this.shouldShowText(label).shouldShowText("Prompt").shouldShowText("Outcome");
  }

  shouldShowOriginalPrompt(label?: string): this {
    this.shouldShowText(/^┌ ?Prompt ·/m);
    if (label !== undefined) this.shouldShowText(label);
    return this;
  }

  shouldShowPhase(title: string): this {
    return this.shouldShowText(title);
  }

  shouldShowAgent(label: string): this {
    return this.shouldShowText(label);
  }

  shouldShowSection(title: string): this {
    return this.shouldShowText(title);
  }

  shouldShowControls(...fragments: string[]): this {
    for (const fragment of fragments) this.shouldShowText(fragment);
    return this;
  }

  shouldAskForConfirmation(message: string): this {
    return this.shouldShowText(message).shouldShowText("y confirm").shouldShowText("esc cancel");
  }

  shouldFitWidth(options: { widths: number[] } | number = this.#width): this {
    const widths = typeof options === "number" ? [options] : options.widths;
    const failures: string[] = [];

    for (const width of widths) {
      for (const [index, line] of this.#component.render(width).entries()) {
        const plain = stripVTControlCharacters(line);
        const measured = visibleWidth(plain);
        if (measured > width) {
          failures.push(`width ${width}, line ${index + 1}, visible ${measured}: ${plain}`);
        }
      }
    }

    this.#assert(failures.length === 0, `Rendered lines exceeded width:\n${failures.join("\n")}`);
    return this;
  }

  shouldHaveClosed(): this {
    this.#assert(this.#spies.close.mock.calls.length === 1, "Expected close callback once.");
    return this;
  }

  shouldHavePausedRun(runId: string): this {
    this.#assert(
      this.#spies.pauseRun.mock.calls.some((call) => call[0] === runId),
      `Expected pause-run callback for ${runId}.`,
    );
    return this;
  }

  shouldHaveResumedRun(runId: string): this {
    this.#assert(
      this.#spies.resumeRun.mock.calls.some((call) => call[0] === runId),
      `Expected resume-run callback for ${runId}.`,
    );
    return this;
  }

  shouldHaveStoppedRun(runId: string): this {
    this.#assert(
      this.#spies.stopRun.mock.calls.some((call) => call[0] === runId),
      `Expected stop-run callback for ${runId}.`,
    );
    return this;
  }

  shouldHaveStoppedAgent(agentId: string): this {
    this.#assert(
      this.#spies.stopAgent.mock.calls.some((call) => call[1] === agentId),
      `Expected stop-agent callback for ${agentId}.`,
    );
    return this;
  }

  #assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(`${message}\n\nRendered screen:\n${this.plainText()}`);
  }
}

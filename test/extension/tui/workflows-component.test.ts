import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WorkflowsTuiComponent,
  type WorkflowsComponentTheme,
} from "#src/extension/tui/workflows-component.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { workflowsScreen } from "./workflows-screen.ts";

const NOW = 1_000_000;

const theme: WorkflowsComponentTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

const ansiTheme: WorkflowsComponentTheme = {
  fg: (color, text) => {
    const code =
      {
        text: 37,
        accent: 35,
        muted: 90,
        dim: 2,
        success: 32,
        error: 31,
        warning: 33,
        border: 37,
        borderAccent: 35,
        borderMuted: 90,
      }[color] ?? 37;
    return `\u001b[${code}m${text}\u001b[39m`;
  },
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

const agent = (overrides: Partial<WorkflowAgentProgress> = {}): WorkflowAgentProgress => ({
  type: "workflow_agent",
  index: 0,
  label: "review:security",
  agentId: "agent_1",
  agentType: "general-purpose",
  model: "Opus 4.8 (1M context)",
  state: "done",
  queuedAt: 0,
  attempt: 1,
  phaseTitle: "Review",
  promptPreview: "review security",
  prompt: "review security",
  resultPreview: "looks good",
  tokens: 41_100,
  toolCalls: 11,
  lastToolName: "Read",
  ...overrides,
});

const runState = (overrides: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  runId: "wf_test",
  taskId: "task_test",
  workflowName: "test-workflow",
  status: "running",
  script: "return null;",
  scriptPath: "/tmp/wf_test/script.js",
  phases: [],
  logs: [],
  workflowProgress: [],
  agentCount: 0,
  totalTokens: 0,
  totalToolCalls: 0,
  startTime: NOW,
  ...overrides,
});

const make = (
  runs: WorkflowRunState[],
  options: Partial<{ onClose: () => void; savedWorkflowCount: number }> = {},
): WorkflowsTuiComponent =>
  new WorkflowsTuiComponent({
    runs,
    theme,
    now: () => NOW,
    savedWorkflowCount: options.savedWorkflowCount,
    onClose: options.onClose,
  });

const hardeningRun = (): WorkflowRunState =>
  runState({
    runId: "wf_hard",
    workflowName: "hardening_slice_and_author",
    description: "Slice the spec into TDD plans and author a pipeline workflow",
    status: "running",
    startTime: NOW - 72_000,
    agentCount: 8,
    phases: [{ title: "Slice" }, { title: "Author" }],
    workflowProgress: [
      { type: "workflow_phase", index: 0, title: "Slice" },
      { type: "workflow_phase", index: 1, title: "Author" },
      agent({
        index: 0,
        label: "slice:P0.1-journal-keying",
        state: "running",
        phaseTitle: "Slice",
      }),
      agent({
        index: 1,
        label: "slice:P0.2-fault-isolation",
        state: "running",
        phaseTitle: "Slice",
      }),
      agent({ index: 2, label: "slice:P0.3-journal-clone", state: "running", phaseTitle: "Slice" }),
      agent({
        index: 3,
        label: "slice:P1.1-model-threading",
        state: "running",
        phaseTitle: "Slice",
      }),
      agent({
        index: 4,
        label: "slice:P1.2-forced-structured",
        state: "running",
        phaseTitle: "Slice",
      }),
      agent({
        index: 5,
        label: "slice:P2.1-drain-on-abort",
        state: "running",
        phaseTitle: "Slice",
        model: "",
        tokens: undefined,
        toolCalls: undefined,
        lastProgressAt: NOW - 72_000,
      }),
      agent({ index: 6, label: "slice:P2.2-limiter-queue", state: "running", phaseTitle: "Slice" }),
      agent({ index: 7, label: "author:pipeline", state: "done", phaseTitle: "Author" }),
    ],
  });

describe("WorkflowsTuiComponent State A overview", () => {
  it("should render the overview as a bordered two-pane monitor with phases and agent metrics", () => {
    const screen = make([hardeningRun()]).render(120).join("\n");

    expect(screen).toContain("┌ Phases");
    expect(screen).toContain("Slice · 7 agents");
    expect(screen).toMatch(/1\/8 agents · 1m ?12s/);
    expect(screen).toContain("› 1 Slice");
    expect(screen).toContain("0/7");
    expect(screen).toContain("✓ Author");
    expect(screen).toContain("41.1k tok · 11 tools");
    expect(screen).toContain("idle ");
    expect(screen).toContain(
      "↑↓ select · → detail · x stop workflow · p pause · esc back · s save",
    );
    expect(screen).not.toContain("Progress");
    expect(screen).not.toContain("Details");
  });

  it("should color key monitor affordances with semantic Pi theme slots", () => {
    const component = new WorkflowsTuiComponent({
      runs: [hardeningRun()],
      theme: ansiTheme,
      now: () => NOW,
    });

    const lines = component.render(120);
    const screen = lines.join("\n");

    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
    expect(screen).toContain("\u001b[35m─");
    expect(screen).toContain("\u001b[35m› ");
    expect(screen).toContain("\u001b[32m✓");
    expect(screen).toContain("\u001b[33midle 1m 12s");
  });

  it("should show the workflow description in the overview header", () => {
    const screen = make([hardeningRun()]).render(120).join("\n");

    expect(screen).toContain("Slice the spec into TDD plans and author a pipeline workflow");
  });

  it("should omit absent model and metric fields in overview agent rows", () => {
    const run = runState({
      phases: [{ title: "Slice" }],
      agentCount: 1,
      workflowProgress: [
        agent({
          label: "slice:bare",
          state: "running",
          model: "",
          tokens: undefined,
          toolCalls: undefined,
          lastProgressAt: undefined,
        }),
      ],
    });

    const screen = make([run]).render(120).join("\n");

    expect(screen).not.toContain("No metrics yet");
    expect(screen).not.toContain("Still collecting");
    expect(screen).not.toContain("unknown");
  });

  it("should ask for confirmation before stopping a workflow from the overview", () => {
    const screen = workflowsScreen([hardeningRun()], { now: NOW })
      .requestStopWorkflow()
      .shouldAskForConfirmation("Stop workflow?")
      .confirm()
      .shouldHaveStoppedRun("wf_hard");

    expect(screen.plainText()).not.toContain("Stop workflow?");
  });

  it("should cancel workflow stop confirmation without calling the stop callback", () => {
    const onStopRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [hardeningRun()],
      theme,
      now: () => NOW,
      onStopRun,
    });

    component.handleInput("x");
    component.handleInput("\x1b");

    expect(onStopRun).not.toHaveBeenCalled();
    expect(component.render(120).join("\n")).not.toContain("Stop workflow?");
  });
});

describe("WorkflowsTuiComponent State B agent detail", () => {
  it("should render structured detail as a bordered two-pane with ordered sections", () => {
    const component = make([hardeningRun()]);
    component.handleInput("\x1b[C");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("┌ Slice · 7 agents");
    expect(screen).toContain("› ● slice:P0.1-journal-keying");
    expect(screen).toContain("Opus 4.8 (1M context)");
    expect(screen).toContain("41.1k tok · 11 tool calls");
    expect(screen).toContain("Prompt · 1 lines · ↵ expand");
    expect(screen).toContain("Activity · last 1 of 11 tool calls");
    expect(screen).toContain("Outcome");
    expect(screen).toContain("Still running");
    expect(screen).toContain(
      "↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save",
    );

    const statusIndex = screen.indexOf("● Running");
    const metricsIndex = screen.indexOf("41.1k tok · 11 tool calls");
    const promptIndex = screen.indexOf("Prompt ·");
    const activityIndex = screen.indexOf("Activity ·");
    const outcomeIndex = screen.indexOf("Outcome");
    expect(statusIndex).toBeLessThan(metricsIndex);
    expect(metricsIndex).toBeLessThan(promptIndex);
    expect(promptIndex).toBeLessThan(activityIndex);
    expect(activityIndex).toBeLessThan(outcomeIndex);
  });

  it("should report the full prompt line count from the full prompt, not the preview", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [
        agent({
          label: "review:security",
          state: "running",
          promptPreview: "preview line one\npreview line two",
          prompt:
            "preview line one\npreview line two\nSENTINEL_FULL_PROMPT_BODY\nmore secret lines",
        }),
      ],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    const screen = component.render(120).join("\n");

    expect(screen).not.toContain("SENTINEL_FULL_PROMPT_BODY");
    expect(screen).toContain("Prompt · 4 lines · ↵ expand");
    expect(screen).toContain("… 2 more lines");
  });

  it("should render only the compact prompt preview in the detail pane body", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [
        agent({
          label: "review:security",
          state: "running",
          promptPreview: "compact prompt preview",
          prompt: "compact prompt preview\nSENTINEL_FULL_PROMPT_LINE_2",
        }),
      ],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("Prompt · 2 lines · ↵ expand");
    expect(screen).toContain("compact prompt preview");
    expect(screen).not.toContain("SENTINEL_FULL_PROMPT_LINE_2");
  });

  it("should ask for confirmation before stopping the selected agent from detail view", () => {
    const screen = workflowsScreen([hardeningRun()], { now: NOW })
      .openSelectedAgent()
      .requestStopAgent()
      .shouldAskForConfirmation("Stop agent?")
      .shouldShowText("slice:P0.1-journal-keying")
      .confirm()
      .shouldHaveStoppedAgent("agent_1");

    expect(screen.plainText()).not.toContain("Stop agent?");
  });

  it("should show a muted empty activity state without a zero placeholder when no tools ran", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [
        agent({ state: "running", lastToolName: undefined, toolCalls: undefined }),
      ],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("Activity");
    expect(screen).toContain("No tool activity");
    expect(screen).not.toContain("of 0 tool calls");
  });

  it("should not crash when rendering box screens at width one", () => {
    const component = make([hardeningRun()]);
    component.handleInput("\x1b[C");
    component.handleInput("\r");

    expect(() => component.render(1)).not.toThrow();
  });
});

const footerOf = (component: WorkflowsTuiComponent): string =>
  (component.render(108).findLast((line) => line.trimEnd().length > 0) ?? "").trimEnd();

const expectGoldenScreen = (component: WorkflowsTuiComponent, width = 120): void => {
  const lines = component.render(width);
  const visualScreen = stripVTControlCharacters(lines.join("\n"));

  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  expect(visualScreen).toMatchSnapshot();
};

describe("WorkflowsTuiComponent State C prompt reader", () => {
  const promptRun = (lines: number, width = 120): WorkflowsTuiComponent => {
    const prompt = Array.from({ length: lines }, (_, index) => `LINE_${index + 1}_END`).join("\n");
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running", prompt, promptPreview: "LINE_1_END" })],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    component.handleInput("\r");
    void width;
    return component;
  };

  it("should render the prompt reader as a bordered box titled with the full line count", () => {
    const screen = promptRun(17).render(120).join("\n");

    expect(screen).toContain("┌ Prompt · 17 lines");
    expect(screen).toContain("LINE_1_END");
    const lines = promptRun(17).render(120);
    expect(lines.some((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
    expect(lines.some((line) => line.includes("└"))).toBe(true);
  });

  it("should preserve the full prompt across scrolling without losing text", () => {
    const component = promptRun(40);
    const collected: string[] = [component.render(120).join("\n")];
    expect(collected[0]).not.toContain("LINE_40_END");

    for (let i = 0; i < 40; i += 1) {
      component.handleInput("j");
      collected.push(component.render(120).join("\n"));
    }

    const all = collected.join("\n");
    for (let line = 1; line <= 40; line += 1) {
      expect(all).toContain(`LINE_${line}_END`);
    }
  });

  it("should show a right-aligned scroll indicator of the visible prompt window", () => {
    const component = promptRun(29);

    expect(footerOf(component)).toMatch(/\b1-\d+ of 29 ↓$/);
    expect(component.render(108).join("\n")).toContain("esc back");

    component.handleInput("j");
    expect(footerOf(component)).toContain("2-");
  });

  it("should scroll with j k and arrows and return to detail on escape", () => {
    const component = promptRun(29);

    component.handleInput("j");
    const afterDown = component.render(108).join("\n");
    component.handleInput("k");
    const afterUp = component.render(108).join("\n");
    expect(afterDown).not.toBe(afterUp);

    component.handleInput("\x1b");
    const detail = component.render(108).join("\n");
    expect(detail).toContain("Activity · last 1");
    expect(detail).not.toContain("┌ Prompt ·");
  });
});

describe("WorkflowsTuiComponent State D chooser", () => {
  it("should render the dynamic workflows chooser with running and completed counts", () => {
    const runs = [
      runState({
        runId: "wf_hard",
        workflowName: "hardening_slice_and_author",
        status: "running",
        agentCount: 8,
        totalTokens: 266_100,
        startTime: NOW,
      }),
      runState({
        runId: "wf_joke",
        workflowName: "generate_joke",
        status: "running",
        agentCount: 4,
        startTime: NOW - 1_000,
      }),
    ];

    const screen = make(runs).render(120).join("\n");

    expect(screen).toContain("/workflows");
    expect(screen).toContain("Dynamic workflows");
    expect(screen).toContain("2 running · 0 completed");
    expect(screen).toMatch(/›\s+↻\s+hardening_slice_and_author/);
    expect(screen).toContain("8 agents");
    expect(screen).toContain("266.1k tok");
    expect(screen).toContain("↑/↓ to select · Enter to view · s to save · Esc to close");
    expect(screen).not.toContain("Choose a workflow");
  });

  it("should default the chooser selection to the newest running workflow", () => {
    const runs = [
      runState({
        runId: "wf_done",
        workflowName: "finished",
        status: "completed",
        startTime: 1_000,
      }),
      runState({ runId: "wf_fresh", workflowName: "fresh", status: "running", startTime: NOW }),
    ];

    const screen = make(runs).render(120).join("\n");

    expect(screen).toMatch(/›\s+↻\s+fresh/);
    expect(screen).toContain("1 running · 1 completed");
    expect(screen).toMatch(/\n\s+✓\s+finished/);
  });
});

describe("WorkflowsTuiComponent golden screens", () => {
  it("should snapshot the canonical State A overview monitor", () => {
    expectGoldenScreen(make([hardeningRun()]));
  });

  it("should snapshot the canonical State B agent detail monitor", () => {
    const component = make([hardeningRun()]);

    component.handleInput("\x1b[C");

    expectGoldenScreen(component);
  });

  it("should snapshot the canonical State C prompt reader", () => {
    const prompt = [
      "You are designing ONE fix from docs/workflow-correctness-hardening-spec.md for this repo.",
      "Read the spec section AND the actual current code in: src/workflow.ts, src/agent.ts, src/prompts/workflow-agent.ts.",
      "Also read the existing tests under tests/ and vitest.config.ts to match the test style and import paths exactly.",
      "Determine how tests are currently run.",
      "",
      "Produce a TDD-ready plan: (1) a complete failing test (RED) written in the repo's exact test style/imports.",
      "Then provide the precise implementation edits (GREEN). Do NOT edit any files — design only.",
      "Quote real function names and line anchors.",
      "Be concrete enough that an implementer can apply it without re-deriving anything.",
      "",
      "FINDING P0.1 - Journal replay is non-deterministic under pipeline()/concurrency.",
      "The hash chain threads a mutable global previousJournalKey synchronously at agent() call time.",
      "Concurrent re-runs can change call ordering.",
      "This prompt is intentionally long enough to exercise the reader footer and scrolling affordance.",
      "END_OF_VISIBLE_PROMPT_FIXTURE",
    ].join("\n");
    const component = make([
      runState({
        phases: [{ title: "Review" }],
        agentCount: 1,
        workflowProgress: [
          agent({ state: "running", prompt, promptPreview: "You are designing ONE fix" }),
        ],
      }),
    ]);

    component.handleInput("\x1b[C");
    component.handleInput("\r");

    expectGoldenScreen(component);
  });

  it("should snapshot the canonical State D workflow chooser", () => {
    const component = make([
      runState({
        runId: "wf_hard",
        workflowName: "hardening_slice_and_author",
        status: "running",
        agentCount: 8,
        totalTokens: 266_100,
        startTime: NOW - 358_000,
      }),
      runState({
        runId: "wf_joke",
        workflowName: "generate_joke",
        status: "running",
        agentCount: 4,
        startTime: NOW,
      }),
    ]);

    component.handleInput("\x1b[A");

    expectGoldenScreen(component);
  });

  it("should snapshot a narrow overview monitor for truncation regressions", () => {
    expectGoldenScreen(make([hardeningRun()]), 60);
  });
});

describe("WorkflowsTuiComponent width contract", () => {
  it("should keep overview and agent detail lines within width at narrow and wide terminals", () => {
    for (const width of [42, 120]) {
      const component = make([hardeningRun()]);
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      component.handleInput("\x1b[C");
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("should keep chooser and prompt reader lines within width at 42 and 120", () => {
    const longPrompt = Array.from({ length: 8 }, () => "z".repeat(200)).join("\n");
    for (const width of [42, 120]) {
      const chooser = make([
        runState({
          runId: "wf_a",
          workflowName: "a-very-long-workflow-name-that-should-be-truncated-cleanly",
          status: "running",
        }),
        runState({ runId: "wf_b", workflowName: "another-running-workflow", status: "running" }),
      ]);
      expect(chooser.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);

      const reader = make([
        runState({
          phases: [{ title: "Review" }],
          agentCount: 1,
          workflowProgress: [agent({ state: "running", prompt: longPrompt })],
        }),
      ]);
      reader.handleInput("\x1b[C");
      reader.handleInput("\r");
      expect(reader.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
});

describe("WorkflowsTuiComponent lifecycle", () => {
  it("should refresh rendered state when runs are replaced", () => {
    const component = make([runState({ runId: "wf_old", workflowName: "old-flow" })]);

    component.setRuns([runState({ runId: "wf_new", workflowName: "new-flow" })]);
    const screen = component.render(80).join("\n");

    expect(screen).toContain("new-flow");
    expect(screen).not.toContain("old-flow");
  });

  it("should call onClose when escape is pressed at the root", () => {
    const onClose = vi.fn<() => void>();
    const component = make([], { onClose });

    component.handleInput("\x1b");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should call onClose when ctrl-c is pressed", () => {
    const onClose = vi.fn<() => void>();
    const component = make([hardeningRun()], { onClose });

    component.handleInput("\x03");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should drop from the chooser to the overview when runs collapse to one", () => {
    const component = make([
      runState({ runId: "wf_a", workflowName: "alpha", status: "running" }),
      runState({ runId: "wf_b", workflowName: "beta", status: "running" }),
    ]);
    expect(component.render(120).join("\n")).toContain("Dynamic workflows");

    component.setRuns([runState({ runId: "wf_a", workflowName: "alpha", status: "running" })]);

    expect(component.render(120).join("\n")).not.toContain("Enter to view");
  });

  it("should render the empty state when there are no runs", () => {
    const screen = make([]).render(80).join("\n");

    expect(screen).toContain("Dynamic workflows");
    expect(screen).toContain("No workflow runs found in .pi/workflows.");
    expect(screen).toContain("esc close");
  });
});

describe("WorkflowsTuiComponent navigation and controls", () => {
  it("should return from agent detail to the overview when left is pressed", () => {
    const component = make([hardeningRun()]);
    component.handleInput("\x1b[C");
    expect(component.render(120).join("\n")).toContain("┌ Slice · 7 agents");

    component.handleInput("\x1b[D");

    expect(component.render(120).join("\n")).toContain("┌ Phases");
  });

  it("should pause a running run when p is pressed", () => {
    const onPauseRun = vi.fn<(runId: string) => void>();
    const onResumeRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [hardeningRun()],
      theme,
      now: () => NOW,
      onPauseRun,
      onResumeRun,
    });

    component.handleInput("p");

    expect(onPauseRun).toHaveBeenCalledWith("wf_hard");
    expect(onResumeRun).not.toHaveBeenCalled();
  });

  it("should resume a paused run when p is pressed", () => {
    const onPauseRun = vi.fn<(runId: string) => void>();
    const onResumeRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [runState({ runId: "wf_paused", status: "paused" })],
      theme,
      now: () => NOW,
      onPauseRun,
      onResumeRun,
    });

    component.handleInput("p");

    expect(onResumeRun).toHaveBeenCalledWith("wf_paused");
    expect(onPauseRun).not.toHaveBeenCalled();
  });

  it("should ignore pause-resume when no run is selected", () => {
    const onPauseRun = vi.fn<(runId: string) => void>();
    const onResumeRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [],
      theme,
      now: () => NOW,
      onPauseRun,
      onResumeRun,
    });

    component.handleInput("p");

    expect(onPauseRun).not.toHaveBeenCalled();
    expect(onResumeRun).not.toHaveBeenCalled();
  });

  it("should not request a stop confirmation when there is no run selected", () => {
    const component = make([]);

    component.handleInput("x");

    expect(component.render(80).join("\n")).not.toContain("Stop workflow?");
  });

  it("should ignore non-decision keys while a stop confirmation is pending", () => {
    const onStopRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [hardeningRun()],
      theme,
      now: () => NOW,
      onStopRun,
    });

    component.handleInput("x");
    component.handleInput("z");

    expect(component.render(120).join("\n")).toContain("Stop workflow?");
    expect(onStopRun).not.toHaveBeenCalled();
  });

  it("should cancel a stop confirmation when n is pressed", () => {
    const onStopRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [hardeningRun()],
      theme,
      now: () => NOW,
      onStopRun,
    });

    component.handleInput("x");
    component.handleInput("n");

    expect(component.render(120).join("\n")).not.toContain("Stop workflow?");
    expect(onStopRun).not.toHaveBeenCalled();
  });

  it("should render a scrolling window of runs in a long chooser", () => {
    const runs = Array.from({ length: 14 }, (_, index) =>
      runState({
        runId: `wf_${index}`,
        workflowName: `flow-${index}`,
        status: "running",
        startTime: NOW - index,
      }),
    );
    const component = make(runs);
    // Move selection down so the window scrolls past the first rows.
    for (let i = 0; i < 13; i += 1) component.handleInput("j");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("flow-13");
    expect(screen).not.toContain("flow-0 ");
  });
});

describe("WorkflowsTuiComponent run and agent status colors", () => {
  const statusGlyph = (status: WorkflowRunState["status"]): string =>
    make([
      runState({ runId: "wf_color_a", workflowName: "color-a", status, startTime: NOW }),
      runState({ runId: "wf_color_b", workflowName: "color-b", status: "running", startTime: 1 }),
    ])
      .render(120)
      .join("\n");

  it("should color every run status bucket in the chooser without crashing", () => {
    const statuses: WorkflowRunState["status"][] = [
      "completed",
      "failed",
      "failing",
      "stopped",
      "stopping",
      "running",
      "resuming",
      "paused",
      "pausing",
      "starting",
      "completing",
      "created",
    ];

    for (const status of statuses) {
      expect(statusGlyph(status)).toContain("color-a");
    }
  });

  const detailFor = (
    agentState: WorkflowAgentProgress["state"],
    resultPreview?: string,
  ): string => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: agentState, resultPreview })],
    });
    const component = new WorkflowsTuiComponent({ runs: [run], theme: ansiTheme, now: () => NOW });
    component.handleInput("\x1b[C");
    return component.render(120).join("\n");
  };

  it("should color and label agent outcomes for each terminal and active state", () => {
    expect(detailFor("done", "all good")).toContain("all good");
    expect(detailFor("failed", "boom")).toContain("boom");
    expect(detailFor("stopped", "halted")).toContain("halted");
    expect(detailFor("running")).toContain("Still running");
    expect(detailFor("queued")).toContain("Still running");
  });

  it("should fall back to default outcome text when no result preview exists", () => {
    expect(detailFor("failed")).toContain("Failed");
    expect(detailFor("stopped")).toContain("Stopped");
    expect(detailFor("done")).toContain("Completed");
  });

  it("should render outcome and detail panes for queued through done states without crashing", () => {
    for (const state of ["queued", "running", "done", "failed", "stopped"] as const) {
      expect(detailFor(state)).toContain("Outcome");
    }
  });

  it("should color agent glyphs across done failed stopped running and queued states", () => {
    expect(detailFor("done")).toContain("[32m");
    expect(detailFor("failed")).toContain("[31m");
    expect(detailFor("stopped")).toContain("[33m");
    expect(detailFor("running")).toContain("[35m");
    expect(detailFor("queued")).toContain("[2m");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  WorkflowsTuiComponent,
  type WorkflowsComponentTheme,
} from "#src/extension/tui/workflows-component.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";

const NOW = 1_000_000;

const theme: WorkflowsComponentTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
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

const make = (runs: WorkflowRunState[]): WorkflowsTuiComponent =>
  new WorkflowsTuiComponent({ runs, theme, now: () => NOW });

describe("WorkflowsTuiComponent rendering edge cases", () => {
  it("should use a live clock by default when no now function is supplied", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running" })],
    });
    const component = new WorkflowsTuiComponent({ runs: [run], theme });

    expect(() => component.render(120)).not.toThrow();
  });

  it("should render detail metrics with idle time and a tool summary but no model", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [
        agent({
          label: "idle-agent",
          state: "running",
          model: "",
          tokens: undefined,
          toolCalls: undefined,
          lastProgressAt: NOW - 5_000,
          lastToolName: "Bash",
          lastToolSummary: "ran tests",
        }),
      ],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("idle ");
    expect(screen).toContain("Bash ran tests");
    expect(screen).not.toContain("Opus");
  });

  it("should render detail and overview for a done agent with no metrics at all", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [
        agent({
          label: "bare-done-agent",
          state: "done",
          model: "",
          tokens: undefined,
          toolCalls: undefined,
          lastProgressAt: undefined,
          lastToolName: undefined,
        }),
      ],
    });
    const overview = make([run]).render(120).join("\n");
    expect(overview).toContain("bare-done-agent");

    const component = make([run]);
    component.handleInput("\x1b[C");
    const detail = component.render(120).join("\n");
    expect(detail).toContain("bare-done-agent");
    expect(detail).toContain("Outcome");
  });

  it("should render the prompt reader for an empty prompt without crashing", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running", prompt: "", promptPreview: "" })],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    component.handleInput("\r");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("Prompt · 1 lines");
    expect(screen).toContain("1-1 of 1");
  });

  it("should reset prompt scroll when escaping from reader back to detail", () => {
    const prompt = Array.from({ length: 40 }, (_, i) => `LINE_${i + 1}`).join("\n");
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running", prompt, promptPreview: "LINE_1" })],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("j");
    expect(component.render(120).join("\n")).toContain("3-");

    // Escape back to detail, then re-open the reader: scroll must start at the top.
    component.handleInput("\x1b");
    component.handleInput("\r");
    const reopened = component.render(120).join("\n");
    expect(reopened).toMatch(/\b1-\d+ of 40/);
  });

  it("should not invoke pause or resume for a completed run", () => {
    const onPauseRun = vi.fn<(runId: string) => void>();
    const onResumeRun = vi.fn<(runId: string) => void>();
    const component = new WorkflowsTuiComponent({
      runs: [runState({ runId: "wf_done", status: "completed" })],
      theme,
      now: () => NOW,
      onPauseRun,
      onResumeRun,
    });

    component.handleInput("p");

    expect(onPauseRun).not.toHaveBeenCalled();
    expect(onResumeRun).not.toHaveBeenCalled();
  });

  it("should render the detail prompt section for an agent with an empty prompt", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running", prompt: "", promptPreview: "" })],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    const screen = component.render(120).join("\n");

    expect(screen).toContain("Prompt · 1 lines · ↵ expand");
  });

  it("should ignore keys that map to no command in the monitor", () => {
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running" })],
    });
    const component = make([run]);
    const before = component.render(120).join("\n");
    component.handleInput("q");
    const after = component.render(120).join("\n");

    expect(after).toBe(before);
  });

  it("should ignore enter while already in the prompt reader", () => {
    const prompt = Array.from({ length: 6 }, (_, i) => `LINE_${i + 1}`).join("\n");
    const run = runState({
      phases: [{ title: "Review" }],
      agentCount: 1,
      workflowProgress: [agent({ state: "running", prompt, promptPreview: "LINE_1" })],
    });
    const component = make([run]);
    component.handleInput("\x1b[C");
    component.handleInput("\r");
    const before = component.render(120).join("\n");
    component.handleInput("\r");
    const after = component.render(120).join("\n");

    expect(after).toBe(before);
    expect(after).toContain("┌ Prompt ·");
  });
});

import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WorkflowsTuiComponent,
  type WorkflowsComponentTheme,
} from "#src/extension/tui/workflows-component.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";

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
  model: "fake-model",
  state: "done",
  queuedAt: 0,
  attempt: 1,
  phaseTitle: "Review",
  promptPreview: "review security",
  resultPreview: "looks good",
  tokens: 31_000,
  toolCalls: 14,
  lastToolName: "read",
  ...overrides,
});

const runState = (overrides: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  runId: "wf_test",
  taskId: "task_test",
  workflowName: "test-workflow",
  status: "created",
  script: "return null;",
  scriptPath: "/tmp/wf_test/script.js",
  phases: [],
  logs: [],
  workflowProgress: [],
  agentCount: 0,
  totalTokens: 0,
  totalToolCalls: 0,
  startTime: 0,
  ...overrides,
});

describe("WorkflowsTuiComponent", () => {
  it("should render workflow runs progress agents and details", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({
          runId: "wf_repo_audit",
          workflowName: "repo-audit",
          status: "running",
          phases: [{ title: "Review" }],
          workflowProgress: [agent()],
          agentCount: 1,
          totalTokens: 31_000,
          totalToolCalls: 14,
          outputPath: ".pi/workflows/wf_repo_audit/output.json",
        }),
      ],
      savedWorkflowCount: 2,
      theme,
    });

    const screen = component.render(100).join("\n");

    expect(screen).toContain("Workflows");
    expect(screen).toContain("1 run • 2 saved workflows");
    expect(screen).toContain("Runs");
    expect(screen).toContain("wf_repo_audit");
    expect(screen).toContain("Progress");
    expect(screen).toContain("Review  1/1 done");
    expect(screen).toContain("Agents");
    expect(screen).toContain("review:security");
    expect(screen).toContain("Details");
    expect(screen).toContain("output: .pi/workflows/wf_repo_audit/output.json");
  });

  it("should open the monitor overview directly when exactly one workflow is active", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({
          runId: "wf_repo_audit",
          workflowName: "repo-audit",
          status: "running",
          phases: [{ title: "Review" }, { title: "Verify" }],
          workflowProgress: [
            { type: "workflow_phase", index: 1, title: "Review" },
            { type: "workflow_phase", index: 2, title: "Verify" },
            agent({ label: "review:security", state: "done", phaseTitle: "Review" }),
            agent({ index: 1, label: "verify:security", state: "running", phaseTitle: "Verify" }),
          ],
          agentCount: 2,
          startTime: Date.now() - 72_000,
        }),
      ],
      theme,
    });

    const screen = component.render(100).join("\n");

    expect(screen).toContain("repo-audit");
    expect(screen).toContain("1/2 agents");
    expect(screen).toContain("Phases");
    expect(screen).toContain("Review");
    expect(screen).toContain("Verify");
    expect(screen).not.toContain("Runs");
  });

  it("should open a workflow chooser when multiple workflows are available", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({ runId: "wf_running", workflowName: "running-review", status: "running" }),
        runState({ runId: "wf_completed", workflowName: "finished-audit", status: "completed" }),
      ],
      theme,
    });

    const screen = component.render(100).join("\n");

    expect(screen).toContain("Choose a workflow");
    expect(screen).toContain("↻ wf_running");
    expect(screen).toContain("✓ wf_completed");
  });

  it("should switch from overview to structured agent detail with left arrow", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({
          runId: "wf_repo_audit",
          workflowName: "repo-audit",
          status: "running",
          phases: [{ title: "Review" }],
          workflowProgress: [
            agent({
              label: "review:security",
              state: "running",
              promptPreview:
                "You are auditing security.\nRead src/security.ts.\nReport validated findings.",
              lastToolName: "Read",
              lastToolSummary: "src/security.ts",
              resultPreview: undefined,
            }),
          ],
          agentCount: 1,
          totalTokens: 41_100,
          totalToolCalls: 11,
        }),
      ],
      theme,
    });

    component.handleInput("\x1b[D");
    const screen = component.render(100).join("\n");

    expect(screen).toContain("review:security");
    expect(screen).toContain("Prompt ·");
    expect(screen).toContain("Activity · last 3");
    expect(screen).toContain("Outcome");
    expect(screen).toContain("Still running");
  });

  it("should open the selected agent prompt reader from structured detail", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({
          runId: "wf_repo_audit",
          workflowName: "repo-audit",
          status: "running",
          phases: [{ title: "Review" }],
          workflowProgress: [
            agent({
              label: "review:security",
              promptPreview: Array.from(
                { length: 12 },
                (_, index) => `Prompt line ${index + 1}`,
              ).join("\n"),
            }),
          ],
          agentCount: 1,
        }),
      ],
      theme,
    });

    component.handleInput("\x1b[D");
    component.handleInput("\r");
    const screen = component.render(100).join("\n");

    expect(screen).toContain("Prompt · 12 lines");
    expect(screen).toContain("Prompt line 1");
    expect(screen).toContain("Prompt line 12");
    expect(screen).not.toContain("Activity ·");
  });

  it("should keep every rendered line within the requested width", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({
          runId: "wf_very_long_identifier_that_must_be_truncated",
          workflowName: "very-long-workflow-name-that-must-not-overflow-the-terminal-width",
          status: "completed",
          workflowProgress: [
            agent({
              label: "verify:an-extremely-long-agent-label-that-should-be-truncated",
              resultPreview:
                "a very long result preview that should be truncated to fit the terminal",
            }),
          ],
          agentCount: 1,
          outputPath: "/tmp/a/very/long/output/path/that/should/not/overflow/output.json",
        }),
      ],
      theme,
    });

    const width = 42;
    const lines = component.render(width);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("should move selection through runs and agents with keyboard input", () => {
    const component = new WorkflowsTuiComponent({
      runs: [
        runState({ runId: "wf_first", workflowName: "first" }),
        runState({
          runId: "wf_second",
          workflowName: "second",
          workflowProgress: [
            agent({ label: "first-agent" }),
            agent({ index: 1, label: "second-agent" }),
          ],
          agentCount: 2,
        }),
      ],
      theme,
    });

    component.handleInput("\x1b[B");
    component.handleInput("\t");
    component.handleInput("\x1b[B");
    const screen = component.render(100).join("\n");

    expect(screen).toContain("> wf_second");
    expect(screen).toContain("> done    second-agent");
  });

  it("should refresh rendered state when runs are replaced", () => {
    const component = new WorkflowsTuiComponent({ runs: [runState({ runId: "wf_old" })], theme });

    component.setRuns([runState({ runId: "wf_new" })]);
    const screen = component.render(80).join("\n");

    expect(screen).toContain("wf_new");
    expect(screen).not.toContain("wf_old");
  });

  it("should call onClose when escape is pressed", () => {
    const onClose = vi.fn<() => void>();
    const component = new WorkflowsTuiComponent({ runs: [], theme, onClose });

    component.handleInput("\x1b");

    expect(onClose).toHaveBeenCalledOnce();
  });
});

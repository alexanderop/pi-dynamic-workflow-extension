import { describe, expect, it, vi } from "vitest";
import type { WorkflowsComponentTheme } from "#src/extension/tui/workflows-component.ts";
import { showWorkflowsTui } from "#src/extension/tui/workflows-view.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { waitFor } from "../../support.ts";

const theme: WorkflowsComponentTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

type WorkflowsViewFactory = (
  tui: { requestRender: () => void },
  theme: WorkflowsComponentTheme,
  keybindings: unknown,
  done: () => void,
) => { render(width: number): string[]; dispose?: () => void };

describe("showWorkflowsTui", () => {
  it("should poll run manifests and refresh the custom component for live ultracode progress", async () => {
    const requestRender = vi.fn<() => void>();
    const renderedScreens: string[] = [];
    const initialRun = runState({
      workflowName: "ultracode",
      description: "audit repo",
      phases: [{ title: "Explore" }],
      workflowProgress: [],
    });
    const liveRun = runState({
      workflowName: "ultracode",
      description: "audit repo",
      phases: [{ title: "Explore" }],
      agentCount: 1,
      workflowProgress: [
        { type: "workflow_phase", index: 0, title: "Explore" },
        {
          type: "workflow_agent",
          index: 0,
          label: "explore project",
          agentId: "agent_0",
          agentType: "general-purpose",
          model: "default",
          state: "running",
          queuedAt: 100,
          startedAt: 101,
          attempt: 1,
          phaseTitle: "Explore",
          promptPreview: "Explore the project",
        },
      ],
    });

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            const component = factory({ requestRender }, theme, {}, vi.fn<() => void>()) as {
              render(width: number): string[];
              dispose?: () => void;
            };
            renderedScreens.push(component.render(100).join("\n"));
            await waitFor(() => requestRender.mock.calls.length > 0);
            renderedScreens.push(component.render(100).join("\n"));
            component.dispose?.();
          }),
        },
      } as never,
      {
        runs: [initialRun],
        savedWorkflowCount: 0,
        pollIntervalMs: 1,
        loadRuns: async () => ({ status: "ok", value: [liveRun] }),
      },
    );

    expect(renderedScreens[0]).not.toContain("explore project");
    expect(renderedScreens.at(-1)).toContain("explore project");
    expect(requestRender).toHaveBeenCalled();
  });
});

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
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
    startTime: 100,
    ...overrides,
  };
}

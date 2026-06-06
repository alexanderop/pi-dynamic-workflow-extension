import { describe, expect, it, vi } from "vitest";
import type { WorkflowsComponentTheme } from "#src/extension/tui/workflows-component.ts";
import { showWorkflowsTui } from "#src/extension/tui/workflows-view.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { delay, waitFor } from "../../support.ts";

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

  it("should forward input to the component and request a render without polling when loadRuns is absent", async () => {
    const requestRender = vi.fn<() => void>();
    const done = vi.fn<() => void>();
    let view!: {
      render(width: number): string[];
      handleInput(data: string): void;
      invalidate(): void;
      dispose?: () => void;
    };

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            view = factory({ requestRender }, theme, {}, done) as typeof view;
            view.render(100);
          }),
        },
      } as never,
      {
        runs: [runState({ workflowName: "no-poll" })],
        savedWorkflowCount: 0,
      },
    );

    requestRender.mockClear();
    view.handleInput("j");
    expect(requestRender).toHaveBeenCalledOnce();

    view.invalidate();

    // Pressing escape at the root invokes onClose, which calls done().
    view.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
  });

  it("should stop refreshing the component after the view is disposed", async () => {
    const requestRender = vi.fn<() => void>();
    let loadCalls = 0;

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            const view = factory({ requestRender }, theme, {}, vi.fn<() => void>()) as {
              render(width: number): string[];
              dispose?: () => void;
            };
            view.render(100);
            // Let at least one poll happen, then dispose and confirm no further loads.
            await waitFor(() => loadCalls > 0);
            view.dispose?.();
            const seen = loadCalls;
            await delay(5);
            expect(loadCalls).toBe(seen);
          }),
        },
      } as never,
      {
        runs: [runState()],
        savedWorkflowCount: 0,
        pollIntervalMs: 1,
        loadRuns: async () => {
          loadCalls += 1;
          return { status: "ok", value: [runState()] };
        },
      },
    );
  });

  it("should skip overlapping refreshes while a load is still pending", async () => {
    const requestRender = vi.fn<() => void>();
    let resolveLoad: (() => void) | undefined;
    let loadCalls = 0;

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            const view = factory({ requestRender }, theme, {}, vi.fn<() => void>()) as {
              render(width: number): string[];
              dispose?: () => void;
            };
            view.render(100);
            await waitFor(() => loadCalls === 1);
            // A second poll fires while the first is pending; it must be skipped.
            await delay(5);
            expect(loadCalls).toBe(1);
            resolveLoad?.();
            view.dispose?.();
          }),
        },
      } as never,
      {
        runs: [runState()],
        savedWorkflowCount: 0,
        pollIntervalMs: 1,
        loadRuns: () => {
          loadCalls += 1;
          return new Promise((resolve) => {
            resolveLoad = () => resolve({ status: "ok", value: [runState()] });
          });
        },
      },
    );
  });

  it("should keep the existing runs when a poll returns an error result", async () => {
    const requestRender = vi.fn<() => void>();
    let loadCalls = 0;

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            const view = factory({ requestRender }, theme, {}, vi.fn<() => void>()) as {
              render(width: number): string[];
              dispose?: () => void;
            };
            const before = view.render(100).join("\n");
            await waitFor(() => loadCalls > 0);
            const after = view.render(100).join("\n");
            // An error result must not replace the rendered runs.
            expect(after).toBe(before);
            expect(after).toContain("error-run");
            view.dispose?.();
          }),
        },
      } as never,
      {
        runs: [runState({ workflowName: "error-run" })],
        savedWorkflowCount: 0,
        pollIntervalMs: 1,
        loadRuns: async () => {
          loadCalls += 1;
          return { status: "error", error: { type: "read", message: "boom" } } as never;
        },
      },
    );

    expect(requestRender).not.toHaveBeenCalled();
  });

  it("should poll with the default interval when none is supplied", async () => {
    const requestRender = vi.fn<() => void>();
    let loadCalls = 0;

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            const view = factory({ requestRender }, theme, {}, vi.fn<() => void>()) as {
              render(width: number): string[];
              dispose?: () => void;
            };
            view.render(100);
            view.dispose?.();
          }),
        },
      } as never,
      {
        runs: [runState()],
        savedWorkflowCount: 0,
        loadRuns: async () => {
          loadCalls += 1;
          return { status: "ok", value: [runState()] };
        },
      },
    );

    // Default 1000ms interval means no poll fires during this synchronous test.
    expect(loadCalls).toBe(0);
  });

  it("should dispose cleanly when there is no polling interval", async () => {
    const requestRender = vi.fn<() => void>();

    await showWorkflowsTui(
      {
        ui: {
          custom: vi.fn<(factory: WorkflowsViewFactory) => Promise<void>>(async (factory) => {
            const view = factory({ requestRender }, theme, {}, vi.fn<() => void>()) as {
              render(width: number): string[];
              dispose?: () => void;
            };
            view.render(100);
            expect(() => view.dispose?.()).not.toThrow();
          }),
        },
      } as never,
      {
        runs: [runState()],
        savedWorkflowCount: 0,
      },
    );
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

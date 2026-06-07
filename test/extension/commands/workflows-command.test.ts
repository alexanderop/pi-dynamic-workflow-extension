import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowsCommand } from "#src/extension/commands/workflows-command.ts";
import { showWorkflowsTui } from "#src/extension/tui/workflows-view.ts";
import type { ShowWorkflowsTuiOptions } from "#src/extension/tui/workflows-view.ts";
import {
  registerWorkflowRunControl,
  unregisterWorkflowRunControl,
} from "#src/workflows/run/control-registry.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { delay, fakePi, unwrap } from "../../support.ts";

vi.mock("#src/extension/tui/workflows-view.ts", () => ({
  showWorkflowsTui: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

describe("registerWorkflowsCommand", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflows-command-"));
    vi.mocked(showWorkflowsTui).mockClear();
  });

  afterEach(async () => {
    unregisterWorkflowRunControl("wf_test");
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should wire pause and resume run callbacks to live run controls in the interactive TUI", async () => {
    await writeRunManifest(tempDir, runState({ status: "running" }));
    const rootDir = join(tempDir, ".pi", "workflows");
    const store = new WorkflowRunStore({ rootDir });
    const pause = vi.fn<() => void>();
    const resume = vi.fn<() => void>();
    const unregister = registerWorkflowRunControl("wf_test", {
      pause,
      resume,
      stopRun: vi.fn<() => void>(),
      stopAgent: vi.fn<(agentId: string) => void>(),
      isPaused: () => false,
      isStopped: () => false,
    });
    const command = registerCommand();

    try {
      await command.handler("", {
        cwd: tempDir,
        mode: "tui",
        hasUI: true,
        ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
      });

      const tuiOptions = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
      tuiOptions?.onPauseRun?.("wf_test");
      await waitForRunStatus(store, "wf_test", "paused");

      tuiOptions?.onResumeRun?.("wf_test");
      await waitForRunStatus(store, "wf_test", "running");

      expect(pause).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
      expect(showWorkflowsTui).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("should wire stop run callbacks to live run controls in the interactive TUI", async () => {
    await writeRunManifest(tempDir, runState({ status: "running", startTime: 100 }));
    const rootDir = join(tempDir, ".pi", "workflows");
    const store = new WorkflowRunStore({ rootDir });
    const stopRun = vi.fn<() => void>();
    const unregister = registerWorkflowRunControl("wf_test", {
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
      stopRun,
      stopAgent: vi.fn<(agentId: string) => void>(),
      isPaused: () => false,
      isStopped: () => false,
    });
    const command = registerCommand();

    try {
      await command.handler("", {
        cwd: tempDir,
        mode: "tui",
        hasUI: true,
        ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
      });

      const tuiOptions = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1] as
        | ShowWorkflowsTuiOptions
        | undefined;
      tuiOptions?.onStopRun?.("wf_test");
      await waitForRunStatus(store, "wf_test", "stopped");

      expect(stopRun).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it("should wire stop agent callbacks to live run controls in the interactive TUI", async () => {
    await writeRunManifest(
      tempDir,
      runState({
        status: "running",
        workflowProgress: [
          {
            type: "workflow_agent",
            index: 0,
            label: "scan-agent",
            agentId: "agent_0",
            agentType: "general-purpose",
            model: "default",
            state: "running",
            queuedAt: 0,
            attempt: 1,
            promptPreview: "scan src",
          },
        ],
      }),
    );
    const rootDir = join(tempDir, ".pi", "workflows");
    const store = new WorkflowRunStore({ rootDir });
    const stopAgent = vi.fn<(agentId: string) => void>();
    const unregister = registerWorkflowRunControl("wf_test", {
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
      stopRun: vi.fn<() => void>(),
      stopAgent,
      isPaused: () => false,
      isStopped: () => false,
    });
    const command = registerCommand();

    try {
      await command.handler("", {
        cwd: tempDir,
        mode: "tui",
        hasUI: true,
        ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
      });

      const tuiOptions = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1] as
        | ShowWorkflowsTuiOptions
        | undefined;
      expect(tuiOptions?.onStopAgent).toEqual(expect.any(Function));
      tuiOptions?.onStopAgent?.("wf_test", "agent_0");
      await waitForAgentStatus(store, "wf_test", "agent_0", "stopped");

      expect(stopAgent).toHaveBeenCalledWith("agent_0");
    } finally {
      unregister();
    }
  });

  it("should forward all visible runs to the TUI so the component decides State A versus State D", async () => {
    await writeRunManifest(tempDir, runState({ runId: "wf_running", status: "running" }));
    await writeRunManifest(
      tempDir,
      runState({ runId: "wf_done", workflowName: "finished", status: "completed" }),
    );
    const command = registerCommand();

    await command.handler("", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
    });

    expect(showWorkflowsTui).toHaveBeenCalledOnce();
    const tuiOptions = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    expect(tuiOptions?.runs).toHaveLength(2);
  });

  it("should show only workflow runs from the current Pi session", async () => {
    await writeRunManifest(
      tempDir,
      runState({
        runId: "wf_current",
        workflowName: "current-session",
        sessionId: "session_current",
      }),
    );
    await writeRunManifest(
      tempDir,
      runState({
        runId: "wf_other",
        workflowName: "other-session",
        sessionId: "session_other",
      }),
    );
    await writeRunManifest(
      tempDir,
      runState({
        runId: "wf_legacy",
        workflowName: "legacy-without-session",
      }),
    );
    const command = registerCommand();

    await command.handler("", {
      cwd: tempDir,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session_current" },
      ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
    });

    expect(showWorkflowsTui).toHaveBeenCalledOnce();
    const tuiOptions = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    expect(tuiOptions?.runs.map((run) => run.runId)).toEqual(["wf_current"]);
    await expect(tuiOptions?.loadRuns?.()).resolves.toMatchObject({
      status: "ok",
      value: [{ runId: "wf_current" }],
    });
  });

  it("should read the workspace workflow root when invoked from a nested project", async () => {
    const nestedProject = join(tempDir, "apps", "nested-project");
    await mkdir(nestedProject, { recursive: true });
    await writeRunManifest(tempDir, runState({ runId: "wf_workspace", status: "completed" }));
    const command = registerCommand();

    await command.handler("", {
      cwd: nestedProject,
      mode: "tui",
      hasUI: true,
      ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
    });

    expect(showWorkflowsTui).toHaveBeenCalledOnce();
    const tuiOptions = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    expect(tuiOptions?.runs.map((run) => run.runId)).toEqual(["wf_workspace"]);
  });
});

interface RegisteredCommandForTest {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function registerCommand(): RegisteredCommandForTest {
  const registerCommandSpy = vi.fn<(...args: unknown[]) => void>();

  registerWorkflowsCommand(
    fakePi({
      registerCommand: registerCommandSpy,
    }),
  );

  return registerCommandSpy.mock.calls[0]?.[1] as RegisteredCommandForTest;
}

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  return {
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
  };
}

async function writeRunManifest(projectDir: string, state: WorkflowRunState): Promise<void> {
  const runDir = join(projectDir, ".pi", "workflows", state.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(state));
}

async function waitForRunStatus(
  store: WorkflowRunStore,
  runId: string,
  status: WorkflowRunState["status"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (unwrap(await store.readRun(runId)).status === status) return;
    await delay(1);
  }
  expect(unwrap(await store.readRun(runId)).status).toBe(status);
}

async function waitForAgentStatus(
  store: WorkflowRunStore,
  runId: string,
  agentId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const agent = unwrap(await store.readRun(runId)).workflowProgress.find(
      (entry) => entry.type === "workflow_agent" && entry.agentId === agentId,
    );
    if (agent?.type === "workflow_agent" && agent.state === status) return;
    await delay(1);
  }
  const agent = unwrap(await store.readRun(runId)).workflowProgress.find(
    (entry) => entry.type === "workflow_agent" && entry.agentId === agentId,
  );
  expect(agent).toMatchObject({ state: status });
}

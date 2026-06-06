import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowsCommand } from "#src/extension/commands/workflows-command.ts";
import { showWorkflowsTui } from "#src/extension/tui/workflows-view.ts";
import {
  registerWorkflowRunControl,
  unregisterWorkflowRunControl,
} from "#src/workflows/run/control-registry.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { delay, unwrap } from "../../support.ts";

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
      isPaused: () => false,
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
});

interface RegisteredCommandForTest {
  handler: (args: string, ctx: any) => Promise<void>;
}

function registerCommand(): RegisteredCommandForTest {
  const registerCommandSpy = vi.fn<(...args: unknown[]) => void>();

  registerWorkflowsCommand({
    registerCommand: registerCommandSpy,
  } as any);

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

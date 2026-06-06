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
import { savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { workflowScript } from "../../workflows/script/workflow-factory.ts";

vi.mock("#src/extension/tui/workflows-view.ts", () => ({
  showWorkflowsTui: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

interface RegisteredCommandForTest {
  handler: (args: string, ctx: any) => Promise<void>;
}

function registerCommand(): RegisteredCommandForTest {
  const registerCommandSpy = vi.fn<(...args: unknown[]) => void>();
  registerWorkflowsCommand({ registerCommand: registerCommandSpy } as any);
  return registerCommandSpy.mock.calls[0]?.[1] as RegisteredCommandForTest;
}

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
    startTime: 0,
    ...overrides,
  };
}

async function writeRunManifest(rootDir: string, state: WorkflowRunState): Promise<void> {
  const runDir = join(rootDir, state.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "manifest.json"), JSON.stringify(state));
}

describe("registerWorkflowsCommand coverage", () => {
  let tempDir: string;
  let stdout = "";
  let stderr = "";
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const registeredRuns = new Set<string>();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflows-cov-"));
    stdout = "";
    stderr = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    vi.mocked(showWorkflowsTui).mockClear();
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    for (const runId of registeredRuns) unregisterWorkflowRunControl(runId);
    registeredRuns.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseCtx = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    cwd: tempDir,
    hasUI: true,
    mode: "tui",
    savedWorkflowDirs: {
      projectDir: join(tempDir, ".pi", "workflows"),
      personalDir: join(tempDir, "home"),
    },
    ui: { custom: vi.fn<() => void>(), notify: vi.fn<() => void>() },
    ...overrides,
  });

  it("should notify when workflow runs cannot be read in the interactive TUI", async () => {
    // Make the run root a file so listRuns fails with a non-ENOENT error.
    await mkdir(join(tempDir, ".pi"), { recursive: true });
    await writeFile(join(tempDir, ".pi", "workflows"), "not a directory");
    const notify = vi.fn<() => void>();
    const command = registerCommand();

    await command.handler("", baseCtx({ ui: { custom: vi.fn<() => void>(), notify } }));

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not read workflow runs"),
      "error",
    );
    expect(showWorkflowsTui).not.toHaveBeenCalled();
  });

  it("should write a run read error to stderr in print mode", async () => {
    await mkdir(join(tempDir, ".pi"), { recursive: true });
    await writeFile(join(tempDir, ".pi", "workflows"), "not a directory");
    const command = registerCommand();

    await command.handler("", baseCtx({ mode: "print", hasUI: false }));

    expect(stderr).toContain("Could not read workflow runs");
  });

  it("should notify when saved workflows cannot be read", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    // Point the saved-workflow project dir at a file so listSavedWorkflows fails.
    const savedFile = join(tempDir, "saved-as-file");
    await writeFile(savedFile, "not a directory");
    const notify = vi.fn<() => void>();
    const command = registerCommand();

    await command.handler(
      "",
      baseCtx({
        ui: { custom: vi.fn<() => void>(), notify },
        savedWorkflowDirs: { projectDir: savedFile },
      }),
    );

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not read saved workflows"),
      "error",
    );
  });

  it("should return a load error from the live refresh loader", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    await writeRunManifest(join(tempDir, ".pi", "workflows"), runState({ status: "running" }));
    const command = registerCommand();

    await command.handler("", baseCtx());

    const options = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    // Replace the run root with a file so the next listRuns errors.
    await rm(join(tempDir, ".pi", "workflows"), { recursive: true, force: true });
    await writeFile(join(tempDir, ".pi", "workflows"), "not a directory");

    await expect(options?.loadRuns?.()).resolves.toMatchObject({ status: "error" });
  });

  it("should ignore a throwing session manager and show all runs", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    await writeRunManifest(join(tempDir, ".pi", "workflows"), runState({ status: "running" }));
    const command = registerCommand();

    await command.handler(
      "",
      baseCtx({
        sessionManager: {
          getSessionId: () => {
            throw new Error("no session");
          },
        },
      }),
    );

    expect(showWorkflowsTui).toHaveBeenCalledOnce();
    const options = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    expect(options?.runs).toHaveLength(1);
  });

  it("should notify when no live control is registered for a run", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    await writeRunManifest(join(tempDir, ".pi", "workflows"), runState({ status: "running" }));
    const notify = vi.fn<() => void>();
    const command = registerCommand();

    await command.handler("", baseCtx({ ui: { custom: vi.fn<() => void>(), notify } }));

    const options = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    options?.onPauseRun?.("wf_test");
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("no live runtime control is available"),
        "warning",
      ),
    );
  });

  it("should notify when a control operation result is an error", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    // Register a control but do NOT write a manifest, so readRun fails inside the controller.
    registeredRuns.add("wf_ghost");
    registerWorkflowRunControl("wf_ghost", {
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
      stopRun: vi.fn<() => void>(),
      stopAgent: vi.fn<(agentId: string) => void>(),
      isPaused: () => false,
      isStopped: () => false,
    });
    const notify = vi.fn<() => void>();
    const command = registerCommand();

    await command.handler("", baseCtx({ ui: { custom: vi.fn<() => void>(), notify } }));

    const options = vi.mocked(showWorkflowsTui).mock.calls[0]?.[1];
    options?.onStopRun?.("wf_ghost");
    options?.onResumeRun?.("wf_ghost");
    options?.onStopAgent?.("wf_ghost", "agent_x");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), "error"));
  });

  it("should fall back to print output when the UI cannot render a custom view", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    await writeRunManifest(
      join(tempDir, ".pi", "workflows"),
      runState({ workflowName: "no-custom-ui", status: "running" }),
    );
    const command = registerCommand();

    // hasUI is true but ui.custom is missing, so shouldUseWorkflowsTui is false.
    await command.handler("", baseCtx({ mode: undefined, ui: { notify: vi.fn<() => void>() } }));

    expect(showWorkflowsTui).not.toHaveBeenCalled();
  });

  it("should emit JSON output in json mode", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    await writeRunManifest(
      join(tempDir, ".pi", "workflows"),
      runState({ workflowName: "json-flow", status: "running" }),
    );
    const command = registerCommand();

    await command.handler("", baseCtx({ mode: "json", hasUI: false }));

    const line = stdout.trim().split("\n").at(-1)!;
    expect(JSON.parse(line)).toMatchObject({
      type: "workflow_command_output",
      command: "workflows",
      severity: "info",
    });
  });

  it("should print an empty-state message when there are no runs or saved workflows", async () => {
    await mkdir(join(tempDir, ".pi", "workflows"), { recursive: true });
    const command = registerCommand();

    await command.handler("", baseCtx({ mode: "print", hasUI: false }));

    expect(stdout).toContain("No workflow runs or saved workflows found in .pi/workflows.");
  });

  it("should default to print output when no mode is set and there is no UI", async () => {
    const rootDir = join(tempDir, ".pi", "workflows");
    await mkdir(rootDir, { recursive: true });
    await writeRunManifest(rootDir, runState({ workflowName: "headless-flow", status: "running" }));
    const command = registerCommand();

    await command.handler(
      "",
      baseCtx({
        mode: undefined,
        hasUI: false,
        ui: { notify: vi.fn<() => void>() },
        savedWorkflowDirs: { projectDir: rootDir },
      }),
    );

    expect(stdout).toContain("headless-flow");
    expect(showWorkflowsTui).not.toHaveBeenCalled();
  });

  it("should emit a JSON error to stderr when runs cannot be read", async () => {
    await mkdir(join(tempDir, ".pi"), { recursive: true });
    await writeFile(join(tempDir, ".pi", "workflows"), "not a directory");
    const command = registerCommand();

    await command.handler("", baseCtx({ mode: "json", hasUI: false }));

    const line = stderr.trim().split("\n").at(-1)!;
    expect(JSON.parse(line)).toMatchObject({ severity: "error" });
  });

  it("should list saved workflows even when there are no runs", async () => {
    const rootDir = join(tempDir, ".pi", "workflows");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      savedWorkflowPath(rootDir, "only-saved"),
      workflowScript({ meta: { name: "only-saved", description: "saved only" } }),
    );
    const command = registerCommand();

    await command.handler(
      "",
      baseCtx({ mode: "print", hasUI: false, savedWorkflowDirs: { projectDir: rootDir } }),
    );

    expect(stdout).toContain("Saved workflows");
    expect(stdout).toContain("only-saved");
    expect(stdout).not.toContain("Workflow runs");
  });

  it("should print full run and saved-workflow details across optional fields", async () => {
    const rootDir = join(tempDir, ".pi", "workflows");
    await mkdir(rootDir, { recursive: true });
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_full",
        workflowName: "full-run",
        status: "completed",
        durationMs: 1234,
        outputPath: "/tmp/out.json",
        agentCount: 3,
      }),
    );
    await writeRunManifest(
      rootDir,
      runState({ runId: "wf_min", workflowName: "minimal-run", status: "running" }),
    );
    await writeFile(
      savedWorkflowPath(rootDir, "documented"),
      workflowScript({
        meta: { name: "documented", description: "Does a thing", whenToUse: "When needed" },
      }),
    );
    await writeFile(
      savedWorkflowPath(rootDir, "bare"),
      workflowScript({ meta: { name: "bare", description: "bare" } }),
    );
    const command = registerCommand();

    await command.handler(
      "",
      baseCtx({
        mode: "print",
        hasUI: false,
        savedWorkflowDirs: { projectDir: rootDir },
      }),
    );

    expect(stdout).toContain("Workflow runs");
    expect(stdout).toContain("full-run");
    expect(stdout).toContain("Duration:");
    expect(stdout).toContain("Output: /tmp/out.json");
    expect(stdout).toContain("minimal-run");
    expect(stdout).toContain("Saved workflows");
    expect(stdout).toContain("documented");
    expect(stdout).toContain("Description: Does a thing");
    expect(stdout).toContain("When to use: When needed");
    expect(stdout).toContain("bare");
  });
});

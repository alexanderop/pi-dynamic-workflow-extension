import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dynamicWorkflowExtension from "../../src/extension/index.ts";
import type { WorkflowRunState } from "../../src/workflows/run/model.ts";

describe("dynamicWorkflowExtension", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflows-extension-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should register the workflows command when extension loads", () => {
    const registerCommand = vi.fn<(...args: unknown[]) => void>();

    dynamicWorkflowExtension({
      registerCommand,
    } as any);

    expect(registerCommand).toHaveBeenCalledWith(
      "workflows",
      expect.objectContaining({
        description: "Show dynamic workflow runs",
        handler: expect.any(Function),
      }),
    );
  });

  it("should render an empty state when no workflow runs exist", async () => {
    const command = registerWorkflowsCommand();
    const notify = vi.fn<NotifyForTest>();

    await command.handler("", {
      cwd: tempDir,
      mode: "tui",
      ui: { notify },
    });

    expect(notify).toHaveBeenCalledWith("No workflow runs found in .pi/workflows.", "info");
  });

  it("should render workflow runs from the project-local workflow store", async () => {
    await writeRunManifest(
      tempDir,
      runState({
        runId: "wf_old",
        workflowName: "old-review",
        status: "running",
        agentCount: 1,
        startTime: 100,
      }),
    );
    await writeRunManifest(
      tempDir,
      runState({
        runId: "wf_new",
        workflowName: "repo-audit",
        status: "completed",
        agentCount: 3,
        durationMs: 72_000,
        outputPath: ".pi/workflows/wf_new/output.json",
        startTime: 300,
      }),
    );
    const command = registerWorkflowsCommand();
    const notify = vi.fn<NotifyForTest>();

    await command.handler("", {
      cwd: tempDir,
      mode: "tui",
      ui: { notify },
    });

    const message = notify.mock.calls[0]?.[0];
    expect(message).toContain("Workflow runs");
    expect(message).toContain("wf_new");
    expect(message).toContain("Status: completed");
    expect(message).toContain("Workflow: repo-audit");
    expect(message).toContain("Agents: 3");
    expect(message).toContain("Duration: 1m 12s");
    expect(message).toContain("Output: .pi/workflows/wf_new/output.json");
    expect(message).toContain("wf_old");
    expect(message.indexOf("wf_new")).toBeLessThan(message.indexOf("wf_old"));
    expect(notify).toHaveBeenCalledWith(message, "info");
  });

  it("should not read journals or transcript files when rendering workflow runs", async () => {
    await writeRunManifest(tempDir, runState({ runId: "wf_manifest_only" }));
    const runDir = join(tempDir, ".pi", "workflows", "wf_manifest_only");
    await mkdir(join(runDir, "transcripts"), { recursive: true });
    await writeFile(join(runDir, "journal.jsonl"), "{not-jsonl");
    await writeFile(join(runDir, "transcripts", "agent_1.jsonl"), "{");
    const command = registerWorkflowsCommand();
    const notify = vi.fn<NotifyForTest>();

    await command.handler("", {
      cwd: tempDir,
      mode: "tui",
      ui: { notify },
    });

    expect(notify.mock.calls[0]?.[0]).toContain("wf_manifest_only");
  });

  it("should write plain text in print mode instead of using interactive UI", async () => {
    await writeRunManifest(tempDir, runState({ runId: "wf_print", workflowName: "print-review" }));
    const command = registerWorkflowsCommand();
    const notify = vi.fn<NotifyForTest>();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await command.handler("", {
        cwd: tempDir,
        mode: "print",
        ui: { notify },
      });
      expect(notify).not.toHaveBeenCalled();
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("wf_print"));
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("Workflow: print-review"));
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("should write structured output in json mode instead of using interactive UI", async () => {
    await writeRunManifest(tempDir, runState({ runId: "wf_json", workflowName: "json-review" }));
    const command = registerWorkflowsCommand();
    const notify = vi.fn<NotifyForTest>();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await command.handler("", {
        cwd: tempDir,
        mode: "json",
        ui: { notify },
      });
      expect(notify).not.toHaveBeenCalled();
      const output = String(stdoutWrite.mock.calls[0]?.[0]);
      expect(JSON.parse(output)).toMatchObject({
        type: "workflow_command_output",
        command: "workflows",
        severity: "info",
        message: expect.stringContaining("wf_json"),
      });
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it("should write command errors to stderr in headless modes", async () => {
    await writeFile(join(tempDir, ".pi"), "not-a-directory");
    const command = registerWorkflowsCommand();
    const notify = vi.fn<NotifyForTest>();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await command.handler("", {
        cwd: tempDir,
        mode: "print",
        ui: { notify },
      });
      expect(notify).not.toHaveBeenCalled();
      expect(stderrWrite).toHaveBeenCalledWith(
        expect.stringContaining("Could not read workflow runs:"),
      );
    } finally {
      stderrWrite.mockRestore();
    }
  });
});

type NotifyForTest = (message: string, type?: "info" | "warning" | "error") => void;

interface RegisteredCommandForTest {
  handler: (args: string, ctx: any) => Promise<void>;
}

function registerWorkflowsCommand(): RegisteredCommandForTest {
  const registerCommand = vi.fn<(...args: unknown[]) => void>();

  dynamicWorkflowExtension({
    registerCommand,
  } as any);

  return registerCommand.mock.calls[0]?.[1] as RegisteredCommandForTest;
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

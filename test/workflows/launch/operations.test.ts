import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultWorkflowLaunchOperations } from "#src/workflows/launch/operations.ts";
import { workflowRun } from "../../builders/workflow-run.ts";

describe("default workflow launch operations", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-operations-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should write the run script copy and initial manifest when storage can be prepared", async () => {
    const rootDir = join(tempDir, ".pi", "workflows");
    const runId = "wf_prepare";
    const state = workflowRun.running("prepare", { runId });

    const result = await defaultWorkflowLaunchOperations.prepareRunFiles({
      rootDir,
      runId,
      script: "return null;",
      initialState: state,
    });

    expect(result).toMatchObject({ status: "ok" });
    await expect(readFile(join(rootDir, runId, "script.js"), "utf8")).resolves.toBe("return null;");
    const manifest = JSON.parse(await readFile(join(rootDir, runId, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ runId, status: "running" });
  });

  it("should report a persistence error when run files cannot be prepared", async () => {
    const rootDir = join(tempDir, ".pi", "workflows");
    const runId = "wf_conflict";
    // Pre-create the run directory so the non-recursive mkdir of the run dir
    // fails with EEXIST inside prepareRunFiles.
    await mkdir(join(rootDir, runId), { recursive: true });

    const result = await defaultWorkflowLaunchOperations.prepareRunFiles({
      rootDir,
      runId,
      script: "return null;",
      initialState: workflowRun.running("conflict", { runId }),
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchPersistenceError",
        path: join(rootDir, runId),
        message: expect.stringContaining(join(rootDir, runId)),
      },
    });
    expect((result as { error: { cause: unknown } }).error.cause).toBeInstanceOf(Error);
  });

  it("should report a persistence error when the run manifest cannot be written", async () => {
    // Make the root dir a file so the store's mkdir of the run dir fails.
    const rootDir = join(tempDir, "root-as-file");
    await writeFile(rootDir, "not a directory", "utf8");

    const result = await defaultWorkflowLaunchOperations.writeRun({
      rootDir,
      state: workflowRun.completed("write-fail", { runId: "wf_write" }),
    });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchPersistenceError" },
    });
    expect((result as { error: { cause: unknown } }).error.cause).toBeInstanceOf(Error);
  });

  it("should write terminal output json when the output path is writable", async () => {
    const outputPath = join(tempDir, "output.json");
    const output = {
      runId: "wf_out",
      taskId: "task_out",
      workflowName: "out",
      status: "completed" as const,
      outputPath,
      usage: { agentCount: 0, subagentTokens: 0, toolUses: 0, durationMs: 0 },
    };

    const result = await defaultWorkflowLaunchOperations.writeTerminalOutput({
      outputPath,
      output,
    });

    expect(result).toMatchObject({ status: "ok" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({ runId: "wf_out" });
  });

  it("should report a persistence error when terminal output cannot be written", async () => {
    // Point the output path at a directory so writeFile throws EISDIR.
    const outputPath = join(tempDir, "output-dir");
    await mkdir(outputPath, { recursive: true });

    const result = await defaultWorkflowLaunchOperations.writeTerminalOutput({
      outputPath,
      output: {
        runId: "wf_out",
        taskId: "task_out",
        workflowName: "out",
        status: "completed",
        outputPath,
        usage: { agentCount: 0, subagentTokens: 0, toolUses: 0, durationMs: 0 },
      },
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowLaunchPersistenceError",
        path: outputPath,
        message: expect.stringContaining(outputPath),
      },
    });
    expect((result as { error: { cause: unknown } }).error.cause).toBeInstanceOf(Error);
  });
});

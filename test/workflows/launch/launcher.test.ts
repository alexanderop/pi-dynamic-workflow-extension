import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  launchWorkflow,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
  type WorkflowTaskNotification,
} from "../../../src/workflows/launch/launcher.ts";
import { WorkflowRunStore } from "../../../src/workflows/run/store.ts";
import type { Result } from "../../../src/workflows/result.ts";
import { workflowScript } from "../script/workflow-factory.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

describe("launchWorkflow", () => {
  let tempDir: string;
  let rootDir: string;
  let now: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-launcher-"));
    rootDir = join(tempDir, ".pi", "workflows");
    now = 100;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should reject launch requests that do not provide exactly one source", async () => {
    const script = workflowScript({ meta: { name: "too-many" } });

    const missing = await launchWorkflow({}, launchOptions());
    const tooMany = await launchWorkflow({ script, name: "saved" }, launchOptions());

    expect(missing).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchInvalidRequestError" },
    });
    expect(tooMany).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchInvalidRequestError" },
    });
  });

  it("should return clear errors for saved workflow sources that are not implemented yet", async () => {
    const byName = await launchWorkflow({ name: "saved-review" }, launchOptions());
    const byPath = await launchWorkflow(
      { scriptPath: join(tempDir, "review.workflow.js") },
      launchOptions(),
    );

    expect(byName).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchUnsupportedSourceError", source: "name" },
    });
    expect(byPath).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchUnsupportedSourceError", source: "scriptPath" },
    });
  });

  it("should reject nondeterministic inline scripts before run storage is created", async () => {
    const result = await launchWorkflow(
      {
        script: workflowScript({
          meta: { name: "nondeterministic" },
          body: "return Date.now();",
        }),
      },
      launchOptions(),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchParseError", message: expect.stringMatching(/Date\.now/) },
    });
    expect(await pathExists(rootDir)).toBe(false);
  });

  it("should persist the script copy and initial run manifest before fake agents start", async () => {
    const agentResult = deferred<string>();
    let agentStarted = false;
    const script = workflowScript({
      meta: {
        name: "launch-smoke",
        description: "Launch a fake one-agent workflow",
        phases: [{ title: "Scan" }],
      },
      body: `
phase("Scan");
log("starting scan");
const result = await agent("scan " + args.target, { label: "scan-agent", phase: "Scan" });
return { result };
`,
    });

    const result = await launchWorkflow(
      { script, args: { target: "src" } },
      launchOptions({
        agentRunner: async (prompt) => {
          agentStarted = true;
          expect(prompt).toBe("scan src");
          return agentResult.promise;
        },
      }),
    );

    const launch = unwrap(result);
    expect(launch).toMatchObject({
      taskId: "task_test",
      runId: "wf_test",
      scriptPath: workflowRunScriptPath(rootDir, "wf_test"),
      transcriptDir: workflowRunTranscriptDir(rootDir, "wf_test"),
    });
    expect(launch.confirmation).toContain("Workflow launched in background. Task ID: task_test");
    expect(launch.confirmation).toContain("Run ID: wf_test");
    expect(launch.confirmation).toContain(`Script file: ${launch.scriptPath}`);
    expect(launch.confirmation).toContain(`Transcript dir: ${launch.transcriptDir}`);
    expect(launch.confirmation).toContain("Use /workflows to watch live progress");
    expect(agentStarted).toBe(false);

    await expect(readFile(launch.scriptPath, "utf8")).resolves.toBe(script);
    expect(await pathExists(launch.transcriptDir)).toBe(true);

    const initialManifest = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_test"));
    expect(initialManifest).toMatchObject({
      runId: "wf_test",
      taskId: "task_test",
      workflowName: "launch-smoke",
      status: "running",
      script,
      scriptPath: launch.scriptPath,
      phases: [{ title: "Scan" }],
      logs: [],
      workflowProgress: [],
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      startTime: 100,
    });

    await waitFor(() => agentStarted);
    now = 175;
    agentResult.resolve("fake agent result");

    const completed = unwrap(await launch.completion);
    expect(completed).toMatchObject({
      status: "completed",
      durationMs: 75,
      logs: ["starting scan"],
      agentCount: 1,
      result: { result: "fake agent result" },
    });
    expect(completed.workflowProgress).toMatchObject([
      { type: "workflow_phase", title: "Scan" },
      { type: "workflow_agent", label: "scan-agent", state: "done" },
    ]);

    const finalManifest = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_test"));
    expect(finalManifest).toMatchObject({
      status: "completed",
      result: { result: "fake agent result" },
      agentCount: 1,
    });
  });

  it("should write terminal output and notify after the completed run manifest is persisted", async () => {
    const notifications: WorkflowTaskNotification[] = [];
    const script = workflowScript({
      meta: {
        name: "terminal-success",
        description: "Review project with fake agents",
        phases: [{ title: "Scan" }],
      },
      body: `
phase("Scan");
const result = await agent("scan src", { label: "scan-agent", phase: "Scan" });
return { result, notes: "full result belongs in output.json" };
`,
    });
    const outputPath = workflowRunOutputPath(rootDir, "wf_test");

    const result = await launchWorkflow(
      { script },
      launchOptions({
        agentRunner: async () => "agent result",
        notifyTerminal: async (notification) => {
          notifications.push(notification);

          const manifest = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_test"));
          const output = JSON.parse(await readFile(outputPath, "utf8"));

          expect(manifest).toMatchObject({
            status: "completed",
            outputPath,
          });
          expect(output).toMatchObject({
            runId: "wf_test",
            taskId: "task_test",
            workflowName: "terminal-success",
            status: "completed",
            result: { result: "agent result", notes: "full result belongs in output.json" },
            usage: {
              agentCount: 1,
              subagentTokens: 0,
              toolUses: 0,
              durationMs: 75,
            },
          });
        },
      }),
    );

    const launch = unwrap(result);
    now = 175;
    const completed = unwrap(await launch.completion);

    expect(completed).toMatchObject({
      status: "completed",
      outputPath,
      result: { result: "agent result", notes: "full result belongs in output.json" },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      customType: "workflow-task-notification",
      display: true,
      details: {
        taskId: "task_test",
        runId: "wf_test",
        outputFile: outputPath,
        status: "completed",
        summary: 'Dynamic workflow "Review project with fake agents" completed',
        usage: {
          agentCount: 1,
          subagentTokens: 0,
          toolUses: 0,
          durationMs: 75,
        },
      },
    });
    expect(notifications[0]!.content).toContain("<task-notification>");
    expect(notifications[0]!.content).toContain(`<task-id>task_test</task-id>`);
    expect(notifications[0]!.content).toContain(`<output-file>${outputPath}</output-file>`);
    expect(notifications[0]!.content).toContain("<status>completed</status>");
    expect(notifications[0]!.content).toContain("<agent_count>1</agent_count>");
  });

  it("should truncate inline notification result while preserving the full output file", async () => {
    const notifications: WorkflowTaskNotification[] = [];
    const script = workflowScript({
      meta: { name: "terminal-truncation" },
      body: `return { text: "x".repeat(600) };`,
    });
    const outputPath = workflowRunOutputPath(rootDir, "wf_test");

    const result = await launchWorkflow(
      { script },
      launchOptions({
        inlineResultMaxChars: 300,
        notifyTerminal: (notification) => {
          notifications.push(notification);
        },
      }),
    );

    const launch = unwrap(result);
    now = 125;
    unwrap(await launch.completion);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.details.result.length).toBeLessThanOrEqual(300);
    expect(notifications[0]!.details.result).toContain("truncated");
    expect(notifications[0]!.details.result).toContain(outputPath);

    const output = JSON.parse(await readFile(outputPath, "utf8"));
    expect(output.result.text).toHaveLength(600);
  });

  it("should return launch confirmation before the background fake agent completes", async () => {
    const agentResult = deferred<string>();
    let completionSettled = false;
    const result = await launchWorkflow(
      {
        script: workflowScript({
          meta: { name: "background" },
          body: `return await agent("slow");`,
        }),
      },
      launchOptions({ agentRunner: async () => agentResult.promise }),
    );

    const launch = unwrap(result);
    void launch.completion.then(() => {
      completionSettled = true;
      return undefined;
    });

    await delay(5);
    expect(completionSettled).toBe(false);

    now = 125;
    agentResult.resolve("done");
    expect(unwrap(await launch.completion)).toMatchObject({ status: "completed", result: "done" });
  });

  it("should write failed terminal output and notify with failures when workflow throws", async () => {
    const notifications: WorkflowTaskNotification[] = [];
    const script = workflowScript({
      meta: {
        name: "terminal-failure",
        description: "Find risky workflow failures",
        phases: [{ title: "Scan" }],
      },
      body: `
phase("Scan");
await agent("scan src", { label: "scan-agent", phase: "Scan" });
throw new Error("workflow exploded");
`,
    });
    const outputPath = workflowRunOutputPath(rootDir, "wf_test");

    const result = await launchWorkflow(
      { script },
      launchOptions({
        agentRunner: async () => "agent result",
        notifyTerminal: (notification) => {
          notifications.push(notification);
        },
      }),
    );

    const launch = unwrap(result);
    now = 175;
    const completion = await launch.completion;

    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "workflow exploded" },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      details: {
        status: "failed",
        outputFile: outputPath,
        summary: 'Dynamic workflow "Find risky workflow failures" failed',
        failures: ["run failed: workflow exploded"],
        usage: {
          agentCount: 1,
          subagentTokens: 0,
          toolUses: 0,
          durationMs: 75,
        },
      },
    });
    expect(notifications[0]!.content).toContain("<status>failed</status>");
    expect(notifications[0]!.content).toContain("<failures>");
    expect(notifications[0]!.content).toContain("<failure>run failed: workflow exploded</failure>");

    const output = JSON.parse(await readFile(outputPath, "utf8"));
    expect(output).toMatchObject({
      runId: "wf_test",
      taskId: "task_test",
      workflowName: "terminal-failure",
      status: "failed",
      failures: [{ scope: "run", message: "workflow exploded" }],
      usage: {
        agentCount: 1,
        subagentTokens: 0,
        toolUses: 0,
        durationMs: 75,
      },
    });
  });

  it("should persist runtime progress once when a workflow fails after agent work", async () => {
    const script = workflowScript({
      meta: {
        name: "fail-after-agent",
        phases: [{ title: "Scan" }],
      },
      body: `
phase("Scan");
log("agent work started");
await agent("scan src", { label: "scan-agent", phase: "Scan" });
throw new Error("workflow exploded");
`,
    });

    const result = await launchWorkflow(
      { script },
      launchOptions({ agentRunner: async () => "agent result" }),
    );

    const launch = unwrap(result);
    now = 175;
    const completion = await launch.completion;
    expect(completion).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowLaunchBackgroundError", message: "workflow exploded" },
    });

    const finalManifest = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_test"));
    expect(finalManifest).toMatchObject({
      status: "failed",
      durationMs: 75,
      logs: ["agent work started"],
      agentCount: 1,
      failures: [{ scope: "run", message: "workflow exploded" }],
    });
    expect(finalManifest.failures).toHaveLength(1);
    expect(finalManifest.workflowProgress).toMatchObject([
      { type: "workflow_phase", title: "Scan" },
      { type: "workflow_agent", label: "scan-agent", state: "done" },
    ]);
  });

  function launchOptions(
    overrides: Partial<Parameters<typeof launchWorkflow>[1]> = {},
  ): Parameters<typeof launchWorkflow>[1] {
    return {
      rootDir,
      now: () => now,
      createTaskId: () => "task_test",
      createRunId: () => "wf_test",
      ...overrides,
    };
  }
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error("Timed out waiting for predicate.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.status === "ok") return result.value;
  throw new Error("Expected Result to be ok.");
}

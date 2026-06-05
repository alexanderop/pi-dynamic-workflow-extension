import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  launchWorkflow,
  workflowRunJournalPath,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
  type WorkflowTaskNotification,
} from "#src/workflows/launch/launcher.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { projectSavedWorkflowDir, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { AgentResponse, agent, setupAgentMock } from "../agent/agent-mock.ts";
import { workflowScript } from "../script/workflow-factory.ts";
import { delay, pathExists, unwrap } from "../../support.ts";

async function writeSavedWorkflow(dir: string, name: string, source: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(savedWorkflowPath(dir, name), source, "utf8");
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

  it("should return clear errors for missing saved workflow sources before run storage is created", async () => {
    const personalDir = join(tempDir, "home", ".pi", "workflows");
    const byName = await launchWorkflow(
      { name: "saved-review" },
      launchOptions({
        savedWorkflowDirs: { projectDir: projectSavedWorkflowDir(rootDir), personalDir },
      }),
    );
    const byPath = await launchWorkflow(
      { scriptPath: join(tempDir, "review.js") },
      launchOptions(),
    );

    expect(byName).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowNotFoundError", name: "saved-review" },
    });
    expect(byPath).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowReadError", path: join(tempDir, "review.js") },
    });
    expect(await pathExists(rootDir)).toBe(false);
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

  it("should launch a saved workflow by name from project scripts before personal scripts", async () => {
    const projectScript = workflowScript({
      meta: {
        name: "review",
        description: "Review source files",
        phases: [{ title: "Review" }],
      },
      body: `
phase("Review");
const result = await agent("review " + args.target, { label: "review-agent", phase: "Review" });
return { result };
`,
    });
    const personalScript = workflowScript({
      meta: { name: "review" },
      body: "return await agent('personal workflow should not run');",
    });
    const personalDir = join(tempDir, "home", ".pi", "workflows");
    await writeSavedWorkflow(projectSavedWorkflowDir(rootDir), "review", projectScript);
    await writeSavedWorkflow(personalDir, "review", personalScript);
    const agents = setupAgentMock(
      agent.call({ prompt: "review src", label: "review-agent", phase: "Review" }, () =>
        AgentResponse.text("project review result"),
      ),
    );

    const result = await launchWorkflow(
      { name: "review", args: { target: "src" } },
      launchOptions({
        savedWorkflowDirs: { personalDir },
        schedulerRunner: agents.schedulerRunner,
      }),
    );

    const launch = unwrap(result);
    expect(launch.scriptPath).toBe(workflowRunScriptPath(rootDir, "wf_test"));
    await expect(readFile(launch.scriptPath, "utf8")).resolves.toBe(projectScript);

    now = 175;
    const completed = unwrap(await launch.completion);
    expect(completed).toMatchObject({
      workflowName: "review",
      status: "completed",
      result: { result: "project review result" },
      phases: [{ title: "Review" }],
    });
    expect(agents.calls()).toHaveLength(1);
    agents.expectNoUnhandledAgents();
  });

  it("should launch a workflow from an explicit script path", async () => {
    const sourcePath = join(tempDir, "saved", "adhoc.js");
    const script = workflowScript({
      meta: { name: "adhoc", phases: [{ title: "Scan" }] },
      body: `
phase("Scan");
return await agent("scan explicit path", { label: "scan-agent", phase: "Scan" });
`,
    });
    await mkdir(join(tempDir, "saved"), { recursive: true });
    await writeFile(sourcePath, script, "utf8");
    const agents = setupAgentMock(
      agent.call({ prompt: "scan explicit path", label: "scan-agent" }, () =>
        AgentResponse.text("path result"),
      ),
    );

    const result = await launchWorkflow(
      { scriptPath: sourcePath },
      launchOptions({ schedulerRunner: agents.schedulerRunner }),
    );

    const launch = unwrap(result);
    await expect(readFile(launch.scriptPath, "utf8")).resolves.toBe(script);
    now = 150;
    const completed = unwrap(await launch.completion);

    expect(completed).toMatchObject({
      workflowName: "adhoc",
      status: "completed",
      result: "path result",
      durationMs: 50,
    });
    agents.expectNoUnhandledAgents();
  });

  it("should persist the script copy and initial run manifest before fake agents start", async () => {
    const scan = agent.pending({ prompt: "scan src", label: "scan-agent", phase: "Scan" });
    const agents = setupAgentMock(scan);
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
      launchOptions({ schedulerRunner: agents.schedulerRunner }),
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
    expect(scan.started).toBe(false);

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

    await scan.waitUntilStarted();
    expect(scan.prompt).toBe("scan src");
    now = 175;
    scan.resolve("fake agent result");

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

    const journal = (await readFile(workflowRunJournalPath(rootDir, "wf_test"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal).toMatchObject([
      { type: "started", agentId: expect.stringMatching(/^a[0-9a-f]{16}$/) },
      {
        type: "result",
        agentId: expect.stringMatching(/^a[0-9a-f]{16}$/),
        result: "fake agent result",
      },
    ]);
    expect(journal[1].key).toBe(journal[0].key);
    expect(agents.calls()).toMatchObject([
      {
        agentId: journal[0].agentId,
        journalKey: journal[0].key,
      },
    ]);
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
    const agents = setupAgentMock(agent.any(() => AgentResponse.text("agent result")));

    const result = await launchWorkflow(
      { script },
      launchOptions({
        schedulerRunner: agents.schedulerRunner,
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
    const slow = agent.pending();
    const agents = setupAgentMock(slow);
    let completionSettled = false;
    const result = await launchWorkflow(
      {
        script: workflowScript({
          meta: { name: "background" },
          body: `return await agent("slow");`,
        }),
      },
      launchOptions({ schedulerRunner: agents.schedulerRunner }),
    );

    const launch = unwrap(result);
    void launch.completion.then(() => {
      completionSettled = true;
      return undefined;
    });

    await delay(5);
    expect(completionSettled).toBe(false);

    now = 125;
    slow.resolve("done");
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
    const agents = setupAgentMock(agent.any(() => AgentResponse.text("agent result")));

    const result = await launchWorkflow(
      { script },
      launchOptions({
        schedulerRunner: agents.schedulerRunner,
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

  it("should fail through launcher storage when a structured fake agent violates schema", async () => {
    const script = workflowScript({
      meta: {
        name: "structured-failure",
        phases: [{ title: "Scan" }],
      },
      body: `
phase("Scan");
return await agent("scan src", {
  label: "scan-agent",
  phase: "Scan",
  schema: {
    type: "object",
    required: ["summary", "count"],
    properties: {
      summary: { type: "string" },
      count: { type: "integer" },
    },
  },
});
`,
    });
    const agents = setupAgentMock(
      agent.call({ label: "scan-agent" }, () => AgentResponse.json({ count: "one" })),
    );

    const launch = unwrap(
      await launchWorkflow({ script }, launchOptions({ schedulerRunner: agents.schedulerRunner })),
    );
    now = 175;

    await expect(launch.completion).resolves.toMatchObject({
      status: "error",
      error: {
        message: expect.stringContaining("does not satisfy agent schema"),
      },
    });

    const finalManifest = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_test"));
    expect(finalManifest).toMatchObject({
      status: "failed",
      failures: [
        {
          scope: "run",
          message: expect.stringContaining("does not satisfy agent schema"),
        },
      ],
      workflowProgress: [
        { type: "workflow_phase", title: "Scan" },
        { type: "workflow_agent", label: "scan-agent", state: "failed" },
      ],
    });

    const journal = (await readFile(workflowRunJournalPath(rootDir, "wf_test"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal.map((event) => event.type)).toEqual(["started", "failed"]);
  });

  it("should reuse cached journal results when resuming an inline workflow", async () => {
    const script = workflowScript({
      meta: {
        name: "resume-cache",
        phases: [{ title: "Scan" }],
      },
      body: `
phase("Scan");
const scan = await agent("scan src", { label: "scan-agent", phase: "Scan" });
return { scan };
`,
    });
    const originalAgents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent", phase: "Scan" }, () => {
        return AgentResponse.json({ summary: "cached scan result" });
      }),
    );
    const resumedAgents = setupAgentMock();

    const original = unwrap(
      await launchWorkflow(
        { script },
        launchOptions({
          createRunId: () => "wf_original",
          schedulerRunner: originalAgents.schedulerRunner,
        }),
      ),
    );
    unwrap(await original.completion);

    const resumed = unwrap(
      await launchWorkflow(
        { script, resumeFromRunId: "wf_original" },
        launchOptions({
          createRunId: () => "wf_resumed",
          schedulerRunner: resumedAgents.schedulerRunner,
        }),
      ),
    );

    const completed = unwrap(await resumed.completion);

    resumedAgents.expectNoAgents();
    expect(completed).toMatchObject({
      status: "completed",
      result: {
        scan: { summary: "cached scan result" },
      },
      agentCount: 1,
    });
    expect(completed.workflowProgress).toMatchObject([
      { type: "workflow_phase", title: "Scan" },
      { type: "workflow_agent", label: "scan-agent", state: "done" },
    ]);
  });

  it("should rerun agent calls when stable key inputs change during resume", async () => {
    const originalScript = workflowScript({
      meta: { name: "resume-changed-key" },
      body: `return await agent("scan src", { label: "scan-agent" });`,
    });
    const changedScript = workflowScript({
      meta: { name: "resume-changed-key" },
      body: `return await agent("scan test", { label: "scan-agent" });`,
    });
    const originalAgents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent" }, () =>
        AgentResponse.text("old result"),
      ),
    );
    const resumedAgents = setupAgentMock(
      agent.call({ prompt: "scan test", label: "scan-agent" }, ({ prompt }) => {
        return AgentResponse.text(`fresh:${prompt}`);
      }),
    );

    const original = unwrap(
      await launchWorkflow(
        { script: originalScript },
        launchOptions({
          createRunId: () => "wf_changed_key",
          schedulerRunner: originalAgents.schedulerRunner,
        }),
      ),
    );
    unwrap(await original.completion);

    const resumed = unwrap(
      await launchWorkflow(
        { script: changedScript, resumeFromRunId: "wf_changed_key" },
        launchOptions({
          createRunId: () => "wf_changed_key_resumed",
          schedulerRunner: resumedAgents.schedulerRunner,
        }),
      ),
    );

    expect(unwrap(await resumed.completion)).toMatchObject({
      status: "completed",
      result: "fresh:scan test",
    });
    expect(resumedAgents.calls()).toMatchObject([{ prompt: "scan test", handled: true }]);
  });

  it("should rerun invalidated journal results when resuming an inline workflow", async () => {
    const script = workflowScript({
      meta: { name: "resume-invalidated" },
      body: `return await agent("scan src", { label: "scan-agent" });`,
    });
    const originalAgents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent" }, () =>
        AgentResponse.text("old result"),
      ),
    );
    const resumedAgents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent" }, () =>
        AgentResponse.text("fresh result"),
      ),
    );

    const original = unwrap(
      await launchWorkflow(
        { script },
        launchOptions({
          createRunId: () => "wf_invalidated",
          schedulerRunner: originalAgents.schedulerRunner,
        }),
      ),
    );
    unwrap(await original.completion);

    const journalPath = workflowRunJournalPath(rootDir, "wf_invalidated");
    const journal = (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    await appendFile(
      journalPath,
      `${JSON.stringify({
        type: "invalidated",
        key: journal[1].key,
        previousAgentId: journal[1].agentId,
        reason: "restart-agent",
        at: 123,
      })}\n`,
      "utf8",
    );

    const resumed = unwrap(
      await launchWorkflow(
        { script, resumeFromRunId: "wf_invalidated" },
        launchOptions({
          createRunId: () => "wf_after_invalidated",
          schedulerRunner: resumedAgents.schedulerRunner,
        }),
      ),
    );

    expect(unwrap(await resumed.completion)).toMatchObject({
      status: "completed",
      result: "fresh result",
    });
    expect(resumedAgents.calls()).toMatchObject([{ prompt: "scan src", handled: true }]);
  });

  it("should rerun incomplete journal attempts when resuming an inline workflow", async () => {
    const script = workflowScript({
      meta: { name: "resume-incomplete" },
      body: `return await agent("scan src", { label: "scan-agent" });`,
    });
    const failingAgents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent" }, () => {
        return AgentResponse.error("agent failed before result");
      }),
    );
    const resumedAgents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent" }, () =>
        AgentResponse.text("fresh result"),
      ),
    );

    const incomplete = unwrap(
      await launchWorkflow(
        { script },
        launchOptions({
          createRunId: () => "wf_incomplete",
          schedulerRunner: failingAgents.schedulerRunner,
        }),
      ),
    );
    await expect(incomplete.completion).resolves.toMatchObject({ status: "error" });

    const resumed = unwrap(
      await launchWorkflow(
        { script, resumeFromRunId: "wf_incomplete" },
        launchOptions({
          createRunId: () => "wf_rerun",
          schedulerRunner: resumedAgents.schedulerRunner,
        }),
      ),
    );

    expect(unwrap(await resumed.completion)).toMatchObject({
      status: "completed",
      result: "fresh result",
    });
    expect(resumedAgents.calls()).toMatchObject([{ prompt: "scan src", handled: true }]);
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

    const agents = setupAgentMock(agent.any(() => AgentResponse.text("agent result")));
    const result = await launchWorkflow(
      { script },
      launchOptions({ schedulerRunner: agents.schedulerRunner }),
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

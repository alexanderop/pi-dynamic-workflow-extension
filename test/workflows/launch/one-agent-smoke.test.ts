import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
import {
  launchWorkflow,
  workflowRunJournalPath,
  workflowRunOutputPath,
  workflowRunScriptPath,
  workflowRunTranscriptDir,
  type WorkflowTaskNotification,
} from "#src/workflows/launch/launcher.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { agent, setupAgentMock } from "../agent/agent-mock.ts";
import { workflowScript } from "../script/workflow-factory.ts";
import { pathExists, unwrap } from "../../support.ts";

interface JsonObject {
  readonly [key: string]: unknown;
}

describe("one-agent workflow smoke", () => {
  let tempDir: string;
  let rootDir: string;
  let now: number;

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-workflow-one-agent-smoke-");
    rootDir = join(tempDir, ".pi", "workflows");
    now = 100;
  });

  it("should launch a fake one-agent workflow end to end", async () => {
    const review = agent.pending({
      prompt: "review src",
      label: "review:smoke",
      phase: "Review",
    });
    const agents = setupAgentMock(review);
    const notifications: WorkflowTaskNotification[] = [];
    const store = new WorkflowRunStore({ rootDir });
    const script = workflowScript({
      meta: {
        name: "one-agent-smoke",
        description: "Smoke test workflow",
        phases: [{ title: "Review" }],
      },
      body: `
phase("Review");
log("starting review");
const result = await agent("review " + args.target, {
  label: "review:smoke",
  phase: "Review",
});
return { result };
`,
    });

    const launch = unwrap(
      await launchWorkflow(
        { script, args: { target: "src" } },
        {
          rootDir,
          now: () => now,
          createTaskId: () => "task_smoke",
          createRunId: () => "wf_smoke",
          schedulerRunner: agents.schedulerRunner,
          notifyTerminal: async (notification) => {
            notifications.push(notification);
            expect(await pathExists(workflowRunOutputPath(rootDir, "wf_smoke"))).toBe(true);
            expect(unwrap(await store.readRun("wf_smoke"))).toMatchObject({
              status: "completed",
              outputPath: workflowRunOutputPath(rootDir, "wf_smoke"),
            });
          },
        },
      ),
    );

    expect(launch).toMatchObject({
      taskId: "task_smoke",
      runId: "wf_smoke",
      scriptPath: workflowRunScriptPath(rootDir, "wf_smoke"),
      transcriptDir: workflowRunTranscriptDir(rootDir, "wf_smoke"),
    });
    expect(launch.confirmation).toContain("Workflow launched in background. Task ID: task_smoke");
    expect(launch.confirmation).toContain("Run ID: wf_smoke");
    expect(launch.confirmation).toContain(`Script file: ${launch.scriptPath}`);
    expect(launch.confirmation).toContain(`Transcript dir: ${launch.transcriptDir}`);
    expect(launch.confirmation).toContain("Use /workflows to watch live progress");
    expect(review.started).toBe(false);

    await expect(readFile(launch.scriptPath, "utf8")).resolves.toBe(script);
    expect(await pathExists(launch.transcriptDir)).toBe(true);

    const initiallyVisibleRun = unwrap(await store.readRun(launch.runId));
    expect(initiallyVisibleRun).toMatchObject({
      runId: "wf_smoke",
      taskId: "task_smoke",
      workflowName: "one-agent-smoke",
      status: "running",
      script,
      scriptPath: launch.scriptPath,
      phases: [{ title: "Review" }],
      logs: [],
      workflowProgress: [],
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      startTime: 100,
    });
    expect(unwrap(await store.listRuns())).toMatchObject([
      { runId: "wf_smoke", status: "running" },
    ]);

    await review.waitUntilStarted();
    expect(review.prompt).toBe("review src");
    now = 175;
    review.resolve("fake review result");

    const completed = unwrap(await launch.completion);
    expect(completed).toMatchObject({
      runId: "wf_smoke",
      taskId: "task_smoke",
      workflowName: "one-agent-smoke",
      status: "completed",
      durationMs: 75,
      logs: ["starting review"],
      agentCount: 1,
      result: { result: "fake review result" },
      outputPath: workflowRunOutputPath(rootDir, "wf_smoke"),
    });
    expect(completed.workflowProgress).toMatchObject([
      { type: "workflow_phase", title: "Review" },
      { type: "workflow_agent", label: "review:smoke", phaseTitle: "Review", state: "done" },
    ]);

    const finalRunFromWorkflowsStore = unwrap(await store.readRun(launch.runId));
    expect(finalRunFromWorkflowsStore).toMatchObject({
      status: "completed",
      outputPath: workflowRunOutputPath(rootDir, "wf_smoke"),
      result: { result: "fake review result" },
      agentCount: 1,
    });
    expect(unwrap(await store.listRuns())).toMatchObject([
      {
        runId: "wf_smoke",
        status: "completed",
        outputPath: workflowRunOutputPath(rootDir, "wf_smoke"),
      },
    ]);

    const journal = await readJsonl(workflowRunJournalPath(rootDir, launch.runId));
    expect(journal).toMatchObject([
      {
        type: "started",
        agentId: expect.stringMatching(/^a[0-9a-f]{16}$/),
        key: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
      },
      {
        type: "result",
        agentId: expect.stringMatching(/^a[0-9a-f]{16}$/),
        key: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
        result: "fake review result",
      },
    ]);
    expect(journal[1]?.key).toBe(journal[0]?.key);

    const output = JSON.parse(await readFile(workflowRunOutputPath(rootDir, launch.runId), "utf8"));
    expect(output).toMatchObject({
      runId: "wf_smoke",
      taskId: "task_smoke",
      workflowName: "one-agent-smoke",
      status: "completed",
      result: { result: "fake review result" },
      usage: {
        agentCount: 1,
        subagentTokens: 0,
        toolUses: 0,
        durationMs: 75,
      },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      customType: "workflow-task-notification",
      display: true,
      details: {
        taskId: "task_smoke",
        runId: "wf_smoke",
        outputFile: workflowRunOutputPath(rootDir, "wf_smoke"),
        status: "completed",
        summary: 'Dynamic workflow "Smoke test workflow" completed',
        usage: {
          agentCount: 1,
          subagentTokens: 0,
          toolUses: 0,
          durationMs: 75,
        },
      },
    });
    agents.expectNoUnhandledAgents();
    agents.expectAllHandlersUsed();
  });
});

async function readJsonl(path: string): Promise<JsonObject[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

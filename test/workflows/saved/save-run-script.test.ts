import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchWorkflow } from "#src/workflows/launch/launcher.ts";
import { saveRunScript } from "#src/workflows/saved/save-run-script.ts";
import { projectSavedWorkflowDir, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { AgentResponse, agent, setupAgentMock } from "../agent/agent-mock.ts";
import { workflowScript } from "../script/workflow-factory.ts";
import { pathExists, unwrap } from "../../support.ts";

describe("saveRunScript", () => {
  let tempDir: string;
  let rootDir: string;
  let now: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-save-run-script-"));
    rootDir = join(tempDir, ".pi", "workflows");
    now = 100;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should save a completed inline run as a project workflow that can be relaunched by name", async () => {
    const script = workflowScript({
      meta: {
        name: "review",
        description: "Review a target",
        phases: [{ title: "Review" }],
      },
      body: `
phase("Review");
const result = await agent("review " + args.target, {
  label: "review-agent",
  phase: "Review",
});
return { result };
`,
    });
    const firstAgents = setupAgentMock(
      agent.call({ prompt: "review src", label: "review-agent", phase: "Review" }, () =>
        AgentResponse.text("first result"),
      ),
    );

    const firstLaunch = unwrap(
      await launchWorkflow(
        { script, args: { target: "src" } },
        launchOptions({
          createRunId: () => "wf_source",
          schedulerRunner: firstAgents.schedulerRunner,
        }),
      ),
    );
    unwrap(await firstLaunch.completion);

    const saved = unwrap(
      await saveRunScript({ runId: "wf_source", name: "review", scope: "project" }, { rootDir }),
    );

    expect(saved).toMatchObject({
      runId: "wf_source",
      name: "review",
      scope: "project",
      path: savedWorkflowPath(projectSavedWorkflowDir(rootDir), "review"),
    });
    await expect(readFile(saved.path, "utf8")).resolves.toBe(script);
    expect(
      await pathExists(join(projectSavedWorkflowDir(rootDir), "review", "manifest.json")),
    ).toBe(false);
    expect(
      await pathExists(join(projectSavedWorkflowDir(rootDir), "review", "journal.jsonl")),
    ).toBe(false);

    const secondAgents = setupAgentMock(
      agent.call({ prompt: "review src", label: "review-agent", phase: "Review" }, () =>
        AgentResponse.text("saved result"),
      ),
    );
    const secondLaunch = unwrap(
      await launchWorkflow(
        { name: "review", args: { target: "src" } },
        launchOptions({
          createRunId: () => "wf_saved",
          schedulerRunner: secondAgents.schedulerRunner,
        }),
      ),
    );

    now = 175;
    expect(unwrap(await secondLaunch.completion)).toMatchObject({
      workflowName: "review",
      status: "completed",
      result: { result: "saved result" },
    });
    firstAgents.expectNoUnhandledAgents();
    secondAgents.expectNoUnhandledAgents();
  });

  it("should reject saving a run that does not exist", async () => {
    const result = await saveRunScript(
      { runId: "wf_missing", name: "review", scope: "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSaveRunScriptRunReadError",
        runId: "wf_missing",
      },
    });
  });

  it("should reject saving a run under a name that does not match meta.name", async () => {
    const script = workflowScript({
      meta: { name: "review" },
      body: `return await agent("review src", { label: "review-agent" });`,
    });
    const agents = setupAgentMock(
      agent.call({ prompt: "review src", label: "review-agent" }, () =>
        AgentResponse.text("result"),
      ),
    );
    const launch = unwrap(
      await launchWorkflow(
        { script },
        launchOptions({
          createRunId: () => "wf_review",
          schedulerRunner: agents.schedulerRunner,
        }),
      ),
    );
    unwrap(await launch.completion);

    const result = await saveRunScript(
      { runId: "wf_review", name: "audit", scope: "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSaveRunScriptInvalidWorkflowError",
        message: expect.stringContaining("meta.name"),
      },
    });
    expect(await pathExists(savedWorkflowPath(projectSavedWorkflowDir(rootDir), "audit"))).toBe(
      false,
    );
    agents.expectNoUnhandledAgents();
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

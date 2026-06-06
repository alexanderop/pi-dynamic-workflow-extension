import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchWorkflow } from "#src/workflows/launch/launcher.ts";
import { saveRunScript } from "#src/workflows/saved/save-run-script.ts";
import { projectSavedWorkflowDir, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { workflowRun } from "../../builders/workflow-run.ts";
import { AgentResponse, agent, setupAgentMock } from "../agent/agent-mock.ts";
import { invalidWorkflowScript, workflowScript } from "../script/workflow-factory.ts";
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

  async function writeRunWithScript(
    runId: string,
    status: "running" | "completed",
    scriptOptions: { name?: string; source?: string; scriptPath?: string } = {},
  ): Promise<string> {
    const scriptPath = scriptOptions.scriptPath ?? join(tempDir, "runs", runId, "script.js");
    if (scriptOptions.source !== undefined) {
      await mkdir(dirname(scriptPath), { recursive: true });
      await writeFile(scriptPath, scriptOptions.source, "utf8");
    }
    const builder = status === "completed" ? workflowRun.completed : workflowRun.running;
    const state = builder(scriptOptions.name ?? "review", {
      runId,
      script: scriptOptions.source ?? "return null;",
      scriptPath,
    });
    unwrap(await new WorkflowRunStore({ rootDir }).writeRun(state));
    return scriptPath;
  }

  it("should reject saving a run with an invalid workflow name", async () => {
    const result = await saveRunScript(
      { runId: "wf_x", name: "../escape", scope: "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowInvalidNameError", name: "../escape" },
    });
  });

  it("should reject saving a run with an unknown scope", async () => {
    const result = await saveRunScript(
      { runId: "wf_x", name: "review", scope: "team" as "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSaveRunScriptInvalidScopeError", scope: "team" },
    });
  });

  it("should reject saving a run that has not completed", async () => {
    await writeRunWithScript("wf_running", "running");

    const result = await saveRunScript(
      { runId: "wf_running", name: "review", scope: "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSaveRunScriptInvalidRunStatusError",
        runId: "wf_running",
        status: "running",
      },
    });
  });

  it("should reject saving when the run script file cannot be read", async () => {
    await writeRunWithScript("wf_no_script", "completed", {
      scriptPath: join(tempDir, "runs", "wf_no_script", "missing.js"),
    });

    const result = await saveRunScript(
      { runId: "wf_no_script", name: "review", scope: "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSaveRunScriptReadError",
        path: join(tempDir, "runs", "wf_no_script", "missing.js"),
      },
    });
  });

  it("should reject saving when the run script is not a valid workflow", async () => {
    const scriptPath = await writeRunWithScript("wf_bad_script", "completed", {
      source: invalidWorkflowScript({ metaSource: "{ name: buildName() }", body: "return null;" }),
    });

    const result = await saveRunScript(
      { runId: "wf_bad_script", name: "review", scope: "project" },
      { rootDir },
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSaveRunScriptInvalidWorkflowError", path: scriptPath },
    });
  });

  it("should save a completed run as a personal workflow", async () => {
    const personalDir = join(tempDir, "home", ".pi", "workflows");
    await writeRunWithScript("wf_personal", "completed", {
      name: "review",
      source: workflowScript({ meta: { name: "review" }, body: "return 'personal';" }),
    });

    const saved = unwrap(
      await saveRunScript(
        { runId: "wf_personal", name: "review", scope: "personal" },
        { rootDir, savedWorkflowDirs: { personalDir } },
      ),
    );

    expect(saved).toMatchObject({
      runId: "wf_personal",
      name: "review",
      scope: "personal",
      path: savedWorkflowPath(personalDir, "review"),
    });
    expect(await pathExists(saved.path)).toBe(true);
  });

  it("should default the personal scope target to the home saved workflow directory", async () => {
    const home = join(tempDir, "fake-home");
    await writeRunWithScript("wf_personal_home", "completed", {
      name: "review",
      source: workflowScript({ meta: { name: "review" }, body: "return 'personal';" }),
    });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const saved = unwrap(
        await saveRunScript(
          { runId: "wf_personal_home", name: "review", scope: "personal" },
          { rootDir },
        ),
      );

      expect(saved.scope).toBe("personal");
      expect(saved.path).toBe(join(home, ".pi", "workflows", "review.js"));
      expect(await pathExists(saved.path)).toBe(true);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("should reject saving when the saved workflow script cannot be written", async () => {
    const blockingFile = join(tempDir, "blocking-file");
    await writeFile(blockingFile, "not a directory", "utf8");
    const projectDir = join(blockingFile, "workflows");
    await writeRunWithScript("wf_write_fail", "completed", {
      name: "review",
      source: workflowScript({ meta: { name: "review" }, body: "return 'review';" }),
    });

    const result = await saveRunScript(
      { runId: "wf_write_fail", name: "review", scope: "project" },
      { rootDir, savedWorkflowDirs: { projectDir } },
    );

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSaveRunScriptWriteError",
        path: savedWorkflowPath(projectDir, "review"),
        cause: { code: "ENOTDIR" },
      },
    });
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

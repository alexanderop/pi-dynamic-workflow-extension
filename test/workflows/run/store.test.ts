import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowRunStore, workflowRunManifestPath } from "#src/workflows/run/store.ts";
import type { Result } from "#src/workflows/result.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";

describe("WorkflowRunStore", () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-store-"));
    rootDir = join(tempDir, ".pi", "workflows");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should list workflow runs from manifest files", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_one", workflowName: "one" }));
    await writeRunManifest(rootDir, runState({ runId: "wf_two", workflowName: "two" }));

    const result = await new WorkflowRunStore({ rootDir }).listRuns();

    const runs = unwrap(result);
    expect(runs.map((run) => run.workflowName).toSorted()).toEqual(["one", "two"]);
  });

  it("should sort workflow runs by newest start time first", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_old", startTime: 100 }));
    await writeRunManifest(rootDir, runState({ runId: "wf_new", startTime: 300 }));
    await writeRunManifest(rootDir, runState({ runId: "wf_mid", startTime: 200 }));

    const result = await new WorkflowRunStore({ rootDir }).listRuns();

    expect(unwrap(result).map((run) => run.runId)).toEqual(["wf_new", "wf_mid", "wf_old"]);
  });

  it("should ignore invalid workflow manifests while listing runs", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_valid" }));
    await writeInvalidManifest(rootDir, "wf_invalid_json", "{");
    await writeInvalidManifest(rootDir, "wf_partial", JSON.stringify({ runId: "wf_partial" }));

    const result = await new WorkflowRunStore({ rootDir }).listRuns();

    expect(unwrap(result).map((run) => run.runId)).toEqual(["wf_valid"]);
  });

  it("should read one workflow run by run id", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_target",
        taskId: "task_target",
        workflowName: "target",
        status: "completed",
        result: { ok: true },
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_target");

    expect(unwrap(result)).toMatchObject({
      runId: "wf_target",
      taskId: "task_target",
      workflowName: "target",
      status: "completed",
      result: { ok: true },
    });
  });

  it("should preserve session ownership metadata when reading a run", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_session",
        sessionId: "session_current",
        triggerSource: "ultracode",
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_session");

    expect(unwrap(result)).toMatchObject({
      runId: "wf_session",
      sessionId: "session_current",
      triggerSource: "ultracode",
    });
  });

  it("should return a typed error when one workflow run does not exist", async () => {
    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_missing");

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowRunNotFoundError",
        runId: "wf_missing",
      },
    });
  });

  it("should return an empty list when the workflow root does not exist yet", async () => {
    const result = await new WorkflowRunStore({ rootDir }).listRuns();

    expect(unwrap(result)).toEqual([]);
  });

  it("should not require journals or transcripts while listing workflow runs", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_manifest_only" }));
    await mkdir(join(rootDir, "wf_manifest_only", "transcripts"), { recursive: true });
    await writeFile(join(rootDir, "wf_manifest_only", "journal.jsonl"), "{not-jsonl");
    await writeFile(join(rootDir, "wf_manifest_only", "transcripts", "agent_1.jsonl"), "{");

    const result = await new WorkflowRunStore({ rootDir }).listRuns();

    expect(unwrap(result)).toHaveLength(1);
  });

  it("should normalize observed exploratory manifests into the run read model", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_observed",
      JSON.stringify({
        id: 1,
        runId: "wf_observed",
        name: "observed",
        status: "error",
        script: "return null;",
        scriptPath: "/tmp/observed.workflow.js",
        startedAt: 100,
        finishedAt: 150,
        error: "boom",
        snapshot: {
          phases: ["Review"],
          logs: ["started"],
          agents: [
            {
              id: 1,
              label: "review",
              phase: "Review",
              prompt: "Review the repo",
              status: "error",
              startedAt: 110,
              endedAt: 140,
              toolCount: 2,
            },
          ],
          agentCount: 1,
          durationMs: 50,
          toolCount: 2,
        },
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_observed");

    expect(unwrap(result)).toMatchObject({
      runId: "wf_observed",
      workflowName: "observed",
      status: "failed",
      phases: [{ title: "Review" }],
      logs: ["started"],
      agentCount: 1,
      totalToolCalls: 2,
      durationMs: 50,
      failures: [{ scope: "run", message: "boom" }],
    });
  });

  it("should preserve the full agent prompt when reloading a persisted manifest", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_full_prompt",
        workflowProgress: [agentEntry({ promptPreview: "P".repeat(160), prompt: "P".repeat(400) })],
        agentCount: 1,
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_full_prompt");

    const [agent] = unwrap(result).workflowProgress;
    expect(agent?.type === "workflow_agent" && agent.prompt).toBe("P".repeat(400));
  });

  it("should recover the full agent prompt from an observed snapshot manifest", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_observed_prompt",
      JSON.stringify({
        runId: "wf_observed_prompt",
        name: "observed",
        script: "return null;",
        scriptPath: "/tmp/observed.workflow.js",
        snapshot: { agents: [{ prompt: "X".repeat(300), status: "success" }] },
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_observed_prompt");

    const agent = unwrap(result).workflowProgress.find((entry) => entry.type === "workflow_agent");
    expect(agent?.type === "workflow_agent" && agent.prompt).toBe("X".repeat(300));
    expect(agent?.type === "workflow_agent" && agent.promptPreview).toBe("X".repeat(160));
  });

  it("should preserve observed agent progress timestamps for idle display", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_observed_progress",
      JSON.stringify({
        runId: "wf_observed_progress",
        name: "observed",
        script: "return null;",
        scriptPath: "/tmp/observed.workflow.js",
        snapshot: {
          agents: [
            {
              label: "review",
              status: "running",
              prompt: "Review the repo",
              lastProgressAt: 25_000,
            },
          ],
        },
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_observed_progress");

    const agent = unwrap(result).workflowProgress.find((entry) => entry.type === "workflow_agent");
    expect(agent?.type === "workflow_agent" && agent.lastProgressAt).toBe(25_000);
  });

  it("should accept legacy manifests whose agent rows omit the prompt field", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_legacy_prompt",
        workflowProgress: [agentEntry({ promptPreview: "legacy preview" })],
        agentCount: 1,
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_legacy_prompt");

    const [agent] = unwrap(result).workflowProgress;
    expect(agent?.type === "workflow_agent" && agent.prompt).toBeUndefined();
    expect(agent?.type === "workflow_agent" && agent.promptPreview).toBe("legacy preview");
  });

  it("should expose the workflow description from a persisted manifest and omit it when absent", async () => {
    await writeRunManifest(
      rootDir,
      runState({ runId: "wf_described", description: "Audit the extension" }),
    );
    await writeRunManifest(rootDir, runState({ runId: "wf_undescribed" }));

    const store = new WorkflowRunStore({ rootDir });
    expect(unwrap(await store.readRun("wf_described")).description).toBe("Audit the extension");
    expect(unwrap(await store.readRun("wf_undescribed")).description).toBeUndefined();
  });

  it("should return a read error when the workflow root is not a directory", async () => {
    await mkdir(tempDir, { recursive: true });
    const filePath = join(tempDir, "root-as-file");
    await writeFile(filePath, "not a directory");

    const result = await new WorkflowRunStore({ rootDir: filePath }).listRuns();

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunReadError", path: filePath },
    });
  });

  it("should surface a non-not-found read error when reading a run manifest", async () => {
    await mkdir(join(rootDir, "wf_dir_manifest", "manifest.json"), { recursive: true });

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_dir_manifest");

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowRunReadError",
        path: join(rootDir, "wf_dir_manifest", "manifest.json"),
      },
    });
  });

  it("should drop persisted phase rows that are not records with a title", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_phase_rows",
        phases: [{ title: "Keep" }, { notTitle: 1 }, "scalar", null] as never,
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_phase_rows"));
    expect(run.phases).toEqual([{ title: "Keep" }]);
  });

  it("should retain explicit observed agent identity, attempt, and result fields", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_full_agent",
      JSON.stringify({
        runId: "wf_full_agent",
        name: "full-agent",
        script: "return null;",
        scriptPath: "/tmp/full-agent.workflow.js",
        snapshot: {
          agents: [
            {
              agentId: "agent_explicit",
              agentType: "security-reviewer",
              model: "claude-opus",
              attempt: 3,
              resultPreview: "looks good",
              status: "done",
              prompt: "audit",
            },
          ],
        },
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_full_agent"));
    const [agent] = run.workflowProgress;
    expect(agent?.type === "workflow_agent" && agent).toMatchObject({
      agentId: "agent_explicit",
      agentType: "security-reviewer",
      model: "claude-opus",
      attempt: 3,
      resultPreview: "looks good",
      state: "done",
    });
  });

  it("should expose the manifest path for a run id", () => {
    expect(workflowRunManifestPath(rootDir, "wf_path")).toBe(
      join(rootDir, "wf_path", "manifest.json"),
    );
  });

  it("should return a write error when the run directory cannot be created", async () => {
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "wf_blocked"), "i am a file, not a directory");

    const result = await new WorkflowRunStore({ rootDir }).writeRun(
      runState({ runId: "wf_blocked" }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunWriteError", path: join(rootDir, "wf_blocked", "manifest.json") },
    });
  });

  it("should reject manifests that are valid JSON but not an object", async () => {
    await writeInvalidManifest(rootDir, "wf_scalar", "42");

    expect(await new WorkflowRunStore({ rootDir }).readRun("wf_scalar")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunInvalidError" },
    });
  });

  it("should sort observed runs by parsed timestamp and treat invalid timestamps as zero", async () => {
    await writeRunManifest(
      rootDir,
      runState({ runId: "wf_ts_valid", startTime: 0, timestamp: "2024-01-02T00:00:00.000Z" }),
    );
    await writeRunManifest(
      rootDir,
      runState({ runId: "wf_ts_invalid", startTime: 0, timestamp: "not-a-date" }),
    );

    const runs = unwrap(await new WorkflowRunStore({ rootDir }).listRuns());
    expect(runs.map((run) => run.runId)).toEqual(["wf_ts_valid", "wf_ts_invalid"]);
  });

  it("should apply default fallbacks for an observed manifest without a snapshot", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_minimal",
      JSON.stringify({
        id: 7,
        runId: "wf_minimal",
        name: "minimal",
        script: "return null;",
        scriptPath: "/tmp/minimal.workflow.js",
        status: "running",
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_minimal"));

    expect(run).toMatchObject({
      runId: "wf_minimal",
      taskId: "task_7",
      workflowName: "minimal",
      status: "running",
      phases: [],
      logs: [],
      workflowProgress: [],
      agentCount: 0,
      totalToolCalls: 0,
      startTime: 0,
    });
    expect(run.sessionId).toBeUndefined();
    expect(run.triggerSource).toBeUndefined();
    expect(run.description).toBeUndefined();
    expect(run.defaultModel).toBeUndefined();
    expect(run.timestamp).toBeUndefined();
    expect(run.durationMs).toBeUndefined();
    expect(run.failures).toBeUndefined();
  });

  it("should derive an observed task id from the run id when id and taskId are absent", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_no_id",
      JSON.stringify({
        runId: "wf_no_id",
        name: "no-id",
        script: "return null;",
        scriptPath: "/tmp/no-id.workflow.js",
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_no_id"));
    expect(run.taskId).toBe("task_wf_no_id");
  });

  it("should retain explicit observed metadata fields when present", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_rich",
      JSON.stringify({
        runId: "wf_rich",
        taskId: "task_explicit",
        sessionId: "session_rich",
        triggerSource: "manual",
        name: "rich",
        description: "explicit description",
        defaultModel: "claude-opus",
        outputPath: "/tmp/out.json",
        status: "completed",
        script: "return null;",
        scriptPath: "/tmp/rich.workflow.js",
        startedAt: 1000,
        finishedAt: 1600,
        snapshot: { description: "snapshot description", phases: ["A", 5, "B"] },
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_rich"));
    expect(run).toMatchObject({
      taskId: "task_explicit",
      sessionId: "session_rich",
      triggerSource: "manual",
      description: "explicit description",
      defaultModel: "claude-opus",
      outputPath: "/tmp/out.json",
      status: "completed",
      phases: [{ title: "A" }, { title: "B" }],
      durationMs: 600,
    });
  });

  it("should fall back to the snapshot description for observed manifests", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_snap_desc",
      JSON.stringify({
        runId: "wf_snap_desc",
        name: "snap-desc",
        script: "return null;",
        scriptPath: "/tmp/snap-desc.workflow.js",
        snapshot: { description: "from snapshot" },
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_snap_desc"));
    expect(run.description).toBe("from snapshot");
  });

  it("should normalize an unknown observed status to failed", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_unknown_status",
      JSON.stringify({
        runId: "wf_unknown_status",
        name: "unknown",
        script: "return null;",
        scriptPath: "/tmp/unknown.workflow.js",
        status: "weird",
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_unknown_status"));
    expect(run.status).toBe("failed");
  });

  it("should preserve a recognized observed status", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_paused_status",
      JSON.stringify({
        runId: "wf_paused_status",
        name: "paused",
        script: "return null;",
        scriptPath: "/tmp/paused.workflow.js",
        status: "paused",
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_paused_status"));
    expect(run.status).toBe("paused");
  });

  it("should ignore non-array observed agents and non-record agent rows", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_bad_agents",
      JSON.stringify({
        runId: "wf_bad_agents",
        name: "bad-agents",
        script: "return null;",
        scriptPath: "/tmp/bad-agents.workflow.js",
        snapshot: { agents: "not-an-array" },
      }),
    );
    await writeInvalidManifest(
      rootDir,
      "wf_mixed_agents",
      JSON.stringify({
        runId: "wf_mixed_agents",
        name: "mixed-agents",
        script: "return null;",
        scriptPath: "/tmp/mixed-agents.workflow.js",
        snapshot: { agents: [null, "scalar", { prompt: "ok", status: "queued" }] },
      }),
    );

    const store = new WorkflowRunStore({ rootDir });
    const badAgents = unwrap(await store.readRun("wf_bad_agents"));
    expect(badAgents.workflowProgress).toEqual([]);

    const mixedAgents = unwrap(await store.readRun("wf_mixed_agents"));
    const agents = mixedAgents.workflowProgress.filter((entry) => entry.type === "workflow_agent");
    expect(agents).toHaveLength(1);
  });

  it("should apply default fields for observed agents missing identity and state", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_default_agent",
      JSON.stringify({
        runId: "wf_default_agent",
        name: "default-agent",
        script: "return null;",
        scriptPath: "/tmp/default-agent.workflow.js",
        snapshot: { agents: [{ id: 9 }] },
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_default_agent"));
    const [agent] = run.workflowProgress;
    expect(agent?.type === "workflow_agent" && agent).toMatchObject({
      label: "agent:0",
      agentId: "agent_9",
      agentType: "unknown",
      model: "unknown",
      state: "failed",
      attempt: 1,
      promptPreview: "",
    });
    expect(agent?.type === "workflow_agent" && agent.phaseTitle).toBeUndefined();
    expect(agent?.type === "workflow_agent" && agent.prompt).toBeUndefined();
    expect(agent?.type === "workflow_agent" && agent.resultPreview).toBeUndefined();
    expect(agent?.type === "workflow_agent" && agent.toolCalls).toBeUndefined();
  });

  it("should derive an observed agent id from its index when id is absent", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_index_agent",
      JSON.stringify({
        runId: "wf_index_agent",
        name: "index-agent",
        script: "return null;",
        scriptPath: "/tmp/index-agent.workflow.js",
        snapshot: { agents: [{ status: "running" }] },
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_index_agent"));
    const [agent] = run.workflowProgress;
    expect(agent?.type === "workflow_agent" && agent.agentId).toBe("agent_0");
  });

  it("should map every recognized observed agent status to a progress state", async () => {
    await writeInvalidManifest(
      rootDir,
      "wf_states",
      JSON.stringify({
        runId: "wf_states",
        name: "states",
        script: "return null;",
        scriptPath: "/tmp/states.workflow.js",
        snapshot: {
          agents: [
            { status: "queued" },
            { status: "done" },
            { status: "failed" },
            { status: "stopped" },
            { status: 12345 },
          ],
        },
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_states"));
    const states = run.workflowProgress
      .filter((entry) => entry.type === "workflow_agent")
      .map((entry) => (entry.type === "workflow_agent" ? entry.state : ""));
    expect(states).toEqual(["queued", "done", "failed", "stopped", "failed"]);
  });

  it("should drop persisted progress rows that do not match the progress shape", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_bad_progress",
        workflowProgress: [
          { type: "workflow_phase", index: 0, title: "Phase" },
          "not-a-record",
          { noType: true },
          { type: "workflow_agent", index: 0 },
        ] as never,
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_bad_progress"));
    expect(run.workflowProgress).toEqual([{ type: "workflow_phase", index: 0, title: "Phase" }]);
  });

  it("should keep persisted failures with every recognized scope and drop invalid ones", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_failures",
        failures: [
          { scope: "run", message: "run failed" },
          { scope: "agent", message: "agent failed" },
          { scope: "pipeline", message: "pipeline failed" },
          { scope: "other", message: "ignored" },
          { scope: "run", noMessage: true },
        ] as never,
      }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_failures"));
    expect(run.failures).toEqual([
      { scope: "run", message: "run failed" },
      { scope: "agent", message: "agent failed" },
      { scope: "pipeline", message: "pipeline failed" },
    ]);
  });

  it("should drop a persisted failures array that holds no valid entries", async () => {
    await writeRunManifest(
      rootDir,
      runState({ runId: "wf_no_failures", failures: [{ scope: "bogus" }] as never }),
    );

    const run = unwrap(await new WorkflowRunStore({ rootDir }).readRun("wf_no_failures"));
    expect(run.failures).toBeUndefined();
  });
});

function agentEntry(overrides: Partial<WorkflowAgentProgress> = {}): WorkflowAgentProgress {
  return {
    type: "workflow_agent",
    index: 0,
    label: "review",
    agentId: "agent_0",
    agentType: "general-purpose",
    model: "fake-model",
    state: "running",
    queuedAt: 0,
    attempt: 1,
    promptPreview: "preview",
    ...overrides,
  };
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

async function writeRunManifest(rootDir: string, state: WorkflowRunState): Promise<void> {
  await writeInvalidManifest(rootDir, state.runId, JSON.stringify(state));
}

async function writeInvalidManifest(rootDir: string, runId: string, source: string): Promise<void> {
  const runDir = join(rootDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "manifest.json"), source);
}

function unwrap<T, E>(result: Result<T, E>): T {
  if (result.status === "ok") return result.value;
  throw new Error("Expected Result to be ok.");
}

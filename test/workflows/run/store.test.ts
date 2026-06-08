import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The production store reads manifests via a *named* `readFile` import from
// `node:fs/promises`. In this ESM setup the module namespace is not
// configurable, so `vi.spyOn(fs, "readFile")` throws. Mocking the module and
// wrapping the real `readFile` with a spy is the way to intercept that named
// import while preserving real behavior, so efficiency assertions observe the
// actual read calls the store makes.
const readFileSpy = vi.fn<(...args: unknown[]) => void>();
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readFileSpy(...args);
      return actual.readFile(...args);
    },
  };
});
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import type { Result } from "#src/workflows/result.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";

describe("WorkflowRunStore", () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-workflow-store-");
    rootDir = join(tempDir, ".pi", "workflows");
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

  it("should preserve planned phase metadata when reading a run", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_planned_counts",
        phases: [
          {
            title: "Discover public sources",
            detail: "Check official sites",
            model: "openai-codex/gpt-5.5",
            agentCount: 6,
            agents: [{ label: "verify-official", model: "openai-codex/gpt-5.5" }],
          },
        ],
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_planned_counts");

    expect(unwrap(result).phases).toEqual([
      {
        title: "Discover public sources",
        detail: "Check official sites",
        model: "openai-codex/gpt-5.5",
        agentCount: 6,
        agents: [{ label: "verify-official", model: "openai-codex/gpt-5.5" }],
      },
    ]);
  });

  it("should preserve planned phase thinking-level metadata when reading a run", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_planned_thinking",
        phases: [
          {
            title: "Deep review",
            detail: "Use heavier reasoning",
            model: "openai-codex/gpt-5.5",
            thinkingLevel: "high",
            agentCount: 1,
            agents: [
              {
                label: "deep-review",
                model: "openai-codex/gpt-5.5",
                thinkingLevel: "high",
              },
            ],
          },
        ],
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_planned_thinking");

    expect(unwrap(result).phases).toEqual([
      {
        title: "Deep review",
        detail: "Use heavier reasoning",
        model: "openai-codex/gpt-5.5",
        thinkingLevel: "high",
        agentCount: 1,
        agents: [
          {
            label: "deep-review",
            model: "openai-codex/gpt-5.5",
            thinkingLevel: "high",
          },
        ],
      },
    ]);
  });

  it("should preserve requested and effective model fallback metadata on agent rows", async () => {
    await writeRunManifest(
      rootDir,
      runState({
        runId: "wf_model_fallback",
        workflowProgress: [
          agentEntry({
            label: "scan-agent",
            model: "openai-codex/gpt-5.5",
            thinkingLevel: "high",
            requestedModel: "openai-codex/gpt-5.55",
            requestedThinkingLevel: "hihg",
            modelFallbackReason: "Requested model is unavailable; using current Pi model.",
          }),
        ],
        agentCount: 1,
      }),
    );

    const result = await new WorkflowRunStore({ rootDir }).readRun("wf_model_fallback");

    const [agent] = unwrap(result).workflowProgress;
    expect(agent).toMatchObject({
      type: "workflow_agent",
      label: "scan-agent",
      model: "openai-codex/gpt-5.5",
      thinkingLevel: "high",
      requestedModel: "openai-codex/gpt-5.55",
      requestedThinkingLevel: "hihg",
      modelFallbackReason: "Requested model is unavailable; using current Pi model.",
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
});

describe("WorkflowRunStore caching", () => {
  let tempDir: string;
  let rootDir: string;

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-workflow-store-cache-");
    rootDir = join(tempDir, ".pi", "workflows");
  });

  it("should include a run added after the first listing", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_one", workflowName: "one" }));
    const store = new WorkflowRunStore({ rootDir });

    expect(unwrap(await store.listRuns()).map((run) => run.workflowName)).toEqual(["one"]);

    await writeRunManifest(rootDir, runState({ runId: "wf_two", workflowName: "two" }));

    expect(
      unwrap(await store.listRuns())
        .map((run) => run.workflowName)
        .toSorted(),
    ).toEqual(["one", "two"]);
  });

  it("should reflect changes to a run that was modified after caching", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_mut", status: "running" }));
    const store = new WorkflowRunStore({ rootDir });

    expect(unwrap(await store.listRuns())[0]?.status).toBe("running");

    await touchAndWrite(rootDir, runState({ runId: "wf_mut", status: "completed" }));

    expect(unwrap(await store.listRuns())[0]?.status).toBe("completed");
  });

  it("should drop a run whose manifest was deleted after caching", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_keep", workflowName: "keep" }));
    await writeRunManifest(rootDir, runState({ runId: "wf_drop", workflowName: "drop" }));
    const store = new WorkflowRunStore({ rootDir });

    expect(unwrap(await store.listRuns())).toHaveLength(2);

    await rm(join(rootDir, "wf_drop"), { recursive: true, force: true });

    const runs = unwrap(await store.listRuns());
    expect(runs.map((run) => run.runId)).toEqual(["wf_keep"]);
  });

  it("should not re-read unchanged manifests on the second listing", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_a" }));
    await writeRunManifest(rootDir, runState({ runId: "wf_b" }));
    const store = new WorkflowRunStore({ rootDir });

    await store.listRuns();

    readFileSpy.mockClear();
    await store.listRuns();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("should re-read only the manifest that changed", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_a", status: "running" }));
    await writeRunManifest(rootDir, runState({ runId: "wf_b", status: "running" }));
    const store = new WorkflowRunStore({ rootDir });

    await store.listRuns();

    await touchAndWrite(rootDir, runState({ runId: "wf_b", status: "completed" }));

    readFileSpy.mockClear();
    await store.listRuns();
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(String(readFileSpy.mock.calls[0]?.[0])).toContain("wf_b");
  });

  it("should re-read when contents change but mtime is unchanged via size difference", async () => {
    await writeRunManifest(rootDir, runState({ runId: "wf_size" }));
    const store = new WorkflowRunStore({ rootDir });

    expect(unwrap(await store.listRuns())[0]?.description).toBeUndefined();

    const originalMtime = (await stat(manifestFilePath(rootDir, "wf_size"))).mtime;
    await writeRunManifest(rootDir, runState({ runId: "wf_size", description: "D".repeat(500) }));
    await utimes(manifestFilePath(rootDir, "wf_size"), originalMtime, originalMtime);

    expect(unwrap(await store.listRuns())[0]?.description).toBe("D".repeat(500));
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

function manifestFilePath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "manifest.json");
}

/**
 * Write a manifest and force a strictly-newer mtime. Writing a file twice in
 * quick succession can yield identical mtimes (filesystem resolution), which
 * would make change-detection tests flaky; bumping mtimeMs guarantees the
 * second write looks newer than the cached entry.
 */
async function touchAndWrite(rootDir: string, state: WorkflowRunState): Promise<void> {
  await writeRunManifest(rootDir, state);
  const path = manifestFilePath(rootDir, state.runId);
  const { mtimeMs } = await stat(path);
  const next = new Date(mtimeMs + 1000);
  await utimes(path, next, next);
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

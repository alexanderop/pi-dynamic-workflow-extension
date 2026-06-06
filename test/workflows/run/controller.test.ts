import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunController } from "#src/workflows/run/controller.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import { unwrap } from "../../support.ts";

describe("WorkflowRunController", () => {
  let tempDir: string;
  let store: WorkflowRunStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-run-controller-"));
    store = new WorkflowRunStore({ rootDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should pause a running run and persist the paused status", async () => {
    await store.writeRun(runState({ status: "running" }));
    const pause = vi.fn<() => void>();
    const controller = new WorkflowRunController({
      store,
      now: sequenceNow(100, 110),
      control: { pause, resume: vi.fn<() => void>() },
    });

    const paused = unwrap(await controller.pause("wf_test"));
    const persisted = unwrap(await store.readRun("wf_test"));

    expect(pause).toHaveBeenCalledOnce();
    expect(paused.status).toBe("paused");
    expect(persisted.status).toBe("paused");
  });

  it("should resume a paused run and persist the running status", async () => {
    await store.writeRun(runState({ status: "paused" }));
    const resume = vi.fn<() => void>();
    const controller = new WorkflowRunController({
      store,
      now: sequenceNow(100, 110),
      control: { pause: vi.fn<() => void>(), resume },
    });

    const resumed = unwrap(await controller.resume("wf_test"));
    const persisted = unwrap(await store.readRun("wf_test"));

    expect(resume).toHaveBeenCalledOnce();
    expect(resumed.status).toBe("running");
    expect(persisted.status).toBe("running");
  });

  it("should reject pause requests for terminal runs without touching the scheduler", async () => {
    await store.writeRun(runState({ status: "completed" }));
    const pause = vi.fn<() => void>();
    const controller = new WorkflowRunController({
      store,
      control: { pause, resume: vi.fn<() => void>() },
    });

    const result = await controller.pause("wf_test");

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowTransitionError", currentState: "completed" },
    });
    expect(pause).not.toHaveBeenCalled();
  });
});

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

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

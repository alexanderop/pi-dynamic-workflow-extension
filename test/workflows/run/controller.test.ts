import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowRunController,
  type WorkflowRunExecutionControl,
} from "#src/workflows/run/controller.ts";
import type { WorkflowAgentProgress } from "#src/workflows/agent/model.ts";
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
      control: executionControl({ pause }),
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
      control: executionControl({ resume }),
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
      control: executionControl({ pause }),
    });

    const result = await controller.pause("wf_test");

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowTransitionError", currentState: "completed" },
    });
    expect(pause).not.toHaveBeenCalled();
  });

  it("should stop a running run and persist the stopped status", async () => {
    await store.writeRun(runState({ status: "running", startTime: 100 }));
    const stopRun = vi.fn<() => void>();
    const controller = new WorkflowRunController({
      store,
      now: sequenceNow(150, 175),
      control: executionControl({ stopRun }),
    });

    const stopped = unwrap(await controller.stopRun("wf_test"));
    const persisted = unwrap(await store.readRun("wf_test"));

    expect(stopRun).toHaveBeenCalledOnce();
    expect(stopped).toMatchObject({ status: "stopped", durationMs: 75 });
    expect(persisted).toMatchObject({ status: "stopped", durationMs: 75 });
  });

  it("should reject stop requests for terminal runs without touching execution control", async () => {
    await store.writeRun(runState({ status: "completed" }));
    const stopRun = vi.fn<() => void>();
    const controller = new WorkflowRunController({
      store,
      control: executionControl({ stopRun }),
    });

    const result = await controller.stopRun("wf_test");

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowTransitionError", currentState: "completed" },
    });
    expect(stopRun).not.toHaveBeenCalled();
  });

  it("should stop a selected agent and persist its stopped progress row", async () => {
    await store.writeRun(
      runState({
        status: "running",
        workflowProgress: [agentProgress({ agentId: "agent_0", state: "running" })],
        agentCount: 1,
      }),
    );
    const stopAgent = vi.fn<(agentId: string) => void>();
    const controller = new WorkflowRunController({
      store,
      now: sequenceNow(200),
      control: executionControl({ stopAgent }),
    });

    const updated = unwrap(await controller.stopAgent("wf_test", "agent_0"));
    const persisted = unwrap(await store.readRun("wf_test"));

    expect(stopAgent).toHaveBeenCalledWith("agent_0");
    expect(updated.status).toBe("running");
    expect(updated.workflowProgress).toMatchObject([{ agentId: "agent_0", state: "stopped" }]);
    expect(persisted.workflowProgress).toMatchObject([{ agentId: "agent_0", state: "stopped" }]);
  });

  it("should propagate the store read error when pausing a missing run", async () => {
    const controller = new WorkflowRunController({ store, control: executionControl() });

    expect(await controller.pause("wf_missing")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunNotFoundError", runId: "wf_missing" },
    });
  });

  it("should propagate the store read error when resuming a missing run", async () => {
    const controller = new WorkflowRunController({ store, control: executionControl() });

    expect(await controller.resume("wf_missing")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunNotFoundError" },
    });
  });

  it("should propagate the store read error when stopping a missing run", async () => {
    const controller = new WorkflowRunController({ store, control: executionControl() });

    expect(await controller.stopRun("wf_missing")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunNotFoundError" },
    });
  });

  it("should propagate the store read error when stopping an agent in a missing run", async () => {
    const controller = new WorkflowRunController({ store, control: executionControl() });

    expect(await controller.stopAgent("wf_missing", "agent_0")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunNotFoundError" },
    });
  });

  it("should surface a control error when pausing throws", async () => {
    await store.writeRun(runState({ status: "running" }));
    const controller = new WorkflowRunController({
      store,
      control: executionControl({
        pause: () => {
          throw new Error("scheduler down");
        },
      }),
    });

    expect(await controller.pause("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunControlOperationError", operation: "pause", runId: "wf_test" },
    });
  });

  it("should surface a control error when resuming throws", async () => {
    await store.writeRun(runState({ status: "paused" }));
    const controller = new WorkflowRunController({
      store,
      control: executionControl({
        resume: () => {
          throw new Error("scheduler down");
        },
      }),
    });

    expect(await controller.resume("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunControlOperationError", operation: "resume" },
    });
  });

  it("should surface a control error when stopping a run throws", async () => {
    await store.writeRun(runState({ status: "running" }));
    const controller = new WorkflowRunController({
      store,
      control: executionControl({
        stopRun: () => {
          throw new Error("scheduler down");
        },
      }),
    });

    expect(await controller.stopRun("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunControlOperationError", operation: "stop" },
    });
  });

  it("should surface a control error when stopping an agent throws", async () => {
    await store.writeRun(
      runState({
        status: "running",
        workflowProgress: [agentProgress({ agentId: "agent_0", state: "running" })],
        agentCount: 1,
      }),
    );
    const controller = new WorkflowRunController({
      store,
      control: executionControl({
        stopAgent: () => {
          throw new Error("scheduler down");
        },
      }),
    });

    expect(await controller.stopAgent("wf_test", "agent_0")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunControlOperationError", operation: "stop-agent" },
    });
  });

  it("should reject resume requests for terminal runs without touching the scheduler", async () => {
    await store.writeRun(runState({ status: "completed" }));
    const resume = vi.fn<() => void>();
    const controller = new WorkflowRunController({ store, control: executionControl({ resume }) });

    expect(await controller.resume("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowTransitionError", currentState: "completed" },
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("should report a missing-agent transition error when the agent is not in the run", async () => {
    await store.writeRun(runState({ status: "running" }));
    const controller = new WorkflowRunController({ store, control: executionControl() });

    expect(await controller.stopAgent("wf_test", "agent_absent")).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowTransitionError",
        currentState: "missing",
        eventType: "agent_stopped",
      },
    });
  });

  it("should reject stopping an agent that is already in a terminal state", async () => {
    await store.writeRun(
      runState({
        status: "running",
        workflowProgress: [agentProgress({ agentId: "agent_0", state: "done" })],
        agentCount: 1,
      }),
    );
    const stopAgent = vi.fn<(agentId: string) => void>();
    const controller = new WorkflowRunController({
      store,
      control: executionControl({ stopAgent }),
    });

    expect(await controller.stopAgent("wf_test", "agent_0")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowTransitionError", currentState: "done" },
    });
    expect(stopAgent).not.toHaveBeenCalled();
  });

  it("should propagate the store write error after pausing succeeds", async () => {
    await store.writeRun(runState({ status: "running" }));
    const controller = new WorkflowRunController({
      store: failingWriteStore(store),
      control: executionControl(),
    });

    expect(await controller.pause("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunWriteError" },
    });
  });

  it("should propagate the store write error after resuming succeeds", async () => {
    await store.writeRun(runState({ status: "paused" }));
    const controller = new WorkflowRunController({
      store: failingWriteStore(store),
      control: executionControl(),
    });

    expect(await controller.resume("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunWriteError" },
    });
  });

  it("should propagate the store write error after stopping a run succeeds", async () => {
    await store.writeRun(runState({ status: "running" }));
    const controller = new WorkflowRunController({
      store: failingWriteStore(store),
      control: executionControl(),
    });

    expect(await controller.stopRun("wf_test")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunWriteError" },
    });
  });

  it("should propagate the store write error after stopping an agent succeeds", async () => {
    await store.writeRun(
      runState({
        status: "running",
        workflowProgress: [agentProgress({ agentId: "agent_0", state: "running" })],
        agentCount: 1,
      }),
    );
    const controller = new WorkflowRunController({
      store: failingWriteStore(store),
      control: executionControl(),
    });

    expect(await controller.stopAgent("wf_test", "agent_0")).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRunWriteError" },
    });
  });
});

function failingWriteStore(real: WorkflowRunStore): WorkflowRunStore {
  return {
    readRun: (runId: string) => real.readRun(runId),
    writeRun: async () => ({
      status: "error",
      error: {
        _tag: "WorkflowRunWriteError",
        message: "disk full",
        path: "/tmp/manifest.json",
        cause: new Error("ENOSPC"),
      },
    }),
  } as unknown as WorkflowRunStore;
}

function executionControl(
  overrides: Partial<WorkflowRunExecutionControl> = {},
): WorkflowRunExecutionControl {
  return {
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    stopRun: vi.fn<() => void>(),
    stopAgent: vi.fn<(agentId: string) => void>(),
    ...overrides,
  };
}

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

function agentProgress(overrides: Partial<WorkflowAgentProgress> = {}): WorkflowAgentProgress {
  return {
    type: "workflow_agent",
    index: 0,
    label: "scan-agent",
    agentId: "agent_0",
    agentType: "general-purpose",
    model: "default",
    state: "running",
    queuedAt: 0,
    attempt: 1,
    promptPreview: "scan src",
    prompt: "scan src",
    ...overrides,
  };
}

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

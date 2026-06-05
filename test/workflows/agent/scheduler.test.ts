import { describe, expect, it } from "vitest";
import {
  calculateDefaultMaxConcurrent,
  WorkflowAgentScheduler,
} from "../../../src/workflows/agent/scheduler.ts";
import type { WorkflowJournalEvent } from "../../../src/workflows/journal/model.ts";
import { delay } from "../../support.ts";

describe("calculateDefaultMaxConcurrent", () => {
  it("should reserve two CPU cores and cap default concurrency at sixteen", () => {
    expect(calculateDefaultMaxConcurrent(1)).toBe(1);
    expect(calculateDefaultMaxConcurrent(12)).toBe(10);
    expect(calculateDefaultMaxConcurrent(64)).toBe(16);
  });
});

describe("WorkflowAgentScheduler", () => {
  it("should never run more fake agents than the configured concurrency cap", async () => {
    let running = 0;
    let peak = 0;
    const scheduler = new WorkflowAgentScheduler({
      maxConcurrent: 2,
      runner: async ({ prompt }) => {
        running += 1;
        peak = Math.max(peak, running);
        await delay(prompt === "slow" ? 20 : 5);
        running -= 1;
        return `done:${prompt}`;
      },
    });

    const results = await Promise.all([
      scheduler.schedule("slow"),
      scheduler.schedule("fast-1"),
      scheduler.schedule("fast-2"),
      scheduler.schedule("fast-3"),
    ]);

    expect(results).toEqual(["done:slow", "done:fast-1", "done:fast-2", "done:fast-3"]);
    expect(peak).toBe(2);
    expect(scheduler.progress().map((agent) => agent.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("should start queued fake agents in FIFO order", async () => {
    const started: string[] = [];
    const scheduler = new WorkflowAgentScheduler({
      maxConcurrent: 1,
      runner: async ({ prompt }) => {
        started.push(prompt);
        await delay(prompt === "first" ? 20 : 1);
        return prompt;
      },
    });

    await Promise.all([
      scheduler.schedule("first"),
      scheduler.schedule("second"),
      scheduler.schedule("third"),
    ]);

    expect(started).toEqual(["first", "second", "third"]);
  });

  it("should reject new agents after the total-agent cap is reached", async () => {
    const scheduler = new WorkflowAgentScheduler({
      maxTotalAgents: 1,
      runner: async ({ prompt }) => prompt,
    });

    await expect(scheduler.schedule("allowed")).resolves.toBe("allowed");
    await expect(scheduler.schedule("blocked")).rejects.toThrow(/maxTotalAgents=1/);
    expect(scheduler.progress()).toHaveLength(1);
  });

  it("should expose queued, running, done, and failed progress rows", async () => {
    const first = deferred<string>();
    const scheduler = new WorkflowAgentScheduler({
      maxConcurrent: 1,
      createAgentId: sequenceIds("agent"),
      runner: async ({ prompt }) => {
        if (prompt === "first") return first.promise;
        throw new Error("fake failure");
      },
    });

    const firstResult = scheduler.schedule("first", { label: "scan", phase: "Review" });
    const secondResult = scheduler.schedule("second", { label: "verify" });

    expect(scheduler.progress()).toMatchObject([
      { agentId: "agent_0", label: "scan", phaseTitle: "Review", state: "running" },
      { agentId: "agent_1", label: "verify", state: "queued" },
    ]);

    first.resolve("ok");
    await expect(firstResult).resolves.toBe("ok");
    await expect(secondResult).rejects.toThrow("fake failure");

    expect(scheduler.progress()).toMatchObject([
      { state: "done", resultPreview: "ok" },
      { state: "failed", resultPreview: "fake failure" },
    ]);
  });

  it("should write started before fake execution and result only after success", async () => {
    const events: WorkflowJournalEvent[] = [];
    let eventsAtRunnerStart: WorkflowJournalEvent[] = [];
    const scheduler = new WorkflowAgentScheduler({
      cwd: "/repo",
      createAgentId: sequenceIds("agent"),
      journal: {
        append: async (event) => {
          events.push(event);
        },
      },
      runner: async () => {
        eventsAtRunnerStart = [...events];
        return { ok: true };
      },
    });

    await expect(
      scheduler.schedule("scan src", {
        label: "scan-agent",
        phase: "Scan",
        agentType: "general-purpose",
        model: "test-model",
        schema: { type: "object" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(eventsAtRunnerStart).toHaveLength(1);
    expect(eventsAtRunnerStart[0]).toMatchObject({ type: "started", agentId: "agent_0" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "started", agentId: "agent_0" });
    expect(events[1]).toMatchObject({ type: "result", agentId: "agent_0", result: { ok: true } });
    expect(events[1]!.key).toBe(events[0]!.key);
    expect(events[0]!.key).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("should not write a result journal event when the fake agent fails", async () => {
    const events: WorkflowJournalEvent[] = [];
    const scheduler = new WorkflowAgentScheduler({
      createAgentId: sequenceIds("agent"),
      journal: {
        append: async (event) => {
          events.push(event);
        },
      },
      runner: async () => {
        throw new Error("fake failure");
      },
    });

    await expect(scheduler.schedule("scan src")).rejects.toThrow("fake failure");

    expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
    expect(events).toMatchObject([
      { type: "started", agentId: "agent_0" },
      { type: "failed", agentId: "agent_0", error: { message: "fake failure" } },
    ]);
  });

  it("should stop a queued fake agent and resolve its scheduled result to null", async () => {
    const first = deferred<string>();
    const scheduler = new WorkflowAgentScheduler({
      maxConcurrent: 1,
      createAgentId: sequenceIds("agent"),
      runner: async ({ prompt }) => {
        if (prompt === "first") return first.promise;
        return prompt;
      },
    });

    const firstResult = scheduler.schedule("first");
    const secondResult = scheduler.schedule("second");

    expect(scheduler.stopAgent("agent_1")).toBe(true);
    await expect(secondResult).resolves.toBeNull();
    expect(scheduler.progress()[1]).toMatchObject({ state: "stopped" });

    first.resolve("ok");
    await expect(firstResult).resolves.toBe("ok");
  });

  it("should stop a running fake agent through its abort signal", async () => {
    const scheduler = new WorkflowAgentScheduler({
      createAgentId: sequenceIds("agent"),
      runner: async ({ signal }) => {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });

    const result = scheduler.schedule("running");

    expect(scheduler.stopAgent("agent_0")).toBe(true);
    await expect(result).resolves.toBeNull();
    expect(scheduler.progress()[0]).toMatchObject({ state: "stopped" });
  });

  it("should wait for a stopped running fake agent to settle before resolving and draining", async () => {
    const runnerExit = deferred<string>();
    let firstAborted = false;
    let firstSettled = false;
    let secondStarted = false;
    const scheduler = new WorkflowAgentScheduler({
      maxConcurrent: 1,
      createAgentId: sequenceIds("agent"),
      runner: async ({ prompt, signal }) => {
        if (prompt === "first") {
          signal.addEventListener("abort", () => {
            firstAborted = true;
          });
          return runnerExit.promise;
        }
        secondStarted = true;
        return "second result";
      },
    });

    const firstResult = scheduler.schedule("first");
    const secondResult = scheduler.schedule("second");
    void firstResult.then(() => {
      firstSettled = true;
      return undefined;
    });

    expect(scheduler.stopAgent("agent_0")).toBe(true);
    expect(firstAborted).toBe(true);
    expect(scheduler.progress()[0]).toMatchObject({ state: "stopped" });

    await delay(0);
    expect(firstSettled).toBe(false);
    expect(secondStarted).toBe(false);

    runnerExit.resolve("late result");

    await expect(firstResult).resolves.toBeNull();
    await expect(secondResult).resolves.toBe("second result");
    expect(secondStarted).toBe(true);
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function sequenceIds(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}_${index++}`;
}

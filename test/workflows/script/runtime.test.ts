import { describe, expect, it } from "vitest";
import {
  parallel,
  pipeline,
  runWorkflowScript,
  tryRunWorkflowScript,
  type WorkflowRuntimeControl,
} from "#src/workflows/script/runtime.ts";
import { AgentResponse, agent, setupAgentMock } from "../agent/agent-mock.ts";
import { deferred } from "../../support.ts";
import { workflowScript } from "./workflow-factory.ts";

describe("runWorkflowScript", () => {
  it("should capture workflow phases, logs, agent calls, and result when script runs with args", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "Scan src", label: "repo inventory" }, ({ prompt }) =>
        AgentResponse.text(`fake:${prompt}`),
      ),
    );
    const state = await runWorkflowScript(
      workflowScript({
        meta: {
          name: "inspect",
          description: "Inspect with fake agents",
          phases: [{ title: "Scan" }],
        },
        body: `
phase("Scan");
log("started");
const result = await agent("Scan " + args.target, { label: "repo inventory" });
return { result };
`,
      }),
      {
        args: { target: "src" },
        schedulerRunner: agents.schedulerRunner,
      },
    );

    expect(state.meta.name).toBe("inspect");
    expect(state.phases).toEqual([{ type: "workflow_phase", index: 0, title: "Scan" }]);
    expect(state.logs).toEqual(["started"]);
    expect(state.agentCalls).toEqual([
      { prompt: "Scan src", options: { label: "repo inventory" } },
    ]);
    expect(state.result).toEqual({ result: "fake:Scan src" });
    agents.expectNoUnhandledAgents();
  });

  it("should hide process and require when workflow script checks sandbox globals", async () => {
    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "sandbox" },
          body: `
return typeof process + ":" + typeof require;
`,
        }),
      ),
    ).resolves.toMatchObject({ result: "undefined:undefined" });
  });

  it("should block nondeterminism when workflow script calls runtime aliases", async () => {
    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "runtime-date" },
          body: `
const Clock = Date;
return Clock.now();
`,
        }),
      ),
    ).rejects.toThrow(/Date.now/);

    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "runtime-random" },
          body: `
const m = Math;
return m.random();
`,
        }),
      ),
    ).rejects.toThrow(/Math.random/);
  });

  it("should return runtime failures as Result values when workflow script throws", async () => {
    const result = await tryRunWorkflowScript(
      workflowScript({
        meta: { name: "runtime-failure" },
        body: `throw new Error("boom");`,
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRuntimeError", message: "boom" },
    });
  });

  it("should route workflow agent calls through the scheduler cap and expose progress rows", async () => {
    let running = 0;
    let peak = 0;
    const agents = setupAgentMock(
      agent.any(async ({ prompt }) => {
        running += 1;
        peak = Math.max(peak, running);
        await delay(5);
        running -= 1;
        return AgentResponse.text(`done:${prompt}`);
      }),
    );
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "scheduled-agents" },
        body: `
return await parallel([
  () => agent("first", { label: "one" }),
  () => agent("second", { label: "two" }),
  () => agent("third", { label: "three" }),
]);
`,
      }),
      {
        maxConcurrentAgents: 1,
        schedulerRunner: agents.schedulerRunner,
      },
    );

    expect(state.result).toEqual(["done:first", "done:second", "done:third"]);
    expect(peak).toBe(1);
    agents.expectAgentsInOrder([{ label: "one" }, { label: "two" }, { label: "three" }]);
    expect(state.workflowProgress).toMatchObject([
      { type: "workflow_agent", label: "one", state: "done", resultPreview: "done:first" },
      { type: "workflow_agent", label: "two", state: "done", resultPreview: "done:second" },
      { type: "workflow_agent", label: "three", state: "done", resultPreview: "done:third" },
    ]);
  });

  it("should expose a live runtime control that pauses scheduler dequeuing", async () => {
    let control: WorkflowRuntimeControl | undefined;
    const first = deferred<string>();
    let secondStarted = false;
    const statePromise = runWorkflowScript(
      workflowScript({
        meta: { name: "controlled-agents" },
        body: `
return await parallel([
  () => agent("first", { label: "first" }),
  () => agent("second", { label: "second" }),
]);
`,
      }),
      {
        maxConcurrentAgents: 1,
        onControlReady: (runtimeControl) => {
          control = runtimeControl;
        },
        schedulerRunner: async ({ prompt }) => {
          if (prompt === "first") return first.promise;
          secondStarted = true;
          return AgentResponse.text("second result");
        },
      },
    );

    await delay(0);
    expect(control).toBeDefined();
    control!.pause();
    first.resolve("first result");

    await delay(0);
    expect(control!.isPaused()).toBe(true);
    expect(secondStarted).toBe(false);

    control!.resume();
    const state = await statePromise;

    expect(secondStarted).toBe(true);
    expect(state.result).toEqual(["first result", "second result"]);
  });
});

describe("parallel", () => {
  it("should preserve result order and resolve throwing thunks to null when tasks run in parallel", async () => {
    const result = await parallel([
      async () => {
        await delay(20);
        return "slow";
      },
      async () => "fast",
      async () => {
        throw new Error("boom");
      },
    ]);

    expect(result).toEqual(["slow", "fast", null]);
  });

  it("should reject already-started promises when parallel receives non-thunk inputs", async () => {
    await expect(parallel([Promise.resolve("started") as any])).rejects.toThrow(/thunks/);
  });
});

describe("pipeline", () => {
  it("should pass previous result, original item, and index when item moves through multiple stages", async () => {
    const result = await pipeline(
      ["a", "b"],
      async (_previous, item, index) => `${item}:${index}`,
      async (previous, item) => `${previous}:${item.toUpperCase()}`,
      async (previous) => `${previous}:done`,
    );

    expect(result).toEqual(["a:0:A:done", "b:1:B:done"]);
  });

  it("should start the next stage for a completed item when another item is still in an earlier stage", async () => {
    const events: string[] = [];
    const result = await pipeline(
      ["fast", "slow"],
      async (_previous, item) => {
        if (item === "slow") await delay(30);
        events.push(`stage1:${item}`);
        return item;
      },
      async (previous, item) => {
        events.push(`stage2:${item}`);
        return previous;
      },
    );

    expect(result).toEqual(["fast", "slow"]);
    expect(events.indexOf("stage2:fast")).toBeLessThan(events.indexOf("stage1:slow"));
  });

  it("should drop a failed item to null and keep other items running when a stage throws", async () => {
    const result = await pipeline(
      ["ok", "fail"],
      async (_previous, item) => {
        if (item === "fail") throw new Error("failed item");
        return item;
      },
      async (previous) => `${previous}:done`,
    );

    expect(result).toEqual(["ok:done", null]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

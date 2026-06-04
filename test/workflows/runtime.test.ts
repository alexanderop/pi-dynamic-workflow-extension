import { describe, expect, it } from "vitest";
import {
  parallel,
  pipeline,
  runWorkflowScript,
  tryRunWorkflowScript,
} from "../../src/workflows/runtime.ts";
import { workflowScript } from "./workflow-factory.ts";

describe("runWorkflowScript", () => {
  it("runs a simple workflow with fake agents, phases, logs, and args", async () => {
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
        agentRunner: async (prompt) => `fake:${prompt}`,
      },
    );

    expect(state.meta.name).toBe("inspect");
    expect(state.phases).toEqual([{ type: "workflow_phase", index: 0, title: "Scan" }]);
    expect(state.logs).toEqual(["started"]);
    expect(state.agentCalls).toEqual([
      { prompt: "Scan src", options: { label: "repo inventory" } },
    ]);
    expect(state.result).toEqual({ result: "fake:Scan src" });
  });

  it("does not expose process or require to workflow scripts", async () => {
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

  it("blocks nondeterminism even through runtime aliases", async () => {
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

  it("can return runtime failures as Result values", async () => {
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
});

describe("parallel", () => {
  it("preserves result order and resolves throwing thunks to null", async () => {
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

  it("rejects already-started promises", async () => {
    await expect(parallel([Promise.resolve("started") as any])).rejects.toThrow(/thunks/);
  });
});

describe("pipeline", () => {
  it("threads previous result, original item, and index through multiple stages", async () => {
    const result = await pipeline(
      ["a", "b"],
      async (_previous, item, index) => `${item}:${index}`,
      async (previous, item) => `${previous}:${item.toUpperCase()}`,
      async (previous) => `${previous}:done`,
    );

    expect(result).toEqual(["a:0:A:done", "b:1:B:done"]);
  });

  it("starts stage 2 for a completed item before slower item stage 1 finishes", async () => {
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

  it("drops a failed item to null and keeps other items running", async () => {
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

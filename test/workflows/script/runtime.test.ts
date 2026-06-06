import { describe, expect, it } from "vitest";
import {
  parallel,
  pipeline,
  runWorkflowScript,
  tryRunWorkflowScript,
  WORKFLOW_COLLECTION_ITEM_LIMIT,
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

  it("should let pipeline first-stage shorthand fan out agent calls", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "inspect a" }, ({ prompt }) => AgentResponse.text(`done:${prompt}`)),
      agent.call({ prompt: "inspect b" }, ({ prompt }) => AgentResponse.text(`done:${prompt}`)),
    );
    const state = await runWorkflowScript(
      workflowScript({
        meta: {
          name: "pipeline-shorthand",
          description: "Use first stage previous as the pipeline item",
        },
        body: `
const inspected = await pipeline(
  [{ prompt: "inspect a" }, { prompt: "inspect b" }],
  async (work) => agent(work.prompt),
);
return inspected;
`,
      }),
      { schedulerRunner: agents.schedulerRunner },
    );

    expect(state.agentCalls).toEqual([
      { prompt: "inspect a", options: {} },
      { prompt: "inspect b", options: {} },
    ]);
    expect(state.result).toEqual(["done:inspect a", "done:inspect b"]);
    agents.expectNoUnhandledAgents();
  });

  it("should use meta.model as the default model for agent calls", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "scan src", model: "opus" }, () => AgentResponse.text("ok")),
    );
    const state = await runWorkflowScript(
      workflowScript({
        meta: {
          name: "model-default",
          description: "Use a model default from metadata",
          model: "opus",
        },
        body: `
return await agent("scan src", { label: "scan-agent" });
`,
      }),
      { schedulerRunner: agents.schedulerRunner },
    );

    expect(state.result).toBe("ok");
    expect(state.workflowProgress).toMatchObject([
      { type: "workflow_agent", label: "scan-agent", model: "opus" },
    ]);
    agents.expectNoUnhandledAgents();
  });

  it("should let explicit agent models override meta.model defaults", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "scan src", model: "sonnet" }, () => AgentResponse.text("ok")),
    );
    const state = await runWorkflowScript(
      workflowScript({
        meta: {
          name: "model-override",
          description: "Use an explicit agent model",
          model: "opus",
        },
        body: `
return await agent("scan src", { label: "scan-agent", model: "sonnet" });
`,
      }),
      { schedulerRunner: agents.schedulerRunner },
    );

    expect(state.result).toBe("ok");
    expect(state.workflowProgress).toMatchObject([
      { type: "workflow_agent", label: "scan-agent", model: "sonnet" },
    ]);
    agents.expectNoUnhandledAgents();
  });

  it("should resolve a direct non-schema agent failure to null", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "dead-agent", description: "Handle a dead agent as null" },
        body: `
return await agent("scan src", { label: "scan-agent" });
`,
      }),
      {
        schedulerRunner: async () => {
          throw new Error("agent died");
        },
      },
    );

    expect(state.result).toBeNull();
    expect(state.workflowProgress).toMatchObject([
      { type: "workflow_agent", label: "scan-agent", state: "failed", resultPreview: "agent died" },
    ]);
  });

  it("should fail fast when the scheduler total-agent cap is exceeded", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "first" }, () => AgentResponse.text("first result")),
    );

    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "agent-cap", description: "Do not hide scheduler cap failures" },
          body: `
await agent("first");
return await agent("second");
`,
        }),
        {
          maxTotalAgents: 1,
          schedulerRunner: agents.schedulerRunner,
        },
      ),
    ).rejects.toThrow(/maxTotalAgents=1/);

    agents.expectAgentsInOrder([{ prompt: "first" }]);
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

  it("should enforce budget.total as a hard ceiling before scheduling further agents", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "first" }, () => AgentResponse.text("first result")),
    );

    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "budget-ceiling" },
          body: `
await agent("first");
return await agent("second");
`,
        }),
        {
          budgetTotal: 1,
          schedulerRunner: agents.schedulerRunner,
        },
      ),
    ).rejects.toThrow(/budget exhausted/);

    agents.expectAgentsInOrder([{ prompt: "first" }]);
    agents.expectNoUnhandledAgents();
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

  it("should expose a live runtime control that stops queued and running agents", async () => {
    type StoppableRuntimeControl = WorkflowRuntimeControl & { stopRun(): void };

    let control: WorkflowRuntimeControl | undefined;
    const first = deferred<string>();
    let firstAborted = false;
    let secondStarted = false;
    const statePromise = runWorkflowScript(
      workflowScript({
        meta: { name: "stoppable-agents" },
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
        schedulerRunner: async ({ prompt, signal }) => {
          if (prompt === "first") {
            signal.addEventListener(
              "abort",
              () => {
                firstAborted = true;
              },
              { once: true },
            );
            return first.promise;
          }
          secondStarted = true;
          return AgentResponse.text("second result");
        },
      },
    );

    try {
      await delay(0);
      expect(control).toBeDefined();

      const stoppableControl = control as StoppableRuntimeControl;
      expect(stoppableControl.stopRun).toEqual(expect.any(Function));
      stoppableControl.stopRun();

      expect(firstAborted).toBe(true);
      await delay(0);
      expect(secondStarted).toBe(false);

      first.resolve("late first result");
      const state = await statePromise;

      expect(state.result).toEqual([null, null]);
      expect(state.workflowProgress).toMatchObject([
        { type: "workflow_agent", label: "first", state: "stopped" },
        { type: "workflow_agent", label: "second", state: "stopped" },
      ]);
    } finally {
      first.resolve("cleanup first result");
      await statePromise.catch(() => undefined);
    }
  });
});

describe("runWorkflowScript runtime internals", () => {
  it("should route agent calls through the default agent runner when no scheduler runner is set", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "default-runner", description: "Echo prompt by default" },
        body: 'return await agent("echo me", { label: "echo" });',
      }),
    );

    expect(state.result).toBe("echo me");
  });

  it("should route agent calls through a custom agentRunner option", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "custom-runner", description: "Use custom agent runner" },
        body: 'return await agent("hello");',
      }),
      {
        agentRunner: async (prompt) => `custom:${prompt}`,
      },
    );

    expect(state.result).toBe("custom:hello");
  });

  it("should estimate tokens as prompt-only when the agent result serializes to undefined", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "undef-result", description: "Result that serializes to undefined" },
        body: `
const value = await agent("a prompt");
return budget.spent();
`,
      }),
      {
        budgetTotal: 1000,
        agentRunner: async () => undefined,
      },
    );

    // prompt length 8 => ceil(8/4) = 2, result contributes 0.
    expect(state.result).toBe(2);
  });

  it("should expose budget spent and remaining helpers to the workflow script", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "budget-helpers", description: "Read budget" },
        body: `
const before = budget.remaining();
await agent("spend some tokens");
return { before, spent: budget.spent(), after: budget.remaining() };
`,
      }),
      { budgetTotal: 1000 },
    );

    const result = state.result as { before: number; spent: number; after: number };
    expect(result.before).toBe(1000);
    expect(result.spent).toBeGreaterThan(0);
    expect(result.after).toBe(1000 - result.spent);
  });

  it("should report infinite remaining budget when no budget total is configured", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "no-budget", description: "Unbounded budget" },
        body: "return budget.remaining();",
      }),
    );

    expect(state.result).toBe(Number.POSITIVE_INFINITY);
  });

  it("should reject non-string prompts passed to agent()", async () => {
    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "bad-prompt", description: "Reject non-string prompt" },
          body: "return await agent(123);",
        }),
      ),
    ).rejects.toThrow(/requires a string prompt/);
  });

  it("should reject phase titles that are not non-empty strings", async () => {
    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "bad-phase", description: "Reject empty phase" },
          body: 'phase("");\nreturn null;',
        }),
      ),
    ).rejects.toThrow(/non-empty string/);
  });

  it("should rethrow a schema agent failure rather than swallowing it to null", async () => {
    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "schema-fail", description: "Schema failures must surface" },
          body: 'return await agent("structured", { label: "s", schema: { type: "object" } });',
        }),
        {
          schedulerRunner: async () => {
            throw new Error("agent died on schema task");
          },
        },
      ),
    ).rejects.toThrow(/agent died on schema task/);
  });

  it("should rethrow a non-schema failure tagged as a schema variant", async () => {
    class SchemaTagged extends Error {
      readonly variant = "schema";
    }

    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "schema-variant", description: "Schema-variant failures must surface" },
          body: 'return await agent("task", { label: "v" });',
        }),
        {
          schedulerRunner: async () => {
            throw new SchemaTagged("schema variant failure");
          },
        },
      ),
    ).rejects.toThrow(/schema variant failure/);
  });

  it("should report a string error message when a workflow rejects with a non-Error value", async () => {
    const result = await tryRunWorkflowScript(
      workflowScript({
        meta: { name: "string-throw", description: "Throw a string" },
        body: 'throw "plain string failure";',
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRuntimeError", message: "plain string failure" },
    });
  });

  it("should report a message from a thrown object that carries a message property", async () => {
    const result = await tryRunWorkflowScript(
      workflowScript({
        meta: { name: "object-throw", description: "Throw an object" },
        body: 'throw { message: "object message failure" };',
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { message: "object message failure" },
    });
  });

  it("should report a stringified message for a thrown object without a message", async () => {
    const result = await tryRunWorkflowScript(
      workflowScript({
        meta: { name: "weird-throw", description: "Throw a number" },
        body: "throw 42;",
      }),
    );

    expect(result).toMatchObject({
      status: "error",
      error: { message: "42" },
    });
  });

  it("should surface parse failures through tryRunWorkflowScript without partial state", async () => {
    const result = await tryRunWorkflowScript("return null;");

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowRuntimeError" },
    });
    expect((result as { error: { partialState?: unknown } }).error.partialState).toBeUndefined();
  });

  it("should allow new Date with arguments through an aliased constructor", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "aliased-date-ok", description: "Aliased Date with args is allowed" },
        body: "const D = Date;\nreturn new D(1700000000000).getTime();",
      }),
    );

    expect(state.result).toBe(1700000000000);
  });

  it("should construct a real date when the aliased Date is called without new", async () => {
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "aliased-date-call", description: "Aliased Date called as a function" },
        body: "const D = Date;\nreturn D(1700000000000).getTime();",
      }),
    );

    expect(state.result).toBe(1700000000000);
  });

  it("should block an aliased argument-less Date constructor at runtime", async () => {
    await expect(
      runWorkflowScript(
        workflowScript({
          meta: { name: "aliased-date-bad", description: "Aliased argument-less Date is blocked" },
          body: "const D = Date;\nreturn new D().getTime();",
        }),
      ),
    ).rejects.toThrow(/argument-less new Date/);
  });

  it("should expose stopAgent and isStopped on the runtime control", async () => {
    let control: (WorkflowRuntimeControl & { stopAgent(id: string): void }) | undefined;
    const state = await runWorkflowScript(
      workflowScript({
        meta: { name: "control-surface", description: "Exercise control surface" },
        body: 'return await agent("x");',
      }),
      {
        onControlReady: (runtimeControl) => {
          control = runtimeControl as WorkflowRuntimeControl & { stopAgent(id: string): void };
          control.stopAgent("nonexistent-agent");
        },
      },
    );

    expect(control?.isStopped()).toBe(false);
    expect(state.result).toBe("x");
  });
});

describe("parallel", () => {
  it("should reject a non-array thunks argument", async () => {
    await expect(parallel("not-an-array" as never)).rejects.toThrow(/requires an array of thunks/);
  });

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

  it("should reject more than 4096 thunks", async () => {
    const thunks = Array.from(
      { length: WORKFLOW_COLLECTION_ITEM_LIMIT + 1 },
      () => async () => null,
    );

    await expect(parallel(thunks)).rejects.toThrow(/at most 4096/);
  });
});

describe("pipeline", () => {
  it("should reject a non-array items argument", async () => {
    await expect(pipeline("nope" as never)).rejects.toThrow(/requires an array of items/);
  });

  it("should reject non-function pipeline stages", async () => {
    await expect(pipeline([1, 2], "not-a-stage" as never)).rejects.toThrow(
      /stages must be functions/,
    );
  });

  it("should seed the first stage previous value with the original item", async () => {
    const item = { name: "x" };
    const result = await pipeline([item], async (previous, originalItem) => [
      previous,
      originalItem,
    ]);

    expect(result).toEqual([[item, item]]);
  });

  it("should support first-stage shorthand callbacks that treat previous as the item", async () => {
    const result = await pipeline([{ name: "x" }], async (item) => (item as { name: string }).name);

    expect(result).toEqual(["x"]);
  });

  it("should pass previous result, original item, and index when item moves through multiple stages", async () => {
    const result = await pipeline(
      ["a", "b"],
      async (previous, _item, index) => `${previous}:${index}`,
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

  it("should reject more than 4096 items", async () => {
    const items = Array.from({ length: WORKFLOW_COLLECTION_ITEM_LIMIT + 1 }, (_, index) => index);

    await expect(pipeline(items, async (_previous, item) => item)).rejects.toThrow(/at most 4096/);
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

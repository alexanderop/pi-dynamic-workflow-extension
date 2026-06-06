import vm from "node:vm";
import { parseWorkflowScript } from "./parser.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { WorkflowAgentScheduler } from "#src/workflows/agent/scheduler.ts";
import type { AgentOptions } from "#src/workflows/agent/model.ts";
import type {
  WorkflowBudget,
  WorkflowRuntimeError,
  WorkflowRuntimeOptions,
  WorkflowRuntimeState,
} from "./model.ts";

export type {
  WorkflowRuntimeControl,
  WorkflowRuntimeError,
  WorkflowRuntimeOptions,
  WorkflowRuntimeState,
} from "./model.ts";

export const WORKFLOW_COLLECTION_ITEM_LIMIT = 4096;

export async function runWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<WorkflowRuntimeState> {
  const result = await executeWorkflowScript(source, options);
  if (result.status === "error") throw result.error.cause;
  return result.value;
}

async function executeWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<Result<WorkflowRuntimeState, WorkflowRuntimeError>> {
  const parsed = parseWorkflowScript(source);
  const phases: WorkflowRuntimeState["phases"] = [];
  const logs: string[] = [];
  const agentCalls: WorkflowRuntimeState["agentCalls"] = [];
  let spentTokens = 0;
  let emitStateChange = noop;
  const scheduler = new WorkflowAgentScheduler({
    maxConcurrent: options.maxConcurrentAgents,
    maxTotalAgents: options.maxTotalAgents,
    defaultModel: parsed.meta.model ?? options.defaultModel,
    cwd: options.cwd,
    journal: options.journal,
    replayCache: options.replayCache,
    onProgress: () => emitStateChange(),
    runner:
      options.schedulerRunner ??
      (async ({ prompt, options: agentOptions }) =>
        await (options.agentRunner ?? defaultAgentRunner)(prompt, agentOptions)),
  });

  options.onControlReady?.({
    pause: () => {
      scheduler.pause();
    },
    resume: () => {
      scheduler.resume();
    },
    stopRun: () => {
      scheduler.stopRun();
    },
    stopAgent: (agentId: string) => {
      scheduler.stopAgent(agentId);
    },
    isPaused: () => scheduler.isPaused(),
    isStopped: () => scheduler.isStopped(),
  });

  const budget: WorkflowBudget = {
    total: options.budgetTotal ?? null,
    spent: () => spentTokens,
    remaining: () =>
      budget.total === null ? Number.POSITIVE_INFINITY : Math.max(0, budget.total - spentTokens),
  };

  const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
    if (typeof prompt !== "string") throw new TypeError("agent(prompt) requires a string prompt.");
    if (budget.total !== null && spentTokens >= budget.total) {
      throw new Error("Workflow token budget exhausted; no further agent() calls are allowed.");
    }
    agentCalls.push({ prompt, options: agentOptions });
    const progressCountBeforeSchedule = scheduler.progress().length;
    try {
      const result = await scheduler.schedule(prompt, agentOptions);
      spentTokens += estimateTokens(prompt, result);
      return result;
    } catch (cause) {
      if (scheduler.progress().length === progressCountBeforeSchedule) throw cause;
      if (agentOptions.schema !== undefined || isSchemaAgentFailure(cause)) throw cause;
      spentTokens += estimateTokens(prompt, null);
      return null;
    }
  };

  const context = vm.createContext({
    args: options.args,
    budget,
    phase: (title: string) => {
      if (typeof title !== "string" || title.length === 0)
        throw new TypeError("phase(title) requires a non-empty string.");
      phases.push({ type: "workflow_phase", index: phases.length, title });
      emitStateChange();
    },
    log: (message: string) => {
      logs.push(String(message));
      emitStateChange();
    },
    agent,
    parallel,
    pipeline,
    Date: deterministicDate(),
    Math: deterministicMath(),
  });

  const currentState = (result?: unknown): WorkflowRuntimeState => ({
    meta: parsed.meta,
    phases,
    logs,
    agentCalls,
    workflowProgress: [...phases, ...scheduler.progress()],
    result,
    stopped: scheduler.isStopped(),
  });
  emitStateChange = () => options.onStateChange?.(currentState());

  try {
    const wrapped = `(async () => {\n${parsed.body}\n})()`;
    const script = new vm.Script(wrapped, { filename: "workflow.js" });
    return ok(currentState(await script.runInContext(context, { timeout: 1000 })));
  } catch (cause) {
    return err({
      _tag: "WorkflowRuntimeError",
      message: errorMessage(cause),
      cause,
      partialState: currentState(),
    });
  }
}

export async function tryRunWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<Result<WorkflowRuntimeState, WorkflowRuntimeError>> {
  try {
    return await executeWorkflowScript(source, options);
  } catch (cause) {
    return err({
      _tag: "WorkflowRuntimeError",
      message: errorMessage(cause),
      cause,
    });
  }
}

function noop(): void {}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (hasMessage(cause)) return cause.message;
  return String(cause);
}

function hasMessage(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function isSchemaAgentFailure(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "variant" in cause && cause.variant === "schema"
  );
}

export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  if (!Array.isArray(thunks)) throw new TypeError("parallel() requires an array of thunks.");
  assertCollectionItemLimit("parallel", thunks.length);
  for (const thunk of thunks) {
    if (typeof thunk !== "function")
      throw new TypeError("parallel() accepts only thunks: () => Promise<T>.");
  }

  return Promise.all(
    thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch {
        return null;
      }
    }),
  );
}

export async function pipeline<T>(
  items: T[],
  ...stages: Array<(previous: unknown, item: T, index: number) => Promise<unknown>>
): Promise<unknown[]> {
  if (!Array.isArray(items)) throw new TypeError("pipeline() requires an array of items.");
  assertCollectionItemLimit("pipeline", items.length);
  for (const stage of stages) {
    if (typeof stage !== "function") throw new TypeError("pipeline() stages must be functions.");
  }

  return Promise.all(
    items.map(async (item, index) => {
      let previous: unknown = item;
      for (const stage of stages) {
        try {
          previous = await stage(previous, item, index);
        } catch {
          return null;
        }
      }
      return previous;
    }),
  );
}

function assertCollectionItemLimit(name: "parallel" | "pipeline", length: number): void {
  if (length > WORKFLOW_COLLECTION_ITEM_LIMIT) {
    throw new TypeError(
      `${name}() accepts at most ${WORKFLOW_COLLECTION_ITEM_LIMIT} items, got ${length}.`,
    );
  }
}

async function defaultAgentRunner(prompt: string): Promise<string> {
  return prompt;
}

function estimateTokens(prompt: string, result: unknown): number {
  const resultText = typeof result === "string" ? result : JSON.stringify(result);
  return Math.ceil((prompt.length + (resultText?.length ?? 0)) / 4);
}

function deterministicMath(): Math {
  const deterministic = Object.create(null);
  for (const key of Reflect.ownKeys(Math)) {
    Object.defineProperty(deterministic, key, Object.getOwnPropertyDescriptor(Math, key)!);
  }
  Object.defineProperty(deterministic, "random", {
    value: () => {
      throw new Error("Workflow scripts must not call Math.random(); use stable indexes instead.");
    },
  });
  return deterministic;
}

function deterministicDate(): DateConstructor {
  const RealDate = Date;
  const DeterministicDate = function (this: Date, ...args: unknown[]) {
    if (args.length === 0) {
      throw new Error(
        "Workflow scripts must not call argument-less new Date(); pass timestamps through args instead.",
      );
    }
    return Reflect.construct(RealDate, args, new.target ?? RealDate);
  };

  Object.setPrototypeOf(DeterministicDate, RealDate);
  DeterministicDate.prototype = RealDate.prototype;
  Object.defineProperty(DeterministicDate, "now", {
    value: (): number => {
      throw new Error(
        "Workflow scripts must not call Date.now(); pass timestamps through args instead.",
      );
    },
  });

  return DeterministicDate as unknown as DateConstructor;
}

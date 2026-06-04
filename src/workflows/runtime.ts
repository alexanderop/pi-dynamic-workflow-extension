import vm from "node:vm";
import { parseWorkflowScript } from "./parser.ts";
import { err, ok, type Result } from "./result.ts";
import type { AgentOptions, WorkflowBudget, WorkflowRuntimeState } from "./types.ts";

export interface WorkflowRuntimeOptions {
  args?: unknown;
  budgetTotal?: number | null;
  agentRunner?: (prompt: string, options: AgentOptions) => Promise<unknown>;
}

export async function runWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<WorkflowRuntimeState> {
  const parsed = parseWorkflowScript(source);
  const phases: WorkflowRuntimeState["phases"] = [];
  const logs: string[] = [];
  const agentCalls: WorkflowRuntimeState["agentCalls"] = [];
  let spentTokens = 0;

  const budget: WorkflowBudget = {
    total: options.budgetTotal ?? null,
    spent: () => spentTokens,
    remaining: () =>
      budget.total === null ? Number.POSITIVE_INFINITY : Math.max(0, budget.total - spentTokens),
  };

  const agent = async (prompt: string, agentOptions: AgentOptions = {}) => {
    if (typeof prompt !== "string") throw new TypeError("agent(prompt) requires a string prompt.");
    agentCalls.push({ prompt, options: agentOptions });
    const result = await (options.agentRunner ?? defaultAgentRunner)(prompt, agentOptions);
    spentTokens += estimateTokens(prompt, result);
    return result;
  };

  const context = vm.createContext({
    args: options.args,
    budget,
    phase: (title: string) => {
      if (typeof title !== "string" || title.length === 0)
        throw new TypeError("phase(title) requires a non-empty string.");
      phases.push({ type: "workflow_phase", index: phases.length, title });
    },
    log: (message: string) => {
      logs.push(String(message));
    },
    agent,
    parallel,
    pipeline,
    Date: deterministicDate(),
    Math: deterministicMath(),
  });

  const wrapped = `(async () => {\n${parsed.body}\n})()`;
  const script = new vm.Script(wrapped, { filename: "workflow.js" });
  const result = await script.runInContext(context, { timeout: 1000 });

  return {
    meta: parsed.meta,
    phases,
    logs,
    agentCalls,
    result,
  };
}

export interface WorkflowRuntimeError {
  readonly _tag: "WorkflowRuntimeError";
  readonly message: string;
  readonly cause: unknown;
}

export async function tryRunWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<Result<WorkflowRuntimeState, WorkflowRuntimeError>> {
  try {
    return ok(await runWorkflowScript(source, options));
  } catch (cause) {
    return err({
      _tag: "WorkflowRuntimeError",
      message: errorMessage(cause),
      cause,
    });
  }
}

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

export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  if (!Array.isArray(thunks)) throw new TypeError("parallel() requires an array of thunks.");
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
  for (const stage of stages) {
    if (typeof stage !== "function") throw new TypeError("pipeline() stages must be functions.");
  }

  return Promise.all(
    items.map(async (item, index) => {
      let previous: unknown;
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

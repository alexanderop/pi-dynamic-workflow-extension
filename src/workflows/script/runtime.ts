// Runs a parsed workflow script inside a Node vm sandbox: assembles the
// script globals, executes the body with slice/deadline guards, and reports
// runtime state. The sandbox globals and determinism shims live in
// sandbox-globals.ts; meta parsing in parser.ts.
import vm from "node:vm";
import { parseWorkflowScript } from "./parser.ts";
import { errorMessage } from "#src/workflows/guards.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { WorkflowAgentScheduler } from "#src/workflows/agent/scheduler.ts";
import type { AgentOptions } from "#src/workflows/agent/model.ts";
import {
  DEFAULT_WORKFLOW_FEATURES,
  type WorkflowFeatureFlags,
} from "#src/workflows/features/registry.ts";
import {
  isNonDefaultModelHint,
  resolveDefaultModel,
  resolveEffectiveAgentOptions,
} from "#src/workflows/model-routing/agent-options.ts";
import type { WorkflowModelRoutingWarning } from "#src/workflows/model-routing/resolve.ts";
import {
  createParallel,
  createPipeline,
  deterministicDate,
  deterministicMath,
  type WorkflowBranchFailure,
} from "./sandbox-globals.ts";
import type {
  WorkflowBudget,
  WorkflowMeta,
  WorkflowRuntimeError,
  WorkflowRuntimeOptions,
  WorkflowRuntimeState,
} from "./model.ts";

export {
  WORKFLOW_COLLECTION_ITEM_LIMIT,
  createParallel,
  createPipeline,
} from "./sandbox-globals.ts";
export type { WorkflowBranchFailure, WorkflowBranchFailureReporter } from "./sandbox-globals.ts";
export type {
  WorkflowRuntimeControl,
  WorkflowRuntimeError,
  WorkflowRuntimeOptions,
  WorkflowRuntimeState,
} from "./model.ts";

/**
 * The globals injected into every workflow sandbox and advertised to script
 * authors. The sandbox context literal is typed against this list, so adding a
 * global without listing it here (or vice versa) fails compilation; the
 * published author types (`types/workflow.d.ts`) and the model-facing tool
 * description are checked against it by the globals contract test.
 */
export const WORKFLOW_SCRIPT_GLOBALS = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "args",
  "budget",
] as const;

type WorkflowScriptGlobal = (typeof WORKFLOW_SCRIPT_GLOBALS)[number];

/**
 * Bounds a single *synchronous* execution slice between awaits (e.g. a
 * `while (true) {}` loop with no await). This is NOT a total wall-clock limit:
 * an async `while (true) { await agent() }` loop yields the event loop on every
 * iteration, so the synchronous slice is tiny and this timer never fires. Total
 * run time is bounded separately by `deadlineMs` in {@link WorkflowRuntimeOptions}.
 */
export const WORKFLOW_SYNCHRONOUS_SLICE_TIMEOUT_MS = 1000;
export const DISABLED_MODEL_ROUTING_LOG_MESSAGE =
  "Workflow model hints are ignored because experimental-model-routing is disabled; using the current Pi model.";

export async function runWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<WorkflowRuntimeState> {
  const result = await executeWorkflowScript(source, options);
  if (result.status === "error") throw result.error.cause;
  return result.value;
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

async function executeWorkflowScript(
  source: string,
  options: WorkflowRuntimeOptions = {},
): Promise<Result<WorkflowRuntimeState, WorkflowRuntimeError>> {
  const parsed = parseWorkflowScript(source);
  const phases: WorkflowRuntimeState["phases"] = [];
  const logs: string[] = [];
  const agentCalls: WorkflowRuntimeState["agentCalls"] = [];
  // The scheduler and sandbox globals are constructed before the runtime state
  // serializer exists, so they close over this emitter; the real listener is
  // bound once `currentState` is defined below.
  const stateEmitter = createStateEmitter();
  const deadlineMs = options.deadlineMs;
  let deadlineExceeded = false;
  const routingWarnings: WorkflowModelRoutingWarning[] = [];
  const features = options.features ?? DEFAULT_WORKFLOW_FEATURES;
  let ignoredModelHintsLogged = false;
  const logIgnoredModelHintsOnce = () => {
    if (ignoredModelHintsLogged) return;
    ignoredModelHintsLogged = true;
    logs.push(DISABLED_MODEL_ROUTING_LOG_MESSAGE);
    stateEmitter.emit();
  };
  const scheduler = new WorkflowAgentScheduler({
    maxConcurrent: options.maxConcurrentAgents,
    maxTotalAgents: options.maxTotalAgents,
    defaultModel: resolveDefaultModel(parsed.meta, options, features),
    defaultThinkingLevel: parsed.meta.thinkingLevel ?? options.defaultThinkingLevel,
    cwd: options.cwd,
    journal: options.journal,
    replayCache: options.replayCache,
    onProgress: () => stateEmitter.emit(),
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

  if (features.experimentalModelRouting !== true && metaHasNonDefaultModelHint(parsed.meta)) {
    logIgnoredModelHintsOnce();
  }

  const budget = createBudget(options.budgetTotal);

  const agent = createAgentGlobal({
    scheduler,
    meta: parsed.meta,
    options,
    features,
    budget,
    routingWarnings,
    logs,
    agentCalls,
    emitStateChange: () => stateEmitter.emit(),
    logIgnoredModelHintsOnce,
    isDeadlineExceeded: () => deadlineExceeded,
    deadlineMs,
  });

  const reportBranchFailure =
    (name: "parallel" | "pipeline") =>
    ({ index, cause }: WorkflowBranchFailure) => {
      logs.push(`${name}[${index}] failed: ${errorMessage(cause)}`);
      stateEmitter.emit();
    };

  const scriptGlobals = {
    args: options.args,
    budget: budget.budget,
    phase: (title: string) => {
      if (typeof title !== "string" || title.length === 0)
        throw new TypeError("phase(title) requires a non-empty string.");
      phases.push({ type: "workflow_phase", index: phases.length, title });
      stateEmitter.emit();
    },
    log: (message: string) => {
      logs.push(String(message));
      stateEmitter.emit();
    },
    agent,
    parallel: createParallel(reportBranchFailure("parallel")),
    pipeline: createPipeline(reportBranchFailure("pipeline")),
  } satisfies Record<WorkflowScriptGlobal, unknown>;

  const context = createSandboxContext(scriptGlobals);

  const currentState = (result?: unknown): WorkflowRuntimeState => ({
    meta: parsed.meta,
    phases,
    logs,
    agentCalls,
    workflowProgress: mergeWorkflowProgress(phases, scheduler.progress()),
    result,
    stopped: scheduler.isStopped(),
  });
  stateEmitter.bind(() => options.onStateChange?.(currentState()));

  try {
    const wrapped = `(async () => {\n${parsed.body}\n})()`;
    const script = new vm.Script(wrapped, { filename: "workflow.js" });
    // The vm `timeout` only bounds the synchronous slice of the run (the IIFE
    // returns a Promise almost immediately), so it guards against `while (true) {}`
    // style sync busy-loops but not async loops. Total wall-clock is bounded by the
    // deadline race below, which also cancels in-flight agents via the scheduler.
    const bodyPromise = Promise.resolve(
      script.runInContext(context, { timeout: WORKFLOW_SYNCHRONOUS_SLICE_TIMEOUT_MS }),
    );
    const result = await runWithDeadline(bodyPromise, deadlineMs, () => {
      deadlineExceeded = true;
      scheduler.stopRun();
    });
    assertSerializableResult(result);
    return ok(currentState(result));
  } catch (cause) {
    return err({
      _tag: "WorkflowRuntimeError",
      message: errorMessage(cause),
      cause,
      partialState: currentState(),
    });
  }
}

interface StateEmitter {
  emit(): void;
  bind(listener: () => void): void;
}

function createStateEmitter(): StateEmitter {
  let listener: () => void = noop;
  return {
    emit: () => listener(),
    bind: (next) => {
      listener = next;
    },
  };
}

interface BudgetHandle {
  readonly budget: WorkflowBudget;
  addSpent(tokens: number): void;
  isExhausted(): boolean;
}

function createBudget(total: number | null | undefined): BudgetHandle {
  let spentTokens = 0;
  const budget: WorkflowBudget = {
    total: total ?? null,
    spent: () => spentTokens,
    remaining: () =>
      budget.total === null ? Number.POSITIVE_INFINITY : Math.max(0, budget.total - spentTokens),
  };
  return {
    budget,
    addSpent: (tokens) => {
      spentTokens += tokens;
    },
    isExhausted: () => budget.total !== null && spentTokens >= budget.total,
  };
}

interface AgentGlobalDeps {
  readonly scheduler: WorkflowAgentScheduler;
  readonly meta: WorkflowMeta;
  readonly options: WorkflowRuntimeOptions;
  readonly features: WorkflowFeatureFlags;
  readonly budget: BudgetHandle;
  readonly routingWarnings: WorkflowModelRoutingWarning[];
  readonly logs: string[];
  readonly agentCalls: WorkflowRuntimeState["agentCalls"];
  readonly emitStateChange: () => void;
  readonly logIgnoredModelHintsOnce: () => void;
  readonly isDeadlineExceeded: () => boolean;
  readonly deadlineMs: number | undefined;
}

function createAgentGlobal(deps: AgentGlobalDeps) {
  return async (prompt: string, agentOptions: AgentOptions = {}): Promise<unknown> => {
    if (typeof prompt !== "string") throw new TypeError("agent(prompt) requires a string prompt.");
    if (deps.isDeadlineExceeded()) {
      throw new Error(
        `Workflow exceeded its wall-clock deadline of ${deps.deadlineMs}ms; no further agent() calls are allowed.`,
      );
    }
    if (deps.budget.isExhausted()) {
      throw new Error("Workflow token budget exhausted; no further agent() calls are allowed.");
    }
    deps.agentCalls.push({ prompt, options: agentOptions });
    const effectiveOptions = resolveEffectiveAgentOptions(agentOptions, {
      meta: deps.meta,
      availableModels: deps.options.availableModels,
      currentModelReference: deps.options.defaultModel,
      currentThinkingLevel: deps.options.defaultThinkingLevel,
      previousWarnings: deps.routingWarnings,
      features: deps.features,
    });
    if (effectiveOptions.ignoredModelHint) deps.logIgnoredModelHintsOnce();
    deps.routingWarnings.push(...effectiveOptions.warnings);
    for (const warning of effectiveOptions.warnings) deps.logs.push(formatRoutingWarning(warning));
    const progressCountBeforeSchedule = deps.scheduler.progress().length;
    try {
      const result = await deps.scheduler.schedule(prompt, effectiveOptions.options);
      deps.budget.addSpent(
        resolveSpentTokens(deps.scheduler, progressCountBeforeSchedule, prompt, result),
      );
      return result;
    } catch (cause) {
      if (deps.scheduler.progress().length === progressCountBeforeSchedule) throw cause;
      if (effectiveOptions.options.schema !== undefined || isSchemaAgentFailure(cause)) throw cause;
      deps.budget.addSpent(
        resolveSpentTokens(deps.scheduler, progressCountBeforeSchedule, prompt, null),
      );
      return null;
    }
  };
}

function createSandboxContext(scriptGlobals: Record<WorkflowScriptGlobal, unknown>): vm.Context {
  return vm.createContext(
    {
      ...scriptGlobals,
      Date: deterministicDate(),
      Math: deterministicMath(),
    },
    {
      // Defense-in-depth, not a trust boundary: workflow scripts are plain JS and
      // never need runtime codegen, so disabling eval()/new Function()/wasm shrinks
      // the surface a malformed or hostile script can reach. The vm itself is not a
      // sandbox against a determined attacker; this only blocks accidental codegen.
      codeGeneration: { strings: false, wasm: false },
    },
  );
}

async function runWithDeadline<T>(
  run: Promise<T>,
  deadlineMs: number | undefined,
  onDeadline: () => void,
): Promise<T> {
  if (deadlineMs === undefined) return run;

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        onDeadline();
        reject(new Error(`Workflow exceeded its wall-clock deadline of ${deadlineMs}ms.`));
      }, deadlineMs);
      deadlineTimer.unref?.();
    });
    return await Promise.race([run, deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}

function metaHasNonDefaultModelHint(meta: {
  readonly model?: string;
  readonly phases?: readonly {
    readonly model?: string;
    readonly agents?: readonly { readonly model?: string }[];
  }[];
}): boolean {
  if (isNonDefaultModelHint(meta.model)) return true;
  return (
    meta.phases?.some(
      (phase) =>
        isNonDefaultModelHint(phase.model) ||
        phase.agents?.some((agent) => isNonDefaultModelHint(agent.model)) === true,
    ) === true
  );
}

function formatRoutingWarning(warning: WorkflowModelRoutingWarning): string {
  if (warning.kind === "model-fallback") {
    return `Workflow model hint '${warning.requested}' is unavailable; using '${warning.effective}'.`;
  }
  return `Workflow thinkingLevel hint '${warning.requested}' is unavailable; using '${warning.effective}'.`;
}

function mergeWorkflowProgress(
  phases: WorkflowRuntimeState["phases"],
  agents: Extract<WorkflowRuntimeState["workflowProgress"][number], { type: "workflow_agent" }>[],
): WorkflowRuntimeState["workflowProgress"] {
  const output: WorkflowRuntimeState["workflowProgress"] = [];
  const emittedAgents = new Set<number>();
  for (const phase of phases) {
    output.push(phase);
    for (const agent of agents) {
      if (agent.phaseTitle !== phase.title) continue;
      output.push(agent);
      emittedAgents.add(agent.index);
    }
  }
  for (const agent of agents) {
    if (!emittedAgents.has(agent.index)) output.push(agent);
  }
  return output;
}

function noop(): void {}

function isSchemaAgentFailure(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "variant" in cause && cause.variant === "schema"
  );
}

async function defaultAgentRunner(prompt: string): Promise<string> {
  return prompt;
}

/**
 * The workflow result is persisted as `output.json` and delivered in the task
 * notification, both via `JSON.stringify`, so probe with the same serializer to
 * fail fast on what would actually break downstream (circular references,
 * BigInt). The most common authoring mistake — returning a value that still
 * contains an unsettled Promise, e.g. `return { findings: parallel(...) }`
 * without `await` — would JSON-serialize silently as `{}`, so the replacer
 * rejects thenables and functions explicitly with a hint that names the fix.
 */
function assertSerializableResult(result: unknown): void {
  try {
    JSON.stringify(result, (_key, value: unknown) => {
      if (typeof value === "function" || isThenable(value)) {
        throw new TypeError("the result contains a function or unsettled Promise");
      }
      return value;
    });
  } catch (cause) {
    throw new Error(
      `Workflow result is not serializable (${errorMessage(cause)}); did you forget to await agent(), parallel(), or pipeline()?`,
      { cause },
    );
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function estimateTokens(prompt: string, result: unknown): number {
  const resultText = typeof result === "string" ? result : JSON.stringify(result);
  return Math.ceil((prompt.length + (resultText?.length ?? 0)) / 4);
}

/**
 * Charge the budget with the scheduler's real accumulated token total for this
 * agent when available (`progress()[progressIndex]?.tokens`, populated by Pi
 * usage_update events), falling back to the char-count estimate when no real
 * usage was observed.
 */
function resolveSpentTokens(
  scheduler: WorkflowAgentScheduler,
  progressIndex: number,
  prompt: string,
  result: unknown,
): number {
  const realTokens = scheduler.progress()[progressIndex]?.tokens;
  return typeof realTokens === "number" && realTokens > 0
    ? realTokens
    : estimateTokens(prompt, result);
}

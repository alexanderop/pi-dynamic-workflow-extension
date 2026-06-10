/**
 * Ambient globals available inside pi-dynamic-workflow-extension workflow scripts.
 *
 * Add this line to the top of a workflow script for editor IntelliSense:
 *
 *   /// <reference types="pi-dynamic-workflow-extension/workflow" />
 *
 * These globals are injected by the sandbox runtime; they are not importable.
 * The script body is plain JavaScript with top-level await. `Date.now()`,
 * `new Date()` (argument-less), `Math.random()`, and runtime code generation
 * (`eval`, `new Function`) are intentionally unavailable so runs stay
 * deterministic — pass timestamps through `args` and vary work by stable index.
 */

export {};

declare global {
  /** A plain JSON Schema describing structured subagent output. */
  interface WorkflowJsonSchema {
    type?: string | string[];
    properties?: Record<string, WorkflowJsonSchema>;
    items?: WorkflowJsonSchema | WorkflowJsonSchema[];
    required?: string[];
    additionalProperties?: boolean | WorkflowJsonSchema;
    enum?: unknown[];
    const?: unknown;
    description?: string;
    [key: string]: unknown;
  }

  interface WorkflowAgentOptions {
    /** Short label (2-5 words) shown in the live `/workflows` progress view. */
    label?: string;
    /** Override the current runtime phase grouping for this agent. */
    phase?: string;
    /**
     * Plain JSON Schema for structured output. When present, the subagent must
     * call `structured_output` and `agent()` resolves to the validated object.
     */
    schema?: WorkflowJsonSchema;
    /** Requested subagent role/type, passed through as prompt guidance. */
    agentType?: string;
    /**
     * Requested model hint. Ignored unless the experimental-model-routing
     * feature is enabled; otherwise the current Pi model is used.
     */
    model?: string;
    /** Requested reasoning effort for this agent. */
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    /**
     * Requested isolation mode. Accepted for forward compatibility but not yet
     * implemented; agents do not currently run in isolated worktrees.
     */
    isolation?: "worktree";
  }

  /** Token-budget tracker for the run. `total` is null when no budget is set. */
  interface WorkflowBudget {
    readonly total: number | null;
    spent(): number;
    remaining(): number;
  }

  /**
   * Spawn one isolated subagent. Without `options.schema` it resolves to the
   * subagent's final text; with `options.schema` it resolves to the validated
   * structured object (type it via the generic `T`).
   */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T>;

  /**
   * Run an array of `() => agent(...)` thunks concurrently (a barrier). Results
   * are returned in input order; a thunk that throws resolves to `null`.
   */
  function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;

  /**
   * Run each item through sequential stages while different items fan out (no
   * cross-item barrier). Each stage receives `(previous, originalItem, index)`;
   * for the first stage `previous === originalItem`. A stage that throws drops
   * that item to `null` and skips its remaining stages.
   */
  function pipeline<TItem>(
    items: TItem[],
    ...stages: Array<(previous: unknown, item: TItem, index: number) => unknown>
  ): Promise<unknown[]>;

  /** Mark the current phase. Used for grouping in the live progress view. */
  function phase(title: string): void;

  /** Append a workflow-level log line shown above the progress tree. */
  function log(message: unknown): void;

  /** Optional JSON value passed via the tool's `args` parameter (verbatim). */
  const args: unknown;

  /** Token-budget tracker for the run. */
  const budget: WorkflowBudget;
}

// Concurrency-capped agent scheduler with journal replay: queues agent() calls,
// caps how many run at once, and short-circuits repeated journal keys from the
// replay cache. The Pi-session runner lives in src/extension/agent/ (ADR 0010:
// the domain core stays Pi-SDK-free).
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { computeWorkflowAgentKey } from "#src/workflows/journal/key.ts";
import type {
  WorkflowAgentJournal,
  WorkflowJournalEvent,
  WorkflowJournalKey,
} from "#src/workflows/journal/model.ts";
import { isTerminalAgentState, transitionAgent } from "#src/workflows/run/state-machine.ts";
import type {
  AgentOptions,
  WorkflowAgentActivityState,
  WorkflowAgentActivitySummary,
  WorkflowAgentProgress,
} from "./model.ts";

export interface WorkflowAgentRunRequest {
  readonly agentId: string;
  readonly journalKey?: WorkflowJournalKey;
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: WorkflowAgentLiveEvent) => void;
}

export type WorkflowAgentLiveEvent =
  | { readonly type: "sidechain_starting"; readonly at: number }
  | {
      readonly type: "agent_event";
      readonly at: number;
      readonly eventType: string;
      readonly label: string;
      readonly activityState?: WorkflowAgentActivityState;
    }
  | {
      readonly type: "tool_start";
      readonly at: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly summary?: string;
    }
  | {
      readonly type: "tool_update";
      readonly at: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly summary?: string;
    }
  | {
      readonly type: "tool_end";
      readonly at: number;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly summary?: string;
      readonly isError: boolean;
    }
  | { readonly type: "message_update"; readonly at: number; readonly summary?: string }
  | {
      readonly type: "usage_update";
      readonly at: number;
      readonly tokens?: number;
      readonly toolCalls?: number;
    };

export type WorkflowAgentRunner = (request: WorkflowAgentRunRequest) => Promise<unknown>;

export interface WorkflowAgentReplayCache {
  has(key: WorkflowJournalKey): boolean;
  get(key: WorkflowJournalKey): unknown;
}

export interface WorkflowAgentSchedulerOptions {
  readonly maxConcurrent?: number;
  readonly maxTotalAgents?: number;
  readonly runner: WorkflowAgentRunner;
  readonly now?: () => number;
  readonly createAgentId?: () => string;
  readonly defaultAgentType?: string;
  readonly defaultModel?: string;
  readonly defaultThinkingLevel?: AgentOptions["thinkingLevel"];
  readonly cwd?: string;
  readonly journal?: WorkflowAgentJournal;
  readonly replayCache?: WorkflowAgentReplayCache;
  readonly onProgress?: (progress: WorkflowAgentProgress[]) => void;
}

/** AgentOptions after scheduler defaults have been applied. */
type ResolvedAgentOptions = AgentOptions & {
  readonly label: string;
  readonly agentType: string;
  readonly model: string;
};

/**
 * Journal event minus its `key`; #appendJournalEvent supplies the key after
 * the shared journal/key guard. The default type parameter distributes Omit
 * over each union member so discriminants survive.
 */
type WorkflowJournalEventInput<E = WorkflowJournalEvent> = E extends WorkflowJournalEvent
  ? Omit<E, "key">
  : never;

interface QueuedAgent {
  readonly progressIndex: number;
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly agentId: string;
  readonly journalKey?: WorkflowJournalKey;
  readonly abortController: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

export class WorkflowAgentScheduler {
  readonly #maxConcurrent: number;
  readonly #maxTotalAgents: number;
  readonly #runner: WorkflowAgentRunner;
  readonly #now: () => number;
  readonly #createAgentId: () => string;
  readonly #defaultAgentType: string;
  readonly #defaultModel: string;
  readonly #defaultThinkingLevel?: AgentOptions["thinkingLevel"];
  readonly #cwd: string;
  readonly #journal?: WorkflowAgentJournal;
  readonly #replayCache?: WorkflowAgentReplayCache;
  readonly #onProgress?: (progress: WorkflowAgentProgress[]) => void;
  readonly #queue: QueuedAgent[] = [];
  readonly #runningAgents = new Map<number, QueuedAgent>();
  readonly #stoppedAgents = new Set<number>();
  readonly #journalStarts = new Map<number, Promise<void>>();
  readonly #progress: WorkflowAgentProgress[] = [];
  #journalTail?: Promise<void>;
  #running = 0;
  #paused = false;
  #runStopped = false;

  constructor(options: WorkflowAgentSchedulerOptions) {
    this.#maxConcurrent = options.maxConcurrent ?? calculateDefaultMaxConcurrent();
    this.#maxTotalAgents = options.maxTotalAgents ?? 1000;
    this.#runner = options.runner;
    this.#now = options.now ?? Date.now;
    this.#createAgentId = options.createAgentId ?? randomAgentId;
    this.#defaultAgentType = options.defaultAgentType ?? "general-purpose";
    this.#defaultModel = options.defaultModel ?? "default";
    this.#defaultThinkingLevel = options.defaultThinkingLevel;
    this.#cwd = options.cwd ?? process.cwd();
    this.#journal = options.journal;
    this.#replayCache = options.replayCache;
    this.#onProgress = options.onProgress;

    if (!Number.isInteger(this.#maxConcurrent) || this.#maxConcurrent < 1) {
      throw new TypeError("WorkflowAgentScheduler maxConcurrent must be a positive integer.");
    }
    if (!Number.isInteger(this.#maxTotalAgents) || this.#maxTotalAgents < 1) {
      throw new TypeError("WorkflowAgentScheduler maxTotalAgents must be a positive integer.");
    }
  }

  schedule(prompt: string, options: AgentOptions = {}): Promise<unknown> {
    if (this.#progress.length >= this.#maxTotalAgents) {
      return Promise.reject(
        new Error(`Workflow agent total cap exceeded: maxTotalAgents=${this.#maxTotalAgents}.`),
      );
    }

    const progressIndex = this.#progress.length;
    const agentId = this.#createAgentId();
    const effectiveOptions = this.#resolveAgentOptions(options, progressIndex);
    const journalKey = this.#computeJournalKey(prompt, effectiveOptions);
    this.#enqueueProgressEntry(progressIndex, prompt, agentId, effectiveOptions);

    const replayed = this.#replayFromCache(progressIndex, journalKey);
    if (replayed !== undefined) return replayed;

    if (this.#runStopped) {
      this.#stop(progressIndex, "run-stopped", journalKey);
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      this.#queue.push({
        progressIndex,
        prompt,
        options: effectiveOptions,
        agentId,
        journalKey,
        abortController: new AbortController(),
        resolve,
        reject,
      });
      this.#drain();
    });
  }

  #resolveAgentOptions(options: AgentOptions, progressIndex: number): ResolvedAgentOptions {
    const label = options.label ?? `agent:${progressIndex}`;
    const agentType = options.agentType ?? this.#defaultAgentType;
    const model = options.model ?? this.#defaultModel;
    const thinkingLevel = options.thinkingLevel ?? this.#defaultThinkingLevel;
    return thinkingLevel === undefined
      ? { ...options, label, agentType, model }
      : { ...options, label, agentType, model, thinkingLevel };
  }

  #computeJournalKey(
    prompt: string,
    options: ResolvedAgentOptions,
  ): WorkflowJournalKey | undefined {
    if (this.#journal === undefined && this.#replayCache === undefined) return undefined;
    return computeWorkflowAgentKey({
      prompt,
      schema: options.schema,
      label: options.label,
      phase: options.phase,
      agentType: options.agentType,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      cwd: this.#cwd,
    });
  }

  #enqueueProgressEntry(
    progressIndex: number,
    prompt: string,
    agentId: string,
    options: ResolvedAgentOptions,
  ): void {
    this.#progress.push({
      type: "workflow_agent",
      index: progressIndex,
      label: options.label,
      agentId,
      agentType: options.agentType,
      model: options.model,
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      state: "queued",
      queuedAt: this.#now(),
      attempt: 1,
      phaseTitle: options.phase,
      promptPreview: prompt.slice(0, 160),
      prompt,
    });
    this.#emitProgress();
  }

  #replayFromCache(
    progressIndex: number,
    journalKey: WorkflowJournalKey | undefined,
  ): Promise<unknown> | undefined {
    if (journalKey === undefined || this.#replayCache?.has(journalKey) !== true) return undefined;
    const cachedResult = this.#replayCache.get(journalKey);
    this.#applyAgentEvent(progressIndex, { type: "agent_started", now: this.#now() });
    this.#applyAgentEvent(progressIndex, {
      type: "agent_succeeded",
      now: this.#now(),
      resultPreview: preview(cachedResult),
    });
    return Promise.resolve(cachedResult);
  }

  stopAgent(agentId: string): boolean {
    const progressIndex = this.#progress.findIndex((agent) => agent.agentId === agentId);
    if (progressIndex === -1 || isTerminalAgentState(this.#progress[progressIndex]!.state)) {
      return false;
    }

    const queuedIndex = this.#queue.findIndex((agent) => agent.progressIndex === progressIndex);
    if (queuedIndex !== -1) {
      const [queued] = this.#queue.splice(queuedIndex, 1);
      this.#stop(progressIndex, "agent-stopped", queued!.journalKey);
      queued!.resolve(null);
      return true;
    }

    const running = this.#runningAgents.get(progressIndex);
    if (running === undefined) return false;

    this.#stop(progressIndex, "agent-stopped", running.journalKey);
    running.abortController.abort();
    return true;
  }

  stopRun(): boolean {
    const queued = this.#queue.splice(0);
    const running = [...this.#runningAgents.values()];
    const pending = [...queued, ...running].filter(
      (agent) => !this.#stoppedAgents.has(agent.progressIndex),
    );

    if (pending.length === 0 && this.#runStopped) return false;
    this.#runStopped = true;
    this.#paused = true;

    // #stop() is idempotent and abort()/resolve(null) are safe to call once per
    // agent here, so no per-agent stopped guard is needed in these loops.
    for (const agent of running) {
      this.#stop(agent.progressIndex, "run-stopped", agent.journalKey);
      agent.abortController.abort();
    }

    for (const agent of queued) {
      this.#stop(agent.progressIndex, "run-stopped", agent.journalKey);
      agent.resolve(null);
    }

    return pending.length > 0;
  }

  isStopped(): boolean {
    return this.#runStopped;
  }

  pause(): boolean {
    if (this.#paused) return false;
    this.#paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.#paused) return false;
    this.#paused = false;
    this.#drain();
    return true;
  }

  isPaused(): boolean {
    return this.#paused;
  }

  progress(): WorkflowAgentProgress[] {
    return this.#progress.map((agent) => ({ ...agent }));
  }

  #drain(): void {
    if (this.#paused || this.#runStopped) return;

    while (this.#running < this.#maxConcurrent && this.#queue.length > 0) {
      const queued = this.#queue.shift()!;
      this.#start(queued);
    }
  }

  #start(queued: QueuedAgent): void {
    this.#running += 1;
    this.#runningAgents.set(queued.progressIndex, queued);
    this.#applyAgentEvent(queued.progressIndex, { type: "agent_started", now: this.#now() });
    void this.#run(queued);
  }

  async #run(queued: QueuedAgent): Promise<void> {
    const started =
      queued.journalKey === undefined ? undefined : this.#appendJournalStarted(queued);
    if (started !== undefined) this.#journalStarts.set(queued.progressIndex, started);
    try {
      const result = await this.#runner({
        agentId: queued.agentId,
        journalKey: queued.journalKey,
        prompt: queued.prompt,
        options: queued.options,
        signal: queued.abortController.signal,
        onEvent: (event) => {
          this.#applyLiveEvent(queued.progressIndex, event);
        },
      });
      if (!this.#stoppedAgents.has(queued.progressIndex)) {
        await started;
        if (queued.journalKey !== undefined) await this.#appendJournalResult(queued, result);
        this.#applyAgentEvent(queued.progressIndex, {
          type: "agent_succeeded",
          now: this.#now(),
          resultPreview: preview(result),
        });
        queued.resolve(result);
      }
    } catch (cause) {
      if (!this.#stoppedAgents.has(queued.progressIndex)) {
        await started;
        if (queued.journalKey !== undefined) await this.#appendJournalFailed(queued, cause);
        this.#applyAgentEvent(queued.progressIndex, {
          type: "agent_failed",
          now: this.#now(),
          resultPreview: errorPreview(cause),
        });
        queued.reject(cause);
      }
    } finally {
      if (this.#stoppedAgents.has(queued.progressIndex)) {
        queued.resolve(null);
      }
      this.#runningAgents.delete(queued.progressIndex);
      this.#running -= 1;
      this.#drain();
    }
  }

  #stop(progressIndex: number, reason?: string, journalKey?: WorkflowJournalKey): void {
    if (this.#stoppedAgents.has(progressIndex)) return;
    this.#stoppedAgents.add(progressIndex);
    this.#applyAgentEvent(progressIndex, { type: "agent_stopped", now: this.#now() });
    void this.#appendJournalStopped(this.#progress[progressIndex]!, journalKey, reason);
  }

  #appendJournalStarted(queued: QueuedAgent): Promise<void> {
    return this.#appendJournalEvent(queued.journalKey, {
      type: "started",
      agentId: queued.agentId,
    });
  }

  #appendJournalResult(queued: QueuedAgent, result: unknown): Promise<void> {
    return this.#appendJournalEvent(queued.journalKey, {
      type: "result",
      agentId: queued.agentId,
      result,
    });
  }

  async #appendJournalFailed(queued: QueuedAgent, cause: unknown): Promise<void> {
    try {
      await this.#appendJournalEvent(queued.journalKey, {
        type: "failed",
        agentId: queued.agentId,
        error: serializeError(cause),
      });
    } catch {
      // Preserve the original agent failure. Journal write failures for failed
      // agents should not mask the runner error that already explains the run.
    }
  }

  async #appendJournalStopped(
    agent: WorkflowAgentProgress,
    journalKey?: WorkflowJournalKey,
    reason?: string,
  ): Promise<void> {
    try {
      await this.#journalStarts.get(agent.index);
      await this.#appendJournalEvent(journalKey, {
        type: "stopped",
        agentId: agent.agentId,
        reason,
      });
    } catch {
      // Stopping should remain best-effort: cancellation must not hang because
      // an audit-trail write failed while the run is already being torn down.
    }
  }

  /** No-ops unless both a journal and the agent's journal key are configured. */
  #appendJournalEvent(
    journalKey: WorkflowJournalKey | undefined,
    event: WorkflowJournalEventInput,
  ): Promise<void> {
    const journal = this.#journal;
    if (journal === undefined || journalKey === undefined) return Promise.resolve();
    const entry: WorkflowJournalEvent = { ...event, key: journalKey };
    const write =
      this.#journalTail === undefined
        ? journal.append(entry)
        : this.#journalTail.then(() => journal.append(entry));
    this.#journalTail = write.catch(() => undefined);
    return write;
  }

  #applyLiveEvent(progressIndex: number, event: WorkflowAgentLiveEvent): void {
    const current = this.#progress[progressIndex];
    if (current === undefined || current.state !== "running") return;

    this.#progress[progressIndex] = patchLiveEvent(current, event);
    this.#emitProgress();
  }

  #applyAgentEvent(progressIndex: number, event: Parameters<typeof transitionAgent>[1]): void {
    const result = transitionAgent(this.#progress[progressIndex]!, event);
    if (result.status === "error") throw new Error(result.error.message);
    this.#progress[progressIndex] = result.value;
    this.#emitProgress();
  }

  #emitProgress(): void {
    this.#onProgress?.(this.progress());
  }
}

export function calculateDefaultMaxConcurrent(cpuCores = availableParallelism()): number {
  return Math.min(16, Math.max(1, cpuCores - 2));
}

function randomAgentId(): string {
  return `a${randomBytes(8).toString("hex")}`;
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").slice(0, 240);
}

function errorPreview(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function serializeError(cause: unknown): { message: string; name?: string; stack?: string } {
  if (cause instanceof Error) {
    return { message: cause.message, name: cause.name, stack: cause.stack };
  }
  return { message: String(cause) };
}

function patchLiveEvent(
  agent: WorkflowAgentProgress,
  event: WorkflowAgentLiveEvent,
): WorkflowAgentProgress {
  switch (event.type) {
    case "sidechain_starting":
      return patchActivity(agent, event, {
        activityState: "starting",
        lastEventType: event.type,
        lastEventLabel: "creating sidechain",
      });
    case "agent_event":
      return patchActivity(agent, event, {
        activityState: event.activityState ?? "waiting_for_model",
        lastEventType: event.eventType,
        lastEventLabel: event.label,
        turnCount: event.eventType === "turn_start" ? (agent.turnCount ?? 0) + 1 : agent.turnCount,
      });
    case "message_update":
      return patchActivity(agent, event, {
        activityState: "thinking",
        lastEventType: event.type,
        lastEventLabel: event.summary ?? "assistant message update",
        messageUpdateCount: (agent.messageUpdateCount ?? 0) + 1,
      });
    case "tool_start":
      return patchActivity(agent, event, {
        activityState: "using_tool",
        lastEventType: event.type,
        lastEventLabel: `using ${event.toolName}`,
        currentToolName: event.toolName,
        currentToolCallId: event.toolCallId,
        lastToolName: event.toolName,
        lastToolSummary: event.summary,
        toolCalls: (agent.toolCalls ?? 0) + 1,
      });
    case "tool_update":
      return patchActivity(agent, event, {
        activityState: "using_tool",
        lastEventType: event.type,
        lastEventLabel: `using ${event.toolName}`,
        currentToolName: event.toolName,
        currentToolCallId: event.toolCallId,
        lastToolName: event.toolName,
        lastToolSummary: event.summary ?? agent.lastToolSummary,
      });
    case "tool_end":
      return patchActivity(agent, event, {
        activityState: "waiting_for_model",
        lastEventType: event.type,
        lastEventLabel: event.isError ? `${event.toolName} failed` : `${event.toolName} finished`,
        currentToolName: undefined,
        currentToolCallId: undefined,
        lastToolName: event.toolName,
        lastToolSummary: event.summary ?? agent.lastToolSummary,
        recentActivity: appendRecentActivity(agent.recentActivity, {
          at: event.at,
          label: event.isError ? `${event.toolName} failed` : `${event.toolName} finished`,
          detail: event.summary,
          toolName: event.toolName,
          isError: event.isError,
        }),
      });
    case "usage_update":
      return patchActivity(agent, event, {
        lastEventType: event.type,
        lastEventLabel: "usage updated",
        tokens: event.tokens ?? agent.tokens,
        toolCalls: event.toolCalls ?? agent.toolCalls,
      });
  }
}

function patchActivity(
  agent: WorkflowAgentProgress,
  event: { readonly at: number },
  patch: Partial<WorkflowAgentProgress>,
): WorkflowAgentProgress {
  return {
    ...agent,
    ...patch,
    lastEventAt: event.at,
    lastProgressAt: event.at,
    observedLiveEvents: (agent.observedLiveEvents ?? 0) + 1,
    telemetryAvailable: true,
  };
}

function appendRecentActivity(
  current: WorkflowAgentActivitySummary[] | undefined,
  entry: WorkflowAgentActivitySummary,
): WorkflowAgentActivitySummary[] {
  return [...(current ?? []), entry].slice(-5);
}

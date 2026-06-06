import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { computeWorkflowAgentKey } from "#src/workflows/journal/key.ts";
import type { WorkflowAgentJournal, WorkflowJournalKey } from "#src/workflows/journal/model.ts";
import { transitionAgent } from "#src/workflows/run/state-machine.ts";
import type { AgentOptions, WorkflowAgentProgress } from "./model.ts";

export interface WorkflowAgentRunRequest {
  readonly agentId: string;
  readonly journalKey?: WorkflowJournalKey;
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly signal: AbortSignal;
}

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
  readonly cwd?: string;
  readonly journal?: WorkflowAgentJournal;
  readonly replayCache?: WorkflowAgentReplayCache;
}

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
  readonly #cwd: string;
  readonly #journal?: WorkflowAgentJournal;
  readonly #replayCache?: WorkflowAgentReplayCache;
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
    this.#cwd = options.cwd ?? process.cwd();
    this.#journal = options.journal;
    this.#replayCache = options.replayCache;

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
    const label = options.label ?? `agent:${progressIndex}`;
    const agentId = this.#createAgentId();
    const agentType = options.agentType ?? this.#defaultAgentType;
    const model = options.model ?? this.#defaultModel;
    const effectiveOptions: AgentOptions = { ...options, label, agentType, model };
    const journalKey =
      this.#journal === undefined && this.#replayCache === undefined
        ? undefined
        : computeWorkflowAgentKey({
            prompt,
            schema: effectiveOptions.schema,
            label,
            phase: effectiveOptions.phase,
            agentType,
            model,
            cwd: this.#cwd,
          });

    this.#progress.push({
      type: "workflow_agent",
      index: progressIndex,
      label,
      agentId,
      agentType,
      model,
      state: "queued",
      queuedAt: this.#now(),
      attempt: 1,
      phaseTitle: options.phase,
      promptPreview: prompt.slice(0, 160),
      prompt,
    });

    if (journalKey !== undefined && this.#replayCache?.has(journalKey) === true) {
      const cachedResult = this.#replayCache.get(journalKey);
      this.#applyAgentEvent(progressIndex, { type: "agent_started", now: this.#now() });
      this.#applyAgentEvent(progressIndex, {
        type: "agent_succeeded",
        now: this.#now(),
        resultPreview: preview(cachedResult),
      });
      return Promise.resolve(cachedResult);
    }

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

  stopAgent(agentId: string): boolean {
    const progressIndex = this.#progress.findIndex((agent) => agent.agentId === agentId);
    if (progressIndex === -1 || isTerminalAgent(this.#progress[progressIndex]!)) return false;

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

  async #appendJournalStarted(queued: QueuedAgent): Promise<void> {
    if (this.#journal === undefined || queued.journalKey === undefined) return;
    await this.#appendJournalEvent({
      type: "started",
      key: queued.journalKey,
      agentId: queued.agentId,
    });
  }

  async #appendJournalResult(queued: QueuedAgent, result: unknown): Promise<void> {
    if (this.#journal === undefined || queued.journalKey === undefined) return;
    await this.#appendJournalEvent({
      type: "result",
      key: queued.journalKey,
      agentId: queued.agentId,
      result,
    });
  }

  async #appendJournalFailed(queued: QueuedAgent, cause: unknown): Promise<void> {
    if (this.#journal === undefined || queued.journalKey === undefined) return;
    try {
      await this.#appendJournalEvent({
        type: "failed",
        key: queued.journalKey,
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
    if (this.#journal === undefined || journalKey === undefined) return;
    try {
      await this.#journalStarts.get(agent.index);
      await this.#appendJournalEvent({
        type: "stopped",
        key: journalKey,
        agentId: agent.agentId,
        reason,
      });
    } catch {
      // Stopping should remain best-effort: cancellation must not hang because
      // an audit-trail write failed while the run is already being torn down.
    }
  }

  #appendJournalEvent(event: Parameters<WorkflowAgentJournal["append"]>[0]): Promise<void> {
    if (this.#journal === undefined) return Promise.resolve();
    const write =
      this.#journalTail === undefined
        ? this.#journal.append(event)
        : this.#journalTail.then(() => this.#journal!.append(event));
    this.#journalTail = write.catch(() => undefined);
    return write;
  }

  #applyAgentEvent(progressIndex: number, event: Parameters<typeof transitionAgent>[1]): void {
    const result = transitionAgent(this.#progress[progressIndex]!, event);
    if (result.status === "error") throw new Error(result.error.message);
    this.#progress[progressIndex] = result.value;
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

function isTerminalAgent(agent: WorkflowAgentProgress): boolean {
  return agent.state === "done" || agent.state === "failed" || agent.state === "stopped";
}

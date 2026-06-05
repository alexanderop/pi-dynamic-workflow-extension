import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { computeWorkflowAgentKey } from "../journal/key.ts";
import type { WorkflowAgentJournal, WorkflowJournalKey } from "../journal/model.ts";
import { transitionAgent } from "../run/state-machine.ts";
import type { AgentOptions, WorkflowAgentProgress } from "./model.ts";

export interface WorkflowAgentRunRequest {
  readonly agentId: string;
  readonly journalKey?: WorkflowJournalKey;
  readonly prompt: string;
  readonly options: AgentOptions;
  readonly signal: AbortSignal;
}

export type WorkflowAgentRunner = (request: WorkflowAgentRunRequest) => Promise<unknown>;

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
  readonly #queue: QueuedAgent[] = [];
  readonly #runningAgents = new Map<number, QueuedAgent>();
  readonly #stoppedAgents = new Set<number>();
  readonly #progress: WorkflowAgentProgress[] = [];
  #running = 0;

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
      this.#journal === undefined
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
    });

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
      this.#stop(progressIndex);
      queued!.resolve(null);
      return true;
    }

    const running = this.#runningAgents.get(progressIndex);
    if (running === undefined) return false;

    this.#stop(progressIndex);
    running.abortController.abort();
    return true;
  }

  progress(): WorkflowAgentProgress[] {
    return this.#progress.map((agent) => ({ ...agent }));
  }

  #drain(): void {
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
    try {
      if (queued.journalKey !== undefined) await this.#appendJournalStarted(queued);
      const result = await this.#runner({
        agentId: queued.agentId,
        journalKey: queued.journalKey,
        prompt: queued.prompt,
        options: queued.options,
        signal: queued.abortController.signal,
      });
      if (!this.#stoppedAgents.has(queued.progressIndex)) {
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

  #stop(progressIndex: number): void {
    this.#stoppedAgents.add(progressIndex);
    this.#applyAgentEvent(progressIndex, { type: "agent_stopped", now: this.#now() });
  }

  async #appendJournalStarted(queued: QueuedAgent): Promise<void> {
    if (this.#journal === undefined || queued.journalKey === undefined) return;
    await this.#journal.append({
      type: "started",
      key: queued.journalKey,
      agentId: queued.agentId,
    });
  }

  async #appendJournalResult(queued: QueuedAgent, result: unknown): Promise<void> {
    if (this.#journal === undefined || queued.journalKey === undefined) return;
    await this.#journal.append({
      type: "result",
      key: queued.journalKey,
      agentId: queued.agentId,
      result,
    });
  }

  async #appendJournalFailed(queued: QueuedAgent, cause: unknown): Promise<void> {
    if (this.#journal === undefined || queued.journalKey === undefined) return;
    try {
      await this.#journal.append({
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

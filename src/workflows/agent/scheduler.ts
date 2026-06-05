import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { transitionAgent } from "../run/state-machine.ts";
import type { AgentOptions, WorkflowAgentProgress } from "./model.ts";

export interface WorkflowAgentRunRequest {
  readonly agentId: string;
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
}

interface QueuedAgent {
  readonly progressIndex: number;
  readonly prompt: string;
  readonly options: AgentOptions;
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
    this.#progress.push({
      type: "workflow_agent",
      index: progressIndex,
      label: options.label ?? `agent:${progressIndex}`,
      agentId: this.#createAgentId(),
      agentType: options.agentType ?? this.#defaultAgentType,
      model: options.model ?? this.#defaultModel,
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
        options,
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
      const result = await this.#runner({
        agentId: this.#progress[queued.progressIndex]!.agentId,
        prompt: queued.prompt,
        options: queued.options,
        signal: queued.abortController.signal,
      });
      if (!this.#stoppedAgents.has(queued.progressIndex)) {
        this.#applyAgentEvent(queued.progressIndex, {
          type: "agent_succeeded",
          now: this.#now(),
          resultPreview: preview(result),
        });
        queued.resolve(result);
      }
    } catch (cause) {
      if (!this.#stoppedAgents.has(queued.progressIndex)) {
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
  return randomBytes(8).toString("hex");
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").slice(0, 240);
}

function errorPreview(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function isTerminalAgent(agent: WorkflowAgentProgress): boolean {
  return agent.state === "done" || agent.state === "failed" || agent.state === "stopped";
}

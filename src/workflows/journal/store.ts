// Append-only JSONL persistence for the agent journal (the replay/resume
// source of truth). The run-manifest store is separate in src/workflows/run/store.ts.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "#src/workflows/guards.ts";
import type { WorkflowJournalEvent, WorkflowJournalKey } from "./model.ts";

export interface WorkflowJournalStoreOptions {
  readonly journalPath: string;
}

export class WorkflowJournalStore {
  readonly #journalPath: string;
  #dirEnsured: Promise<void> | undefined;

  constructor(options: WorkflowJournalStoreOptions) {
    this.#journalPath = options.journalPath;
  }

  get journalPath(): string {
    return this.#journalPath;
  }

  async append(event: WorkflowJournalEvent): Promise<void> {
    await this.#ensureDir();
    await appendFile(
      this.#journalPath,
      `${JSON.stringify(serializeJournalEvent(event))}\n`,
      "utf8",
    );
  }

  #ensureDir(): Promise<void> {
    // Memoize the promise (not a boolean) so concurrent first-appends share a
    // single mkdir instead of racing one each. recursive: true is idempotent,
    // so a retry after failure is safe.
    this.#dirEnsured ??= mkdir(dirname(this.#journalPath), { recursive: true })
      .then(() => undefined)
      .catch((cause) => {
        this.#dirEnsured = undefined;
        throw cause;
      });
    return this.#dirEnsured;
  }

  async readEvents(): Promise<WorkflowJournalEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.#journalPath, "utf8");
    } catch (cause) {
      if (isFileNotFoundError(cause)) return [];
      throw cause;
    }

    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseJournalLine(line, index + 1));
  }
}

export class WorkflowJournalResultCache {
  readonly #results: Map<WorkflowJournalKey, unknown>;

  constructor(results: Map<WorkflowJournalKey, unknown>) {
    this.#results = results;
  }

  has(key: WorkflowJournalKey): boolean {
    return this.#results.has(key);
  }

  get(key: WorkflowJournalKey): unknown {
    if (!this.#results.has(key)) return undefined;
    return structuredClone(this.#results.get(key));
  }

  entries(): Array<[WorkflowJournalKey, unknown]> {
    return Array.from(this.#results.entries(), ([key, value]) => [key, structuredClone(value)]);
  }
}

export function buildWorkflowJournalResultCache(
  events: Iterable<WorkflowJournalEvent>,
): WorkflowJournalResultCache {
  const cache = new Map<WorkflowJournalKey, unknown>();
  for (const event of events) {
    if (event.type === "result") cache.set(event.key, structuredClone(event.result));
    if (event.type === "invalidated") cache.delete(event.key);
  }
  return new WorkflowJournalResultCache(cache);
}

function parseJournalLine(line: string, lineNumber: number): WorkflowJournalEvent {
  const value: unknown = JSON.parse(line);
  if (isWorkflowJournalEvent(value)) return value;
  throw new Error(`Invalid workflow journal event at line ${lineNumber}.`);
}

function serializeJournalEvent(event: WorkflowJournalEvent): WorkflowJournalEvent {
  if (event.type !== "result" || event.result !== undefined) return event;
  return { ...event, result: null };
}

function isWorkflowJournalEvent(value: unknown): value is WorkflowJournalEvent {
  if (!isRecord(value) || typeof value.type !== "string" || !isJournalKey(value.key)) return false;
  if (value.type === "started") return typeof value.agentId === "string";
  if (value.type === "result") return typeof value.agentId === "string" && "result" in value;
  if (value.type === "failed") return typeof value.agentId === "string" && isRecord(value.error);
  if (value.type === "stopped") return typeof value.agentId === "string";
  if (value.type === "invalidated") {
    return (
      typeof value.previousAgentId === "string" &&
      value.reason === "restart-agent" &&
      typeof value.at === "number"
    );
  }
  return false;
}

function isJournalKey(value: unknown): value is WorkflowJournalKey {
  return typeof value === "string" && /^v2:[0-9a-f]{64}$/.test(value);
}

function isFileNotFoundError(cause: unknown): boolean {
  return isRecord(cause) && cause.code === "ENOENT";
}

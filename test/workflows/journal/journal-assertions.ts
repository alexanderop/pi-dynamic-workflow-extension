import { expect } from "vitest";
import type { WorkflowJournalEvent, WorkflowJournalKey } from "#src/workflows/journal/model.ts";
import {
  buildWorkflowJournalResultCache,
  WorkflowJournalStore,
} from "#src/workflows/journal/store.ts";

/**
 * Minimal agent identity the journal assertions can use to map a human-friendly
 * agent label back to the `agentId` recorded in the journal. The run manifest's
 * `workflowProgress` agent rows already carry both, so the scenario harness can
 * pass them straight through.
 */
export interface JournalAgentIdentity {
  readonly label: string;
  readonly agentId: string;
}

export interface WorkflowJournalAssertionsOptions {
  /**
   * Agent identities used to resolve a label to its `agentId`. When omitted,
   * label arguments are treated as raw `agentId` values.
   */
  readonly identities?: readonly JournalAgentIdentity[];
}

/**
 * Journal assertions grounded in the real JSONL journal model (ADR 0008):
 * append order matters, `started` precedes execution, `result` is written only
 * after successful validation, and replay uses the latest non-invalidated
 * result per journal key. The helper never assumes a single event pair per key,
 * so resume/retry/invalidation journals can be inspected too.
 */
export function workflowJournalAssertions(
  journalPath: string,
  options: WorkflowJournalAssertionsOptions = {},
): WorkflowJournalAssertions {
  return new WorkflowJournalAssertions(journalPath, options.identities ?? []);
}

export class WorkflowJournalAssertions {
  readonly #store: WorkflowJournalStore;
  readonly #journalPath: string;
  readonly #identities: readonly JournalAgentIdentity[];

  constructor(journalPath: string, identities: readonly JournalAgentIdentity[]) {
    this.#journalPath = journalPath;
    this.#store = new WorkflowJournalStore({ journalPath });
    this.#identities = identities;
  }

  async events(): Promise<WorkflowJournalEvent[]> {
    return this.#store.readEvents();
  }

  /** Assert the given event types appear, in order, as a subsequence. */
  async shouldHaveEvents(types: ReadonlyArray<WorkflowJournalEvent["type"]>): Promise<this> {
    const events = await this.events();
    let cursor = 0;
    for (const event of events) {
      if (cursor < types.length && event.type === types[cursor]) cursor += 1;
    }
    if (cursor !== types.length) {
      throw new Error(
        `Expected journal to contain ordered events ${JSON.stringify(types)}.\n${this.#describe(events)}`,
      );
    }
    return this;
  }

  /** Assert any `result` event matches `result`, regardless of agent. */
  async shouldHaveResult(result: unknown): Promise<this> {
    const events = await this.events();
    expect(
      events,
      `Expected a journal result equal to ${JSON.stringify(result)}.\n${this.#describe(events)}`,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ type: "result", result })]));
    return this;
  }

  /** Assert the most recent (cache-winning) result for an agent equals `result`. */
  async shouldHaveAgentResult(labelOrAgentId: string, result: unknown): Promise<this> {
    const events = await this.events();
    const key = this.#requireKey(labelOrAgentId, events);
    const actual = buildWorkflowJournalResultCache(events).get(key);
    expect(
      actual,
      `Expected latest result for '${labelOrAgentId}' to equal ${JSON.stringify(result)}.\n${this.#describe(events)}`,
    ).toEqual(result);
    return this;
  }

  /** Alias documenting that replay reads the latest non-invalidated result. */
  async shouldUseLatestNonInvalidatedResult(
    labelOrAgentId: string,
    result: unknown,
  ): Promise<this> {
    return this.shouldHaveAgentResult(labelOrAgentId, result);
  }

  /** Assert a `started` event precedes a `result` event for the same key. */
  async shouldLinkStartedAndResult(labelOrAgentId: string): Promise<this> {
    const events = await this.events();
    const key = this.#requireKey(labelOrAgentId, events);
    const startedAt = events.findIndex((event) => event.type === "started" && event.key === key);
    const resultAt = events.findIndex((event) => event.type === "result" && event.key === key);
    if (startedAt === -1 || resultAt === -1 || startedAt >= resultAt) {
      throw new Error(
        `Expected a 'started' event before a 'result' event for '${labelOrAgentId}'.\n${this.#describe(events)}`,
      );
    }
    return this;
  }

  /** Assert the journal has no `invalidated` (restart-agent) events. */
  async shouldNotHaveInvalidatedEvents(): Promise<this> {
    const events = await this.events();
    const invalidated = events.filter((event) => event.type === "invalidated");
    if (invalidated.length > 0) {
      throw new Error(
        `Expected no invalidated journal events, found ${invalidated.length}.\n${this.#describe(events)}`,
      );
    }
    return this;
  }

  #requireKey(labelOrAgentId: string, events: readonly WorkflowJournalEvent[]): WorkflowJournalKey {
    const agentId = this.#resolveAgentId(labelOrAgentId);
    const match = events.find((event) => eventAgentId(event) === agentId);
    if (match === undefined) {
      throw new Error(
        `No journal events found for '${labelOrAgentId}' (agentId '${agentId}').\n${this.#describe(events)}`,
      );
    }
    return match.key;
  }

  #resolveAgentId(labelOrAgentId: string): string {
    return (
      this.#identities.find((identity) => identity.label === labelOrAgentId)?.agentId ??
      labelOrAgentId
    );
  }

  #describe(events: readonly WorkflowJournalEvent[]): string {
    return `Journal path: ${this.#journalPath}\nParsed events: ${JSON.stringify(events, null, 2)}`;
  }
}

function eventAgentId(event: WorkflowJournalEvent): string {
  return event.type === "invalidated" ? event.previousAgentId : event.agentId;
}

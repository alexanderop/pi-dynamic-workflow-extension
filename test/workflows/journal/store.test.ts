import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowJournalKey } from "../../../src/workflows/journal/model.ts";
import {
  buildWorkflowJournalResultCache,
  WorkflowJournalStore,
} from "../../../src/workflows/journal/store.ts";

describe("WorkflowJournalStore", () => {
  let tempDir: string;
  let journalPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
    journalPath = join(tempDir, "wf_test", "journal.jsonl");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should append and read workflow journal events as JSONL", async () => {
    const key = journalKey("1".repeat(64));
    const store = new WorkflowJournalStore({ journalPath });

    await store.append({ type: "started", key, agentId: "a0000000000000000" });
    await store.append({ type: "result", key, agentId: "a0000000000000000", result: { ok: true } });

    await expect(store.readEvents()).resolves.toEqual([
      { type: "started", key, agentId: "a0000000000000000" },
      { type: "result", key, agentId: "a0000000000000000", result: { ok: true } },
    ]);
  });

  it("should preserve undefined result events as readable null results", async () => {
    const key = journalKey("2".repeat(64));
    const store = new WorkflowJournalStore({ journalPath });

    await store.append({ type: "result", key, agentId: "a0000000000000000", result: undefined });

    await expect(store.readEvents()).resolves.toEqual([
      { type: "result", key, agentId: "a0000000000000000", result: null },
    ]);
  });

  it("should read a missing journal as an empty event list", async () => {
    await expect(new WorkflowJournalStore({ journalPath }).readEvents()).resolves.toEqual([]);
  });
});

describe("buildWorkflowJournalResultCache", () => {
  it("should cache only result events and let the latest non-invalidated result win", () => {
    const completed = journalKey("1".repeat(64));
    const incomplete = journalKey("2".repeat(64));
    const restarted = journalKey("3".repeat(64));

    const cache = buildWorkflowJournalResultCache([
      { type: "started", key: completed, agentId: "a0000000000000000" },
      { type: "result", key: completed, agentId: "a0000000000000000", result: { value: 1 } },
      { type: "started", key: incomplete, agentId: "a1111111111111111" },
      { type: "started", key: completed, agentId: "a2222222222222222" },
      { type: "result", key: completed, agentId: "a2222222222222222", result: { value: 2 } },
      { type: "result", key: restarted, agentId: "a3333333333333333", result: "old" },
      {
        type: "invalidated",
        key: restarted,
        previousAgentId: "a3333333333333333",
        reason: "restart-agent",
        at: 123,
      },
    ]);

    expect(cache.get(completed)).toEqual({ value: 2 });
    expect(cache.has(incomplete)).toBe(false);
    expect(cache.has(restarted)).toBe(false);
  });

  it("should clone cached results so replay callers cannot mutate journal state", () => {
    const key = journalKey("4".repeat(64));
    const cache = buildWorkflowJournalResultCache([
      { type: "result", key, agentId: "a0000000000000000", result: { nested: { ok: true } } },
    ]);

    const result = cache.get(key) as { nested: { ok: boolean } };
    result.nested.ok = false;

    expect(cache.get(key)).toEqual({ nested: { ok: true } });
  });
});

function journalKey(hex: string): WorkflowJournalKey {
  return `v2:${hex}`;
}

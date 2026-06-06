import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowJournalKey } from "#src/workflows/journal/model.ts";
import {
  buildWorkflowJournalResultCache,
  WorkflowJournalStore,
} from "#src/workflows/journal/store.ts";

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

  it("should expose the configured journal path", () => {
    expect(new WorkflowJournalStore({ journalPath }).journalPath).toBe(journalPath);
  });

  it("should rethrow non-not-found read errors", async () => {
    const store = new WorkflowJournalStore({ journalPath: tempDir });
    await expect(store.readEvents()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("should read stopped and failed events and skip blank lines", async () => {
    const key = journalKey("5".repeat(64));
    const store = new WorkflowJournalStore({ journalPath });

    await store.append({ type: "stopped", key, agentId: "a0000000000000000", reason: "user" });
    await store.append({
      type: "failed",
      key,
      agentId: "a0000000000000000",
      error: { message: "boom" },
    });

    await expect(store.readEvents()).resolves.toEqual([
      { type: "stopped", key, agentId: "a0000000000000000", reason: "user" },
      { type: "failed", key, agentId: "a0000000000000000", error: { message: "boom" } },
    ]);
  });

  it("should throw on a journal line that is not a valid event", async () => {
    await mkdir(join(tempDir, "wf_test"), { recursive: true });
    await writeFile(journalPath, `${JSON.stringify({ type: "started", key: "not-a-key" })}\n`);

    await expect(new WorkflowJournalStore({ journalPath }).readEvents()).rejects.toThrow(
      /Invalid workflow journal event at line 1/,
    );
  });

  it("should reject events with an unknown type", async () => {
    await mkdir(join(tempDir, "wf_test"), { recursive: true });
    const key = journalKey("6".repeat(64));
    await writeFile(journalPath, `${JSON.stringify({ type: "mystery", key })}\n`);

    await expect(new WorkflowJournalStore({ journalPath }).readEvents()).rejects.toThrow(
      /Invalid workflow journal event/,
    );
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

  it("should return undefined when getting a key that is not cached", () => {
    const cache = buildWorkflowJournalResultCache([]);
    expect(cache.get(journalKey("7".repeat(64)))).toBeUndefined();
  });

  it("should expose cloned entries for all cached results", () => {
    const key = journalKey("8".repeat(64));
    const cache = buildWorkflowJournalResultCache([
      { type: "result", key, agentId: "a0000000000000000", result: { nested: { ok: true } } },
    ]);

    const entries = cache.entries();
    expect(entries).toEqual([[key, { nested: { ok: true } }]]);

    (entries[0]![1] as { nested: { ok: boolean } }).nested.ok = false;
    expect(cache.get(key)).toEqual({ nested: { ok: true } });
  });
});

function journalKey(hex: string): WorkflowJournalKey {
  return `v2:${hex}`;
}

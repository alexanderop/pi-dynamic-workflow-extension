// Copy-paste this whole file into https://www.typescriptlang.org/play
// Goal: understand the workflow resume cache idea in a tiny standalone example.
//
// Real implementation detail:
// - We use SHA-256 for the key.
// - This playground uses a tiny toy hash so it runs without Node imports.
//
// Main idea:
// - The workflow script is NOT snapshotted.
// - On resume, the script runs again from the top.
// - Every agent() call computes the same stable key from its effective inputs.
// - If journal.jsonl already has a result for that key, return it immediately.
// - If not, spawn the agent and append new journal events.

type JournalKey = `v2:${string}`;

type JournalEvent =
  | { type: "started"; key: JournalKey; agentId: string }
  | { type: "result"; key: JournalKey; agentId: string; result: unknown }
  | { type: "invalidated"; key: JournalKey; previousAgentId: string; reason: "restart-agent" };

type AgentOptions = {
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  schema?: unknown;
};

type EffectiveAgentCall = {
  keyVersion: "v2";
  prompt: string;
  schema: unknown;
  label: string;
  phase: string | null;
  agentType: string;
  model: string;
  cwd: string;
};

let nextAgentNumber = 1;

async function runWorkflow(journal: JournalEvent[], failOnceForLabel?: string) {
  // This is rebuilt on every run/resume by scanning journal.jsonl.
  const cache = buildCache(journal);

  const runtime = {
    cwd: "/repo",
    defaultAgentType: "general-purpose",
    defaultModel: "claude-opus-4-8",
    liveAgentCalls: 0,

    async agent(prompt: string, options: AgentOptions = {}) {
      const effective: EffectiveAgentCall = {
        keyVersion: "v2",
        prompt,
        schema: options.schema ?? null,
        label: options.label ?? `agent:${this.liveAgentCalls}`,
        phase: options.phase ?? null,
        agentType: options.agentType ?? this.defaultAgentType,
        model: options.model ?? this.defaultModel,
        cwd: this.cwd,
      };

      const key = stableKey(effective);

      // This is the resume magic.
      // Same effective call => same key => cached result can be reused.
      if (cache.has(key)) {
        console.log(`CACHE HIT  ${effective.label}`);
        return cache.get(key);
      }

      console.log(`CACHE MISS ${effective.label}`);

      const agentId = `a${String(nextAgentNumber++).padStart(4, "0")}`;
      journal.push({ type: "started", key, agentId });

      // Simulate an interrupted/crashed run after started but before result.
      if (failOnceForLabel === effective.label) {
        throw new Error(`crashed after starting ${effective.label}`);
      }

      this.liveAgentCalls += 1;
      const result = await fakeAgent(prompt, effective.label);

      // Only completed results are reusable on resume.
      journal.push({ type: "result", key, agentId, result });
      return result;
    },
  };

  // Pretend this is the user's workflow script.
  // On resume, this whole function runs again from the top.
  const review = await runtime.agent("review src", {
    label: "review:src",
    phase: "Review",
    schema: { type: "object" },
  });

  const verify = await runtime.agent("verify src", {
    label: "verify:src",
    phase: "Verify",
    schema: { type: "object" },
  });

  return { review, verify, liveAgentCalls: runtime.liveAgentCalls };
}

function buildCache(journal: JournalEvent[]) {
  const cache = new Map<JournalKey, unknown>();

  for (const event of journal) {
    if (event.type === "started") {
      // started means an attempt began, but it is NOT cacheable yet.
      continue;
    }

    if (event.type === "result") {
      // Latest result wins if duplicate keys exist.
      cache.set(event.key, structuredClone(event.result));
      continue;
    }

    if (event.type === "invalidated") {
      // restart-agent removes the old cached result.
      cache.delete(event.key);
    }
  }

  return cache;
}

async function fakeAgent(prompt: string, label: string) {
  await sleep(20);
  return { label, answer: `agent result for: ${prompt}` };
}

// Real code uses SHA-256. This is only a deterministic playground hash.
function stableKey(input: EffectiveAgentCall): JournalKey {
  const preimage = canonicalJson(input);
  return `v2:${toyHash64(preimage)}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, sortKeysDeep(inner)]),
    );
  }
  return value;
}

function toyHash64(text: string): string {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const shortHex = (hash >>> 0).toString(16).padStart(8, "0");
  return shortHex.repeat(8); // 64 hex chars, like SHA-256 width, but not secure.
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function demo() {
  const journal: JournalEvent[] = [];

  console.log("--- First run: crash during verify ---");
  try {
    await runWorkflow(journal, "verify:src");
  } catch (error) {
    console.log(String(error));
  }

  console.log("\nJournal after crashed run:");
  console.table(journal.map((e) => ({ type: e.type, key: e.key.slice(0, 12) + "...", agentId: "agentId" in e ? e.agentId : "" })));

  console.log("\n--- Resume: run same workflow again ---");
  const resumed = await runWorkflow(journal);
  console.log("Workflow result:", resumed);
  console.log("Live agent calls during resume:", resumed.liveAgentCalls);
  console.log("Notice: review was cached; only verify ran live.\n");

  console.log("Journal after resume:");
  console.table(journal.map((e) => ({ type: e.type, key: e.key.slice(0, 12) + "...", agentId: "agentId" in e ? e.agentId : "" })));
}

void demo();

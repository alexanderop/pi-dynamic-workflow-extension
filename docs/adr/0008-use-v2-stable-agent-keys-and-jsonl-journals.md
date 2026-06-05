# ADR 0008: Use V2 Stable Agent Keys And JSONL Journals

Status: accepted

## Context

`spec.md` now includes real Claude Code workflow artifacts from `~/.claude`. The
observed workflow resume cache is a per-run append-only `journal.jsonl`, not a
separate global cache directory. Journal rows use a stable `v2:<64 hex>` key and a
separate random `agentId`. Interrupted runs leave `started` rows without matching
`result` rows, and at least one completed run contains duplicate stable keys with
multiple attempts.

The exact Claude key preimage is not visible from the artifacts. We still need a
predictable implementation now so fake-agent runs can write audit history and the
future resume cache can be deterministic.

## Decision

Add a `journal` workflow domain module with:

- `WorkflowJournalEvent` models matching the observed JSONL event shape.
- `WorkflowJournalStore` for append-only `.pi/workflows/<runId>/journal.jsonl`.
- `computeWorkflowAgentKey()` that returns `v2:<sha256>`.

The key preimage is canonical JSON with sorted object keys and these fields:

- key version (`v2`)
- prompt
- schema, or `null` when absent
- effective label, including the scheduler default label
- phase, or `null` when absent
- effective agent type
- effective model
- project cwd

The scheduler writes `started` before invoking the agent runner, writes `result`
after a successful runner result and before resolving the `agent()` call, and
writes `failed` for runner failures.

Cache calculation is intentionally simple:

1. For every `agent(prompt, options)` call, normalize the effective call inputs.
   Defaults matter. For example, a missing label becomes `agent:<index>`, a
   missing schema becomes `null`, and a missing phase becomes `null`.
2. Serialize those inputs as canonical JSON. Canonical means object keys are
   sorted recursively, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same
   string.
3. Hash that canonical string with SHA-256.
4. Prefix the hex digest with `v2:`. That final string is the resume cache key.
5. Append the agent lifecycle event to `journal.jsonl` with that key and the
   random `agentId`.

Example, simplified:

```json
{
  "keyVersion": "v2",
  "prompt": "review src",
  "schema": { "type": "object" },
  "label": "review:src",
  "phase": "Review",
  "agentType": "general-purpose",
  "model": "claude-opus-4-8",
  "cwd": "/repo"
}
```

The canonical JSON for that object is hashed into a key such as:

```text
v2:8d6575facc11f2b35c3a5da58923ec83c1714f1808f6bf902f4f7caf63222991
```

On resume, we do not replay JavaScript state from a VM snapshot. Instead, we scan
`journal.jsonl` from top to bottom and build an in-memory map:

- `started` means "this attempt began" but does not add anything to the cache.
- `result` means "this key has a reusable result" and stores/replaces
  `cache[key]`.
- `invalidated` removes `cache[key]`.
- started-only attempts are incomplete and are ignored for cache hits.
- if multiple results exist for the same key, the latest non-invalidated result
  wins.

Then the workflow script runs again from the top. When it reaches an `agent()`
call, it calculates the key again. If `cache[key]` exists, the runtime returns
that stored result immediately instead of spawning a new agent. If no result is
cached, it runs a new agent and appends new journal events.

Resume flow:

```text
            existing run directory
                    │
                    ▼
        .pi/workflows/wf_123/journal.jsonl
                    │
                    ▼
          scan JSONL from top to bottom
                    │
                    ▼
        build cache: Map<journalKey, result>
                    │
                    ▼
          execute script again from top
                    │
                    ▼
             agent(prompt, options)
                    │
                    ▼
          normalize inputs + hash key
                    │
          ┌─────────┴─────────┐
          │                   │
          ▼                   ▼
   cache hit             cache miss
          │                   │
          ▼                   ▼
 return cached       append started,
 result immediately  run real/fake agent,
                     append result
```

Example with one completed call and one interrupted call:

```text
journal.jsonl before resume
───────────────────────────
1  started key=A agentId=a111
2  result  key=A agentId=a111 result={"ok":true}
3  started key=B agentId=a222

cache built from journal
────────────────────────
A ──▶ {"ok":true}
B ──▶ <missing>  (started-only, not cached)

script re-executes
──────────────────
agent call produces key A ──▶ cache hit  ──▶ return {"ok":true}
agent call produces key B ──▶ cache miss ──▶ spawn new agent
```

Example with duplicate keys and latest result winning:

```text
journal.jsonl before resume
───────────────────────────
1  started key=A agentId=a111
2  result  key=A agentId=a111 result="old"
3  started key=A agentId=a222
4  result  key=A agentId=a222 result="new"

cache built from journal
────────────────────────
A ──▶ "new"
```

Example with invalidation after restart-agent:

```text
journal.jsonl before resume
───────────────────────────
1  started     key=A agentId=a111
2  result      key=A agentId=a111 result="bad answer"
3  invalidated key=A previousAgentId=a111 reason=restart-agent

cache built from journal
────────────────────────
A ──▶ <missing>  (invalidated, must rerun)
```

The important idea: resume is just deterministic re-execution plus a journal
lookup at each `agent()` boundary. Everything before and after the `agent()` call
is recomputed by JavaScript; only completed agent results are reused.

## Consequences

- Fake workflow launches now leave the same kind of audit/cache trail observed in
  Claude Code artifacts.
- Agent ids remain random run artifacts; they are not cache keys.
- The exact hash does not claim byte-for-byte Claude compatibility, but the
  event contract and replay semantics match observed behavior.
- Because effective labels participate in the key, unlabeled calls use the
  scheduler's deterministic default label (`agent:<index>`). Workflow authors
  should still provide explicit labels when they expect stable resume behavior
  across edits.

---
created: 2026-06-04
implemented: false
---

# Workflow Correctness & Hardening Spec

## Status

Draft

## Summary

A multi-agent review of the workflow runtime (`src/workflow.ts`), the subagent
driver (`src/agent.ts`), the prompts (`src/prompts/*`), and the surrounding
infrastructure (`src/workflow-manager.ts`, `src/workflow-tool.ts`,
`src/workflow-library.ts`) found that the architecture is sound and largely
complete, but contains **three correctness bugs**, **two semantic divergences**
from the intended primitive contract, and a set of **feature gaps and
hardening issues**.

This spec catalogs every finding with evidence, severity, a proposed fix, and
the test that should accompany it. Findings are ordered by priority. The
highest-priority items (P0) silently corrupt the resume feature and lose work on
partial failure; they should be fixed before the runtime is relied on for
long-running, concurrent workflows.

## Non-goals

- This spec does not propose new authoring primitives (see
  `workflow-primitives-spec.md` for `artifact()`, `validateArgs()`, `retry()`,
  `withTimeout()`).
- It does not propose replacing `node:vm` with a true isolation boundary unless
  the threat model changes (see P3.1 for the explicit decision required).
- It does not change the public in-script API surface except where noted
  (`agent({ model })`, fault-isolation semantics), and those changes are
  backward-compatible.

## Severity legend

- **P0** — silent incorrectness in a shipped feature (resume, fan-out). Fix first.
- **P1** — divergence from intended contract; data loss or surprising behavior.
- **P2** — robustness / teardown / consistency issues.
- **P3** — security posture decision and feature gaps.

---

## P0.1 — Journal replay is non-deterministic under `pipeline()` and concurrent spawns

### Problem

The journal cache key is a **hash chain** threaded through a single mutable
global, `previousJournalKey`, computed synchronously at `agent()` call time:

```ts
// src/workflow.ts:522-523
const journalKey = computeWorkflowAgentKey(taskPrompt, previousJournalKey, normalizedOptions);
previousJournalKey = journalKey;
```

Each key incorporates the previous key (`computeWorkflowAgentKey`,
`src/workflow.ts:218`), so the chain is only stable if the **synchronous
`agent()` call order** is identical between the original run and the replay.

That holds for strictly sequential scripts and for `parallel()` thunks that call
`agent()` in their synchronous prefix. It does **not** hold for `pipeline()`
(`src/workflow.ts:631`) or for any thunk that `await`s before spawning an agent:

- **Live run:** `pipeline` stage 2 agents are invoked in the order stage 1
  results _resolve_ — i.e. real agent latency order.
- **Cached replay:** cached results resolve via `Promise.resolve` on the
  microtask queue — i.e. array index order.

Different synchronous call order → different chained keys → cache miss → the
`journalDiverged` latch flips (`src/workflow.ts:557`) → **the entire remaining
tail re-runs.** Resume is the flagship feature, and it silently degrades to "run
almost everything again" the moment a workflow uses concurrency.

### Evidence

- `src/workflow.ts:522-523` (synchronous chain mutation)
- `src/workflow.ts:631-645` (`pipeline` awaits between stages)
- `src/workflow.ts:622-629` (`parallel` synchronous-prefix assumption)
- `src/workflow.ts:525,557` (`journalDiverged` one-way latch)
- `tests/workflow-journal.test.ts` — **every** test is a strictly sequential
  script; no concurrent-spawn replay is covered, so this passes green.

### Proposed fix

Stop threading a single mutable chain through a concurrent call graph. Key each
agent by a **deterministic structural identity** instead of timing-dependent
call order. Options, in order of preference:

1. **Stable call-site + sibling index.** Derive each agent's key from its
   position in the static call structure: parent scope key + a monotonic
   per-scope child index assigned at the synchronous point where the
   `parallel`/`pipeline`/sequential call is _constructed_, not where the agent
   resolves. `parallel(thunks)` and `pipeline(items, ...stages)` know their
   item/stage indices up front — assign `(batchId, itemIndex, stageIndex)`
   deterministically before any `await`.
2. **Content-addressed keys (no chain).** Key purely on
   `hash(prompt + canonicalOptions)` plus a disambiguating occurrence counter
   for identical calls. Loses the "edit invalidates downstream" property, so
   pair it with an explicit dependency mechanism if that property is desired.

Recommended: option 1, because it preserves the "an upstream edit invalidates
everything structurally downstream" semantic that the current chain is trying to
express, without depending on resolution timing.

Whichever is chosen, `journalDiverged` should become **per structural branch**,
not a single global latch, so a miss in one `pipeline` item does not force every
other item and the rest of the workflow to re-run.

### Tests

- A `pipeline()` with ≥2 items and ≥2 stages, run twice against a shared
  journal, where stage 1 agents are made to resolve in **non-index order** on
  the first run (e.g. an injected agent whose latency depends on the item). The
  second run must reuse **all** cached results (`calls` count unchanged).
- A `parallel()` whose thunks `await` before calling `agent()`, replayed; assert
  full cache reuse.
- An "edit one item, keep the rest" test: changing one pipeline item's prompt
  must re-run only that item's chain, not sibling items.

---

## P0.2 — `parallel()` / `pipeline()` reject the whole batch on a single failure

### Problem

The intended contract (and the contract the prompt guidance encourages, e.g.
`.filter(Boolean)` after `parallel`) is **fault isolation**: a failing
`parallel` thunk resolves to `null`, and a `pipeline` stage that throws drops
that one item to `null` and skips its remaining stages. One bad item never kills
the batch.

The implementation uses bare `Promise.all`, which rejects on the first failure
and discards every sibling's result:

```ts
// src/workflow.ts:628 — parallel
return Promise.all(thunks.map(async (thunk) => await (thunk as () => Promise<unknown>)()));

// src/workflow.ts:636-644 — pipeline (no try/catch around stages)
return Promise.all(
  items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) value = await stage(value, item, index);
    return value;
  }),
);
```

Combined with P0.1's latch, one flaky agent in a 40-agent fan-out rejects the
batch, loses 39 good results, and poisons the journal tail.

### Evidence

- `src/workflow.ts:622-629` (`parallel`)
- `src/workflow.ts:631-645` (`pipeline`)
- Contrast with the documented `.filter(Boolean)` usage pattern, which only
  makes sense if failures become `null`.

### Proposed fix

- `parallel`: wrap each thunk so a rejection resolves to `null`:
  `thunks.map((t) => Promise.resolve().then(t).catch(() => null))`. Surface the
  error via `log()` / `onAgentEnd` (already done in the agent runner) so failures
  remain visible.
- `pipeline`: wrap each item's stage chain in `try/catch`; on throw, set the
  item's result to `null` and skip its remaining stages.
- Document the `null`-on-failure contract in `types/workflow.d.ts` and the
  workflow-tool prompt so authors know to filter.

### Open question

Should there be an opt-in strict mode (`parallel(thunks, { failFast: true })`)
for workflows that genuinely want all-or-nothing? Default must be fault-isolated.

### Tests

- `parallel` with one throwing thunk → result array has `null` at that index,
  other entries intact; the call itself resolves.
- `pipeline` where stage 1 throws for one item → that item is `null`, its later
  stages never run, sibling items complete.

---

## P0.3 — In-memory journal returns cached results by reference

### Problem

`createInMemoryWorkflowJournal.getResult` hands back the stored object directly
with no clone:

```ts
// src/workflow.ts:182
return results.has(key) ? { result: results.get(key) } : undefined;
```

If a workflow mutates a cached agent result, it corrupts the journal entry for
any later identical key, and diverges from `createFileWorkflowJournal`, which
round-trips through JSON and so always returns a fresh value
(`src/workflow.ts:198`).

### Evidence

- `src/workflow.ts:178-189` (in-memory journal)
- `src/workflow.ts:191-216` (file journal round-trips via JSON)

### Proposed fix

Clone on read (and ideally on write) in `createInMemoryWorkflowJournal` using
`structuredClone`, so both journal implementations have identical value
semantics. Also run agent results through `assertStructuredCloneable` (not only
`assertJsonSerializable`, `src/workflow.ts:589`) so null-prototype objects
behave identically between file and memory journals.

### Tests

- Store a result, get it, mutate the returned object, get again → second get is
  unaffected.
- A null-prototype agent result produces the same replay value from both the
  file and in-memory journals.

---

## P1.1 — Per-agent `model` is silently dropped

### Problem

`agent(prompt, { model })` is reduced to a prose hint
(`Requested model hint: ${model}`, `src/prompts/workflow-agent.ts:26`) and never
reaches `createAgentSession`, which _does_ accept a model. `AgentRunOptions`
(`src/agent.ts`) doesn't even have a `model` field, so per-agent model selection
is impossible — all subagents run on the session default.

### Evidence

- `src/prompts/workflow-agent.ts:26` (model → prose only)
- `src/workflow.ts:586` passes `schema` through `runOptions` but not `model`
- `src/agent.ts` — `AgentRunOptions` has no `model`; `run()` spreads only
  constructor-level `sessionOptions`.

### Proposed fix

Thread `model` through end to end: add `model?: string` to
`WorkflowAgentRunOptions` (`src/workflow.ts:49`), pass `normalizedOptions.model`
into `runOptions`, add it to `AgentRunOptions`, and map it into the per-run
`createAgentSession` call. Keep the prose hint only as a fallback for custom
agent runners that can't honor it.

### Tests

- A fake `WorkflowAgentLike` asserts it receives `options.model === "haiku"`
  when the script calls `agent(p, { model: "haiku" })`.

---

## P1.2 — Structured output is not forced; one soft repair turn only

### Problem

When a schema is passed, the model is _asked_ (via prompt contract) to call
`structured_output`, then given exactly one soft repair turn
(`src/agent.ts:50-66`), then the run hard-fails with
`structuredOutputMissingError`. There is no `tool_choice: required` forcing the
call. A stubborn model fails a run that a forced tool call would complete.

Mitigations already present: the underlying library TypeBox-validates the tool
args and the model loop implicitly retries on validation failure. But:

- With no/invalid schema the tool falls back to `Type.Any`
  (`src/structured-output.ts:22-25`), silently disabling validation.
- The implicit validation-retry loop is **unbounded** (no max-turns cap).

### Evidence

- `src/agent.ts:50-66` (single repair turn, no forced tool choice)
- `src/prompts/structured-output.ts:16-32` (prompt contract + repair prompt)
- `src/structured-output.ts:22-25` (`Type.Any` fallback)
- The provider supports `toolChoice` but it is never plumbed through.

### Proposed fix

1. Plumb `toolChoice` so that, on at least the repair turn (and ideally whenever
   a schema is present), the `structured_output` tool is **forced**.
2. Reject schemas that resolve to `Type.Any` when a schema was explicitly
   provided, or at minimum `log()` a warning so silent no-op validation is
   visible.
3. Add a max-turns / max-retries cap to the agent loop so a model that keeps
   emitting malformed args cannot loop until the global budget/timeout.

### Tests

- A fake model that never calls the tool on the first turn but would on a forced
  turn → run succeeds.
- A schema that resolves to `Type.Any` with an explicit schema arg → warning is
  logged (or run fails fast, per chosen policy).

---

## P2.1 — In-flight agents are not drained on timeout/abort

### Problem

`await Promise.allSettled([...pendingAgentRuns])` (`src/workflow.ts:698`) runs
only after the script body resolves normally. When
`raceWithAbortAndTimeout` rejects (`src/workflow.ts:694`), the drain at line 698
is skipped. Detached agents keep running and can `appendResult` to the journal
file **after** `runWorkflow` has already rejected — a post-return side effect
that can interleave with a subsequent run reading the same journal.

### Evidence

- `src/workflow.ts:694-698` (drain skipped on rejection path)
- `src/workflow.ts:561,591` (agents append to the journal independently)
- `src/workflow.ts:712-753` (`raceWithAbortAndTimeout`)

### Proposed fix

On abort/timeout, signal the in-flight agents (the runtime already holds
`options.signal`) and `await Promise.allSettled([...pendingAgentRuns])` in a
`finally` before `runWorkflow` returns or throws, so all journal writes are
flushed and ordered before teardown.

### Tests

- Start a workflow with a slow agent, trigger `timeoutMs`; assert no journal
  write occurs after `runWorkflow` rejects (observe via a wrapped journal).

---

## P2.2 — Limiter leaves aborted entries in its queue

### Problem

In `createLimiter` (`src/workflow.ts:956`), when a queued waiter is aborted it
rejects but its resolver closure is never removed from `queue`. A later
`next()` then `queue.shift()?.()` calls a dead resolver
(`src/workflow.ts:962`), consuming a wake slot that a live waiter should have
received. Benign during teardown, but a latent correctness smell.

### Evidence

- `src/workflow.ts:960-984` (`next` / queue), `src/workflow.ts:968-975`
  (abort path doesn't dequeue).

### Proposed fix

Track queue entries so the abort handler removes its own entry from `queue`, or
have `next()` skip resolvers already settled/aborted. Add the abort-while-queued
case to the limiter tests.

### Tests

- Saturate the limiter, queue several tasks, abort one queued task, then free
  slots; assert every remaining live task still runs exactly once.

---

## P2.3 — Failed agents force the whole tail to re-run on resume

### Problem

On agent failure the runtime appends a `started` record but never a `result`
record (`src/workflow.ts:599-611`), so on replay the failed agent re-runs —
intended. But because `journalDiverged` is a single global latch set at the
failed agent's spawn (`src/workflow.ts:557`), **every** agent after it re-runs
too, even ones that previously succeeded and were journaled. A single transient
failure at agent 10 of 20 re-runs agents 10–20.

This is largely subsumed by the P0.1 fix (per-branch divergence + structural
keys). Listed separately because it should be explicitly verified.

### Proposed fix

After P0.1, divergence is per structural branch, so a failed agent only forces
re-execution of its own dependents, not unrelated downstream agents. Confirm
with a test.

### Tests

- 5 sequential agents where agent 3 fails on run 1; on run 2 assert agents 1–2
  are reused and only 3+ (its dependents) re-run, not via a global latch.

---

## P3.1 — `node:vm` is not a security boundary (threat-model decision required)

### Problem

The sandbox uses `node:vm`, which shares the V8 isolate and host process with
the script. The hardening present (`forbidConstructorEscape`,
`codeGeneration.strings:false`, deterministic facades, AST checks) is a
blocklist against an open attack surface. Concrete escapes exist:

- Host-realm objects leak via errors/promises returned by injected functions:
  `caught.constructor.constructor("return process")()` reaches `process` and
  arbitrary code (`src/workflow.ts:565-620,628,636`).
- `forbidConstructorEscape` only shadows own `.constructor`; the prototype-chain
  constructor (`Object.getPrototypeOf(fn).constructor`) is untouched
  (`src/workflow.ts:166-176`).
- Determinism facades are bypassable: a real `Date`/`Math` is recoverable via
  intrinsics, and the AST check misses aliasing (`const d = Date; d.now()`),
  computed access, and destructuring (`src/workflow.ts:381-423`).

### Decision required

Establish the threat model explicitly:

- **If workflow scripts are authored by the assistant/user** (same trust level
  as any code the agent already runs via shell), then sandbox escape is not a
  new privilege, and these findings are **low security severity**. In that case:
  - Treat the AST/facade checks as a **determinism lint and UX guard**, not a
    security control, and document that clearly.
  - Prioritize the **determinism** angle (a non-deterministic script silently
    breaks replay — directly related to P0.1), not the RCE angle.
- **If workflow scripts can ever be untrusted third-party input**, the `vm`
  approach must be replaced with `isolated-vm` or an out-of-process sandbox with
  serialized RPC for `agent`/`log`/`artifact`/`phase`/`budget`, and no live host
  function may be exposed to the script.

### Proposed fix (regardless of model)

- Document the trust assumption at the top of `src/workflow.ts`.
- Strengthen determinism enforcement so non-deterministic scripts fail loudly
  (catch aliasing/destructuring at runtime via frozen facades, or detect at the
  journal layer when a replay diverges without a script edit).
- If untrusted authorship is in scope, open a separate spec for an
  `isolated-vm`/subprocess migration; do not attempt to patch `vm` into a
  boundary.

### Tests

- Determinism: `const d = Date; d.now()` and `const { random } = Math; random()`
  must fail (they currently fail only by luck of the facade thrower — make it
  intentional and tested).

---

## P3.2 — Feature gaps vs. the intended primitive set

### `workflow()` nesting — absent

There is no `workflow()` global; scripts cannot invoke another workflow inline
(`src/workflow.ts:663-679` exposes only `agent`, `parallel`, `pipeline`, `phase`,
`log`, `artifact`, `args`, `cwd`, `budget`, `process`, `console`). If nesting is
desired, add a `workflow(nameOrRef, args)` primitive that runs a child inline,
sharing the parent's limiter, agent counter, journal, abort signal, and token
budget, restricted to one level of nesting.

### `isolation: 'worktree'` — hint only

`isolation` flows into the journal key and the agent prompt as literal text
(`src/prompts/workflow-agent.ts:27`) but performs no `git worktree` setup. Agents
that mutate files in parallel share one `cwd` and will clobber each other. Either
implement real per-agent worktrees in the default agent runner
(`src/workflow.ts:755-766`) or remove the option and the hint until it is real,
so authors are not misled.

These are larger features; they should be scoped in their own specs once the P0
correctness work lands.

---

## Recommended implementation order

1. **P0.1** journal keying (structural identity, per-branch divergence) — the
   root cause; P2.3 falls out of it.
2. **P0.2** fault isolation in `parallel`/`pipeline`.
3. **P0.3** in-memory journal clone-on-read.
4. **P1.1** thread `model` end to end.
5. **P1.2** force structured output + cap retries.
6. **P2.1 / P2.2** teardown drain + limiter queue cleanup.
7. **P3.1** write down the threat model + determinism hardening.
8. **P3.2** scope `workflow()` and worktree isolation as follow-up specs.

Each P0/P1/P2 item must ship with the failing test described above written
first, so the regression that hid these (sequential-only journal tests,
all-or-nothing fan-out, reference aliasing) cannot recur.

## Compatibility

All P0–P2 fixes are backward-compatible for existing sequential workflows.
P0.2 changes observable behavior for failing fan-outs (rejection → `null`), which
is the intended contract; document it and update any workflow that relied on
fail-fast to opt in explicitly if `failFast` is added.

## Success criteria

- A concurrent (`pipeline`/`parallel`) workflow re-run against an unchanged
  journal reuses **100%** of cached agent results.
- A single failing agent in a fan-out yields a `null` for that item and does not
  drop sibling results or poison the journal tail.
- `agent({ model })` provably changes the subagent's model.
- A schema-bearing agent that initially answers in prose still produces validated
  structured output (forced tool call), and a malformed-args loop is bounded.
- No journal writes occur after `runWorkflow` settles on timeout/abort.
- The trust model for workflow scripts is documented, and determinism violations
  fail loudly rather than silently breaking replay.

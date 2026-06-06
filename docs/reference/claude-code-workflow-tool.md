# Claude Code `Workflow` tool — exact definition & how it was invoked

> **Why this doc exists.** This project reverse-engineers Claude Code's dynamic
> workflow feature so we can build the Pi-extension equivalent. The single most
> useful ground-truth artifact is the **actual `Workflow` tool definition** as it
> is presented to the orchestrating model. This file records that definition
> verbatim, plus a worked example of a real invocation, so our extension's DSL and
> runtime can be checked against the real contract instead of guesswork.
>
> Captured: 2026-06-06. Source: the `Workflow` tool schema + description exposed to
> the Claude Code agent in this session, and the concrete call made to review this
> repo.

---

## 1. Tool name

`Workflow`

## 2. Parameter schema (verbatim JSON Schema)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "maxLength": 524288,
      "description": "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase()."
    },
    "scriptPath": {
      "type": "string",
      "description": "Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`."
    },
    "name": {
      "type": "string",
      "description": "Name of a predefined workflow (built-in or from .claude/workflows/). Resolves to a self-contained script."
    },
    "resumeFromRunId": {
      "type": "string",
      "pattern": "^wf_[a-z0-9-]{6,}$",
      "description": "Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming."
    },
    "args": {
      "description": "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question)."
    },
    "title": {
      "type": "string",
      "description": "Ignored — set the workflow title in the script's `meta` block."
    },
    "description": {
      "type": "string",
      "description": "Ignored — set the workflow description in the script's `meta` block."
    }
  }
}
```

### Notes on the schema

- **No field is `required`.** The caller supplies **one of** `script`, `scriptPath`,
  or `name`. Precedence: `scriptPath` > `script` > `name`.
- `title` and `description` are accepted but **ignored**; the real values come from
  the script's `meta` block.
- `args` has **no `type`** — any JSON value passes through verbatim to the script's
  global `args`.
- `maxLength` on `script` is 524288 (512 KiB).

## 3. What the tool's long-form description specifies

The description attached to the tool is effectively the runtime manual. Key
contracts (paraphrased, but faithful to the source):

### Purpose & execution model

- Orchestrates many subagents **deterministically** — loops/conditionals/fan-out
  live in JavaScript, not in model judgement.
- Runs in the **background**: the call returns immediately with a task ID; a
  `<task-notification>` arrives on completion. `/workflows` shows live progress.
- **Opt-in gated.** The model may only call it when the user explicitly opted into
  multi-agent orchestration (e.g. the keyword `ultracode`, "use a workflow", an
  ultracode session, or a skill that instructs it). Otherwise it must use the
  single-agent `Agent` tool or ask first.

### `meta` block (mandatory, first statement)

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes', // one-line, shown in permission dialog
  phases: [                                          // one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix',  detail: 'one agent per flaky test' },
  ],
}
```

- Must be a **pure literal** — no variables, function calls, spreads, or template
  interpolation.
- Required: `name`, `description`. Optional: `whenToUse`, `phases`, and `model`.
- Phase titles in `meta.phases` are matched **exactly** against `phase()` calls.

### Script body hooks (the DSL)

| Hook | Signature | Semantics |
|------|-----------|-----------|
| `agent` | `agent(prompt: string, opts?): Promise<any>` | Spawn one subagent. Without `schema` returns final text (string). With `schema` (JSON Schema) it forces a `StructuredOutput` tool call and returns the validated object. Returns `null` if the user skips it or it dies after retries. Opts: `label`, `phase`, `schema`, `model`, `isolation: 'worktree'`, `agentType`. |
| `pipeline` | `pipeline(items, stage1, stage2, ...): Promise<any[]>` | Each item flows through all stages independently — **no barrier** between stages. Item A can be in stage 3 while item B is in stage 1. Stage callback gets `(prevResult, originalItem, index)`; for the first stage, `prevResult === originalItem`. A throwing stage drops that item to `null`. **This is the default for multi-stage work.** |
| `parallel` | `parallel(thunks: Array<() => Promise<any>>): Promise<any[]>` | Run thunks concurrently — **this is a barrier** (awaits all). A throwing thunk resolves to `null` (the call never rejects), so `.filter(Boolean)` before use. |
| `log` | `log(message: string): void` | Narrator progress line above the tree. |
| `phase` | `phase(title: string): void` | Start a new phase; later `agent()` calls group under it. |
| `workflow` | `workflow(nameOrRef, args?): Promise<any>` | Run another workflow inline (one level deep only). Shares concurrency cap, agent counter, abort signal, token budget. |

### Globals

- `args` — the value passed as the tool's `args` param, verbatim (`undefined` if not
  given).
- `budget` — `{ total: number|null, spent(): number, remaining(): number }`. The
  per-turn token target ("+500k"-style). `total` is `null` when unset; the target is
  a **hard ceiling** — once `spent()` reaches `total`, further `agent()` calls throw.

### Hard constraints

- Scripts are **plain JavaScript**, not TypeScript (no type annotations / interfaces
  / generics).
- The non-deterministic time/random helpers (`Date.now()`, `Math.random()`, argless
  `new Date()`) are **unavailable and throw** — they would break resume. Pass
  timestamps via `args`; vary randomness by index. *(Practical gotcha observed: the
  validator scans the script text for these literal substrings — even inside a prompt
  string — and rejects the call. Reword such mentions in prompts.)*
- No filesystem / Node.js API access.
- Concurrency cap per workflow: `min(16, cpuCores − 2)`; excess `agent()` calls
  queue.
- A single `parallel()` / `pipeline()` call accepts at most **4096 items**.
- Lifetime cap: **1000 agents** per workflow run (runaway backstop).

### Default-to-`pipeline()` guidance

A barrier (`parallel` between stages) is only justified when stage N genuinely needs
**all** of stage N−1's results at once (dedup/merge, zero-count early exit, "compare
against the other findings"). "I need to flatten/map/filter first" is **not** a
barrier reason — do it inside a pipeline stage.

### Resume

Relaunch with `Workflow({ scriptPath, resumeFromRunId })`. Completed `agent()` calls
with unchanged `(prompt, opts)` return cached results instantly; the first edited/new
call and everything after runs live. Same-session only; stop the prior run first.

---

## 4. The actual invocation made in this session

**Goal:** an in-depth quality review of this extension, cross-referencing the real
Pi source (cloned read-only at `/tmp/pi`) for every dimension.

**Params passed:** exactly one — `script` (a self-contained JS string). No `name`,
`scriptPath`, `args`, or `resumeFromRunId`.

> First attempt was **rejected** because the prompt text literally contained the
> substrings `Date.now` / `Math.random` (the deterministic-validator scans the whole
> script string). Reworded to "nondeterministic time/random helpers" and resubmitted
> the identical structure.

### Shape of the script

1. **`meta`** — `name: 'pi-workflow-extension-review'`, a one-line description, and
   three phases: `Review`, `Verify`, `Synthesize`.
2. **Constants & schemas** — `REPO` and `PI` paths; `FINDINGS_SCHEMA` (dimension
   summary + findings array, each with `severity` / `category` / `observation` /
   `piComparison` / `suggestion` / `confidence`) and `VERDICT_SCHEMA` (`isReal`,
   `piReferenceAccurate`, `finalSeverity`, `revisedSuggestion`, `critique`).
3. **`DIMENSIONS`** — 7 review targets (agent-spawning, script-runtime,
   launch-orchestration, run-persistence, tui-extension, ultracode-mode,
   view-projection), each prompt listing the exact extension files to read **and**
   the exact `/tmp/pi` source files to cross-reference, with the instruction to cite
   `path:line` for every pi claim.
4. **Orchestration body** — the canonical *pipeline → per-finding adversarial verify
   → synthesize* pattern:

```js
phase('Review')
const reviewed = await pipeline(
  DIMENSIONS,
  // stage 1: one reviewer per dimension, structured output
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  // stage 2: as soon as a dimension returns, fan out one skeptic per finding (no barrier across dimensions)
  (review, d) => parallel(
    review.findings.map((f) => () =>
      agent(verifyPrompt(f), { label: `verify:${d.key}:${f.id}`, phase: 'Verify', schema: VERDICT_SCHEMA })
        .then((v) => ({ finding: f, verdict: v })),
    ),
  ),
)

// keep only findings confirmed real AND not downgraded to "invalid"
const confirmed = /* flatten + filter(isReal && finalSeverity !== 'invalid') */
log(`Confirmed ${confirmed.length} findings across ${dims.length} dimensions`)

phase('Synthesize')
const report = await agent(synthesisPrompt(confirmed), { label: 'synthesize', phase: 'Synthesize' })

return { confirmedCount: confirmed.length, report }
```

**Why these hooks, in this order:**

- `pipeline` (not `parallel` between review and verify) so each dimension's findings
  start verifying the instant that dimension finishes — no wasted wall-clock waiting
  for the slowest reviewer.
- Inner `parallel` over a single dimension's findings is a legitimate barrier: we
  want that dimension's verified-findings bundle together before moving on.
- Each verifier re-opens **both** the extension file and the cited pi source, biased
  toward skepticism, so plausible-but-wrong findings (or fabricated pi citations)
  get dropped before synthesis.
- A single final `agent()` synthesizes only the survivors into the report.

### What the call returned

A background launch result containing: a **Task ID**, the **Run ID**
(`wf_…`, matching the `resumeFromRunId` pattern), a **transcript dir**, and the
**persisted script path** under the session directory — confirming the description's
claim that every invocation writes its script to disk for iteration/resume.

---

## 5. How this maps back to our extension

Cross-check our DSL/runtime against the real contract above:

- **DSL surface** (`src/workflows/script/`): we model `agent` / `parallel` /
  `pipeline` / `phase` / `log` / `budget` / nested `workflow`. Confirm the
  **no-barrier `pipeline` vs barrier `parallel`** semantics match §3.
- **`meta` as a pure literal** parsed statically — our acorn parser should reject
  computed `meta` the same way.
- **Determinism ban** on time/random — our runtime should forbid the same helpers
  (and note the substring-scan behaviour for parity, or deliberately diverge).
- **Caps**: `min(16, cores−2)` concurrency, 4096 items/call, 1000 agents/run.
- **`schema` → forced structured-output tool**: the real tool validates at the
  tool-call layer and retries; our `pi-runner` currently throws on `schema`
  (`src/workflows/agent/pi-runner.ts`) — this is the documented gap to close.
- **Persistence/resume**: real tool persists the script and caches unchanged
  `agent()` calls by `(prompt, opts)`; compare to our `journal/` + `saved/` design.

See also: [[spec.md]], `docs/learning/08-state-persistence-and-workflows-command.md`.

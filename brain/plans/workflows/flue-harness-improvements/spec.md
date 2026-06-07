---
title: Flue-Inspired Harness Improvements
status: proposed
priority: P5
last_audited: 2026-06-07
implementation: "Not implemented beyond the already-completed structured-output-retry sibling project."
next: "Pick independent W1-W6 slices after higher-priority monitor, live-feedback, and persistence gaps."
---

# Spec: Flue-Inspired Harness Improvements

## Status

Proposed on 2026-06-07.

This spec collects the agent-loop improvements we can port from
[`withastro/flue`](https://github.com/withastro/flue) into the Pi dynamic
workflow extension. It groups them as independently shippable workstreams (W1–W6)
so they can be picked up one at a time.

It is a sibling to, and follow-on from,
[[structured-output-retry]] — that project already ported Flue's
`finish`/`give_up` result-tool pattern. This spec captures everything else worth
taking.

## Why Flue is a direct reference

Flue is built on the **same substrate** as this extension —
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. So these are not
conceptual analogies; they are working implementations against the same APIs we
call. Adaptation cost is low.

Product shapes differ, which bounds what is worth taking:

- **Flue** — headless, deployable agent framework (HTTP/WebSocket, Cloudflare
  Durable Objects, Node, sandboxes). "Build and ship agents anywhere."
- **This extension** — Claude-Code-like dynamic workflows running in-process
  inside Pi's TUI.

The agent-loop internals transfer. The serving/deployment layer does not (see
Non-goals).

All Flue references below are pinned to commit
`b2d680314e53ff6f41352799441c0d2c82e803e8`.

## Goals

- Make schema-backed workflow agents recover from invalid output without
  spending a nudge.
- Make `budget` enforcement trustworthy by basing it on real provider usage.
- Reduce abort/dispose boilerplate and the risk of double-dispose.
- Improve failure diagnostics for given-up agents.
- Give long-running subagents a survival path when context overflows.
- Provide a skill-from-markdown prompt builder so workflow agents can run skills.

## Non-goals

- Do not adopt Flue's serving layer: `cloudflare/*`, `node/*` websocket,
  `runtime/*` HTTP app, dispatch queue, run/session Durable Object stores.
- Do not adopt Flue's `sandbox.ts` / virtual-sandbox / `just-bash`; workflow
  agents run in the user's Pi session, not an isolated sandbox.
- Do not adopt Flue's provider/MCP wiring (`mcp.ts`, `providers.ts`,
  `cloudflare-model.ts`); Pi already provides these.
- Do not switch the workflow schema surface to Valibot. Workflow schemas remain
  plain JSON Schema (see [[structured-output-retry]]). Where Flue uses
  `valibot.safeParse`, we use a JSON-Schema validation equivalent.
- Do not add live model tests.

---

## W1 — Corrective in-tool validation (highest leverage)

### Status: proposed

### Motivation

This completes the gap that [[structured-output-retry]] explicitly flagged but
did not close. That spec's Error Handling section states: *"Invalid tool
arguments should preferably surface to the model as a Pi tool error first."*
The current implementation does not do this.

### Current state

`createWorkflowStructuredOutputToolBundle(...)` in
`src/workflows/agent/structured-output-tool.ts` accepts whatever
pi-agent-core's tool-parameter JSON-Schema check lets through. Inside
`structured_output.execute` it only does `structuredClone(params)` and marks the
outcome `finished`. There is **no second validation pass** and **no corrective
feedback** for output that is structurally allowed but semantically wrong
(failed `minLength`, out-of-range numbers, bad enum values, unmet cross-field
constraints, or anything pi-agent-core does not enforce).

Consequence: the runner's two-nudge loop in `pi-runner.ts`
(`finishStructuredOutputAgent`) only handles the `pending` case — the model
never called the tool. It cannot handle "called the tool with invalid content."

### Flue reference

`packages/runtime/src/result.ts`:

- `finish.execute` runs `v.safeParse(schema, candidate)` (L199).
- On failure it builds a human-readable issue list and **throws** (L202-217):
  pi-agent-core encodes the throw as a tool-error tool-result, which the model
  sees on its next turn and self-corrects — **without consuming a runner nudge**.
- `formatIssuePath` (L279) renders issue locations like `items[2].name`.

### Proposed change

1. In `structured_output.execute`, after the existing pi-agent-core validation,
   run an explicit JSON-Schema validation of `params` against the workflow
   schema (envelope-unwrapped where applicable).
2. On validation failure, **throw** a `WorkflowAgentSchemaError`-derived message
   that:
   - names each failing path (port `formatIssuePath`'s shape);
   - states the expected constraint;
   - instructs the model to call `structured_output` again with a corrected
     payload.
   Do **not** set the outcome; leave it `pending` so a later valid call wins.
3. Only set `outcome = { type: "finished", value }` after validation passes.

Implementation note on the validator: we take plain JSON Schema, not Valibot.
Options, in order of preference:

- Reuse whatever JSON-Schema validation pi-agent-core already exposes, if it can
  be invoked on demand inside `execute` with a structured issue list.
- Otherwise add a small dependency-light JSON-Schema validator (or a focused
  subset covering the constraints we document as supported).

Decide the validator in a spike before implementing; record the decision in an
ADR if it adds a dependency.

### Interaction with the nudge loop

After W1, the two failure channels are distinct and complementary:

- **Invalid content** → tool-error throw → model self-corrects same turn, no
  nudge spent.
- **No tool call at all** (`pending`) → existing follow-up nudge (max two).

The `STRUCTURED_OUTPUT_NUDGE_LIMIT` policy is unchanged.

### Test plan

`test/workflows/agent/structured-output-tool.test.ts`:

- Valid object output → `finished`, value captured.
- Output that violates a refinement (e.g. `minLength`, enum) → `execute` throws
  with a message naming the path; outcome stays `pending`.
- A subsequent valid call after a throw → `finished`.
- Envelope schema: invalid inner value throws; valid inner value unwraps.

`test/workflows/agent/pi-runner.test.ts`:

- Model calls `structured_output` with invalid args, receives the tool error,
  retries with valid args in the same turn → agent succeeds with **no** nudge
  emitted.

### Acceptance

- A schema agent that submits invalid output recovers via the tool-error path
  without spending a nudge.
- Validation error messages name the failing field(s).
- Journal `result` events remain validation-safe: only validated values are
  cached.

---

## W2 — Real provider usage for `budget`

### Status: proposed

### Motivation

`budget.total` is documented to the model as a **hard ceiling**
(`src/extension/tools/workflow-tool.ts`), but the spend it is compared against is
a heuristic, not real usage.

### Current state

`src/workflows/script/runtime.ts` increments `spentTokens` via
`estimateTokens(prompt, result)` (L123, L128) — a string-length estimate. The
`budget` object exposes `spent()` / `remaining()` over this estimate (L96-101),
and `agent()` throws when `spentTokens >= budget.total` (L105).

### Flue reference

`packages/runtime/src/usage.ts`:

- `PromptUsage` shape (`types.ts:727`) — input / output / cacheRead / cacheWrite
  / totalTokens / nested `cost`.
- `emptyUsage()` (L15) — identity element.
- `addUsage(a, b)` (L30) — field-wise sum including cost.
- `fromProviderUsage(usage)` (L54) — normalize pi-ai's `Usage` into
  `PromptUsage`.

### Proposed change

1. Capture each subagent's real `Usage` from the Pi session (pi-ai surfaces it
   on assistant messages / turn end; see how `compaction.ts` reads
   `getAssistantUsage`).
2. Roll usage up through the scheduler so the workflow runtime sees a real
   `PromptUsage` per `agent()` call.
3. Feed real `totalTokens` into `spentTokens` instead of `estimateTokens`. Keep
   `estimateTokens` only as a fallback when a session reports no usage.
4. Optionally expose cost to workflow scripts later; out of scope for the first
   slice (budget enforcement is token-based).

### Test plan

- Fake Pi session reports a known `Usage`; `budget.spent()` reflects the real
  total, not the estimate.
- No-usage session falls back to the estimate.
- Budget ceiling still throws on the next `agent()` once real spend crosses
  `total`.

### Acceptance

- `budget.spent()` reflects real provider token usage when available.
- The hard ceiling is enforced against real usage.

---

## W3 — `CallHandle` abort/dispose abstraction

### Status: proposed

### Motivation

`runPiWorkflowAgent` in `pi-runner.ts` hand-rolls the abort wiring:
`addEventListener("abort", ...)`, manual `abort()`, `removeEventListener`,
`session.dispose()`, plus pre/post-abort checks in `promptOrThrowIfAborted`. The
"dispose exactly once on abort during retry" guarantee is currently asserted by
test rather than enforced by structure.

### Flue reference

`packages/runtime/src/abort.ts`:

- `abortErrorFor(signal)` (L6) — standard `AbortError` carrying the signal
  reason as `cause`.
- `createCallHandle(externalSignal, run)` (L29) — links an external signal to an
  internal `AbortController`, runs `run(controller.signal)`, and removes the
  listener in `finally`.

### Proposed change

1. Port `abort.ts` (both functions) into the extension, e.g.
   `src/workflows/agent/abort.ts`.
2. Refactor `runPiWorkflowAgent` to run the prompt/retry sequence inside a
   `createCallHandle`, so listener add/remove and single-dispose live in one
   place.
3. Replace ad-hoc `throw new Error("...aborted...")` with `abortErrorFor(signal)`
   for consistent `AbortError` semantics.

### Test plan

- Existing abort tests in `pi-runner.test.ts` continue to pass (abort before
  start, abort during retry disposes once).
- Aborting surfaces an `AbortError` whose `cause` is the signal reason.

### Acceptance

- Abort/dispose wiring is centralized; no behavior regression.

---

## W4 — `ResultUnavailableError` with transcript

### Status: proposed

### Motivation

When a schema agent gives up, `WorkflowAgentSchemaError` carries only a message.
Diagnosing *why* in `/workflows` is harder without the lead-up.

### Flue reference

`packages/runtime/src/result.ts`: `ResultUnavailableError` (L311) carries both
the model-supplied `reason` and the `assistantText` transcript preceding the
give-up.

### Proposed change

1. When the outcome is `gave_up`, build the failure with both the `reason` and
   the final assistant transcript (we already have
   `extractFinalAssistantText` / `lastAssistantText` in `pi-runner.ts`).
2. Either extend `WorkflowAgentSchemaError` with an optional `assistantText`
   field, or add a dedicated `WorkflowResultUnavailableError`. Prefer extending
   the existing error to avoid a new failure type in journal/handling code.
3. Surface the reason in `resultPreview` / failure detail per
   [[structured-output-retry]] §"Live progress behavior".

### Test plan

- `give_up` failure carries both reason and assistant transcript.
- Failure detail/`resultPreview` includes the reason.

### Acceptance

- Given-up agents report reason plus transcript in failure detail.

---

## W5 — Context compaction for long-running subagents

### Status: proposed (largest effort; highest capability gain)

### Motivation

The extension has **no context management**. A subagent that reads many files or
runs a long tool sequence will eventually exceed the model window and fail
outright. This is most acute on the ultracode / deep-workflow path, where agents
are intentionally long-lived.

### Flue reference

`packages/runtime/src/compaction.ts` (748 lines), built on pi-ai
(`completeSimple`, `isContextOverflow`):

- `CompactionSettings` (L26) and `deriveCompactionDefaults` (L51) — model-aware
  reserve/keep-recent headroom.
- `calculateContextTokens` (L76) / token estimation helpers.
- `shouldCompact` (L180) — threshold trigger.
- `prepareCompaction` (L519) — pure cut-point selection + message extraction +
  file-op tracking (preserves exact file paths / function names / error
  messages).
- `compact` (L666) — orchestrates summary generation and message replacement.
- Two trigger modes: **threshold** (proactive, no retry) and **overflow**
  (reactive on `isContextOverflow`, then auto-retry).

### Proposed change

Port compaction in slices, behind a feature flag (default off initially):

1. **Spike** — confirm pi-coding-agent's `createAgentSession` exposes the
   message list and usage in a form `prepareCompaction` can consume, and that we
   can replace history mid-session. If the session API does not allow history
   rewrite, document the constraint and stop here.
2. **Threshold compaction** — port `deriveCompactionDefaults`, `shouldCompact`,
   `prepareCompaction`, and a summary generator; trigger before a prompt when
   tokens exceed `contextWindow - reserveTokens`.
3. **Overflow compaction** — detect `isContextOverflow` from a failed prompt,
   compact, then auto-retry once.
4. **Observability** — emit a live event when compaction runs so `/workflows`
   explains the pause.

Gate behind a feature flag (see [[feature-flags]]), e.g.
`experimental-compaction`, default off until validated.

### Test plan

- `shouldCompact` returns true past threshold, false below (pure-function
  tests).
- `prepareCompaction` selects a valid cut point and preserves file-op summaries.
- Fake session: threshold path compacts before prompt; overflow path compacts
  then retries.
- A live compaction event is emitted.

### Acceptance

- A subagent that would overflow instead compacts and continues (flag on).
- Compaction is observable in `/workflows`.
- Default behavior is unchanged while the flag is off.

---

## W6 — Skill-from-markdown prompt builder

### Status: proposed

### Motivation

The repo ships a skill (`skills/workflow-debugger/SKILL.md`) and declares
`pi.skills` in `package.json`, but workflow agents have no builder to turn a
skill into a subagent prompt with lazily-referenced resources.

### Flue reference

`packages/runtime/src/result.ts` and `skill-frontmatter.ts`:

- `parseSkillMarkdown(raw, { directoryName, path })` — frontmatter + body parse.
- `buildWorkspaceSkillPrompt(name, directory, skillMdPath, raw)` — builds a
  `Run the skill named "…"` prompt with `<skill_instructions>` and a
  `<skill_resources>` block instructing the agent to read only the files it
  needs (lazy load).
- `buildPackagedSkillPrompt(...)` — same for packaged skills.

### Proposed change

1. Port `parseSkillMarkdown` and `buildWorkspaceSkillPrompt` (workspace variant
   only; packaged-skill base64 directory format is out of scope unless we adopt
   packaged skills).
2. Add an optional `agent(prompt, { skill })` path, or a `skill(name, args?)`
   workflow global, that resolves a workspace skill and prompts the subagent
   with the built skill prompt.
3. Compose with W1: when a skill run also requests structured output, append the
   result footer after the skill instructions (Flue does this via the `schema`
   arg to its skill-prompt builders).

This workstream is the loosest fit and lowest priority; sequence it last.

### Test plan

- `parseSkillMarkdown` extracts frontmatter and body from
  `skills/workflow-debugger/SKILL.md`.
- Built prompt contains skill body and a resources block.
- Skill + schema run appends the structured-output footer.

### Acceptance

- A workflow can run a workspace skill in a subagent via a built skill prompt.

---

## Sequencing

| Order | Workstream | Effort | Value | Notes |
|---|---|---|---|---|
| 1 | W1 corrective validation | small | high | completes structured-output-retry's open gap |
| 2 | W3 CallHandle | small | medium | de-risks abort/dispose; quick |
| 3 | W4 give-up transcript | tiny | medium | diagnostics; pairs with W1 |
| 4 | W2 real usage | small/med | medium | makes `budget` ceiling trustworthy |
| 5 | W5 compaction | large | high | biggest capability gain; flag-gated |
| 6 | W6 skill prompts | medium | low/med | loosest fit; last |

## Cross-cutting requirements

- Keep all changes Pi-native (custom tools, in-session prompts) per
  [[structured-output-retry]].
- New experimental capabilities ship behind [[feature-flags]], default off.
- Update [[spec-coverage]] and [[plans/index]] when any workstream lands.
- Record an ADR for: W1's validator choice (if it adds a dependency), W5's
  compaction trigger policy, and any new public workflow global (W6 `skill()`).
- No live model tests (fake Pi sessions only).

## Open questions

- W1: reuse pi-agent-core's validator or add a JSON-Schema validator dependency?
  Resolve in the W1 spike.
- W2: does the Pi session surface per-turn `Usage` for sidechain subagents the
  same way `compaction.ts` reads it for the main session? Confirm before
  building.
- W5: does `createAgentSession` permit mid-session history replacement? If not,
  compaction may be infeasible without upstream Pi support — the W5 spike gates
  the rest.
- W5: threshold-only first, or threshold + overflow together? Recommendation:
  ship threshold first, overflow second.

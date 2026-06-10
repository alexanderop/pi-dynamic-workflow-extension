---
title: Codebase Readability Review
status: implemented
priority: P2
last_audited: 2026-06-10
implementation: "All five themes landed (Theme 2 → 1 → 3 → 4 → 5); every checkbox above is checked and pnpm run verify is green (536 tests / 62 files). ADR 0019 records the launcher split."
next: "Nothing planned; treat remaining Theme 5 camp-site items as done. Reopen only if a future review finds new god files."
---

# Codebase Readability Review — 2026-06-09

A review of `src/` focused on **reading cost**: what makes it hard to orient in,
navigate, and trust the code. Produced by two refactoring reviews (one over the
`src/workflows` domain core, one over `src/extension`) plus a navigation survey.

Every suggestion here is **behavior-preserving** — moves, extractions, and
renames. The existing Vitest suite is the safety net; run `pnpm run verify`
after each step.

## The headline

The micro level is already good: small pure helpers, `Result`-based errors,
options objects everywhere, intent-revealing "why" comments. The reading cost
is concentrated at the **macro level**:

1. Three god files bundle many concerns each (Theme 1).
2. Small helpers are copy-pasted across modules, forcing readers to diff them
   (Theme 2).
3. Union-type guards are hand-maintained and can drift from the types (Theme 3).
4. `src/` is silent about its own structure — no module says what it owns
   (Theme 4).
5. Assorted local cleanups, fix opportunistically (Theme 5).

Suggested order: **Theme 2 → Theme 1 → Theme 3 → Theme 4 → Theme 5**.
Theme 2 first because it is mechanical, zero-risk, and Theme 1's file splits
get cleaner once shared helpers have a real home.

---

## Theme 1 — Split the three god files

**Why this matters:** a file that owns many concerns taxes every reader, every
time. To answer one question ("where does a run become `failed`?") you scan
hundreds of unrelated lines. The fix is *not* rewriting anything — all three
files already have clean internal seams (free functions with explicit
parameters); only the file boundary is missing. Splitting them is mostly
cut-and-paste plus import updates.

### 1.1 `src/workflows/launch/launcher.ts` (748 lines, six concerns)

- [x] Current contents and where they should go:

| Lines (approx) | Concern | New home |
|---|---|---|
| 273–340 | Source selection/validation (`selectLaunchSource`, `loadLaunchSource`) | `launch/source.ts` |
| 342–491 | Background execution (`startBackgroundExecution`, `executeWorkflowInBackground`) | `launch/background.ts` |
| 503–569 | Live-manifest persistence + terminal-artifact writing | `launch/background.ts` |
| 595–692 | State-transition wrappers (`completeRunState`, `stopRunState`, `failRunState`, `mergeRuntimeState`) | `launch/run-state.ts` |
| 694–748 | Generic error/format utilities (`errorMessage`, `hasMessage`, …) | shared guards module (see Theme 2) |

- [x] Inside `launchWorkflow` itself (lines 96–226, 130 lines): extract the
  32-line `initialState` literal (136–167) into
  `buildInitialRunState(parsed, request, options, ids)` and the 22-line
  `runtimeOptions` literal (191–212) into `buildRuntimeOptions(...)`. Both are
  pure data assembly with no control flow. Afterwards `launchWorkflow` reads
  as a 6-step recipe: validate → allocate ids → build state → persist → kick
  off background → return.

- [x] Collapse the duplicated terminal paths in `executeWorkflowInBackground`
  (lines 449–491). The success branch and failure branch each repeat the same
  four steps — build terminal state, write artifacts, wrap errors, notify —
  differing only in which state builder runs. Extract
  `finalizeRun(state): Promise<Result<WorkflowRunState, ...>>` so both
  branches become "build terminal state → finalize → return".

**Why the split helps here specifically:** "where does a run transition to
`failed`?" becomes "open `launch/run-state.ts`", not "scan 748 lines".

### 1.2 `src/extension/tui/workflows-component.ts` (798 lines, god component)

`WorkflowsTuiComponent` (lines 92–712) is a 620-line class holding keyboard
input, four screen renderers (chooser / overview / agent detail / prompt
reader), confirmation-dialog state, scroll state, render caching, and color
mapping.

**The key insight:** the renderers only need `(theme, view, nav, width)` —
they don't need the class at all. And the codebase already established the
right pattern: `view/projector.ts` and `view/navigation.ts` pulled the view
model and selection math out of the component. This is *finishing* that
extraction, not a new idea.

- [x] Move `#renderChooser`, `#renderOverview`, `#renderAgentDetail`,
  `#renderPromptReader` plus their row helpers (lines 460–511) into pure
  functions in `tui/render-overview.ts`, `tui/render-chooser.ts`, etc. (or one
  `tui/render-screens.ts` if separate files feel heavy). The class shrinks to
  state + input dispatch.
- [x] While moving `#renderOverview` (237–312): extract
  `plannedAgentLines(selectedPhase, hasAgentRows)` and
  `phaseRowLine(phase, selected)`. The "X agents expected; names appear after
  enqueue." message is currently duplicated at lines 280 and 290 and collapses
  to one site.

### 1.3 `src/extension/commands/workflows-command.ts` (581 lines, ~8 concerns)

- [x] Extract the entire `features` subcommand — parsing (257–307), handling
  (194–242), formatting (350–380) — into
  `commands/workflows-features-subcommand.ts` (~190 lines). It is fully
  self-contained today.
- [x] Extract the plain-text overview formatter (517–581) into
  `commands/workflows-overview-format.ts`.
- [x] In the `/workflows` handler (101–187): the 40-line `showWorkflowsTui`
  call contains seven inline callback closures that bury the happy path.
  Extract `buildWorkflowsTuiCallbacks(ctx, pi, store, rootDir, options)`
  returning the options object; the handler then reads as
  route → load → show.

### 1.4 Same pattern, smaller scale

- [x] `src/extension/tools/workflow-tool.ts` (384 lines): nearly half is
  `renderCall`/`renderResult` formatting (lines 209–385) unrelated to
  launching. Move it to `tools/workflow-tool-render.ts`; optionally also move
  the 19-line `WORKFLOW_TOOL_DESCRIPTION` prompt constant out. Registration
  file drops to ~120 lines.
- [x] `src/extension/agent/pi-runner.ts` (365 lines): the runner lifecycle
  (59–118) is clear, but the file also contains a Pi-event→live-event
  translator (230–307) and an assistant-message text extractor (309–361),
  each with its own vocabulary of type guards. Extract
  `agent/pi-live-events.ts` and `agent/pi-messages.ts`. Bonus: the event
  mapping gets its own test seam.
- [x] `src/workflows/script/runtime.ts` (471 lines): `executeWorkflowScript`
  (63–248, 185 lines) holds six mutable closure variables. Extract
  `createBudget`, `createAgentGlobal(deps)`, `createSandboxContext(globals)`,
  and `runWithDeadline(...)`. Also consider moving the determinism shims
  (`deterministicDate`/`deterministicMath`, 436–471) and the public
  `parallel`/`pipeline` helpers into `script/sandbox-globals.ts` so
  `runtime.ts`'s contract ("run a script") is crisp.
- [x] `src/workflows/run/store.ts` (584 lines): the actual store
  (read/write/cache, 65–189) is clean, but ~370 lines below it implement
  deserialization for **two different schemas** — the native manifest
  (`toWorkflowRunState`) and the reverse-engineered Claude Code "observed"
  manifest (`observedManifestToRunState`, 268–334). Extract
  `run/manifest-codec.ts`, or split further into `native-manifest.ts` /
  `observed-manifest.ts`. This split also *documents the reverse-engineering
  boundary*, which matters for this project's spec.md mapping.
- [x] `src/workflows/agent/scheduler.ts`: `schedule` (139–216, ~78 lines)
  mixes cap enforcement, option defaulting, journal-key computation,
  progress-entry creation, replay short-circuit, and enqueueing — the actual
  scheduling decision is buried at the bottom. Extract private methods
  `#resolveAgentOptions`, `#computeJournalKey`, `#enqueueProgressEntry`,
  `#replayFromCache` so `schedule` reads as guard → prepare →
  replay-or-enqueue.

**ADR note:** the launcher split (1.1) changes the file layout of a domain
module, so per project convention add a short ADR ("split launch module along
source/background/run-state seams") connecting it to ADR 0007's
domain-module rationale.

---

## Theme 2 — Kill the copy-pasted helpers (start here)

**Why this matters:** when a reader sees two near-identical helpers in
different files, they must diff them to learn whether the divergence is
intentional. Every duplicate is a small standing tax, and one of them is a
genuine correctness risk. This is the cheapest theme — an afternoon, zero
behavior change.

- [x] **Create `src/workflows/guards.ts`** (sibling to the existing
  `result.ts`, which is the precedent for shared single-purpose modules) and
  consolidate:
  - `isRecord` — currently in `run/store.ts:562`, `script/parser.ts:233`,
    `journal/store.ts:122`
  - `isNodeError` — currently in `run/store.ts:582`, `saved/resolver.ts:257`,
    `saved/list.ts:133`
  - `errorMessage` / `hasMessage` — currently in `launch/launcher.ts:723–736`
    and `script/runtime.ts:311–324`
- [x] **Delete `isTerminalAgent`** (`agent/scheduler.ts:562–564`) and import
  `isTerminalAgentState` from `run/state-machine.ts:296–298` instead.
  *This is the riskiest duplicate*: the state machine is the authority on
  terminality, and a private copy can silently diverge when a new terminal
  state is added.
- [x] **Name the model-routing expression.** The exact expression
  `experimentalModelRouting ? meta.model ?? defaultModel : defaultModel`
  appears three times: `launcher.ts:145–147`, `launcher.ts:198–200`, and
  `runtime.ts:87–89`. Extract
  `resolveDefaultModel(meta, options, features)` — the name documents *what
  the policy is*, which the inline ternary does not.
- [x] **One launcher type.** The injected-launcher function type
  `(request, options) => Promise<Result<WorkflowLaunch, WorkflowLaunchError>>`
  is hand-written in three files (`workflows-command.ts:78–81`,
  `workflow-tool.ts:103–106`, `saved-workflow-commands.ts:88–91`), and
  `(options.launchWorkflow ?? launchWorkflow)` appears at all three call
  sites. Add next to the real function:

  ```ts
  // in src/workflows/launch/launcher.ts
  export type WorkflowLauncher = typeof launchWorkflow;
  ```

  Then every consumer is `readonly launchWorkflow?: WorkflowLauncher`. If the
  real signature changes, the seam updates itself.
- [x] **One command context.** `WorkflowCommandContext`
  (`workflows-command.ts:61–75`) and `SavedWorkflowCommandContext`
  (`saved-workflow-commands.ts:63–76`) redeclare the same nontrivial shape —
  including the subtle `modelRegistry & { getAvailable?: ... }` intersection.
  A reader cannot tell whether the two are *intentionally* different (they
  aren't, modulo `savedWorkflowDirs`). Extract a shared base type in
  `commands/command-output.ts` or a new `commands/context.ts` and extend it.

---

## Theme 3 — Derive guards and transitions from one source of truth

**Why this matters:** hand-maintained lists that mirror a type definition
drift silently. The compiler won't catch a guard that forgets a new union
member, and a reader must cross-check guard against type to trust either.

- [x] **Const-array union guards.** `run/store.ts:465–520` spells out the
  12-member `WorkflowRunStatus` union and 6-member thinking-level union as
  chained `===` comparisons. The codebase already has the right pattern —
  `WORKFLOW_SCRIPT_GLOBALS` in `runtime.ts:32–40`:

  ```ts
  // pattern to copy, next to the type in run/model.ts:
  export const WORKFLOW_RUN_STATUSES = [
    "pending", "running", /* ... */
  ] as const;
  export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

  // guard becomes a one-liner that can never drift:
  const isWorkflowRunStatus = (v: unknown): v is WorkflowRunStatus =>
    WORKFLOW_RUN_STATUSES.includes(v as WorkflowRunStatus);
  ```

  Apply to `isWorkflowRunStatus`, `isWorkflowThinkingLevel`,
  `isWorkflowFeatureDecisionSource`. Thinking-level literals also appear in
  `model-routing/resolve.ts` and `agent/model.ts` — point them at the same
  constant.
- [x] **Invert the restart transition.** The `agent_restarted` transition
  (`run/state-machine.ts:225–251`) resets ~20 fields to `undefined` one by
  one. Every new telemetry field added to `WorkflowAgentProgress` (and
  `patchLiveEvent` in `scheduler.ts` keeps adding them) must also be
  remembered here — and a reader can't tell which omissions are deliberate.
  Invert it: **construct a fresh queued-agent record from the fields that
  survive** (`index`, `label`, `agentType`, `model`, `thinkingLevel`,
  `phaseTitle`, the `prompt*` fields, `attempt + 1`) instead of spreading the
  old record and nulling the rest. "What survives a restart" is a short,
  stable list; "what resets" grows forever.

---

## Theme 4 — Orientation aids (docs only, no code changes)

**Why this matters:** the docs→code direction is excellent
(`brain/contracts/spec-coverage.md` is the linchpin: spec section → owning
files → tests). But the code→docs direction is nearly zero, and `src/` itself
says nothing about its own structure. A new reader who stumbles into `src/`
first — the most common entry path — gets no anchors.

- [x] **One-or-two-line role headers per module.** No directory under
  `src/workflows/*/` or `src/extension/*/` says what it owns. Opening
  `src/workflows/agent/` shows `model.ts` + `scheduler.ts` with no hint that
  the Pi runner lives across the architecture boundary in
  `src/extension/agent/` (that placement is *intentional* per ADR 0010 —
  which makes it exactly the kind of thing worth one line of explanation).
  Either a 2–5 line `README.md` per module dir, or a header doc-comment in
  each module's main file. Example:

  ```ts
  // src/workflows/agent/scheduler.ts
  // Concurrency-capped agent scheduler with journal replay.
  // The Pi-session runner lives in src/extension/agent/ (ADR 0010:
  // domain core stays Pi-SDK-free).
  ```

- [x] **Defuse the basename collisions.** Six modules have a `model.ts`; two
  each have `store.ts`, `projector.ts`, `resolve.ts`, `layout.ts`. The
  `#src/` absolute imports keep this unambiguous in code, so **renaming is
  not warranted** — but IDE autocomplete and filesystem browsing are noisy.
  The role headers above are the cheap fix ("Run-manifest persistence; the
  *journal* store is separate in `journal/store.ts`").
- [x] **Make the test harness discoverable.** `test/suite/` (shared
  `FakePiSession` + tmpdir helpers, with its own README) is invisible unless
  you already know it exists. Add a one-line pointer comment at the top of
  test files that use the harness, and/or mention `test/suite/README.md` from
  the testing reference doc.
- [x] Optional: a short "where is X implemented?" pointer at the top of
  `README.md` linking to `brain/contracts/spec-coverage.md`, since that table
  is the single best orientation tool in the repo and is currently buried.

---

## Theme 5 — Small local cleanups (camp-site rule)

Fix these only when already touching the file; none justify a dedicated PR.

- [x] **Nested ternary pyramid** — `#overviewAgentRow`
  (`workflows-component.ts:495–508`) picks metric text via a triple-nested
  ternary (tool metrics → idle warning → no-telemetry → empty). Decompose
  into `#agentMetricLabel(agent, metricParts)` with early returns. Same smell
  at `#renderStopConfirmation:562–567`.
- [x] **Magic layout numbers** — `visibleRange(..., 10)`
  (`workflows-component.ts:441`) and `12` / `0.4` in `clampLeftWidth`
  (714–718), while the sibling `PROMPT_VISIBLE_ROWS` *is* properly named.
  Name them `CHOOSER_VISIBLE_ROWS`, `MIN_LEFT_PANE_WIDTH`,
  `LEFT_PANE_MAX_FRACTION`.
- [x] **Use the exported name** — `workflows-command.ts:313` and `:351` write
  `Awaited<ReturnType<typeof resolveWorkflowFeatures>>` although
  `features/resolve.ts:58` already exports `ResolvedWorkflowFeatures`.
- [x] **Name the late-binding trick** — `script/runtime.ts:72` declares
  `let emitStateChange = noop`, and line 209 reassigns it *after* the
  scheduler and sandbox globals have closed over it. A reader must discover
  this temporal coupling to understand why early `log()` calls work. Either
  replace with a small emitter object (`{ emit() }`) constructed before the
  scheduler, or at minimum add a "why" comment naming the idiom. (Theme 1's
  runtime extraction subsumes this.)
- [x] **String-snapshot dirty checking** — `workflows-component.ts:142–172` +
  `#snapshot` (694–700) detect changes by comparing concatenated state
  strings. Clever but undiscoverable, and a new state field silently won't
  trigger re-render unless someone remembers to append it to `#snapshot`.
  Rename to `#stateFingerprint()` with a one-line "why" comment, or have each
  `#handle*` return a `changed: boolean` and drop the mechanism.
- [x] **Sentinel contract for "unknown model"** — `view/projector.ts:81–120`
  (`toAgentRow`) buries staleness derivation in front of a 24-field copy
  literal, and line 82 uses magic sentinels (`""`, `"unknown"`, `"default"`)
  that also appear as fill-in defaults in `store.ts:441–442` with no shared
  name. Extract `deriveAgentStaleness(agent, now)` and a shared
  `hasKnownModel(model)` so the sentinel contract is written down once.
- [x] **Flatten `resolveSavedWorkflowByName`** — `saved/resolver.ts:71–120`:
  the exact-path branch and the scan loop duplicate the read→parse→match
  pattern at three-level nesting. Extract `tryCandidate(candidate)` returning
  `found | skip | error`.
- [x] **Factor the journal guard** — `agent/scheduler.ts:358–410`: four
  `#appendJournal*` methods repeat the
  `journal === undefined || journalKey === undefined` guard. The *differing*
  catch behavior per method is well-commented and should stay; only the
  shared guard belongs in a common `#appendJournalEvent`.

---

## Already good — patterns to copy, not just preserve

When implementing the items above, converge on these existing patterns:

- **Declarative transition table** — `run/state-machine.ts:42–99`. The
  `TransitionTable` with required state keys (compile-error exhaustiveness)
  is the best-read file in the core. Model new stateful behavior this way,
  not with ad-hoc flags.
- **Decision-before-action discriminated unions** — `selectLaunchSource`
  (`launcher.ts:307–340`) returns `script | name | scriptPath` *before*
  acting on it. Mirror this shape when splitting other long functions.
- **Threaded-path validators** — `script/parser.ts`'s `requireString` /
  `requireNonEmptyString` / `requireNonNegativeInteger` produce precise
  errors from tiny functions. The store codecs (Theme 1.4 / store split)
  should converge on this style.
- **Dependency-sliced host types** —
  `RegisterWorkflowToolPi = Pick<ExtensionAPI, ...> & Partial<Pick<...>>`
  documents exactly which Pi surface each registration touches.
- **Pure classification separated from side effects** —
  `classifySavedWorkflowCommand` (`saved-workflow-commands.ts:142–175`)
  takes the command list as data, keeping collision logic testable; the
  impure `registerDirectCommand` stays thin.
- **Layered precedence pipeline** — `extension/features/resolve.ts:70–93`
  reads as the literal precedence spec (user → project → hook → env → cli →
  session → override) via small `apply*` functions. The cleanest file in the
  extension layer; the TUI renderers should converge toward this style.
- **"Why" comments over "what" comments** — `deriveLiveStatus`
  (`launcher.ts:644–653`), `WORKFLOW_SYNCHRONOUS_SLICE_TIMEOUT_MS`
  (`runtime.ts:43–50`), `isScriptPathWithinRoot` (`resolver.ts:210–219`),
  `stripMarkdownFence` (`parser.ts:71–77`) all explain intent and threat
  model, not mechanics. Keep writing these.

---

## How to verify each step

1. `pnpm run verify` after every extraction/move — the suite is integration-
   heavy (`launcher.test.ts` alone is 1,507 lines) and covers these files
   well, so pure moves that break behavior will fail loudly.
2. For Theme 1 splits: imports should change, **public exports should not**
   (re-export from the original module if external callers exist, or update
   the few internal import sites — `#src/` paths make this a grep).
3. For Theme 3: after converting a guard to a const array, temporarily add a
   member to the union type and confirm the guard picks it up without edits.

> **Caveat at time of writing:** the working tree has uncommitted changes in
> `package.json`, `src/workflows/script/parser.ts`,
> `src/workflows/script/runtime.ts`, and their tests. Land or stash those
> before starting Theme 1 work on `runtime.ts`/`parser.ts`; everything else
> is unaffected.

Line numbers reference the code as of 2026-06-09 (commit `6c9bbac7` + local
changes) and will drift — treat them as starting points, not anchors.

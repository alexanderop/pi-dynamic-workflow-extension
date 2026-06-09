# Review action items — 2026-06-08 (ultracode run #2)

> Actionable fix-list from the second ultracode codebase review (17 agents:
> 8 specialist reviewers → adversarial verify → Opus coordinator).
> **Verdict: `minor_issues`** — 0 critical · 16 warnings · 12 suggestions (38 raw, 9 deduped).
>
> Companion to the narrative writeup in `ultracode-codebase-review-2026-06-08.md`.
> This file is the "what to fix and how" checklist.

Coordinator's framing: there is **no surviving true-critical defect**. Every reviewer-flagged
"critical" reduces to one misplaced file (`registry.ts`) that has zero Pi imports, so there is
no runtime contamination today. The substance is a coherent cluster of warnings worth clearing
before further build-out.

---

## Resolution status (verified 2026-06-09)

Each finding was re-checked against the current code, then fixed test-first where still open.

- **Already done before this pass:** #1 (registry moved to `src/workflows/features/`),
  #2 (synchronous-slice timeout documented + real `deadlineMs` wall-clock race added),
  #8 (`applyRunTransitions` extracted), #9 (`#ensureDir` memoizes mkdir),
  #10 (mtime+size manifest cache), #16 (lint/fmt scope docs already correct).
- **Fixed this pass (test-first):**
  - #3 live-manifest status clobber — `deriveLiveStatus()` derives `paused`/`stopped` from the
    runtime control so progress writes no longer overwrite a paused/stopped manifest.
  - #4 + #5 architecture — `pi-runner.ts` and `structured-output-tool.ts` moved to
    `src/extension/agent/`; width-rendering helpers moved to `src/extension/tui/layout.ts`,
    leaving `view/layout.ts` pure. `src/workflows` is now Pi-SDK-free, **enforced** by a new
    `no-restricted-feature-imports` pattern on `@earendil-works/pi`.
  - #6 scriptPath traversal — `isScriptPathWithinRoot()` containment check in `loadLaunchSource`.
  - #7 prompt injection — ultracode goal wrapped in a `<goal>…</goal>` data block.
  - #11–#14 untested branches — per-subscription unsubscribe spy, pi-runner pre-abort +
    empty-assistant-response paths, journal corrupt/wrong-shape JSONL rejection.
  - #15 docs drift — `spec-coverage.md` §5 gap updated; moved-file paths corrected.
- **Suggestions applied:** domain-layer `resumeFromRunId` validation (`/^wf_[a-z0-9-]{6,}$/`);
  `vm.createContext` `codeGeneration: { strings: false, wasm: false }` hardening (with eval test);
  dropped the unnecessary `as unknown as Record<string, unknown>` cast in `parser.ts`;
  narrowed `thinkingLevelMap` to `string | null`; annotated `isolation: 'worktree'` in the tool
  description as accepted-but-not-yet-implemented.
- **Suggestions deferred** (minor, "when in the area"): pi-runner structural guard after the
  `createAgentSession` cast, statusline `tick()` double render, `#bounds()` view-model rebuild,
  `statusline/projector.ts` `[...text]` spread, and the two test-doc/assertion clarifications.

## Priority batch (highest leverage, low risk)

### 1. Relocate `registry.ts` — clears 8 boundary violations at once
- **Problem:** `src/extension/features/registry.ts` is imported by 8 sites under `src/workflows/**`
  (`run/model.ts:3-5`, `run/store.ts:6-11` — runtime `isWorkflowFeatureKey` used at `store.ts:316`,
  `script/model.ts:5`, `script/runtime.ts:6` — runtime `DEFAULT_WORKFLOW_FEATURES`,
  `launch/launcher.ts:23-27` — runtime `workflowFeatureKeys()`, `launch/model.ts:9-12`,
  `model-routing/agent-options.ts:2`). This violates the rule that `src/workflows/**` must not
  import from `src/extension/**`. The domain core is not buildable/testable independent of the
  extension subtree, and any future Pi dependency added to `registry.ts` would silently leak in.
- **Fix:** move the file to `src/workflows/features/registry.ts` (it's pure types/constants, no Pi
  imports) and have the extension re-export from there. One move fixes all 8 sites, no logic change.

### 2. Inert VM timeout — false runaway-script protection
- **File:** `src/workflows/script/runtime.ts:167` (body wrapped at line 165)
- **Problem:** the script body is wrapped as `(async () => {…})()`, so
  `runInContext(context, { timeout: 1000 })` only measures the ~0ms synchronous Promise
  construction. A script doing `while (true) { await agent(...) }` runs forever; the timeout
  never fires. (Flagged independently by correctness + typescript.)
- **Fix:** remove the misleading `timeout` option and document that cancellation depends on the
  existing scheduler `AbortSignal`; or enforce a real wall-clock deadline outside the vm via that
  signal.

### 3. Live-manifest persister clobbers controller pause/stop on disk
- **File:** `src/workflows/launch/launcher.ts:464-476` (`mergeRuntimeState` at 575-591)
- **Problem:** `mergeRuntimeState` spreads `initialState` (whose `status` is hardcoded `"running"`
  at line 114) and never overrides `status`. After `WorkflowRunController.pause()` / `stopRun()`
  writes `paused`/`stopped`, the next scheduler progress event fires `onStateChange` → `persist()`
  and overwrites it with `running`. Any disk reader (polling TUI / statusline) sees a paused/stopped
  run as still running.
- **Fix:** pass a `getStatus()` callback (or optional `status` override) into `mergeRuntimeState`
  so live writes preserve the controller's last-written status.

---

## Architecture (boundary layering)

### 4. Pi SDK `defineTool` imported into domain layer
- **File:** `src/workflows/agent/structured-output-tool.ts:1`
- **Problem:** imports `defineTool` / `ToolDefinition` from `@earendil-works/pi-coding-agent`,
  coupling the domain tool schema to the Pi SDK and making the module untestable without the full SDK.
- **Fix:** move to `src/extension/tools/` (or `extension/agent/`); `pi-runner.ts` is the intended
  Pi-SDK boundary and can own tool construction.

### 5. Pi TUI imported into the pure projector
- **File:** `src/workflows/view/layout.ts:1`
- **Problem:** imports `truncateToWidth` / `visibleWidth` from `@earendil-works/pi-tui`, breaking the
  ADR 0010 contract that `view/` is TUI-agnostic.
- **Fix:** inject the two width helpers, or re-implement them with a zero-dependency segmenter so
  `view/` tests need no UI SDK.

---

## Security (latent; local-dev threat model)

### 6. Unrestricted filesystem read via `scriptPath`
- **File:** `src/workflows/saved/resolver.ts:122-126` (tool schema `workflow-tool.ts:54-57`)
- **Problem:** `readSavedWorkflowScriptPath` passes the caller-supplied path straight to `readFile`;
  the tool schema has no `pattern`/allowlist. An LLM agent can pass `/etc/passwd` or `~/.ssh/id_rsa`
  and its content is opened (and executed if it parses as a valid script).
  *Note:* the original "error echoes file content" claim was **disproven** during verify — parse
  errors return a generic acorn message, not the file body.
- **Fix:** in `readSavedWorkflowScriptPath` (or `loadLaunchSource`), `path.resolve` both an allowed
  root (workflow `rootDir` / `.pi/workflows/`) and the input, and assert containment before reading.
  Add a defensive `pattern` on the tool param.

### 7. Prompt-injection path into a privileged subagent
- **File:** `src/extension/ultracode/launch-ultracode-workflow.ts:27-38`
- **Problem:** `args.goal` is spliced verbatim into both `agent()` prompts in
  `BUNDLED_ULTRACODE_WORKFLOW_SCRIPT` with no delimiter; the subagent has filesystem/shell access.
  Lower severity because attacker and user are usually the same person in a local dev tool.
- **Fix:** wrap the goal in an explicit `<goal>…</goal>` data block instructing the subagent to
  treat it as data only.

---

## Correctness / refactoring

### 8. Duplicated two-step `transitionRun`+throw in three terminal builders
- **File:** `src/workflows/launch/launcher.ts:526-573`
- **Problem:** `completeRunState`, `stopRunState`, `failRunState` repeat the same
  double-transition-then-throw structure and convert transition errors to exceptions inconsistent
  with the surrounding Result style. (The throws are caught at line 353, so they don't escape
  silently — the "abandons Result contract" framing was overstated.)
- **Fix:** extract `applyRunTransitions(state, ...events): Result<…>` and propagate via the existing
  `err(backgroundError(...))` path.

---

## Performance

### 9. `mkdir` syscall on every journal append
- **File:** `src/workflows/journal/store.ts:21`
- **Problem:** `append()` issues an unconditional `mkdir(..., { recursive: true })` before each
  `appendFile` on the agent hot path (10 parallel agents × 4 events = 40 redundant mkdirs).
- **Fix:** guard with a `#dirEnsured` boolean (appends are already serialized through the journal
  tail chain — no race).

### 10. Full manifest re-read on every 1-second poll
- **File:** `src/workflows/run/store.ts:69-83`
- **Problem:** `listRuns()` does `readdir` + `Promise.all(readFile)` over every run directory with no
  mtime/count change-detection, called by two independent 1s pollers (statusline + TUI). Cost grows
  linearly with run history.
- **Fix:** cache last listing + per-manifest mtime and re-read only changed entries, or expose an
  in-process `setRun` update path.

---

## Tests (untested branches)

### 11. `fake-pi-session.ts` shared unsubscribe spy
- **File:** `test/suite/fake-pi-session.ts:29`
- **Problem:** all `subscribe` calls return the same `this.unsubscribe`, so
  `pi-runner.test.ts:215`'s `toHaveBeenCalledOnce()` conflates spy identity with subscription count;
  false confidence if production ever subscribes twice.
- **Fix:** return a per-subscription closure that removes only that listener.

### 12. pi-runner pre-abort path untested
- **File:** `test/workflows/agent/pi-runner.test.ts` (target `pi-runner.ts:94-98`)
- **Fix:** add a test with an already-aborted signal asserting reject message, `prompt` never called,
  and `abort`/`dispose` called.

### 13. pi-runner empty-assistant-response path untested
- **File:** `pi-runner.ts:312-314` throws when no assistant text is returned, but `FakePiSession`
  always appends one.
- **Fix:** override the prompt mock to push no message and assert the "finished without a final
  assistant text response" rejection.

### 14. journal corrupt-JSONL line path untested
- **File:** `store.ts:77-80` throws on malformed/wrong-shape lines and propagates through resume;
  only happy paths covered.
- **Fix:** add a wrong-shape (`{"type":"unknown"}`) and a non-JSON line test asserting `readEvents()`
  rejects.

---

## Docs drift

### 15. `spec-coverage.md:14` stale gap
- Claims §5 Pi subagent execution remains a gap, but `createPiWorkflowAgentRunner` is wired at
  `workflow-launch-options.ts:85` and `launch-ultracode-workflow.ts:98`, and `plans/index.md:51-54`
  records it as Done. **Fix:** update the cell; point remaining gaps at restart-agent control and
  sidechain transcripts.

### 16. Lint/fmt scope docs wrong
- `AGENTS.md:41` / `CLAUDE.md:41` claim `pnpm run lint` targets `.pi/workflows/scripts`; `package.json`
  runs `oxlint src test tools` (no such dir; `tools/` holds the local Oxlint plugin).
  `AGENTS.md:43` / `CLAUDE.md:43` `fmt` description likewise says "workflow scripts".
  **Fix:** correct both to the real scope (`src test tools` + config files).

---

## Suggestions (do when in the area)

- `launcher.ts:232-235` — validate `resumeFromRunId` against `/^wf_[a-z0-9-]{6,}$/` in the domain
  layer (currently only the tool-layer TypeBox pattern guards it).
- `script/runtime.ts:133` — add `contextCodeGeneration: { strings: false, wasm: false }` to
  `vm.createContext` (defense-in-depth; `vm` is not a trust boundary — document that).
- `script/parser.ts:274` — drop the unnecessary `as unknown as Record<string, unknown>`;
  `AnyNode` already satisfies `Object.entries`.
- `model-routing/resolve.ts:7` — narrow `thinkingLevelMap` from `unknown | null` to `string | null`.
- `agent/pi-runner.ts:133` — add a structural guard / type predicate after the unchecked
  `createAgentSession` cast.
- `statusline/workflow-statusline.ts:108-111` — drop the standalone `tick()` double render, or fire
  it only while a refresh is in flight.
- `tui/workflows-component.ts:550-558` — `#bounds()` rebuilds the full `MonitorViewModel` just for
  counts; derive counts from raw state or cache the view model per update cycle.
- `statusline/projector.ts:134` — replace `[...text]` spread in `truncatePlain` with
  `text.length`/`text.slice()` (or `Intl.Segmenter` only if grapheme support is truly needed).
- `test/workflows/launch/launcher.test.ts:1294` — assert + comment the intended
  errored-agent → `completed, result:null` terminal status.
- `test/workflows/agent/scheduler.test.ts:164-198` — document the journal-ordering synchronicity
  assumption or add a stricter pre-runner ordering check.
- `tools/workflow-tool.ts:35` — `isolation: 'worktree'` is advertised to the model but never
  consumed by scheduler/pi-runner; implement it or annotate "(accepted but not yet implemented)".

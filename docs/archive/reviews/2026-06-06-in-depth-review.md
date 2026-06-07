# Pi Dynamic-Workflow Extension — In-Depth Review (2026-06-06)

> Produced by a multi-agent review that, for every dimension, read the extension
> code **and** cross-referenced the real Pi source at `/tmp/pi`, then
> adversarially verified each finding against that source. **All 32 findings below
> had their pi citations independently confirmed accurate (32/32).**
>
> Coverage: all 7 dimensions. 32 findings went through the full adversarial-verify
> pass; the 7th dimension (**launch-orchestration**) was re-run separately after the
> first agent overflowed the structured-output token limit, so its 6 net-new findings
> are single-pass (slightly lower confidence on the two LOW smells). Total: **38
> findings**.

## Verdict

This is a genuinely strong reimplementation of the Workflow tool: the DSL surface
(`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`), the journal-based
resume protocol, the run state machine, and the TUI all exist and are tested. It
mirrors the real tool's *shape* faithfully. The gaps are about **honesty of
guarantees and fidelity to its own spec**, not missing scaffolding:

1. **The sandbox is theatre.** `node:vm` is presented as enforcing the
   determinism/filesystem bans, but it is trivially escapable — a workflow script
   can reach `process.env` and raw `fs`. (CRITICAL)
2. **Three documented contract clauses are unimplemented:** `budget.total` as a
   hard ceiling, the nested `workflow()` global, and the per-call 4096 fan-out cap.
3. **Two correctness bugs that bite the moment real content flows through:**
   subagent failures (auth/rate-limit) are silently swallowed, and ANSI-styled text
   gets duplicated/corrupted by the hand-rolled wrapper.
4. **One concurrency hazard:** two uncoordinated writers race on `manifest.json`,
   so a user's pause/stop can be clobbered by the next progress tick.
5. **The ultracode policy has no actuator:** the model is told to "launch a
   workflow" but no `pi.registerTool` actuator is registered, so it can't.

A recurring theme: the extension **re-derives things pi already exports**
(`wrapTextWithAnsi`, `truncateToWidth`'s ellipsis/pad, `formatTokens`,
post-input `requestRender`) — and the re-derivations are where the bugs live.

## Top priorities

| # | Severity | Area | One-line fix |
|---|----------|------|--------------|
| 1 | CRITICAL | Script runtime | Stop claiming `node:vm` is a sandbox — either accept pi's trust model and drop the framing, or move to a real isolate (`worker_threads`/`isolated-vm`). |
| 2 | HIGH | Subagent | Inspect the **last** message's `stopReason`/`errorMessage` so auth/rate-limit failures surface instead of an empty-text "success". |
| 3 | HIGH | Run persistence | Give `manifest.json` a single writer (or CAS with a monotonic revision) so pause/stop isn't clobbered by the live persister. |
| 4 | HIGH | View | Replace `wordWrap` with pi's `wrapTextWithAnsi`; the current `stripAnsi`+`.length` slice duplicates characters. |
| 5 | HIGH | Script runtime | Enforce `budget.total` as a hard ceiling: `agent()` must throw when `spent >= total`. |
| 6 | HIGH | Ultracode | Register a `pi.registerTool` workflow-launch actuator (the ADR/spec-mandated one) — wire the existing `launchUltracodeWorkflow`. |
| 7 | HIGH | Launch/agent | `isolation: "worktree"` is a no-op but taught to the LLM — implement `git worktree add` per agent, or remove the option + authoring instruction. |
| 8 | HIGH | Script runtime | Add the nested `workflow()` global with a one-level depth guard (spec §7). |

---

## Findings by area

### 1. Script runtime & DSL parser

**Summary:** the DSL is close to the contract but ships three unimplemented clauses
and a sandbox that gives false safety.

#### 🔴 CRITICAL — `node:vm` sandbox is trivially escapable — `src/workflows/script/runtime.ts:84`
The body runs inside `vm.createContext({...})` + a `this`-bearing arrow IIFE, and
this is relied on to enforce the fs/determinism bans. But top-level `this` is the
context global, so `this.constructor.constructor("return process")()` returns the
**host** `process` — verified reachable: `process.env` (secrets/API keys),
`process.binding("fs")`, and the real `Date`/`Math` (defeating `deterministicDate`/
`deterministicMath` at `runtime.ts:212-247` and the AST checks in `parser.ts`). The
test at `test/workflows/script/runtime.test.ts:50` only checks `typeof process` is
`undefined`, giving false confidence.
**Pi:** pi does **not** sandbox extensions at all — `loader.ts:331-343` loads via
`createJiti(...).import()` with full Node access, because its trust model is
author-installed code. So pi offers no sandbox to copy; this extension is solving a
*harder* problem with a tool that is explicitly not a security boundary.
**Fix:** Pick an honest path. **(A)** Accept pi's trust model: drop the sandbox
framing, document that scripts run with full extension authority, keep the
determinism helpers as lint nudges only. **(B)** If scripts are agent-authored
(lower-trust), `node:vm` cannot contain them — move to `worker_threads`/
`child_process.fork` with `env: {}` and a restricted resolver, or `isolated-vm`.
Either way, replace the misleading `runtime.test.ts:50` assertion with a red-team
test asserting the escape is closed (B) or explicitly accepted (A).

#### 🟠 HIGH — `budget.total` not enforced as a hard ceiling — `runtime.ts:76`
`agent()` only does `spentTokens += estimate` **after** the agent resolves; it never
checks `budget.remaining()` before scheduling, so it can never throw on exhaustion —
contradicting `spec.md:257-263` / acceptance item 21 ("further `agent()` calls MUST
throw"). A runaway loop relying on the runtime backstop runs to the 1000-agent cap.
**Pi:** no equivalent (pi has no Workflow tool); this is a self-defined contract the
runtime documents in `model.ts:19-23` but doesn't implement.
**Fix:** At the top of `agent()`, before scheduling:
`if (budget.total !== null && spentTokens >= budget.total) throw new Error('Workflow budget exhausted')`.
Guard on `total !== null` (else `remaining()` is `Infinity`). Add a test asserting
it throws rather than running to the agent cap.

#### 🟠 HIGH — Nested `workflow()` global is missing — `runtime.ts:84`
`spec.md:185-216` and §7 require a `workflow(nameOrRef, args)` global sharing the
parent's concurrency cap, agent counter, abort signal, and budget, with one-level
nesting. The context object injects everything **except** `workflow`, so calling it
is a `ReferenceError`. No depth guard exists.
**Pi:** no equivalent — pure contract-fidelity gap vs the extension's own spec.
**Fix:** Add the `workflow` global reusing the parent scheduler/budget/token
accumulator; add a `nestingDepth` guard that throws at depth 1.

#### 🟡 MEDIUM — `vm` `timeout: 1000` doesn't bound async workflows — `runtime.ts:118`
`runInContext(context, { timeout: 1000 })` only bounds **synchronous** execution up
to the first `await` (verified: a 2.5 s `agent()` resolves fine), yet it *can*
wrongly kill heavy synchronous setup.
**Pi:** pi cancels via `AbortSignal` threaded through agent-core
(`extensions/runner.ts:296-298,614-621`), not a vm timeout.
**Fix:** Remove `{ timeout: 1000 }`; rely on the abort signal for cancellation.

#### 🟡 MEDIUM — No per-call 4096 fan-out cap — `runtime.ts:161`
`parallel()`/`pipeline()` accept arbitrarily large arrays; the contract caps fan-out
at 4096 items/call (`docs/areas/references/claude-code-workflow-tool.md:136`).
**Fix:** Add a shared `const MAX_FAN_OUT = 4096` guard at the top of both primitives.

#### ⚪ LOW — `pipeline()` seeds first stage's `previous` with `undefined` — `runtime.ts:190`
Spec reference (`spec.md:392-401`) seeds `let prev = item`, so stage 0 should receive
the item as both `prev` and `item`. Code uses `let previous: unknown;`.
**Fix:** `let previous: unknown = item;`.

#### ⚪ LOW — AST determinism check is shallow — `parser.ts:153`
`assertDeterministic()` only catches literal `Date.now()`/`Math.random()`/argless
`new Date()`; aliasing (`const D = Date`) slips past the AST (though the vm-injected
deterministic globals still catch it at runtime).
**Fix:** Keep it, but document it as best-effort lint, not a guarantee.

---

### 2. Subagent spawning & session lifecycle

**Summary:** wiring to `createAgentSession`/`SessionManager` is broadly right, but
failure signalling and host-context reuse are dropped.

#### 🟠 HIGH — Final-text extraction ignores `stopReason`/`errorMessage` — `src/workflows/agent/pi-runner.ts:126`
`extractFinalAssistantText` scans backward for the last assistant message and returns
its text, never inspecting `stopReason`/`errorMessage`. Pi's agent **catches** every
API/auth/abort error and records a synthetic final assistant message with empty text,
`stopReason: 'error'|'aborted'`, and the real cause in `errorMessage`
(`agent.ts:476-491`) — then resolves normally. So a failed subagent throws the
generic "finished without a final assistant text response", discarding the real
reason (e.g. "No API key found for anthropic"); or looks like an empty success if
earlier assistant text exists.
**Pi:** print mode reads the **last** message and, on `stopReason === 'error'|'aborted'`,
surfaces `errorMessage` + failure exit (`modes/print-mode.ts:129-146`).
**Fix:** Mirror print-mode — read `messages[messages.length-1]`; if it's a terminal
assistant turn with `stopReason` error/aborted, throw `errorMessage`; else return its
text; keep the backward scan only as fallback. Thread `request.agentId` through so
the scheduler journals the true cause.

#### 🟡 MEDIUM — `session.abort()` awaited fire-and-forget — `pi-runner.ts:62`
The handler does `void session.abort()` and the pre-start path calls `abort();
session.dispose()` synchronously. `AgentSession.abort()` is `async`
(`agent.abort(); await agent.waitForIdle()` — `agent-session.ts:1413-1417`); disposing
before it settles can tear down mid-flight.
**Fix:** `await` the abort promise before `dispose()`.

#### 🟡 MEDIUM — `model`/`modelRegistry` never plumbed — `src/extension/ultracode/launch-ultracode-workflow.ts:97`
No live caller supplies `model`/`modelRegistry`, so every subagent re-resolves
auth+model from disk (`createAgentSession` builds a fresh `AuthStorage` +
`findInitialModel`, `sdk.ts:174-221`) instead of reusing the host pi context.
**Fix:** When `launchUltracodeWorkflow` is wired in, populate
`UltracodeLaunchContext.modelRegistry`/`.model` from the host `ExtensionContext`.

#### ⚪ LOW — Runner hard-throws on `agent({schema})` — `pi-runner.ts:50`
Throwing is a safe placeholder, but pi already offers the idiomatic path:
`createAgentSession({ customTools })` (`sdk.ts:71,382`) + provider `toolChoice` forced
tool use (`anthropic.ts:237`).
**Fix:** (When the structured-output slice lands) compose `customTools` + forced
`toolChoice` rather than inventing a `response_format` API pi doesn't have.

#### ⚪ LOW — `createAgentSession` result cast drops `modelFallbackMessage` — `pi-runner.ts:98`
Cast to `{ session }` discards `modelFallbackMessage` (e.g. "Could not restore model
X"). **Fix:** Widen the factory result type and surface the message.

---

### 3. Run state machine, persistence & resume

**Summary:** temp+rename atomicity and the journal cache are sound and match pi's
posture, but a two-writer race and some dead resume code undercut it.

#### 🟠 HIGH — Two uncoordinated read-modify-write writers on `manifest.json` — `src/workflows/run/controller.ts:43`
`WorkflowRunController.pause/resume/stopRun/stopAgent` do `readRun → transition →
writeRun`, while the launcher's `createLiveManifestPersister` (`launcher.ts:411-437`)
independently writes `mergeRuntimeState(...)` every progress tick — no lock, no
version, no CAS. A user pause writes `status:'paused'`; the next tick overwrites the
whole doc from the runtime snapshot, clobbering it. `stopAgent` is worse.
**Pi:** `SessionManager` is a single in-memory authority — the **only** writer,
appending one entry or doing a full `_rewriteFile` from its own memory
(`session-manager.ts:872-882,908-935`); control ops mutate the live in-memory object,
not a re-read copy.
**Fix:** Route status through the live runtime (pi's model), or make `writeRun` a
compare-and-swap against a monotonic revision.

#### 🟡 MEDIUM — `restart-agent` journal invalidation is dead code — `src/workflows/agent/scheduler.ts:206`
`WorkflowJournalInvalidatedEvent` + the cache-delete in `journal/store.ts:72` exist,
but nothing in `src/` ever appends an `'invalidated'` event, so a restarted agent
would replay a stale cache hit. Latent (no live path triggers restart today).
**Fix:** Either wire the invalidation emit into the restart path or remove the
half-protocol and note it as unimplemented.

#### ⚪ LOW — `runId`/`resumeFromRunId` joined into paths without validation — `src/workflows/launch/launcher.ts:189`
`join(rootDir, request.resumeFromRunId, ...)` (and `store.ts:151`,
`save-run-script`) with no validation → path traversal surface.
**Pi:** pi calls `assertValidSessionId` before composing paths
(`session-manager.ts:825-826`). **Fix:** Add `validateRunId()` mirroring
`validateSavedWorkflowName`/`assertValidSessionId` and enforce at every boundary.

#### ⚪ LOW — No `fsync` on manifest temp+rename or journal append — `src/workflows/run/store.ts:99`
Crash window can lose the latest write. **Pi:** pi *also* doesn't fsync
(`session-manager.ts:872-935`) — so this **matches pi**; acceptable to ship. Add a
file-handle + `fsync` only if true power-loss durability is wanted.

#### ⚪ LOW — Journal coerces `undefined` result to `null` — `src/workflows/journal/store.ts:83`
An agent returning `undefined` replays as `null`. Root cause: `JSON.stringify` omits
`undefined` keys, failing the `"result" in value` guard. **Fix:** acceptable, but
document the semantic change (or persist a sentinel).

---

### 4. View projection & layout

**Summary:** the projector is nearly pure, but the layer **re-derives** pi-tui's
ANSI-aware helpers and the re-derivations carry the bugs.

#### 🟠 HIGH — `wordWrap` duplicates/corrupts characters on ANSI input — `src/workflows/view/layout.ts:47`
`head = stripAnsi(truncateToWidth(remaining, w, ""))` then `remaining.slice(head.length)`:
`truncateToWidth` keeps the consumed ANSI bytes, `stripAnsi` removes them, so
`head.length` under-counts and the slice re-emits characters. Verified:
`wordWrap("\x1b[31mabcdefghij\x1b[0m", 5)` → `["abcde","abcde","fghij\x1b[0m"]`. Latent
today (plain prompts) but corrupts any styled content.
**Pi:** `wrapTextWithAnsi` (`/tmp/pi/packages/tui/src/utils.ts:663`, exported at
`index.ts:107`) tracks an `AnsiCodeTracker` across breaks and re-emits active codes.
**Fix:** Replace `wordWrap` with `wrapTextWithAnsi`; delete local `stripAnsi`/
`ANSI_PATTERN`; add an ANSI case to `layout.property.test.ts`.

#### 🟡 MEDIUM — `agentsForPhase` fallback double-counts unphased agents — `src/workflows/view/projector.ts:158`
When a named phase currently has zero agents, it falls back to **all** unphased
agents, so every not-yet-started named phase shows the same unphased agents.
**Fix:** Compute membership once; bucket unphased agents into a single synthetic
phase only when there are **no** named phases.

#### ⚪ LOW — `truncateEllipsis`/`padTo` re-derive `truncateToWidth` — `src/workflows/view/layout.ts:4`
`truncateToWidth(text, width, "…", true)` already does exact-width pad and custom
ellipsis (`utils.ts:884-918`), and fixes a wide-grapheme off-by-one the manual
`" ".repeat` only masks. **Fix:** delegate to `truncateToWidth`.

#### ⚪ LOW — `titleSegment` top border one column short on wide chars — `src/workflows/view/layout.ts:104`
Truncated branch doesn't pad, so a double-width boundary grapheme yields
`segmentWidth-1`. **Fix:** pass `pad=true` as the 4th arg (also `workflows-component.ts:299`).

#### ⚪ LOW — `formatTokens` truncates and has no `M` tier — `src/workflows/view/layout.ts:111`
`Math.floor(count/100)/10` → 1999 renders "19.9k"; 2_000_000 → "2000k".
**Pi:** `template.js:799-803` rounds and adds an `M` tier. **Fix:** mirror pi's tiered
rounding.

#### ⚪ LOW — Projector default `now = Date.now()` makes the transform impure — `src/workflows/view/projector.ts:15`
Pure only if the caller passes `now` (it does today). **Fix:** make `now` required on
both option objects; delete the `?? Date.now()` fallbacks.

---

### 5. TUI rendering & Pi extension API integration

**Summary:** the component works but redundantly re-renders, re-clamps, and leans on
an editor lifecycle pi doesn't actually provide.

#### 🟡 MEDIUM — `UltracodeEditor.dispose()` is not in pi's editor lifecycle — `src/extension/ultracode/rainbow-editor.ts:58`
`dispose()` clears the animation `setInterval`, but pi's base `Editor` has no
`dispose` and `setCustomEditorComponent` swaps editors via `editorContainer.clear()`
**without** disposing the outgoing one (`interactive-mode.ts:2227`) — so the interval
leaks on swap.
**Fix:** Document the load-bearing dependency, and drive cleanup from a lifecycle pi
actually calls (e.g. clear the interval on `session_shutdown`/when the mode leaves
"on"), not from a `dispose()` pi never invokes.

#### ⚪ LOW — Rainbow colorizer's trailing RESET can corrupt editor ANSI — `src/extension/ultracode/rainbow-editor.ts:54`
`super.render(width).map(colorize...)` runs over lines that already contain border
color and the inverse-video fake cursor; the blanket reset is correct only because
pi's `Editor` currently emits no SGR content. Latent fragility.
**Fix:** colorize plain content only / track ANSI state like `wrapTextWithAnsi`.

#### ⚪ LOW — `requestRender()` after `handleInput` duplicates pi's render — `src/extension/tui/workflows-view.ts:58`
Pi already calls `focusedComponent.handleInput(data)` then `this.requestRender()`
(`tui.ts:763-770`); the custom component is the focused component.
**Fix:** drop the explicit `tui.requestRender()` and rely on pi's post-input render
(the component already `invalidate()`s only on change).

#### ⚪ LOW — `#cache` re-truncates already-clamped lines — `src/extension/tui/workflows-component.ts:514`
`#cache` maps `#line` (width-check + maybe `truncateToWidth`) over **every** line,
including header/chooser/footer already built with `#line` → double width math/frame.
**Pi:** `Box` caches final composed lines keyed by width/child output without re-running
width math (`tui/src/components/box.ts:4-9,21`).
**Fix:** build raw lines in the per-screen methods and let `#cache` be the **sole**
clamp point.

#### ⚪ LOW — Hand-rolled `wordWrap` duplicates `wrapTextWithAnsi` (and only hard-breaks) — `src/workflows/view/layout.ts:37`
Same root cause as the HIGH view finding, from the TUI angle: no word-awareness, strips
ANSI. **Fix:** swap for `wrapTextWithAnsi` at `workflows-component.ts:291`; delete
`wordWrap`/`stripAnsi`.

---

### 6. Ultracode session-mode

**Summary:** the policy is injected but **unenforceable**, and the state machine has
dead states beyond what the spec/ADR define.

#### 🟠 HIGH — Mandated `pi.registerTool` workflow-launch actuator is missing — `src/extension/ultracode/register-ultracode.ts:24`
`registerUltracode` wires `input`/`before_agent_start`/`session_start`/
`session_shutdown`. While "on", it injects a system prompt telling the model to
"author and run dynamic workflows" — but registers **no model-facing tool** to do so.
`launchUltracodeWorkflow`/`BUNDLED_ULTRACODE_WORKFLOW_SCRIPT` exist but are never
called. Net: the policy is unenforceable; the model is told to do something it has no
API for. ADR-0012 (bullet 3) and `spec.md:803-804` both require a `pi.registerTool`
launcher delegating to `launchWorkflow`.
**Pi:** `registerTool` is on `ExtensionAPI` (`extensions/types.ts:1142`); custom tools
surface to the model via `promptSnippet`/`getAllTools` (`types.ts:440,1224`).
**Fix:** Register a `launch_workflow` tool (via `defineTool`, `types.ts:462`) that
reuses `launchUltracodeWorkflow`; register unconditionally and early-return an error
when mode is off. Don't ship an instruction with no actuator plus dead launch code.

#### 🟡 MEDIUM — State machine has unreachable `arming`/`disabled` states — `src/extension/ultracode/mode-state-machine.ts:36`
`valid_trigger` goes straight to `{state:"on"}`, so `policy_injected` (acts only in
`arming`) is a guaranteed no-op — the `before_agent_start` call at
`register-ultracode.ts:65` does nothing. Spec (`spec.md:798`) and ADR-0012 only
describe on/off.
**Fix:** Collapse to `{state:"off"} | {state:"on"; activatedBy; goal}`; remove the
`arming`/`disabled` variants and the dead `policy_injected`/`disable` events.

#### 🟡 MEDIUM — Reminder double-injected (custom message + system-prompt suffix) — `src/extension/ultracode/register-ultracode.ts:121`
`before_agent_start` returns both `message` (a `display:false` CustomMessage that pi
**persists** into the conversation, `agent-session.ts:1107-1117`) and `systemPrompt`
(reset+re-derived each turn, `:1124`) carrying the same text → context bloat that
compounds every turn.
**Fix:** Return **only** `systemPrompt` (it applies every turn and never accumulates);
drop the `message`.

#### ⚪ LOW — `session_shutdown` clears mode in memory but never persists "off" — `src/extension/ultracode/register-ultracode.ts:40`
Restore is entry-replay-authoritative (the last "on" entry wins on reload), so the
in-memory shutdown transition is cosmetic and immediately overwritten by
`session_start`.
**Fix:** Remove the cosmetic transition; keep restore as the single source of truth.

---

### 7. Launch orchestration

**Summary:** `launcher.ts` is **not** the orchestration core — it's a run-lifecycle
module (load source → prepare files → defer background exec → persist manifests →
write terminal artifacts/notifications). The real fan-out/parallel/pipeline/budget/
concurrency live in `runtime.ts` + `scheduler.ts`. Vs pi's single abort-threaded loop
(`agent-loop.ts`) + stateful runtime owner (`agent-session-runtime.ts`), this splits
responsibilities more cleanly — but surfaces several real gaps. *(This dimension was
re-run separately after the first agent overflowed; findings are from a single pass,
not the adversarial double-check the other 32 received — treat the two LOW
serialization/persistence smells as slightly lower-confidence.)*

> Two findings here **corroborate** already-verified ones: budget-not-enforced
> (= RT-2, HIGH) and the meaningless `vm` `timeout:1000` for async fan-out (= RT-4,
> MEDIUM). Listed once below as confirmations; see §1 for the canonical entries.

#### 🟠 HIGH — `isolation: "worktree"` is a no-op — `src/workflows/agent/model.ts:7`, `scheduler.ts`, `pi-runner.ts:46`
`AgentOptions.isolation?: "worktree"` is declared **and** `workflow-authoring-prompt.ts:31`
actively tells the LLM to pass it — but `scheduler.schedule()` never reads it and
`pi-runner.ts` runs every agent in `SessionManager.inMemory(options.cwd)` against the
**same shared cwd**. Agents the author believes are isolated write to the same tree
concurrently → silent file clobbering.
**Pi:** pi binds each session to a concrete `cwd` and recreates cwd-bound services per
runtime (`agent-session-runtime.ts:99-105,200-207`); it has no worktree fan-out to
copy — this must be **built**, not assumed.
**Fix:** Either implement it (`git worktree add` a temp dir per worktree agent, set as
the session `cwd`, clean up in `finally`) or **remove** `isolation` from `AgentOptions`
and the authoring prompt until built, so the LLM stops emitting a silently-ignored
safety option.

#### 🟠 HIGH — Budget tracked but never enforced *(confirms RT-2)* — `runtime.ts:69`
`spentTokens` is incremented **after** each `await scheduler.schedule(...)`, so
concurrent `parallel()` agents all read `remaining()` at the pre-batch value — the
guard must live **inside the scheduler** (alongside the existing `maxTotalAgents`
check, `scheduler.ts:92-96`), not the script-facing `agent()`.
**Pi:** pi has no token ceiling either, but never *advertises* one; `WorkflowBudget`
implies enforcement that isn't wired.

#### 🟡 MEDIUM — `parallel()`/`pipeline()` swallow all errors to `null` — `runtime.ts:161`
Both `catch { return null }`, collapsing a failed agent and a legitimate falsy result
into the same value. The `.filter(Boolean)` contract then silently drops successful
`0`/`""`/`false` alongside failures, with no failure reason; `pipeline` discards the
partial `previous` on any stage failure.
**Pi:** pi never converts errors to `null` — `executeToolCallsParallel` preserves each
outcome as a structured `ToolResultMessage` with `isError`
(`agent-loop.ts:505-515`, `createToolResultMessage:727-737`).
**Fix:** Return a discriminated `{ ok:true, value } | { ok:false, error }` (or a
failure sentinel); document `.filter(r => r.ok)`; surface failures into
`WorkflowFailure[]`.

#### 🟡 MEDIUM — Usage telemetry (tokens/toolCalls) is structurally always zero — `pi-runner.ts:83`
`launcher.ts:685-690` sums `entry.tokens`/`entry.toolCalls` into the terminal
`<usage>`, but `pi-runner` returns only `extractFinalAssistantText(session)` (a string)
and never reports usage; `agent_succeeded` carries only `resultPreview`. So every
`WorkflowAgentProgress.tokens`/`toolCalls` stays `undefined` → reported
`subagent_tokens`/`tool_uses` are always 0.
**Pi:** usage is on the `AssistantMessage` from `streamAssistantResponse`
(`agent-loop.ts:342-354`) — exactly where this runner drops it.
**Fix:** Return `{ text, usage: { tokens, toolCalls } }` from `pi-runner` and thread it
through `agent_succeeded` → `transitionAgent` (which already accepts `tokens`/`toolCalls`
at `state-machine.ts:190-191`). *(This is the same plumbing the §2 `stopReason` fix
should ride along with.)*

#### 🟡 MEDIUM — `vm` `timeout:1000` meaningless for async fan-out *(confirms RT-4)* — `runtime.ts:118`
Same as §1 RT-4 — listed here because the launch reviewer independently reached it.

#### ⚪ LOW — `launcher.ts` conflates lifecycle with notification/XML serialization — `src/workflows/launch/launcher.ts:492`
~110 LOC of presentation (`toTaskNotification`, `taskNotificationXml`, `failuresXml`,
`escapeXml`, `inlineResult`, `formatFailure`) is serialization, not launching. Not a
god-module otherwise.
**Pi:** pi separates formatting (`messages.ts`, `event-bus.ts`) from session lifecycle
(`agent-session-runtime.ts`). **Fix:** extract to `launch/notification.ts` (pure,
unit-testable, −110 LOC).

#### ⚪ LOW — Live-manifest persistence swallows every write error — `launcher.ts:438`
`store.writeRun(state).catch(() => undefined)` drops every intermediate write failure
(disk full, permission) with no log/signal; the UI shows a stale manifest and only the
final `writeTerminalArtifacts` surfaces anything.
**Fix:** Record the last write error and include it in the terminal result / an
`onPersistError` observer. Best-effort is fine for intermediate UI manifests, but not
invisibly.

#### ⚪ LOW — `agent_started` journal write skipped on fast stop → orphaned `stopped` — `scheduler.ts:251`
For an agent stopped while still **queued** (`stopRun`/`stopAgent` at `:171,198,204`),
`#run` never executes, so no `started` promise is registered, yet a `stopped` event is
journaled → a `stopped`-without-`started` replay sequence.
**Pi:** pi emits a terminal aborted message only for calls that actually entered
execution (`agent-loop.ts:440-443,478-481`).
**Fix:** Skip the journal `stopped` write for never-started queued agents, or make the
reducer treat `stopped`-without-`started` as a replay no-op.

---

## Quick wins vs deeper refactors

**Quick wins (mechanical, low-risk):**
- Replace `wordWrap`/`stripAnsi`/`truncateEllipsis`/`padTo`/`formatTokens` with pi-tui
  equivalents (`wrapTextWithAnsi`, `truncateToWidth(...,pad)`, pi's `formatTokens`).
- Drop the redundant `tui.requestRender()` in `workflows-view.ts:58`.
- Make `projector` `now` required; collapse the ultracode state machine to on/off.
- Return only `systemPrompt` from `before_agent_start` (kill the double-injection).
- Add the 4096 fan-out guard and the `budget.total` throw (both ~5 lines).
- Fix `pipeline()` first-stage seed (`let previous = item`).

**Deeper refactors (design decisions):**
- Resolve the sandbox honesty question (accept pi's trust model vs. real isolate).
- Single-writer (or CAS) ownership of `manifest.json`.
- Make subagent failure a first-class outcome (`stopReason`/`errorMessage` plumbing
  end-to-end through the scheduler/journal).
- Implement nested `workflow()` (touches scheduler, budget pool, abort propagation).
- Register the ultracode launch tool and wire `model`/`modelRegistry` from host
  context (turns the dead launch path into a live one).
- Consider decomposing `launcher.ts` (see §7).

---
title: Rebuild The Pi Workflows TUI
status: partial
priority: P2
last_audited: 2026-06-07
implementation: "Projection, layout, navigation, command page objects, TUI adapter tests, chooser/detail/prompt foundations, save-run action, and stopped-run resume affordance exist."
next: "Complete the spec §24 four-state monitor rebuild and keep all actions behind controller/projection boundaries."
---

# Implementation Plan — Rebuild the Pi `/workflows` TUI (spec §24)

Single source of truth for rebuilding `/workflows` into the four-state monitor of
spec §24 (State A overview, State B structured agent detail, State C prompt
reader, State D chooser). Follow top-to-bottom with strict TDD
(red → green → refactor) per step.

---

## 0. Canonical decisions (resolving all open questions)

These supersede any conflicting statement in the four area designs.

### 0.1 Shared field names
- **`WorkflowAgentProgress.prompt?: string`** — the full original prompt. Named
  `prompt` (matches `schedule()` arg and observed-manifest `agent.prompt`). NOT
  `promptFull`/`originalPrompt`. `promptPreview` stays the ≤160-char compact
  slice.
- **`WorkflowRunState.description?: string`** — workflow description, sourced
  `meta.description ?? request.description`. Omitted from headers when
  `undefined`; never a placeholder.

### 0.2 `transitionAgent` carries `prompt` forward automatically
Confirmed by reading `src/workflows/run/state-machine.ts:175` — every branch
spreads `{ ...agent }` via `const nextAgent = { ...agent, state: nextState }`.
So `prompt` survives `started/succeeded/failed/stopped/restarted` with **no
state-machine change**. (Note: `agent_restarted` resets metrics but keeps
`prompt` because it spreads `...nextAgent` and never deletes `prompt`. Leave as
is — restarting an agent keeps its original prompt, which is correct.)

### 0.3 Where helpers live — TWO modules, no duplication
- **`src/workflows/view/layout.ts`** (NEW): PURE width/format helpers. Imports
  `{ truncateToWidth, visibleWidth }` from `@earendil-works/pi-tui` (confirmed
  exported). Holds the *string math*: `headerSummaryLine`, `twoPaneBox`,
  `truncateEllipsis`, `padTo`, `formatTokens`, `formatModelLabel`,
  `formatDuration`, `formatIdle`.
- **The TUI component** (`workflows-component.ts`) consumes `layout.ts`
  directly. We do **NOT** create a separate `src/workflows/view/render.ts` with
  `renderTwoPane`/`renderMonitorHeader`. The component builds plain
  pre-truncated row strings and titles, calls `twoPaneBox`/`headerSummaryLine`
  from `layout.ts`, and applies theme styling only to the *whole produced lines*
  it needs colored (borders/titles stay plain; selected-row accent is applied to
  the cell string BEFORE it is passed in, and `twoPaneBox` measures with
  `visibleWidth` so ANSI is width-safe). This resolves the State-A/B area's open
  question about helper home: **layout.ts is pure and Pi-tui-aware; the component
  owns no box-drawing logic.**

  Rationale: a single bordering implementation (`twoPaneBox`) is unit-tested in
  `layout.test.ts` and reused by both States A and B, satisfying the
  `visibleWidth(line) === width` contract once.

### 0.4 Styling and width: pass styled cells, measure with `visibleWidth`
`twoPaneBox` and `headerSummaryLine` receive cell/line strings that MAY already
contain ANSI styling, and they MUST measure with `visibleWidth` (not
`.length`) and truncate with `truncateToWidth`. Selected-phase/agent accent
coloring is applied by the component to the cell text; because the box measures
visible width, borders stay aligned. Titles and borders are styled by the
component AFTER `twoPaneBox` returns is NOT allowed (would break width) — instead
`twoPaneBox` returns plain box lines and the component does not re-style border
lines. Border/title styling: keep borders unstyled (plain `┌─┬─┐`) for v1;
accent styling of borders is a later enhancement. The width tests require
`visibleWidth(line) <= width`; plain borders trivially satisfy `=== width`.

### 0.5 Pane split ratio (deterministic for width tests)
`twoPaneBox` computes `leftWidth` from the caller; the component passes
`leftWidth = clamp(maxLeftRowVisibleWidth + 2, 12, floor(width * 0.4))`. For the
fixed test widths (42, 120) this is deterministic. Right inner width =
`width - leftWidth - 3` (two outer borders + one divider, plus the single-space
cell padding handled inside `twoPaneBox`). `twoPaneBox` asserts every produced
line `visibleWidth === width` and throws in dev if not (caught by tests).

### 0.6 Fixed visible-row heights (no terminal height available)
`render(width)` has no height. Use module constants:
- `PROMPT_VISIBLE_ROWS = 15` (State C window; spec shows `1-15 of 29`).
- `PANE_VISIBLE_ROWS = 10` (States A/B body rows; matches spec screen ~10 body
  rows). Phase/agent lists beyond this scroll via the existing windowing.

### 0.7 Token / duration / idle formatting
- `formatTokens(n)`: `n < 1000 → String(n)`; else one decimal `k`, trailing
  `.0` trimmed. `41100 → "41.1k"`, `266100 → "266.1k"`, `900 → "900"`. Uses
  `Math.floor(n/100)/10` (floor to one decimal, matching `41100→41.1`).
- `formatDuration(ms)`: reuse the existing projector shape (`42s`, `1m 12s`,
  `1h 2m 3s`). `formatIdle(ms)` = same minutes/seconds shape (`72_000 → "1m 12s"`,
  `42_000 → "42s"`). Both live in `layout.ts`; the projector keeps its own
  `formatDuration` OR re-exports layout's — see §0.8.
- Header elapsed in State A screen shows `1m12s` (no space) but spec §24.6 chooser
  shows `5m 58s` (space). **Decision:** header/chooser elapsed both use
  `formatDuration` with a SPACE (`1m 12s`). The State A test asserts
  `/1\/8 agents · 1m ?12s/` (optional space) so a space passes. Replace the
  current `elapsedSince` (`1m12s`, no space) usage.

### 0.8 `formatDuration` single home
Keep `formatDuration` exported from `src/workflows/view/projector.ts` (the
command already imports it from there). `layout.ts` re-exports it
(`export { formatDuration } from "./projector.ts"`) OR defines `formatIdle` and a
local duration formatter. **Decision:** move the canonical implementation into
`layout.ts`, and have `projector.ts` re-export it
(`export { formatDuration } from "./layout.ts"`) so the command import path is
unchanged. This avoids two divergent duration formatters.

### 0.9 `isActiveRun` / active-count semantics — single home
Define `isActiveRun(status)` and `chooserCounts(runs)` ONCE in
`src/workflows/view/projector.ts` and export them. The component imports them
(no local duplicate).
- `isActiveRun(status)` = `true` for
  `starting|running|pausing|paused|resuming|completing`; `false` for
  `created|completed|failing|failed|stopping|stopped`.
- Chooser counts: `running = count(isActiveRun)`, `completed =
  count(status === "completed")`. Failed/stopped rows are still listed but not
  counted (matches spec showing only `running · completed`).

### 0.10 Routing on active count
Constructor/`setRuns` route by **active** count, not `runs.length`:
- `runs.length === 0` → empty state (rendered in `render()`).
- `runs.length >= 1 && activeRunCount(runs) <= 1` → `overview` (State A).
  (A single completed run still opens overview.)
- `runs.length > 1` with `activeRunCount > 1` → `chooser`. Refinement: spec
  §24.6 shows chooser whenever multiple workflows exist in session. **Decision:**
  `chooser` when `runs.length > 1`; `overview` when `runs.length === 1`. The
  "active" nuance only matters for default selection and counts, not the
  overview-vs-chooser branch — because §24.10 says "one active visible workflow
  → State A; multiple visible → State D". So: `runs.length <= 1 → overview`,
  `runs.length > 1 → chooser`. This keeps Case3 (single completed → overview)
  correct and Case2 (two running → chooser) correct.

### 0.11 Default chooser selection
`defaultChooserSelection(runs)` = index of the active run with the greatest
`startTime`; fallback to first active; fallback `0`. Implemented in `projector.ts`
as part of `buildChooserView().defaultSelectedIndex` and reused by the component.

### 0.12 Model context suffix (`Opus 4.8 (1M context)`)
`formatModelLabel(model)` returns `model` as-is for v1 (the manifest already
stores the full `model` string, which in real runs is `Opus 4.8 (1M context)`).
No new `modelContextLabel` field. State B test sets
`model:'Opus 4.8 (1M context)'` directly. Omit the model field entirely when
`model` is `''`, `'unknown'`, or `'default'`.

### 0.13 Idle source needs `lastProgressAt` threaded
`idleMs` derives from `now - lastProgressAt` for running agents with no tokens.
The live scheduler path already sets `lastProgressAt` via the state machine. The
**store path must also thread `lastProgressAt`** so reloaded runs can show idle.
Add to `normalizeObservedAgents` and `isWorkflowProgressEntry` handling (optional
field). See Step 1.4.

### 0.14 Manifest size
Inlining the full `prompt` per agent into `manifest.json` is accepted (spec
mandates no prompt text lost; there is no separate per-agent transcript file to
point at). All new fields optional → old manifests still validate.

### 0.15 State C reads full prompt; State B never does
State C: `selectedAgent.prompt ?? selectedAgent.promptPreview`. State B: ONLY
`promptPreview`. Negative test guards State B against future regression.

### 0.16 Navigation state shape (canonical)
```ts
interface MonitorNavigationState {
  readonly screen: 'chooser' | 'overview' | 'agentDetail' | 'promptReader';
  readonly selectedRunIndex: number;
  readonly selectedPhaseIndex: number;
  readonly selectedAgentIndex: number;
  readonly promptScrollOffset: number;
}
interface MonitorBounds {
  readonly runCount: number;
  readonly phaseCount: number;
  readonly agentCount: number;
  readonly promptLineCount: number;
}
```
The **component keeps its own private fields** (`#screen`, `#selectedRunIndex`,
`#selectedPhaseIndex`, `#selectedAgentIndex`, `#promptScroll`) and may EITHER
delegate to the pure `navigation.ts` functions OR keep its current inline
handlers. **Decision:** the component delegates routing decisions
(active-count, default selection) to `projector.ts` helpers but keeps its inline
`handleInput` key dispatch (it already matches spec transitions). The pure
`navigation.ts` module is rewritten and unit-tested as the *reference* state
machine; wiring the component to call it is a refactor in Step 6 (optional, low
risk). This avoids a risky big-bang rewrite of `handleInput` while still
delivering the tested pure machine.

### 0.17 Reserved keys
`s` (save), `x` (stop), `r` (restart) remain footer labels with no handlers
(no-ops) for v1, per §24.10. `p` keeps its existing pause/resume handler.
Footers are STATIC text (`p pause`) per spec, replacing the dynamic
`#pauseHelpText()`.

---

## Dependency order

1. **Read-model / data plumbing** (model fields + scheduler + store + launcher).
2. **Pure view layer**: `layout.ts`, `projector.ts` (monitor/chooser builders +
   active helpers), `navigation.ts` (screen machine) — each with unit tests.
3. **TUI renderers**: State A & B (two-pane), then State C & D.
4. **Command routing** confirmation.
5. **Refactor / cleanup** (delete legacy layout code, optionally wire component to
   `navigation.ts`).

Backward-compat and width contracts are called out per step and summarized in §7.

---

## Step 1 — Read-model / data plumbing

### 1.1 `prompt` field on the model (RED is structural — compile)
**Edit** `src/workflows/agent/model.ts`: add after `promptPreview: string;`
```ts
  /** Compact ≤160-char preview for narrow rows. */
  promptPreview: string;
  /** Full original prompt for State C; optional for legacy manifests/snapshots. */
  prompt?: string;
```
**Edit** `src/workflows/run/model.ts`: add to `WorkflowRunState` after
`workflowName: string;`:
```ts
  description?: string;
```

### 1.2 Scheduler threads the full prompt
**Failing test** — `test/workflows/agent/scheduler.test.ts`:
- `should expose the full original prompt on the progress entry, not only the truncated preview`
  - Arrange: `const longPrompt = 'L'.repeat(500)`; scheduler with
    `maxConcurrent:1, runner: async ({ prompt }) => prompt`.
  - Act: `await scheduler.schedule(longPrompt, { label: 'audit' }); const [row] = scheduler.progress();`
  - Assert: `row.prompt === longPrompt`; `row.promptPreview === longPrompt.slice(0,160)`;
    `row.promptPreview.length === 160`.

**Edit** `src/workflows/agent/scheduler.ts` (the `this.#progress.push({…})` at
lines 111-123): add `prompt,` alongside `promptPreview: prompt.slice(0, 160)`.
No state-machine change (see §0.2).

**Green:** `pnpm test scheduler`.

### 1.3 Store: full prompt round-trips (strict + observed + legacy)
**Failing tests** — `test/workflows/run/store.test.ts`:
- `should preserve the full agent prompt when reloading a persisted manifest`
  - Write manifest whose `workflowProgress[0]` is a `workflow_agent` with
    `promptPreview:'P'.repeat(160)`, `prompt:'P'.repeat(400)`, all required
    fields. Assert `readRun` ok and the agent row `prompt === 'P'.repeat(400)`.
- `should recover the full agent prompt from an observed snapshot manifest`
  - Write `{runId,name,script,scriptPath,snapshot:{agents:[{prompt:'X'.repeat(300),status:'success'}]}}`.
    Assert `agentRow.prompt === 'X'.repeat(300)` and
    `agentRow.promptPreview === 'X'.repeat(160)`.
- `should accept legacy manifests whose agent rows omit the prompt field`
  - `workflow_agent` entry with `promptPreview` but no `prompt` key. Assert ok,
    `agentRow.prompt === undefined`, `promptPreview` preserved.
- `should expose the workflow description from a persisted manifest and omit it when absent`
  - A: strict manifest `description:'Audit the extension'` → `value.description === 'Audit the extension'`.
  - B: strict manifest, no description → `value.description === undefined`.

**Edits** `src/workflows/run/store.ts`:
1. `toWorkflowRunState` return object: add
   `description: isString(value.description) ? value.description : undefined,`.
   Do **not** add `description` to the required-field guard (lines 168-182).
2. `observedManifestToRunState` return object: add
   ```ts
   description: isString(value.description)
     ? value.description
     : isRecord(value.snapshot) && isString(value.snapshot.description)
       ? value.snapshot.description
       : undefined,
   ```
3. `normalizeObservedAgents` return object (line 307 area): keep
   `promptPreview: isString(agent.prompt) ? agent.prompt.slice(0,160) : ""` AND
   add `prompt: isString(agent.prompt) ? agent.prompt : undefined,` and
   `lastProgressAt: isNumber(agent.lastProgressAt) ? agent.lastProgressAt : endedAt`
   (so idle can render for reloaded running agents; §0.13).
4. `isWorkflowProgressEntry`: keep `prompt` optional — add to the
   `workflow_agent` branch `&& (value.prompt === undefined || isString(value.prompt))`.
   Never make it mandatory.
5. Replace `normalizeProgress`’s bare `progress.filter(isWorkflowProgressEntry)`
   with a map that deterministically copies the full prompt for agent entries:
   ```ts
   function normalizeProgress(progress: unknown[]): WorkflowProgressEntry[] {
     return progress.filter(isWorkflowProgressEntry).map(normalizeAgentEntry);
   }
   function normalizeAgentEntry(entry: WorkflowProgressEntry): WorkflowProgressEntry {
     if (entry.type !== "workflow_agent") return entry;
     return { ...entry, prompt: isString(entry.prompt) ? entry.prompt : undefined };
   }
   ```
   (`isString` already in module.)

**Green:** `pnpm test store`. **Backward-compat:** all four new behaviors keep
old manifests valid (prompt/description optional).

### 1.4 Launcher persists `description`
**Failing test** — `test/workflows/launch/launcher.test.ts`:
- `should persist the workflow description from meta.description on the initial run state`
  - Launch a script whose parsed `meta.description='Audit pi-webfetch'`; read the
    written manifest via `store.readRun(runId)`. Assert `run.description === 'Audit pi-webfetch'`.
  - Also: `meta.description` absent but `request.description='from request'` →
    `run.description === 'from request'`.

**Edits** `src/workflows/launch/launcher.ts`:
1. In `initialState` (lines 87-101) add
   `description: parsed.value.meta.description ?? request.description,`. Reuse the
   existing `summarySource` local where possible (note `summarySource` falls back
   to `meta.name`; `description` must NOT fall back to name — keep them separate).
2. `mergeRuntimeState` (lines 576-592): it already spreads `...initialState`
   first, so `description` is preserved automatically. Confirm no later key
   overrides it (it does not). No edit required beyond a confirming comment.

**Green:** `pnpm test launcher`.

---

## Step 2 — `src/workflows/view/layout.ts` (NEW, pure)

**Failing tests** — `test/workflows/view/layout.test.ts` (import
`{ visibleWidth } from "@earendil-works/pi-tui"` for assertions):
- `should right-align the summary within the width`
  - `headerSummaryLine('repo-audit','1/8 agents · 1m12s', 50)`:
    `visibleWidth === 50`, `startsWith('repo-audit')`, `endsWith('1/8 agents · 1m12s')`.
- `should truncate the left side with an ellipsis when summary does not fit`
  - `headerSummaryLine('x'.repeat(80),'1/8 · 1m12s', 40)`:
    `visibleWidth === 40`, contains `'…'`, `endsWith('1/8 · 1m12s')`.
- `should build a two-pane box where every line equals the width`
  - `twoPaneBox({leftTitle:'Phases', rightTitle:'Slice · 7 agents',
    leftLines:['› 1 Slice 0/7'], rightLines:['● slice:P0.1 41.1k tok · 11 tools'],
    leftWidth:23, width:42})`: every line `visibleWidth === 42`; `lines[0]`
    contains `'┌ Phases'` and `'┬'`; `lines.at(-1)` contains `'└'` and `'┴'`.
- `should never let pane content cross the divider border`
  - long left/right lines, `leftWidth:10, width:42`: every body line
    `visibleWidth === 42`, `startsWith('│')`, `endsWith('│')`.
- `should format tokens compactly as k`
  - `formatTokens(41_100) === '41.1k'`, `formatTokens(900) === '900'`,
    `formatTokens(266_100) === '266.1k'`.
- `should format idle duration as idle label`
  - `formatIdle(72_000) === '1m 12s'`, `formatIdle(42_000) === '42s'`.

**Implement** `src/workflows/view/layout.ts`:
```ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function truncateEllipsis(text: string, width: number): string {
  if (width < 1) return "";
  if (visibleWidth(text) <= width) return text;
  return `${truncateToWidth(text, Math.max(0, width - 1), "")}…`;
}
export function padTo(text: string, width: number): string {
  const t = truncateEllipsis(text, width);
  return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}
export function headerSummaryLine(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const leftMax = Math.max(0, width - rightW - 1);
  const leftCell = padTo(truncateEllipsis(left, leftMax), leftMax);
  return `${leftCell} ${right}`; // visibleWidth === leftMax + 1 + rightW === width
}
export function twoPaneBox(opts: {
  leftTitle: string; rightTitle: string;
  leftLines: string[]; rightLines: string[];
  leftWidth: number; width: number;
}): string[] { /* see §0.5; top/bottom borders + body rows, each padTo'd, assert width */ }
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = Math.floor(n / 100) / 10;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}
export function formatModelLabel(model: string): string { return model; }
export function formatDuration(ms: number): string { /* '42s' | '1m 12s' | '1h 2m 3s'; ms<1000 -> `${ms}ms` */ }
export function formatIdle(ms: number): string { /* same min/sec shape as formatDuration but always seconds-floor; 72000 -> '1m 12s' */ }
```
`twoPaneBox` internals (canonical, §0.5):
- inner left width `li = leftWidth`; inner right width `ri = width - leftWidth - 3`.
- top: `'┌ ' + padTo(leftTitle, li-2 fill with ─) ...` — build as
  `┌` + `' ' + leftTitle + ' '` padded with `─` to `li`, then `┬`, then right
  title padded with `─` to `ri`, then `┐`; assert visibleWidth === width.
- body row `i`: `'│ ' + padTo(leftLines[i] ?? '', li-2) + ' │ ' + padTo(rightLines[i] ?? '', ri-2) + ' │'`.
  (Account for the single space gutter each side — final visibleWidth === width.)
- bottom: `'└' + '─'.repeat(li) + '┴' + '─'.repeat(ri) + '┘'`.
- Pad both line lists to `max(leftLines.length, rightLines.length)` (short pane →
  blank cells).
- After building, assert `lines.every(l => visibleWidth(l) === width)`; throw in
  dev so tests catch drift.

`formatDuration` is the canonical home (§0.8). Then **edit `projector.ts`** to
`export { formatDuration } from "./layout.ts";` and delete its local copy (keep
the export so `workflows-command.ts` import is unbroken).

**Green:** `pnpm test layout`.

---

## Step 3 — `projector.ts` monitor/chooser builders + active helpers

### 3.1 New view-model types
**Edit** `src/workflows/view/model.ts` — add (keep legacy
`WorkflowRunsViewModel`/`WorkflowRunRow`/`WorkflowRunDetails`/`WorkflowPhaseSummary`
for now; mark legacy with a comment; they are removed in Step 6 once the
component no longer uses them):
```ts
export interface MonitorAgentRow {
  glyph: string; label: string; state: WorkflowAgentProgress["state"];
  modelLabel?: string; tokens?: number; toolCalls?: number; idleMs?: number;
  fullPrompt: string; promptPreview: string;
  lastToolName?: string; lastToolSummary?: string; resultPreview?: string;
}
export interface MonitorPhaseRow { title: string; doneAgents: number; totalAgents: number; selected: boolean; }
export interface MonitorViewModel {
  header: { workflowName: string; description?: string; doneAgents: number; totalAgents: number; elapsedLabel: string };
  phases: MonitorPhaseRow[];
  selectedPhaseIndex: number;
  selectedPhaseAgents: MonitorAgentRow[];
}
export interface ChooserRow {
  glyph: string; workflowName: string; agentCount: number;
  tokens?: number; durationLabel: string; status: WorkflowRunStatus; selected: boolean;
}
export interface ChooserViewModel {
  runningCount: number; completedCount: number; rows: ChooserRow[]; defaultSelectedIndex: number;
}
```
Keep `WorkflowViewFocus` only until `navigation.ts` stops importing it (Step 4),
then remove.

### 3.2 Builders + active helpers
**Failing tests** — `test/workflows/view/projector.test.ts` (these REPLACE the
old generic-projector tests, see §8):
- `should count done as terminal-success agents over visible agent rows`
  - 3 agents (`done`,`running`,`failed`), `agentCount:99`; `selectedPhaseIndex:0`
    (or all in one phase). `header.doneAgents === 1`, `header.totalAgents === 3`.
- `should omit model and metrics fields when agent data is missing`
  - agent `model:'unknown', tokens:undefined, toolCalls:undefined, lastProgressAt:undefined`
    → `row.modelLabel/tokens/toolCalls` all `undefined`.
- `should expose idle duration when an agent is running without metrics`
  - `now=100_000`, agent `running, tokens:undefined, lastProgressAt:now-72_000`
    → `row.tokens === undefined`, `row.idleMs === 72_000`.
- `should include only the selected phase agents in the monitor view`
  - two phases, `selectedPhaseIndex:1` → `selectedPhaseAgents.map(r=>r.label) === ['author:a']`.
- `should omit the description when the run has none`
  - `header.description === undefined`.
- `should expose the full prompt on agent rows for the prompt reader`
  - agent `prompt:'x'.repeat(500)` → `selectedPhaseAgents[0].fullPrompt.length === 500`.
- `should build a chooser model with running and completed counts`
  - `runningCount===1`, `completedCount===1`; hardening row `tokens===266_100`,
    `agentCount===8`.
- `should default chooser selection to the newest running workflow`
  - 3 runs (`running@10`,`completed@99`,`running@50`) →
    `rows[defaultSelectedIndex].workflowName === 'new'`.
- `should omit chooser token total when no tokens were recorded`
  - `totalTokens:0` → `rows[0].tokens === undefined`.

**Implement** in `src/workflows/view/projector.ts`:
```ts
export function isActiveRun(status: WorkflowRunStatus): boolean { /* §0.9 */ }
export function chooserCounts(runs: WorkflowRunState[]): { running: number; completed: number } { /* §0.9 */ }
export function defaultChooserSelection(runs: WorkflowRunState[]): number { /* §0.11 */ }

export function buildMonitorView(
  run: WorkflowRunState,
  opts: { selectedPhaseIndex: number; now?: number },
): MonitorViewModel {
  const now = opts.now ?? Date.now();
  const agents = run.workflowProgress.filter(isWorkflowAgentProgress);
  const titles = uniquePhaseTitles(run, agents);      // reuse, run.phases first
  const phases = titles.map((title, i) => ({
    title,
    totalAgents: agents.filter(a => a.phaseTitle === title).length,
    doneAgents: agents.filter(a => a.phaseTitle === title && a.state === "done").length,
    selected: i === opts.selectedPhaseIndex,
  }));
  const selTitle = phases[opts.selectedPhaseIndex]?.title;
  const selectedPhaseAgents = agents
    .filter(a => a.phaseTitle === selTitle)
    .map(a => toAgentRow(a, now));
  return {
    header: {
      workflowName: run.workflowName,
      description: run.description,                    // undefined => omit (§0.1)
      doneAgents: agents.filter(a => a.state === "done").length,
      totalAgents: agents.length,                     // visible rows, NOT run.agentCount
      elapsedLabel: formatDuration(run.durationMs ?? Math.max(0, now - run.startTime)),
    },
    phases, selectedPhaseIndex: opts.selectedPhaseIndex, selectedPhaseAgents,
  };
}

function toAgentRow(a: WorkflowAgentProgress, now: number): MonitorAgentRow {
  const hasModel = a.model !== "" && a.model !== "unknown" && a.model !== "default";
  const idleMs = a.state === "running" && a.tokens === undefined && a.lastProgressAt !== undefined
    ? Math.max(0, now - a.lastProgressAt) : undefined;
  return {
    glyph: agentGlyph(a.state), label: a.label, state: a.state,
    modelLabel: hasModel ? formatModelLabel(a.model) : undefined,
    tokens: a.tokens !== undefined && a.tokens > 0 ? a.tokens : undefined,
    toolCalls: a.toolCalls !== undefined && a.toolCalls > 0 ? a.toolCalls : undefined,
    idleMs,
    fullPrompt: a.prompt ?? a.promptPreview,          // §0.15
    promptPreview: a.promptPreview,
    lastToolName: a.lastToolName, lastToolSummary: a.lastToolSummary, resultPreview: a.resultPreview,
  };
}

export function buildChooserView(runs: WorkflowRunState[], opts: { now?: number } = {}): ChooserViewModel {
  const { running, completed } = chooserCounts(runs);
  const def = defaultChooserSelection(runs);
  return {
    runningCount: running, completedCount: completed, defaultSelectedIndex: def,
    rows: runs.map((run, i) => ({
      glyph: isActiveRun(run.status) ? "↻" : run.status === "completed" ? "✓" : statusGlyph(run.status),
      workflowName: run.workflowName,
      agentCount: run.agentCount,
      tokens: run.totalTokens > 0 ? run.totalTokens : undefined,
      durationLabel: formatDuration(run.durationMs ?? Math.max(0, (opts.now ?? Date.now()) - run.startTime)),
      status: run.status, selected: i === def,
    })),
  };
}
```
Add a small `agentGlyph(state)` (running/queued→`●`, done→`✓`, failed→`!`,
stopped→`■`). Reuse `uniquePhaseTitles`, `isWorkflowAgentProgress`. Keep the
legacy `projectWorkflowsView`/`toRunDetails` for now (deleted Step 6).

**Green:** `pnpm test projector`.

---

## Step 4 — `navigation.ts` screen state machine

**Failing tests** — `test/workflows/view/navigation.test.ts` (REWRITE the file;
remove the old focus tests `should cycle focus between runs agents and details`,
`should skip agent focus…`, `should enter agent focus…`, and adapt the move/clamp
tests). New tests:
- `should start at overview for one active workflow and chooser for many`
  - `initialMonitorNavigation(1).screen === 'overview'`; `(2) === 'chooser'`;
    `(0) === 'chooser'`.
- `should move the phase selection in the overview` — overview ↑↓ changes
  `selectedPhaseIndex` (clamped to `phaseCount`) and resets `selectedAgentIndex` to 0.
- `should open agent detail from overview with left` — overview+`left`+`agentCount>0`
  → `agentDetail`.
- `should return to overview from agent detail with right` — agentDetail+`right` → `overview`.
- `should move the agent selection in the detail view` — agentDetail ↑↓ →
  `selectedAgentIndex` clamped to `agentCount`.
- `should open the prompt reader from detail with enter and reset scroll` —
  agentDetail enter → `promptReader`, `promptScrollOffset === 0`.
- `should scroll the prompt reader with movement and clamp at bounds` —
  promptReader ↑↓ adjust `promptScrollOffset` clamped `[0, promptLineCount-1]`.
- `should walk back chooser to overview to detail to prompt and esc to unwind` —
  `escapeMonitor`: promptReader→agentDetail→overview→chooser (runCount>1);
  chooser → `{ close: true }`.
- `should select a run from the chooser and open overview on enter` — chooser ↑↓
  → `selectedRunIndex`; enter → `overview` with phase/agent indices reset.
- `should clamp stale monitor selections after the run list refreshes` —
  `clampMonitorNavigation` re-clamps indices; `agentDetail` with `agentCount===0`
  demotes to `overview`; stale `selectedRunIndex:9`→`0`.

**Implement** — replace whole file `src/workflows/view/navigation.ts`:
```ts
export interface MonitorNavigationState { /* §0.16 */ }
export interface MonitorBounds { /* §0.16 */ }

export function initialMonitorNavigation(runCount: number): MonitorNavigationState {
  return { screen: runCount === 1 ? "overview" : "chooser",
    selectedRunIndex: 0, selectedPhaseIndex: 0, selectedAgentIndex: 0, promptScrollOffset: 0 };
}
export function moveMonitorSelection(s, b, dir): MonitorNavigationState { /* per-screen, see tests */ }
export function focusInMonitor(s, b, dir: "left" | "right"): MonitorNavigationState {
  if (s.screen === "overview" && dir === "left" && b.agentCount > 0) return { ...s, screen: "agentDetail" };
  if (s.screen === "agentDetail" && dir === "right") return { ...s, screen: "overview" };
  return s;
}
export function enterMonitor(s, b): MonitorNavigationState {
  if (s.screen === "chooser") return { ...s, screen: "overview", selectedPhaseIndex: 0, selectedAgentIndex: 0 };
  if (s.screen === "overview" && b.agentCount > 0) return { ...s, screen: "agentDetail" };
  if (s.screen === "agentDetail") return { ...s, screen: "promptReader", promptScrollOffset: 0 };
  return s;
}
export function escapeMonitor(s, b): { state?: MonitorNavigationState; close?: boolean } {
  if (s.screen === "promptReader") return { state: { ...s, screen: "agentDetail" } };
  if (s.screen === "agentDetail") return { state: { ...s, screen: "overview" } };
  if (s.screen === "overview") return b.runCount > 1 ? { state: { ...s, screen: "chooser" } } : { close: true };
  return { close: true }; // chooser
}
export function clampMonitorNavigation(s, b): MonitorNavigationState { /* clamp all indices; demote agentDetail->overview if agentCount===0; demote promptReader->agentDetail if promptLineCount===0; keep chooser */ }
```
Remove `import type { WorkflowViewFocus }`. `moveMonitorSelection` per screen:
chooser→`selectedRunIndex` (reset phase/agent 0); overview→`selectedPhaseIndex`
(reset agent 0); agentDetail→`selectedAgentIndex`; promptReader→`promptScrollOffset`
clamped `[0, promptLineCount-1]`. Keep `clampIndex`.

**Green:** `pnpm test navigation`. After this, `WorkflowViewFocus` is unused in
`navigation.ts`; defer its type removal to Step 6 (component still references the
legacy projector path until Step 5/6).

---

## Step 5 — TUI renderers

The component imports from `layout.ts` (`twoPaneBox`, `headerSummaryLine`,
`formatTokens`, `formatModelLabel`, `formatIdle`, `formatDuration`) and from
`projector.ts` (`buildMonitorView`, `buildChooserView`, `isActiveRun`,
`chooserCounts`, `defaultChooserSelection`). The component switches its data
source from `projectWorkflowsView` to `buildMonitorView`/`buildChooserView`.

### 5.1 Header helper (shared by A & B)
Add a private `#renderHeader(view: MonitorViewModel, width)`:
- line 1: `'─'.repeat(width)` accent rule.
- line 2: `headerSummaryLine(bold-accent(name), '<done>/<total> agents · <elapsed>', width)`.
  Apply `this.#theme.bold(this.#theme.fg("accent", name))` to the left arg
  BEFORE passing (headerSummaryLine measures visibleWidth, §0.4).
- line 3: muted `description` (single `truncateEllipsis(description, width)`)
  ONLY when `header.description` is a non-empty string; otherwise omit.
- line 4: blank.

### 5.2 State A — `#renderOverview`
**Failing tests** — `test/extension/tui/workflows-component.test.ts`:
- `should render State A overview as a bordered two-pane monitor with Phases and agent metrics`
  - Arrange single running run, phases `[{title:'Slice'},{title:'Author'}]`,
    7 `slice:*` agents in Slice (one running idle w/o tokens, others
    `tokens:41100/toolCalls:11`), 1 done `author:*`; `startTime = Date.now()-72000`.
  - Assert (`render(120).join('\n')`): `toContain('┌ Phases')`;
    `toContain('Slice · 7 agents')`; `toMatch(/1\/8 agents · 1m ?12s/)`;
    `toContain('› 1 Slice')`; `toContain('0/7')`; `toContain('✓ Author')`;
    `toContain('41.1k tok · 11 tools')`; `toContain('idle ')`;
    `toContain('↑↓ select · ← detail · x stop workflow · p pause · esc back · s save')`;
    `not.toContain('Progress')`; `not.toContain('Details')`.
- `should omit absent model and metric fields in State A agent rows`
  - one running agent `model:'', tokens:undefined, toolCalls:undefined`,
    `lastProgressAt` set. Assert `not.toContain('No metrics yet')`,
    `not.toContain('Still collecting')`, `not.toContain('unknown')`; no trailing
    `·` tail beyond label when no idle either.

**Implement** — replace `#renderOverview` body:
```ts
const view = buildMonitorView(run, { selectedPhaseIndex: this.#selectedPhaseIndex });
const header = this.#renderHeader(view, width);
const selPhase = view.phases[this.#selectedPhaseIndex];
const phaseRows = view.phases.map((p, i) =>
  `${i === this.#selectedPhaseIndex ? "› " : "  "}${i + 1} ${p.title}  ${p.doneAgents}/${p.totalAgents}`);
const rightTitle = `${selPhase?.title ?? ""} · ${view.selectedPhaseAgents.length} agents`;
const leftWidth = clampLeftWidth(phaseRows, width);
const agentRows = view.selectedPhaseAgents.map(a => this.#overviewAgentRow(a, rightInnerWidth(width, leftWidth)));
return [...header, ...twoPaneBox({ leftTitle: "Phases", rightTitle, leftLines: phaseRows, rightLines: agentRows, leftWidth, width })];
```
`#overviewAgentRow(a, innerWidth)`: compose
`${a.glyph} ${label}${a.modelLabel ? ' ' + a.modelLabel : ''}` left part,
right metric segment from `#overviewMetrics(a)` =
`a.tokens !== undefined ? '${formatTokens(a.tokens)} tok' + (a.toolCalls ? ' · ${a.toolCalls} tools' : '')`
else `a.idleMs !== undefined ? 'idle ${formatIdle(a.idleMs)}'` else `''`.
Right-align metric within `innerWidth` (truncate label so left+gap+metric fit).
Remove all `Runs/Progress/Phases/Agents/Details` heading pushes and the
`output:`/`tokens:` Details block.

### 5.3 State B — `#renderAgentDetail`
**Failing tests**:
- `should render State B structured detail as bordered two-pane with ordered sections`
  - Arrange running run, phase 'Slice' multiple agents; selected first agent
    `running, model:'Opus 4.8 (1M context)', tokens:41100, toolCalls:11`,
    17-line `promptPreview`, `lastToolName` set, `resultPreview:undefined`.
  - Act: `handleInput('\x1b[D')` (left); `render(120).join('\n')`.
  - Assert order via `indexOf`: `'● Running' < '41.1k tok' < 'Prompt ·' < 'Activity ·' < 'Outcome'`;
    `toContain('┌ Slice · ')`; `toContain('› ● slice')`;
    `toContain('Opus 4.8 (1M context)')`; `toContain('41.1k tok · 11 tool calls')`;
    `toContain('Prompt · 17 lines · ↵ expand')`; `toContain('… ')`;
    `toContain('Activity · last 3 of 11 tool calls')`; `toContain('Still running')`;
    `toContain('↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save')`.
- `should not dump the full prompt body in State B structured detail`
  - agent `promptPreview:'line1\nline2'` (2 lines) plus a unique
    `prompt` value containing `'SENTINEL_FULL_PROMPT_BODY'`. Assert
    `not.toContain('SENTINEL_FULL_PROMPT_BODY')`; Prompt section shows `'… '`
    affordance / `'↵ expand'`.
- `should show a muted empty activity state in State B when no tool calls recorded`
  - running agent `lastToolName:undefined, toolCalls:undefined`. Assert joined
    `toContain('Activity')` and a muted empty marker (e.g. `'No tool activity'`);
    every line `visibleWidth<=120`; `toMatch(/│.*Activity/)`.

**Implement** — replace `#renderAgentDetail` body:
```ts
const view = buildMonitorView(run, { selectedPhaseIndex: this.#selectedPhaseIndex });
const header = this.#renderHeader(view, width);
const agents = view.selectedPhaseAgents;
const sel = agents[this.#selectedAgentIndex];
const leftTitle = `${view.phases[this.#selectedPhaseIndex]?.title ?? ""} · ${agents.length} agents`;
const agentListRows = agents.map((a, i) =>
  `${i === this.#selectedAgentIndex ? "› " : "  "}${a.glyph} ${truncated(a.label)}`);
const detailRows = sel ? this.#detailSections(sel) : ["No agent selected"];
const leftWidth = clampLeftWidth(agentListRows, width);
return [...header, ...twoPaneBox({ leftTitle, rightTitle: sel?.label ?? "", leftLines: agentListRows, rightLines: detailRows, leftWidth, width })];
```
`#detailSections(a: MonitorAgentRow)` produces, IN ORDER:
1. status/model: `${a.glyph} ${capitalize(a.state)}${a.modelLabel ? ' · ' + a.modelLabel : ''}`
2. metrics: join with ` · ` omitting absent —
   `[a.tokens && '${formatTokens(a.tokens)} tok', a.toolCalls && '${a.toolCalls} tool calls', a.idleMs!==undefined && 'idle ${formatIdle(a.idleMs)}']`.
3. `''`
4. `Prompt · ${lineCount(a.promptPreview)} lines · ↵ expand`
5. preview lines from **`a.promptPreview` ONLY** (first 2, then `… N more lines`).
6. `''`
7. `Activity · last 3 of ${a.toolCalls ?? 0} tool calls`
8. activity rows: `a.lastToolName ? [name+summary] : ['No tool activity recorded']`.
9. `''`, `Outcome`, `  ${outcomeText(a)}`.
All rows are plain strings; `twoPaneBox` pads/truncates into the right pane
(empty-activity line therefore renders between `│` borders → `/│.*Activity/`).

### 5.4 Glyphs and footers
- Add `agentGlyph(state)` module fn (running/queued→`●`, done→`✓`, failed→`!`,
  stopped→`■`). Keep `statusGlyph` for chooser (running-ish→`↻`, completed→`✓`).
- Replace `#helpText` overview/agentDetail branches with STATIC strings:
  - overview: `'↑↓ select · ← detail · x stop workflow · p pause · esc back · s save'`
  - agentDetail: `'↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save'`
  - Remove `#pauseHelpText()` usage (delete or keep unused). `p` still calls
    `#handlePauseResume`.

### 5.5 State C — `#renderPromptReader`
Add field `#promptScroll = 0;` near `#selectedAgentIndex`. In `handleInput`,
when `#screen==='promptReader'`: `'j'` or `Key.down` → increment (clamp to
maxScroll), `'k'` or `Key.up` → decrement (≥0); invalidate on change. Entering
promptReader (`#handleEnter`) resets `#promptScroll=0`; escaping promptReader
(`#handleEscape`) resets `#promptScroll=0`.

**Failing tests**:
- `should render the prompt reader as a bordered box titled with the full line count`
  - agent `prompt:` 17 lines (`Original prompt line 1..17`),
    `promptPreview:'Original prompt line 1'`. Act `\x1b[D` then `\r`;
    `render(120).join('\n')`. Assert `toContain('┌ Prompt · 17 lines')`; a line
    starts `'│'` ends `'│'`; last content line includes `'└'`;
    `toContain('Original prompt line 17')`.
- `should preserve the full prompt across scrolling without losing text`
  - 40-line prompt. Open reader, press `'j'` ~30×, concat all renders. Assert
    every `L1..L40` appears; top window initially does NOT contain `L40`.
- `should show a right-aligned scroll indicator of the visible prompt window`
  - 29-line prompt, `render(108)`. Footer (last non-empty line) matches
    `/\b1-\d+ of 29 ↓$/` (trim-right); left contains `'esc back'`. After one
    `'j'`, first number increments.
- `should scroll the prompt reader with j k and arrow keys and return to detail on escape`
  - `'j'` shifts window down; `'k'` back; `'\x1b'` returns to State B (joined
    contains `'Activity · last 3'`, NOT `'┌ Prompt ·'`); `onClose` NOT called.

**Implement** — replace `#renderPromptReader`:
```ts
const a = this.#selectedAgentRow();                 // from buildMonitorView selectedPhaseAgents[idx]
const full = a?.fullPrompt ?? "";                   // §0.15
const inner = Math.max(1, width - 4);               // '│ ' + ' │'
const wrapped = wordWrap(full, inner);
const title = `Prompt · ${wrapped.length} lines`;
const pageRows = Math.min(wrapped.length, PROMPT_VISIBLE_ROWS);
const maxScroll = Math.max(0, wrapped.length - pageRows);
this.#promptScroll = Math.min(this.#promptScroll, maxScroll);
const window = wrapped.slice(this.#promptScroll, this.#promptScroll + pageRows);
// top border '┌ {title} ' + '─'×fill + '┐' (width-exact); body '│ ' + padTo(line, inner) + ' │';
// bottom '└' + '─'×(width-2) + '┘';
const first = wrapped.length === 0 ? 0 : this.#promptScroll + 1;
const last = Math.min(wrapped.length, this.#promptScroll + pageRows);
const footer = headerSummaryLine(
  this.#theme.fg("dim", "• x stop · r restart · p pause · esc back · s save"),
  `${first}-${last} of ${wrapped.length} ↓`, width);
return [...box, footer];
```
Add `wordWrap(text, width)`: split on `\n`, greedily wrap each line to width via
`visibleWidth`, hard-break tokens longer than width (never lose characters).

### 5.6 State D — `#renderChooser`
**Failing tests**:
- `should render the dynamic workflows chooser with running and completed counts`
  - runs `[hardening_slice_and_author running 8 agents 266100 tok startTime now-358000, generate_joke running 4 agents]`.
    Assert `toContain('/workflows')`, `toContain('Dynamic workflows')`,
    `toContain('2 running · 0 completed')`, `/›\s+↻\s+hardening_slice_and_author/`,
    `toContain('8 agents')`, `toContain('266.1k tok')`,
    `toContain('↑/↓ to select · Enter to view · s to save · Esc to close')`,
    `not.toContain('Choose a workflow')`.
- `should default the chooser selection to the newest running workflow`
  - `[finished completed startTime:1000, fresh running startTime:now]`.
    `/›\s+↻\s+fresh/`; `'1 running · 1 completed'`; completed row has no `›`
    (`  ✓ finished`).

**Implement** — replace `#renderChooser`:
```ts
const cv = buildChooserView(this.#runs);
const counts = `${cv.runningCount} running · ${cv.completedCount} completed`;
const lines = [
  this.#line(width, this.#theme.fg("dim", "› /workflows")),
  "",
  this.#line(width, "─".repeat(width)),
  "",
  this.#line(width, "  " + this.#theme.bold("Dynamic workflows")),
  this.#line(width, "  " + this.#theme.fg("dim", counts)),
  "",
];
for (const [i, row] of cv.rows.entries()) {
  const cursor = i === this.#selectedRunIndex ? "› " : "  ";
  const tok = row.tokens !== undefined ? ` · ${formatTokens(row.tokens)} tok` : "";
  const content = `${cursor}${row.glyph} ${row.workflowName}   ${row.agentCount} agents${tok} · ${row.durationLabel}`;
  lines.push(this.#line(width, i === this.#selectedRunIndex ? this.#theme.fg("accent", content) : content));
}
lines.push("", this.#line(width, this.#theme.fg("dim",
  "↑/↓ to select · Enter to view · s to save · Esc to close")));
return lines;
```
Initialize `#selectedRunIndex` to `defaultChooserSelection(runs)` in the
constructor and `setRuns` (when on chooser) so the cursor lands on newest
running.

### 5.7 `render()` wiring
- Constructor (line 53): `this.#screen = options.runs.length > 1 ? "chooser" : "overview";`
  and `this.#selectedRunIndex = defaultChooserSelection(options.runs);` (§0.10/0.11).
- `setRuns` (67-68): `if (runs.length === 0) this.#screen = "chooser";
  if (runs.length <= 1 && this.#screen === "chooser") this.#screen = "overview";`
  Re-clamp `#selectedRunIndex`; do NOT reset `#promptScroll`.
- In `render()`: when `#screen==='chooser'`, return the chooser block directly
  (it owns its own header+footer; do NOT prepend the generic
  `Workflows`/subtitle header at 117-119 nor append the shared footer 138-139).
  When `#screen==='promptReader'`, suppress the outer shared footer (reader emits
  its own footer with scroll indicator). Empty state (`runs.length===0`) keeps a
  simple message + `esc close`. States A/B keep the outer footer via `#helpText`.

**Green for Step 5:** `pnpm test workflows-component`.

### 5.8 Width contract tests (States A–D)
- `should keep State A and State B lines within width at narrow and wide terminals`
  - long `workflowName`, agent labels/model/metrics, phase titles. For
    `width ∈ [42,120]`: `render(width)` then `handleInput('\x1b[D')` then
    `render(width)`; every line `visibleWidth(line) <= width`.
- `should keep chooser and prompt reader lines within width at 42 and 120`
  - chooser (≥2 running, 70-char name) and prompt-reader (long single-line
    prompt). For `width ∈ [42,120]`: every `render(width)` line
    `visibleWidth(line) <= width`; bordered lines start/end with box chars within
    width.

These pass because `twoPaneBox`/`headerSummaryLine`/`wordWrap` enforce
`visibleWidth === width`, and `#line` truncates any stray non-boxed line.

---

## Step 6 — Command routing + cleanup/refactor

### 6.1 Command routing (confirm, no behavior change)
**Failing test** — `test/extension/commands/workflows-command.test.ts`:
- `should pass all visible runs to the workflows TUI so the component decides State A versus State D`
  - Write two manifests (one running, one completed) under `tempDir/.pi/workflows`
    via `writeRunManifest`; register command; call handler `mode:'tui', hasUI:true`,
    `ui.custom` present. Assert `showWorkflowsTui` called once; its 2nd arg
    `.runs` has length 2 (both forwarded, not collapsed).

`workflows-command.ts` already forwards `runs.value` unchanged (lines 57-69). No
functional change; the test guards against future pre-filtering. (May need a test
helper `writeRunManifest`; reuse `WorkflowRunStore.writeRun` or an existing
fixture util in the test dir.)

### 6.2 Cleanup (refactor — keep green)
- Delete legacy projector surface once the component no longer imports it:
  `projectWorkflowsView`, `toRunDetails`, `summarizePhases`, and the legacy
  model types `WorkflowRunsViewModel`, `WorkflowRunRow`, `WorkflowRunDetails`,
  `WorkflowPhaseSummary`, `WorkflowViewFocus`. Remove the old
  `WorkflowViewNavigation*` exports (already replaced in Step 4).
- Remove component dead code: `#formatOverviewAgentRow`, `#formatDetailAgentRow`,
  `#subtitle`, `formatMetrics` placeholder branches, `#pauseHelpText`,
  `splitLines`/`previewLines` if superseded, old `#renderOverview/#renderAgentDetail`
  helpers. Keep `elapsedSince` only if still used; prefer `formatDuration`.
- Optionally wire `handleInput` to the pure `navigation.ts` functions (Step 4) to
  remove duplicated transition logic. Low priority; only if it keeps all
  component tests green.
- Run full suite: `pnpm test` and `pnpm typecheck`/`pnpm lint`.

---

## 7. Cross-cutting constraints (verify at every step)

### Backward compatibility (manifest validator)
- `prompt`, `description`, `lastProgressAt` are ALL optional. `isWorkflowProgressEntry`
  must never make them mandatory. Old manifests (strict & observed) without these
  keys still return `status:'ok'`. Explicit test:
  `should accept legacy manifests whose agent rows omit the prompt field` (Step 1.3).
- Observed/legacy snapshot path keeps slicing `promptPreview` to 160 chars AND now
  preserves full `prompt`.

### Width contract (`visibleWidth(line) <= width`) at 42 and 120
Every screen has an explicit width test (Step 5.8 for A–D; `layout.test.ts` for
the box primitives). `twoPaneBox`/`headerSummaryLine`/`wordWrap` enforce
`=== width`; the component's `#line` is the final truncation backstop.
Styled cells are measured by `visibleWidth`, never `.length` (§0.4).

### No placeholders
States A/B omit absent `model`/`tokens`/`toolCalls`/`idle` (no `unknown`,
`default`, `0`, `No metrics yet`, `Still collecting`). Header omits the
description line when `undefined`. Chooser omits `tok` when `totalTokens===0`.

---

## 8. Existing tests/assertions to REWRITE or REMOVE

The old generic `Runs/Progress/Agents/Details` layout is deleted, so these must
change:

**`test/workflows/view/projector.test.ts`** — REPLACE both existing cases:
- `should build run rows and selected details from manifest state` — REMOVE (the
  `projectWorkflowsView`/`WorkflowRunsViewModel` surface is deleted). Superseded
  by the `buildMonitorView`/`buildChooserView` tests (Step 3).
- `should summarize phase progress from agent rows without reading transcript state`
  — REMOVE or port into the new `buildMonitorView` phase-count test.

**`test/workflows/view/navigation.test.ts`** — REWRITE entirely (Step 4):
- REMOVE focus-based tests: `should cycle focus between runs agents and details
  when agents exist`, `should skip agent focus when the selected run has no
  agents`, `should enter agent focus from a selected run`.
- ADAPT `should move the selected run and reset the selected agent`,
  `should clamp run selection…`, `should clamp stale selections…` into the new
  screen-machine equivalents (`moveMonitorSelection`, `clampMonitorNavigation`).

**`test/extension/tui/workflows-component.test.ts`** — REWRITE these:
- `should render workflow runs progress agents and details` — REMOVE (asserts the
  deleted `Progress`/`Agents`/`Details` headings). Replaced by State A/B tests.
- `should open the monitor overview directly when exactly one workflow is active`
  — KEEP but update assertions to the new State A shape (`'┌ Phases'`,
  `'Slice · N agents'`) and the active-routing Case3 (single completed → overview).
- `should open a workflow chooser when multiple workflows are available` — UPDATE
  to State D shape (`'Dynamic workflows'`, `'N running · N completed'`); drop any
  `'Choose a workflow'`/runId-column assertions.
- `should switch from overview to structured agent detail with left arrow` —
  UPDATE to expect the bordered State B (`'┌ Slice · '`, `'› ● '`) not the old
  `Agents`/`> done label` list.
- `should open the selected agent prompt reader from structured detail` — UPDATE
  to the bordered `'┌ Prompt · N lines'` reader and full-prompt content.
- `should keep every rendered line within the requested width` — KEEP, extend to
  cover all four states at 42 and 120 (Step 5.8).
- `should move selection through runs and agents with keyboard input` — UPDATE to
  phase/agent selection semantics (overview ↑↓ = phase; agentDetail ↑↓ = agent).
- `should refresh rendered state when runs are replaced`,
  `should call onClose when escape is pressed` — KEEP (behavior unchanged); verify
  escape-from-overview-at-root still calls `onClose` and chooser routing holds.

---

## 9. Verification checklist (run after each step / at the end)

- Step 1: `pnpm test scheduler store launcher` green; old manifests still parse.
- Step 2: `pnpm test layout` green.
- Step 3: `pnpm test projector` green (new builders; legacy tests removed).
- Step 4: `pnpm test navigation` green (screen machine).
- Step 5: `pnpm test workflows-component` green; width tests at 42 & 120 pass for
  A/B/C/D; State B negative-prompt test passes.
- Step 6: `pnpm test workflows-command` green; full `pnpm test` + typecheck +
  lint green; dead legacy code removed.

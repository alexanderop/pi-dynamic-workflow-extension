# Claude Code Workflow Feature Specification

## 1. Purpose

Build a Claude-Code-like Workflow feature: a detached JavaScript orchestration
runtime that can launch many isolated subagents, track progress, persist an
audit trail, resume completed work through a journal, and notify the main
conversation when the run completes or fails.

This spec is derived from local Claude Code artifacts from the pi-webfetch audit
run. It describes externally visible contracts and implementation requirements;
it does not require byte-for-byte compatibility with Claude Code internals.

## 2. Goals

- Allow a main agent to launch a long-running workflow and continue or finish
  its turn immediately.
- Let workflow JavaScript coordinate subagent work through a small, sandboxed
  host API.
- Run subagents concurrently with one global scheduler limit.
- Persist enough state for a progress UI, audit trail, and replay-style resume.
- Support saved reusable workflow commands.
- Return the final result through a task notification with a pointer to the full
  output file.

## 3. Non-Goals

- Do not expose arbitrary filesystem, shell, network, or MCP access to workflow
  JavaScript.
- Do not implement resume as a VM snapshot of JavaScript execution.
- Do not merge saved workflows with historical run state.
- Do not require exact Claude Code private type names, internal hashes, or UI
  implementation details.

## 4. Core Concepts

### Workflow

A Workflow is a JavaScript module or inline script executed by the workflow
runtime. It coordinates subagents with host-provided functions such as `agent`,
`parallel`, and `pipeline`.

### Run

A Run is one execution of a workflow. Every run has a `runId`, `taskId`, run
state JSON, per-run script copy, journal, and subagent transcripts.

### Subagent

A Subagent is an isolated sidechain session created by one `agent()` call. It has
its own prompt, transcript, metadata, tool calls, and optional structured output
schema.

### Journal

The Journal is an append-only JSONL log of agent invocation events. It provides
the cache for replay-style resume.

### Saved Workflow

A Saved Workflow is a reusable JavaScript command file. It stores orchestration
only, not results or run history.

## 5. System Architecture

The feature consists of six components:

1. **Launcher**
   - Accepts an inline script or saved workflow name.
   - Allocates `taskId` and `runId`.
   - Writes the run script copy.
   - Creates initial run state.
   - Starts execution in the background.
   - Returns `{ taskId, runId }` immediately.

2. **Sandbox Runtime**
   - Evaluates workflow JavaScript.
   - Exposes only workflow globals.
   - Records logs, phases, final result, and failures.

3. **Agent Scheduler**
   - Queues all `agent()` calls.
   - Enforces one global concurrency cap.
   - Updates progress rows on queue, start, tool use, result, failure, and stop.

4. **Persistence Layer**
   - Stores run JSON, script copy, journal, subagent transcripts, and metadata.
   - Writes incrementally on every meaningful transition.

5. **Workflow Controller**
   - Implements pause, resume, stop run, stop agent, restart agent, and save
     script operations.

6. **Notification Dispatcher**
   - Injects a task notification into the main conversation when the run reaches
     a terminal state.

## 6. Workflow Script Format

Saved workflows are JavaScript modules.

```js
export const meta = {
  name: 'webfetch-quality-audit',
  description: 'Audit pi-webfetch with review and verification subagents',
  whenToUse: 'Run before merging substantial changes to pi-webfetch',
  phases: [
    { title: 'Review', detail: 'One reviewer per audit dimension' },
    { title: 'Verify', detail: 'Adversarially verify each finding' },
  ],
}

const results = await pipeline(
  DIMENSIONS,
  (dimension) => agent(dimension.prompt, {
    label: `review:${dimension.key}`,
    phase: 'Review',
    agentType: dimension.agentType,
    schema: FINDINGS_SCHEMA,
  }),
  (review, dimension) => parallel(review.findings.map((finding) => () =>
    agent(buildVerificationPrompt(finding), {
      label: `verify:${dimension.key}:${finding.id}`,
      phase: 'Verify',
      agentType: 'general-purpose',
      schema: VERDICT_SCHEMA,
    }),
  )),
)

return results
```

Requirements:

- A saved workflow MUST export `meta`.
- `meta` MUST be a pure object literal. It MUST NOT contain variables, function
  calls, spreads, or template interpolation. The launcher reads `meta`
  statically before executing the script body.
- `meta.name` MUST be the command name.
- `meta.description` MUST summarize what the workflow does in one line. It is
  shown in the launch/permission UI and supersedes any launch-level cosmetic
  description.
- `meta.whenToUse` MAY describe when to reach for this workflow. It is shown in
  the saved-workflow list.
- `meta.model` MAY name a default workflow model. The Pi extension parser
  preserves this field and the runtime applies it as the default model for
  `agent()` calls that omit `options.model`.
- `meta.requiredTools` MAY declare external Pi tools that must be available to
  workflow subagents before the run starts. Each entry MUST be an object with a
  non-empty `name` string and MAY include a `purpose` string. This is a Pi
  extension field, not an observed Claude Code field. The field declares tool
  names only; it MUST NOT make this package depend on, import, or bundle those
  tools. Example:

  ```js
  requiredTools: [
    { name: "web_search", purpose: "Find source candidates" },
    { name: "fetch_content", purpose: "Read source pages" },
  ]
  ```

- `meta.phases` SHOULD define expected progress phases. Each entry has a `title`;
  titles MUST match the strings passed to `phase()`/`agent({ phase })` exactly.
  An entry MAY carry a `detail` string describing what the phase does (observed in
  real saved workflows) and MAY carry a `model` field documenting a per-phase
  model override (part of the API; not exercised by the reference artifacts).
  This Pi extension also accepts optional planning hints for phases whose fan-out
  is known before execution: `agentCount` (a non-negative integer planned total)
  and `agents` (an array of `{ label, model?, agentType? }` planned rows). These
  are not observed Claude Code fields. `/workflows` uses them to show phase totals,
  model hints, details, and known agent labels before runtime agent rows have been
  queued. Omit them for open-ended or result-dependent phases.
- A workflow MAY use top-level `await`.
- The runtime MUST capture the script return value as the run result.
- A workflow MAY read global `args` for invocation input.

Workflow scripts are plain JavaScript, not TypeScript. TypeScript-only syntax
(type annotations, `interface`, generics) MUST NOT appear in a script body; the
`declare`/`interface` blocks in this document describe the host API contract and
are not part of any executable script.

Workflow scripts MUST be deterministic across replay. The runtime MUST make
`Date.now()`, `Math.random()`, and the argument-less `new Date()` throw inside a
workflow script, and the Pi extension intentionally also rejects the literal text
`Date.now`, `Math.random`, or `new Date()` anywhere in the script for closer
Claude compatibility, because resume (§14) re-executes the script and nondeterministic
values would change the computed agent keys and break the journal cache. Pass
timestamps in through `args` and stamp results after the workflow returns; vary
per-iteration work by index rather than by random values.

Observed Claude Code project saved workflow location:

- Project workflows: `.claude/workflows/*.js`

This Pi extension keeps the Claude-like plain `.js` file shape but uses the Pi
namespace shown in §18 and intentionally supports only project/workspace-local
saved workflows.

Observed local artifacts include project saved workflows such as
`<project>/.claude/workflows/webfetch-quality-audit.js`. Most observed saved
workflow file basenames match `meta.name`, but command identity SHOULD come from
`meta.name`, while filenames are lookup/storage details.

## 7. Runtime API

The workflow runtime MUST expose only these globals:

```ts
declare const args: unknown;

declare const budget: {
  total: number | null;
  spent(): number;
  remaining(): number;
};

declare function phase(title: string): void;
declare function log(message: string): void;

declare function agent<T = unknown>(
  prompt: string,
  options?: AgentOptions,
): Promise<T extends object ? T : string | null>;

declare function parallel<T>(
  thunks: Array<() => Promise<T>>,
): Promise<Array<T | null>>;

declare function pipeline<T>(
  items: T[],
  ...stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>
): Promise<unknown[]>;

declare function workflow(
  nameOrRef: string | { scriptPath: string },
  args?: unknown,
): Promise<unknown>;

interface AgentOptions {
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  schema?: JsonSchema;
  isolation?: "worktree";
}
```

Runtime behavior:

- `phase(title)` appends a `workflow_phase` progress row.
- `log(message)` appends a run-level log entry.
- `agent(prompt, options)` schedules one subagent through the global scheduler.
  - Without `schema`, the resolved value is the subagent's final text as a
    string.
  - With `schema`, the resolved value is the validated structured output object.
    Current Pi extension status: the real Pi subagent runner registers a
    per-agent terminating `structured_output` custom tool from the workflow's
    plain JSON object schema. The subagent MUST call that tool as its final
    action; if it finishes without the tool call, the schema agent fails.
  - If the user skips the agent mid-run, the call resolves to `null`. Callers
    SHOULD filter with `.filter(Boolean)` when a skip is possible.
  - If the scheduler rejects the call before queuing it, such as when the
    `maxTotalAgents` lifetime cap is exceeded, the call MUST throw instead of
    resolving to `null`; this is the runaway-loop backstop.
  - `options.isolation: "worktree"` runs the subagent in a fresh git worktree so
    agents that mutate files in parallel do not conflict. It is expensive
    (per-agent setup and disk) and the worktree is removed automatically if left
    unchanged. Omit it unless agents write to the working tree concurrently.
- `parallel(thunks)` evaluates the thunks concurrently and resolves to results
  in input order. It is a barrier: it awaits all thunks. `parallel` MUST accept
  only thunks (`() => Promise<T>`), never already-started promises — a started
  promise has already invoked `agent()` before the scheduler can queue it, which
  would bypass the concurrency cap. A single `parallel()` call MUST accept at
  most 4096 thunks. A thunk that throws resolves to `null` in the result array;
  the `parallel` call itself MUST NOT reject.
- `pipeline(items, ...stages)` runs each item through all stages independently,
  with no global barrier between stages. It accepts any number of stages. Each
  stage callback receives `(previousStageResult, originalItem, index)`. For the
  first stage, `previousStageResult === originalItem`. A single `pipeline()` call
  MUST accept at most 4096 items. A stage that throws drops that item to `null`
  and skips its remaining stages.
- `workflow(nameOrRef, args)` runs another workflow inline as a sub-step and
  resolves to that workflow's return value. A string resolves a saved workflow
  by name; `{ scriptPath }` runs a script file. The child shares the parent
  run's concurrency cap, total-agent counter, abort signal, and token budget.
  Nesting is one level only: calling `workflow()` inside a child MUST throw.
- `budget.total` is the turn's output-token target, or `null` if none was set.
  `budget.spent()` returns output tokens spent this turn across the main loop and
  all workflows (the pool is shared). `budget.remaining()` returns
  `max(0, total - spent())`, or `Infinity` when `total` is `null`. The target is
  a hard ceiling: once `spent()` reaches `total`, further `agent()` calls MUST
  throw. Budget-driven loops MUST guard on `budget.total` so that an unset
  budget (`remaining()` of `Infinity`) does not run to the total-agent cap.
- All `agent()` calls, including calls inside `parallel()`, `pipeline()`, and a
  nested `workflow()`, MUST pass through the same scheduler.

## 8. Launch Contract

```ts
interface WorkflowLaunchRequest {
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: unknown;
  resumeFromRunId?: string;
  title?: string; // ignored; set the title/name in meta
  description?: string; // ignored; meta.description is the real description
}
```

The launch RESPONSE is a human-readable confirmation string, not a structured
object. It MUST convey the `taskId`, the `runId`, the per-run script path, and
the subagent transcript directory, and SHOULD point the user at the live view.
The reference run returned text of this shape:

```text
Workflow launched in background. Task ID: wv46197hp
Run ID: wf_901813da-ebe
Script file: <session>/workflows/scripts/webfetch-quality-audit-wf_901813da-ebe.js
Transcript dir: <session>/subagents/workflows/wf_901813da-ebe
You will be notified when it completes. Use /workflows to watch live progress.
```

Launch rules:

- No source field is schema-required, but the caller MUST supply at least one of
  `script`, `name`, or `scriptPath`.
- Source precedence is `scriptPath` > `script` > `name`. This lets the caller
  iterate by passing the persisted script file while leaving older cosmetic
  fields or a saved workflow name in place.
- `title` and `description` MAY be supplied for compatibility but are ignored;
  the real display values come from the script's `meta` block.
- If `scriptPath` is provided, the launcher runs the script file at that path.
- Else, if `script` is provided, the launcher compiles and runs that inline
  workflow. `script` MUST NOT exceed 524288 characters.
- Else, if `name` is provided, the launcher loads the matching saved workflow.
  Every launch persists its script under the run directory and surfaces that
  path in the confirmation, so a later launch can iterate on or resume the same
  script.
- If `resumeFromRunId` is provided, the launcher resumes from that prior run's
  journal per §14: unchanged `agent()` calls return cached results and only
  edited or new calls execute. Resume is same-session only and the prior run
  MUST be stopped first.
- The Pi extension launch adapter MUST preflight `meta.requiredTools` before
  creating or scheduling the run. A required tool is satisfied only when Pi has a
  tool with that exact name and it is active for the launching session. Missing
  or disabled required tools MUST reject the launch with an actionable error
  that lists missing names and explains that the workflow package does not bundle
  those external capabilities.
- The launcher MUST reject a script that calls nondeterministic primitives at
  launch. The reference runtime rejected one launch with
  `Workflow scripts must be deterministic: Date.now()/Math.random()/new Date()
  are unavailable`, confirming the §6/§20 ban is enforced eagerly.
- The launcher MUST create the run directory and initial state before returning.
- The launcher MUST start execution in the background.
- The launcher MUST return the confirmation (carrying `taskId`, `runId`, and the
  script path) without waiting for completion.

Initial run state MUST include:

- `taskId`
- `runId`
- `workflowName`
- `status: "running"`
- `script`
- `scriptPath`
- `requiredTools`, when declared by workflow metadata
- `phases`
- `logs: []`
- `workflowProgress: []`
- `agentCount: 0`
- `totalTokens: 0`
- `totalToolCalls: 0`
- `startTime`

## 9. Subagent Contract

Each `agent()` call MUST create a fresh sidechain session with:

- Prompt as the first user message.
- Same project cwd as the workflow run.
- Selected `agentType`, if provided.
- Selected model or runtime default model.
- Selected Pi thinking level / provider reasoning-effort level when available.
- Normal tool permission policy for background work.
- If the workflow declares `meta.requiredTools`, those tools MUST be available to
  every subagent session that may need them. The runner MAY do this by sharing
  selected external tool definitions from the launching Pi session or by loading
  the relevant external extensions, but it MUST NOT bundle those tools in this
  workflow package. If the runner cannot provide the required tools to
  subagents, the launch MUST fail before spending subagent tokens. Loading
  external tools for this purpose MUST NOT recursively expose the `Workflow` tool
  to subagents unless a future nested-workflow design explicitly requires it.
- Transcript path:
  `subagents/workflows/<runId>/agent-<agentId>.jsonl`
- Metadata path:
  `subagents/workflows/<runId>/agent-<agentId>.meta.json`
- A matching `workflow_agent` progress row.

If `schema` is provided:

- The runtime MUST require structured output.
- The runtime MUST validate the output against the schema.
- Invalid or missing output SHOULD trigger a bounded retry or in-conversation
  nudge.
- Final schema failure MUST reject the `agent()` promise and be surfaced in run
  failures.
- A journal `result` event MUST only be appended after validation succeeds.

## 10. Scheduling

The scheduler MUST enforce one global concurrency cap across the whole run, and
a hard ceiling on the total number of agents spawned over the run's lifetime.

Recommended caps:

```ts
maxConcurrent = Math.min(16, Math.max(1, cpuCores - 2))
maxTotalAgents = 1000 // runaway-loop backstop, far above any real workflow
```

A `workflow()` child shares both caps with its parent: the concurrency limit and
the total-agent counter are run-wide, not per-workflow.

Queue behavior:

- Agents enter `queued` before they consume a slot.
- Agents enter `running` when a scheduler slot is assigned.
- Agents enter `done`, `failed`, or `stopped` on terminal outcome.
- Queue order SHOULD be FIFO.
- Result order for `parallel()` MUST match input order.

The observed pi-webfetch run on a 12-core machine peaked at 10 concurrent
agents, consistent with `min(16, cpuCores - 2)`.

## 11. Pipeline Semantics

`pipeline()` MUST advance each item independently through any number of stages.

Correct shape:

```ts
await Promise.all(
  items.map(async (item, index) => {
    let prev = item;
    for (const stage of stages) {
      prev = await stage(prev, item, index);
    }
    return prev;
  }),
);
```

Incorrect shape:

```ts
let results = items;
for (const stage of stages) {
  results = await Promise.all(results.map(stage)); // barrier per stage
}
return results;
```

The incorrect shape creates a barrier at every stage boundary. A later-stage
call for one item would wait for every item to finish the prior stage, which
contradicts the observed Workflow behavior. Each stage callback receives
`(previousStageResult, originalItem, index)`, and a stage that throws drops that
item to `null` and skips its remaining stages.

## 12. Run State Model

The run JSON is the UI/read model. It MUST be cheap to load without replaying
every subagent transcript.

```ts
interface WorkflowRunState {
  runId: string;
  taskId: string;
  sessionId?: string;
  triggerSource?: "ultracode" | "skill" | "manual" | "saved" | "unknown";
  workflowName: string;
  status: WorkflowRunStatus;
  summary?: string;
  script: string;
  scriptPath: string;
  requiredTools?: Array<{ name: string; purpose?: string }>;
  phases: Array<{
    title: string;
    detail?: string;
    model?: string;
    agentCount?: number;
    agents?: Array<{ label: string; model?: string; agentType?: string }>;
  }>;
  logs: string[];
  startTime: number;
  timestamp?: string;
  durationMs?: number;
  outputPath?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  workflowProgress: WorkflowProgressEntry[];
  result?: unknown;
  failures?: WorkflowFailure[];
}

type WorkflowRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

type WorkflowProgressEntry =
  | WorkflowPhaseProgress
  | WorkflowAgentProgress;

interface WorkflowPhaseProgress {
  type: "workflow_phase";
  index: number;
  title: string;
}

interface WorkflowAgentProgress {
  type: "workflow_agent";
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId: string;
  agentType: string;
  model: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  state: "queued" | "running" | "done" | "failed" | "stopped";
  queuedAt: number;
  startedAt?: number;
  lastProgressAt?: number;
  durationMs?: number;
  attempt: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
}

interface WorkflowFailure {
  scope: "run" | "agent" | "pipeline";
  message: string;
  agentId?: string;
  pipelineIndex?: number;
}
```

Persistence requirements:

- The runtime MUST write run state before execution starts.
- The runtime MUST update run state on every progress transition.
- The runtime MUST write final status, timestamp, duration, result, and failures
  before sending notification.

## 13. Journal Model

The journal is append-only JSONL.

```ts
type WorkflowJournalEvent =
  | {
      type: "started";
      key: `v2:${string}`;
      agentId: string;
    }
  | {
      type: "result";
      key: `v2:${string}`;
      agentId: string;
      result: unknown;
    }
  | {
      type: "failed";
      key: `v2:${string}`;
      agentId: string;
      error: { message: string; name?: string; stack?: string };
    }
  | {
      type: "stopped";
      key: `v2:${string}`;
      agentId: string;
      reason?: string;
    }
  | {
      type: "invalidated";
      key: `v2:${string}`;
      previousAgentId: string;
      reason: "restart-agent";
      at: number;
    };
```

The stable `key` MUST represent the effective agent call. Include at least:

- Prompt
- Schema
- Label
- Phase
- Agent type
- Model
- Pi thinking level / provider reasoning effort, when available
- Project cwd
- Runtime version or key version

The random `agentId` MUST NOT be used as the resume key.

Observed on disk: keys are `v2:` followed by exactly 64 lowercase hex chars
(SHA-256 width), while `agentId` is a distinct 17-char hex token — the two never
coincide. Across the initial reference journals only `started` and `result`
events appeared; `failed`, `stopped`, and `invalidated` are part of the contract
but were not observed (the failure path surfaced instead through the task
notification, and no restart/stop occurred). Run 2 contained `started` keys with
no matching `result`, the on-disk form of the §14 incomplete-call condition.

A broader read-only audit of `~/.claude/projects` on 2026-06-05 found 23 workflow
journals under `subagents/workflows/<runId>/journal.jsonl`. Across those files:

- event shapes were still only `started` and `result`;
- totals were 589 `started` events and 565 `result` events;
- no observed journal used `failed`, `stopped`, or `invalidated`;
- killed/failed/interrupted runs left started-only keys in the journal;
- one completed run contained duplicate stable keys with multiple `started`
  events and, for some keys, multiple `result` events with different `agentId`s.

Therefore journal consumers MUST NOT assume one event pair per key. Replay should
scan top-to-bottom, ignore started-only attempts for cache hits, and let the
latest non-invalidated `result` for a key win unless a later `invalidated` event
is introduced by our controller.

## 14. Resume Semantics

Resume means replaying the workflow script against the existing journal cache.

Algorithm:

1. Load the same script.
2. Scan `journal.jsonl` from top to bottom.
3. Build a key-to-result cache from non-invalidated `result` events. If multiple
   result events exist for the same key, the latest non-invalidated result wins.
4. Execute the script from the top.
5. On each `agent()` call, compute the stable key.
6. If the key has a cached result, return it without spawning a subagent.
7. If the key has no cached result, spawn a new subagent.

Rules:

- A `started` event without a matching later `result` for the same key and
  attempt is incomplete.
- Incomplete calls MUST NOT be returned from cache.
- Duplicate `started` rows for the same key are possible in real journals; they
  are audit history, not distinct cache slots.
- JavaScript variables are reconstructed by rerunning the script.
- Changing prompt, schema, model, label, phase, or agent type SHOULD produce a
  different key.

## 15. Save Semantics

Saving a workflow copies only the executed script to the project/workspace-local
saved workflow location.

Requirements:

- Claude Code saves project workflows to `.claude/workflows/<meta.name>.js`.
- This Pi extension maps that location to
  `<pi-workflow-root>/<meta.name>.js`, where `<pi-workflow-root>` is the same
  project/workspace `.pi/workflows` root used for run artifacts.
- Saved workflows are project-local prompt/command templates; this extension MUST
  NOT save or resolve them from a user-home or cross-project workflow directory.
- Observed local saved files are plain `.js` modules, not `.workflow.js` files.
- The saved filename MUST be derived from the script's `meta.name`.
- Do not copy run JSON.
- Do not copy journal files.
- Do not copy transcripts.
- Do not copy final result.

A saved workflow is a project-local retriggerable command template. A UI adapter MAY
surface `<meta.name>.js` as a slash-style command such as `/deep-research who is
alexander opalic`; internally that retrigger launches the saved workflow by
`name` and passes the trailing text as invocation `args`.

A later invocation of the saved workflow creates a new run id and new run state.

## 16. Control Operations

```ts
interface WorkflowController {
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  stopAgent(runId: string, agentId: string): Promise<void>;
  restartAgent(runId: string, agentId: string): Promise<void>;
  saveRunScript(runId: string): Promise<string>;
}
```

Behavior:

- `pause` stops dequeuing new agents and marks the run `paused`.
- `resume` moves the run back to `running` and continues by journal replay.
- `stopRun` cancels queued work, requests cancellation for running agents, and
  marks the run `stopped`.
- `stopAgent` cancels one queued or running agent and records a stopped event.
- `restartAgent` invalidates the prior cached result, creates a new attempt, and
  preserves the old transcript.
- `saveRunScript` copies only the run script to the project/workspace-local saved
  workflow directory using the script's `meta.name`.

## 17. Notification Contract

When a run reaches a terminal state, the runtime MUST enqueue a notification for
the main conversation.

```xml
<task-notification>
  <task-id>wv46197hp</task-id>
  <tool-use-id>...</tool-use-id>
  <output-file>/path/to/full/output</output-file>
  <status>completed</status>
  <summary>Dynamic workflow "webfetch-quality-audit" completed</summary>
  <result>possibly truncated result</result>
  <failures>optional failures</failures>
  <usage>
    <agent_count>34</agent_count>
    <subagent_tokens>1016567</subagent_tokens>
    <tool_uses>299</tool_uses>
    <duration_ms>255101</duration_ms>
  </usage>
</task-notification>
```

Requirements:

- In Pi, the extension-specific notification message SHOULD include an explicit
  continuation instruction around the `<task-notification>` XML when the
  workflow was launched because of an extension-controlled policy or trigger
  (for example `ultracode`). Pi converts custom messages into user-context
  messages, but it does not provide Claude Code's private task-notification
  policy, so the notification must tell the main agent to continue from the
  workflow result.
- `output-file` MUST point to the full result. The reference run truncated the
  inline `<result>` (`truncated 94566 chars, full result in <output-file>`).
- Inline `result` MAY be truncated.
- `status` MUST match the terminal run state.
- `usage` MUST include agent count, token count, tool-use count, and duration.
- `<summary>` is derived from the workflow's description (the example string is
  illustrative). The reference run's actual summary interpolated the launch
  `description`/`meta.description` text, not the bare `meta.name`.
- Branch failures SHOULD be included in `failures`, placed between `<result>`
  and `<usage>`. The second reference run (`wf_6da350cb-7c6`) emitted a
  `<failures>` block whose entries read
  `pipeline[N] failed: agent({schema}): subagent completed without calling
  StructuredOutput (after 2 in-conversation nudges)` — confirming both the
  failure-reporting path and the §9 "bounded nudge then reject" behavior.

## 18. Storage Layout

The Claude-like artifact layout is:

```text
<claude-project-root>/
  <session-id>.jsonl
    Main conversation transcript.

  <session-id>/
    workflows/
      <runId>.json
        Run state/read model.

      scripts/
        <workflowName>-<runId>.js
          Exact script executed by this run.

    subagents/workflows/<runId>/
      journal.jsonl
        Append-only resume/cache journal.

      agent-<agentId>.jsonl
        Full sidechain transcript.

      agent-<agentId>.meta.json
        Minimal agent metadata.
```

Observed Claude Code project saved workflows live outside run state:

```text
.claude/workflows/<workflowName>.js
```

Pi extension mapping:

The extension resolves the workflow root from the Pi `cwd` by walking upward and
using the outermost existing `.pi/workflows` directory. This lets a workspace-level
Pi root such as `/Users/alexanderopalic/Projects/.pi/workflows` own workflow
runs even when Pi is launched from a nested repository inside that workspace. If
no ancestor has `.pi/workflows`, the extension falls back to
`<cwd>/.pi/workflows`.

```text
<pi-workflow-root>/
  <runId>/
    manifest.json
      Run state/read model for `/workflows`.

    script.js
      Exact script executed by this run.

    journal.jsonl
      Append-only resume/cache journal.

    output.json
      Full terminal workflow result.

    transcripts/
      Full subagent transcripts and metadata.

  <workflowName>.js
    Project/workspace-local saved workflow scripts, using Claude-like plain `.js` files.
```

The Pi `/workflows` list view MUST read only `manifest.json` files. Journals,
outputs, and transcripts are detailed/audit artifacts and MUST NOT be required
to render the overview.

`/workflows` MUST branch on Pi extension mode. In `tui` and `rpc` modes it may
use dialog-capable UI such as notifications or, for the future rich viewer,
`ctx.ui.custom()` guarded by `ctx.mode === "tui"`. In `print` and `json` modes it
MUST avoid Pi UI methods because Pi documents them as no-ops there. Observed Pi
source currently executes extension command handlers as `Promise<void>` and
ignores handler return values, so headless command output needs an explicit
non-interactive emission path. The current extension emits plain text in `print`
mode and one JSON line with `type: "workflow_command_output"` in `json` mode.

Pi run manifests MAY include `sessionId` ownership metadata. When a current Pi
session id is available from `ctx.sessionManager.getSessionId()`, the default
`/workflows` view filters run manifests to that session id. Legacy manifests
without `sessionId` and manifests from other sessions are hidden by the default
session-scoped view. Saved workflow scripts are not session-scoped.

The Pi extension SHOULD also expose a passive active-workflow status line through
`ctx.ui.setStatus("dynamic-workflows", text)`. This status line is a compact cue,
not the full monitor: it selects the newest active run in the current session and
caps the rendered text to a short footer-friendly width. It formats workflow
name, done/total agent count, elapsed runtime, current phase, current active
agent, and compact token usage without verbose labels such as `agents`, `phase`,
`agent`, or `tokens`. It SHOULD omit the workflow description entirely; the
`/workflows` monitor owns descriptive context. The status line clears itself when
no active run remains. Because Pi footer statuses are non-interactive, arrow-key
selection and `Enter` handling belong to a future below-editor widget or the
`/workflows` TUI rather than this passive status entry.

## 19. Pi Ultracode Session Policy

This section is a Pi integration decision, not an observed Claude Code internal
contract. It maps the Claude-like dynamic workflow model onto the public Pi
extension API.

`ultracode` is a user-facing trigger word and session policy, not a public LLM
tool name. When a user submits a prompt beginning with `ultracode <goal>`, the
extension SHOULD:

1. transition a per-session `ultracode` mode state machine to `on`;
2. persist the transition as a Pi custom session entry;
3. return an input `transform` so the main agent still receives the task;
4. inject a custom message and/or system-prompt addition from
   `before_agent_start` while mode is `on`;
5. expose a model-facing workflow-launch tool that validates scripts and calls
   `launchWorkflow(...)`.

While `ultracode` mode is `on`, the main agent SHOULD treat workflow
orchestration as the default for substantive tasks. Trivial conversational turns
and one-line mechanical edits MAY still be handled solo. The policy instruction
SHOULD tell the agent to optimize for correctness over token cost and to
adversarially verify findings before relying on them.

The mode state machine SHOULD be restorable from Pi session entries through
`ctx.sessionManager.getEntries()` on `session_start`. Direct bundled
`ultracode` workflow launch MAY exist as a fallback or test fixture, but it is
not the primary Pi behavior.

Terminal workflow notifications for ultracode-launched runs SHOULD use
`pi.sendMessage(..., { triggerTurn: true })`, not `pi.sendUserMessage(...)`, so
the main agent is re-invoked with the result without creating a new user message.

### 19.1 Pi Skill-Packaged Workflow Policy

This section is a Pi integration decision for making reusable workflows available
through normal Pi skills. It is not an observed Claude Code contract.

A Pi skill MAY act as a lightweight front door for one or more workflow scripts
bundled next to `SKILL.md`. In this pattern the skill owns the user-facing
routing policy and the workflow script owns the multi-agent orchestration.

Recommended package shape:

```text
skills/deep-research/
  SKILL.md
  workflows/
    deep-research.js
```

The skill SHOULD invoke the model-facing `Workflow` tool with `scriptPath` and
`args`, not paste the workflow source into assistant text and not copy the script
into `.pi/workflows` as a saved workflow unless the user explicitly asks to save
it. The skill resolves the bundled workflow script to an absolute path and calls:

```js
Workflow({
  scriptPath: "/absolute/path/to/skills/deep-research/workflows/deep-research.js",
  args: refinedResearchQuestion,
})
```

This makes skills a reusable distribution mechanism for workflows while keeping
saved workflows (§15) as a separate user/project command mechanism.

Skill front doors SHOULD perform task gating before launching expensive
multi-agent work. For a `deep-research` skill, the expected gate is:

- simple factual, definitional, or one-step questions: answer directly and do
  not launch `Workflow`;
- unclear or underspecified research requests: ask 2-3 clarifying questions and
  do not launch yet;
- substantive research requests needing multiple sources, citations,
  comparisons, or adversarial claim verification: launch the bundled workflow
  with the refined question in `args`.

Invoking `Workflow` from a skill is explicit multi-agent opt-in. The Workflow
permission gate therefore SHOULD allow a launch when the active skill
instructions explicitly call for `Workflow({ scriptPath, args })`, even if
`ultracode` mode is not active. Runs launched this way SHOULD use
`triggerSource: "skill"` when that provenance is available.

Skill-packaged workflows may depend on external tools, but those tools MUST
remain external to this project. For example, `deep-research` may require
`web_search` and `fetch_content` supplied by a separate Pi web package. The
workflow declares those requirements through `meta.requiredTools`; the extension
preflights them and fails fast with install/enable guidance instead of silently
running a web research workflow without web tools.

## 20. Security Requirements

- Workflow JavaScript MUST NOT have direct filesystem, shell, network, browser,
  or MCP tools.
- Subagents MAY use tools according to normal permission policy.
- Every side effect MUST be attributable to a subagent transcript.
- The journal MUST record agent results, not arbitrary filesystem mutations.
- Saved workflow files SHOULD be reviewable JavaScript orchestration.
- The runtime MUST enforce a maximum concurrent-agent cap and a maximum
  total-agent cap per run (see §10; recommended `maxTotalAgents = 1000`).
- The runtime MUST block nondeterministic primitives (`Date.now()`,
  `Math.random()`, argument-less `new Date()`) in workflow scripts so resume
  stays sound (see §6).

## 21. Acceptance Criteria

An implementation is complete when these scenarios pass:

1. Launching an inline workflow returns `{ taskId, runId }` immediately.
2. Launching a saved workflow resolves the project/workspace-local workflow
   location correctly and does not read cross-project workflow directories.
3. The runtime writes initial run JSON before execution starts.
4. `phase()` and `log()` update run state.
5. `agent()` creates an isolated transcript and metadata file.
6. `agent({ schema })` validates structured output before resolving.
7. Missing structured output fails predictably after bounded retries or nudges.
8. `parallel()` preserves result order and respects the scheduler cap.
9. `pipeline()` starts stage 2 for an item as soon as that item's stage 1
   completes.
10. The scheduler never exceeds `maxConcurrent`.
11. Run JSON can render progress without reading subagent transcripts.
12. The journal records `started` before subagent execution and `result` only
   after validated success.
13. Resume reuses completed keyed results and reruns incomplete calls.
14. Restarting an agent invalidates the prior cached result without deleting old
   transcript history.
15. Saving a workflow copies only the script.
16. Terminal runs send task notifications with full output file paths.
17. Workflow JavaScript cannot directly perform privileged side effects.
18. `pipeline()` accepts more than two stages and threads
   `(previousStageResult, originalItem, index)` into each one.
19. `parallel()` rejects already-started promises and resolves a throwing thunk
   to `null` without rejecting the whole call.
20. `agent()` resolves to a string without a schema, a validated object with a
   schema, and `null` when the user skips the agent.
21. `budget.total` acts as a hard ceiling: `agent()` throws once `spent()`
   reaches `total`, and `remaining()` is `Infinity` when no target is set.
22. `workflow()` runs a saved or script-path workflow inline, shares the parent
   caps and budget, and throws when nested more than one level deep.
23. `Date.now()`, `Math.random()`, and argument-less `new Date()` throw inside a
   workflow script.
24. `meta.requiredTools` rejects launch before run creation when required
   external tools are missing or inactive, and the error explains that the
   workflow package does not bundle those tools.
25. A Pi skill can package a workflow script and launch it by passing
   `scriptPath` plus `args` to `Workflow`; this skill-driven launch is treated as
   explicit multi-agent opt-in without requiring `ultracode`.

## 22. Observed Reference Run

These facts came from the local pi-webfetch audit artifacts and can be used as a
test fixture for validating a compatible implementation:

- Run id: `wf_901813da-ebe`
- Task id: `wv46197hp`
- Workflow name: `webfetch-quality-audit`
- Status: `completed`
- Agent count: `34`
- Progress entries: `36`
- Journal lines: `68`
- Total tokens: `1016567`
- Total tool calls: `299`
- Duration: `255101ms`
- Default model: `claude-opus-4-8[1m]`
- Phases: `Review`, `Verify`
- Saved project workflow: `.claude/workflows/webfetch-quality-audit.js`
- Run state:
  `~/.claude/projects/-Users-alexanderopalic-Projects-piWeb/c68356de-3f5c-47e0-963f-5242ffe85716/workflows/wf_901813da-ebe.json`
- Journal:
  `~/.claude/projects/-Users-alexanderopalic-Projects-piWeb/c68356de-3f5c-47e0-963f-5242ffe85716/subagents/workflows/wf_901813da-ebe/journal.jsonl`

The observed run had 6 review agents and 28 verifier agents. It confirmed that
`pipeline()` does not wait for every review to finish before starting
verification for completed dimensions.

### Real Artifact Tree

The actual run lived under one Claude project/session directory:

```text
~/.claude/projects/-Users-alexanderopalic-Projects-piWeb/
  c68356de-3f5c-47e0-963f-5242ffe85716.jsonl
    Main conversation transcript.

  c68356de-3f5c-47e0-963f-5242ffe85716/
    workflows/
      wf_901813da-ebe.json
        Run state/read model. About 160K.

      scripts/
        webfetch-quality-audit-wf_901813da-ebe.js
          Exact script executed for this run. About 16K.

    subagents/workflows/wf_901813da-ebe/
      journal.jsonl
        Append-only agent journal. 68 lines, about 132K.

      agent-afebf68095c3a82a6.jsonl
      agent-afebf68095c3a82a6.meta.json
      agent-ab3eec4f0c3d65e15.jsonl
      agent-ab3eec4f0c3d65e15.meta.json
      ...
      agent-a878a25aca2b2ce40.jsonl
      agent-a878a25aca2b2ce40.meta.json
        34 agent transcript files and 34 matching metadata files.
        The whole run subagent directory was about 3.9M.
```

The saved reusable command was separate from the run:

```text
/Users/alexanderopalic/Projects/piWeb/.claude/workflows/webfetch-quality-audit.js
```

That saved file contained only the reusable JavaScript orchestration. It did not
include `wf_901813da-ebe.json`, `journal.jsonl`, transcripts, or the final
result.

### Run JSON Contents

The run JSON had these top-level keys:

```json
[
  "runId",
  "timestamp",
  "taskId",
  "script",
  "scriptPath",
  "result",
  "agentCount",
  "logs",
  "durationMs",
  "summary",
  "workflowName",
  "status",
  "startTime",
  "phases",
  "defaultModel",
  "workflowProgress",
  "totalTokens",
  "totalToolCalls"
]
```

The phase list was stored as:

```json
[
  { "title": "Review" },
  { "title": "Verify" }
]
```

The first progress rows show that phases and agents share the same
`workflowProgress` array:

```json
[
  {
    "type": "workflow_phase",
    "index": 1,
    "title": "Review"
  },
  {
    "type": "workflow_phase",
    "index": 2,
    "title": "Verify"
  },
  {
    "type": "workflow_agent",
    "index": 1,
    "label": "review:security",
    "phaseIndex": 1,
    "phaseTitle": "Review",
    "agentId": "afebf68095c3a82a6",
    "agentType": "security-reviewer",
    "model": "claude-opus-4-8[1m]",
    "state": "done",
    "queuedAt": 1780560336755,
    "startedAt": 1780560336771,
    "attempt": 1,
    "lastToolName": "StructuredOutput",
    "lastToolSummary": "SECURITY",
    "tokens": 31669,
    "toolCalls": 14,
    "durationMs": 94854,
    "promptPreview": "You are auditing a standalone pi extension package...",
    "resultPreview": "{\"dimension\":\"SECURITY\",\"summary\":\"The SSRF defense..."
  }
]
```

The last progress rows were verifier agents in the `Verify` phase, for example:

```json
{
  "type": "workflow_agent",
  "index": 34,
  "label": "verify:typescript-conventions:ts-element-cast-html",
  "phaseIndex": 2,
  "phaseTitle": "Verify",
  "agentId": "a878a25aca2b2ce40",
  "agentType": "general-purpose",
  "model": "claude-opus-4-8[1m]",
  "state": "done",
  "queuedAt": 1780560475910,
  "startedAt": 1780560533941,
  "attempt": 1,
  "lastToolName": "StructuredOutput",
  "lastToolSummary": "ts-element-cast-html",
  "tokens": 23302,
  "toolCalls": 4,
  "durationMs": 44820
}
```

The final `result` was an array with one entry per audit dimension:

```json
[
  { "dimension": "security", "verified": 5 },
  { "dimension": "typescript-conventions", "verified": 6 },
  { "dimension": "tool-api-parity", "verified": 2 },
  { "dimension": "correctness-robustness", "verified": 7 },
  { "dimension": "tests", "verified": 6 },
  { "dimension": "architecture", "verified": 2 }
]
```

The actual result objects also included `summary` text and nested verifier
records; the compact shape above is enough for fixture validation.

### Journal Contents

The journal began with six review-agent `started` events. One review result
completed, then the runtime immediately started verifier agents for that
dimension. The first rows looked like this:

```json
{"type":"started","key":"v2:c244b274ccd43dd1d2a5c0028cc0a3d1b4664ea7b8d00cc87781c08699be6aa1","agentId":"afebf68095c3a82a6"}
{"type":"started","key":"v2:8d6575facc11f2b35c3a5da58923ec83c1714f1808f6bf902f4f7caf63222991","agentId":"af3fcc1ba59ba36e5"}
{"type":"started","key":"v2:949c9561f562c2ab2bf66bd6ea3faa174a5457cf2619246eb270daf7e162aab9","agentId":"ad90c826d005fdadb"}
{"type":"started","key":"v2:2a3da59b565ec47088ccda21acc5079ee6509a42be464c4907adbe2c1b83f812","agentId":"aaca1bc181ea38afe"}
{"type":"started","key":"v2:8fb5681334f31d9356ad0a6276487d4c2a7b5d795392290446540bd13774c110","agentId":"a53786f7055dbd00f"}
{"type":"started","key":"v2:dbea1fc1724a866118b363a94549222913c8a5fd3c3b05dd7620460393fcd623","agentId":"ab3eec4f0c3d65e15"}
{"type":"result","key":"v2:2a3da59b565ec47088ccda21acc5079ee6509a42be464c4907adbe2c1b83f812","agentId":"aaca1bc181ea38afe","result":{"dimension":"Architecture & Module Boundaries","summary":"...","findings":[...]}}
{"type":"started","key":"v2:05afe89525aad12c0d2429e7c1010ba097f8b0d43f7e353b7a0c73e0bf335ef6","agentId":"a99f7eca2d5a114c8"}
```

This illustrates two important requirements:

- The journal stores a stable `v2:<hash>` key and a separate random `agentId`.
- The runtime can enqueue downstream verifier agents as soon as one review
  result exists; it does not need every review result first.

### Subagent Transcript Contents

Each agent had two files:

```text
agent-afebf68095c3a82a6.jsonl
agent-afebf68095c3a82a6.meta.json
```

The metadata file was minimal:

```json
{"agentType":"security-reviewer"}
```

Across all 34 metadata files, the observed `agentType` distribution was:

```json
{
  "general-purpose": 30,
  "architecture-reviewer": 1,
  "typescript-reviewer-v2": 1,
  "kcd-test-reviewer": 1,
  "security-reviewer": 1
}
```

The transcript JSONL rows were sidechain conversation records. The first
security reviewer transcript began with rows shaped like:

```json
[
  {
    "isSidechain": true,
    "agentId": "afebf68095c3a82a6",
    "type": "user",
    "message": { "role": "user", "content": "You are auditing..." },
    "cwd": "/Users/alexanderopalic/Projects/piWeb",
    "sessionId": "c68356de-3f5c-47e0-963f-5242ffe85716"
  },
  {
    "isSidechain": true,
    "agentId": "afebf68095c3a82a6",
    "type": "assistant",
    "message": { "role": "assistant", "content": [{ "type": "text" }] },
    "cwd": "/Users/alexanderopalic/Projects/piWeb",
    "sessionId": "c68356de-3f5c-47e0-963f-5242ffe85716"
  },
  {
    "isSidechain": true,
    "agentId": "afebf68095c3a82a6",
    "type": "assistant",
    "message": { "role": "assistant", "content": [{ "type": "tool_use" }] },
    "cwd": "/Users/alexanderopalic/Projects/piWeb",
    "sessionId": "c68356de-3f5c-47e0-963f-5242ffe85716"
  }
]
```

This confirms that an implementation needs both a compact run read model and
full per-agent transcripts. The progress UI can read `wf_901813da-ebe.json`,
while audit/debug views can open individual `agent-*.jsonl` files.

The transcript rows above are illustrative, not exhaustive. Real rows also carry
`parentUuid`, `uuid`, `timestamp`, `userType`, `entrypoint`, `version`,
`gitBranch`, and (on assistant rows) `requestId`, `attributionAgent`, plus a
`message.usage` block with cache-token breakdowns. An implementation MUST treat
the field list here as a minimum, not a closed set.

### Second Reference Run (failure + incomplete-journal fixture)

A second run lived in the same session and is a better fixture for the failure
and resume-incomplete paths, which run 1 never exercised:

- Run id: `wf_6da350cb-7c6`
- Task id: `wkuc2xafj`
- Workflow name: `reverse-engineer-workflow-feature`
- Status: `completed`
- Agent count: `12` (all `general-purpose`)
- Total tokens: `266989`
- Total tool calls: `180`
- Duration: `402557ms`
- Default model: `claude-opus-4-8` — note: **no `[1m]` suffix**. `defaultModel`
  is not always the `[1m]` variant shown for run 1; both forms are valid.
- Phases: `Investigate`, `FactCheck`
- Run state JSON has the same 18 top-level keys as run 1 (no `failures` key in
  the run JSON itself; failures surface only in the task notification).

Its journal had 12 `started` events but only 8 `result` events — **4 incomplete
calls** (a `started` key with no matching `result`). This is exactly the §14
incomplete condition observed on disk: those 4 keys MUST NOT be served from cache
on resume. Its task notification carried a `<failures>` block reporting the 4
items that completed without calling `StructuredOutput` after 2 nudges.

This run is independent, not a resume of run 1: the two journals share zero keys
and zero agentIds. No `invalidated`/`stopped` events appear in either journal, so
restart and stop handling (§16) remain unproven by the artifacts.

### API Surface: Exercised vs Documented

The reference scripts (`webfetch-quality-audit`, `reverse-engineer-workflow-
feature`, and the `deep-research2` artifact) exercise only part of the §7 API.
An implementation MUST still provide the full surface, but only the following was
observed in real scripts:

- Exercised: `agent` (always with `schema`), `parallel` (including
  `parallel` nested inside a `parallel`), `pipeline` (always with exactly two
  stages; stage callbacks used `(prev, item)` and never the `index` arg),
  `phase`, `log`, `args`, the `label`/`phase`/`agentType`/`schema` agent options,
  top-level `await`, top-level `return`, the `null`/`.filter(Boolean)` skip
  idiom, and `meta.whenToUse`/`meta.phases[].detail`.
- NOT exercised by any reference script (documented API, no on-disk usage):
  the `budget` global, the `workflow()` nested call, `agent({ isolation:
  'worktree' })`, `agent({ model })`, `pipeline` with three or more stages, and
  `agent()` without a `schema` (the string-return branch).

## 23. Open Questions

These details were not proven by the artifacts and should be implementation
choices:

- Exact stable-key hash algorithm and input serialization. The artifacts fix the
  output form (`v2:` + 64 lowercase hex, i.e. SHA-256 width) but not the exact
  preimage or field ordering. A completed real journal with duplicate keys shows
  that duplicate effective calls can share a cache key, so our implementation
  must choose and document whether to mimic that exactly or include a structural
  call-position component to avoid accidental collisions.
- Exact prompt wording for the structured-output nudge. The retry COUNT is now
  known: the runtime nudges twice in-conversation, then fails the call (per the
  run-2 failure messages: "after 2 in-conversation nudges").
- Exact policy for whether pause cancels running agents or only stops dequeuing.
- Exact live reattachment behavior for currently running subagents.

A `/workflows` dialog demonstrably exists — the transcript shows a save
confirmation and a "Dynamic workflows dialog dismissed" marker — but its live
rendering is never surfaced into the agent-visible transcript. The terminal UI
specified in §24 is therefore a normative implementation target based on the
user-supplied Claude Code workflow-monitor reference screens. Treat it as the
visual and interaction contract for this project, not as proof of Claude Code's
private implementation internals.

Document the chosen answers before implementation so downstream behavior is
predictable.

## 24. Workflow UI Reference Screens

> Status: not yet implemented. This section is the source of truth for how the
> `/workflows` terminal UI should look and behave. Existing implementations that
> render a generic run/job browser are incomplete until they match the screens
> and behavior below. The ASCII layouts are normative: renderer tests should use
> them as golden references, adjusted only for terminal width and elapsed time.

### 24.1 Problem

The workflow UI should match the real Claude Code dynamic-workflow monitor
reference screens instead of showing a generic job browser. The monitor needs to
feel like a live terminal dashboard:

- one active workflow opens directly into the workflow monitor,
- the first view is a phase/agent overview,
- arrow navigation can switch into a structured agent detail view,
- the detail view shows a compact summary, not the whole prompt/result dump,
- `enter` opens the selected agent's original prompt in a full prompt view,
- when multiple workflows are present/running in the session, `/workflows`
  starts with a workflow chooser list.

### 24.2 Visual style requirements

- Dark Pi terminal background.
- A thin accent line across the top of the monitor.
- Workflow name in bold accent/lavender.
- Workflow description in muted text directly below the name.
- Artifact directory in dim text in the monitor header: `artifacts dir: .pi/workflows/<runId>/`.
- Right-aligned status summary: `<done>/<total> agents · <elapsed>`.
- Bordered content area with single-line box drawing.
- Muted footer with keyboard shortcuts.
- Use compact glyphs consistently:
  - `›` selected row
  - `✓` done/success
  - `●` pending/running list bullet when spinner is not available
  - `↻` running workflow in chooser
  - `↵` enter/original prompt action
- Long names, prompt lines, paths, tool calls, and outcome text must truncate
  with `…` when displayed in single-line rows, never wrap through pane borders.
- Prompt-reader content may wrap inside the prompt pane, but the border and every
  produced line must still respect the pane width.
- Every rendered line must respect the Pi TUI `render(width)` width contract.
- The final UI should look like the screenshots first; do not preserve older
  `/workflows` list-browser sections such as generic `Runs`, `Progress`,
  `Agents`, and `Details` headings unless they appear in the screens below.

### 24.3 State A: one active workflow opens to the overview

When exactly one workflow is active in the session, `/workflows` should skip the
workflow chooser and open this monitor directly.

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────
hardening_slice_and_author                                                       1/8 agents · 1m12s
Slice the workflow-correctness-hardening spec into TDD-ready implementation plans, and author a reusable spec-implementation pipeline workflow
artifacts dir: .pi/workflows/wf_hard/

┌ Phases ───────────────┬ Slice · 7 agents ────────────────────────────────────────────────────────────────┐
│ › 1 Slice   0/7       │ ● slice:P0.1-journal-keyi… Opus 4.8 (1M context)                   41.1k tok · 11 tools │
│   ✓ Author 1/1        │ ● slice:P0.2-fault-isolat… Opus 4.8 (1M context)                   33.4k tok · 17 tools │
│                       │ ● slice:P0.3-journal-clone Opus 4.8 (1M context)                   25.2k tok · 11 tools │
│                       │ ● slice:P1.1-model-thread… Opus 4.8 (1M context)                   34.3k tok · 17 tools │
│                       │ ● slice:P1.2-forced-struc… Opus 4.8 (1M context)                   42.2k tok · 20 tools │
│                       │ ● slice:P2.1-drain-on-abo…                                             idle 1m 12s │
│                       │ ● slice:P2.2-limiter-queue Opus 4.8 (1M context)                   29.1k tok · 12 tools │
│                       │                                                                            │
│                       │                                                                            │
│                       │                                                                            │
└───────────────────────┴────────────────────────────────────────────────────────────────────────────┘
↑↓ select · → detail · x stop workflow · p pause · esc back · s save
```

Overview behavior:

- Left pane lists workflow phases.
- Right pane lists agents for the selected phase.
- The selected phase row owns the `›` cursor.
- If a phase declares planning hints, the phase row and selected phase pane title
  use those hints before any `workflow_agent` rows exist, so the UI can say `0/6`,
  `Phase · 6 agents`, show the phase `detail`, show the planned/default `model`,
  and list known planned agent labels. Once matching actual queued agent rows
  appear, real rows replace planned placeholders; when actual queued rows exceed
  the planned count, the actual count wins.
- Agent rows show, in order:
  1. status glyph,
  2. agent label,
  3. model/context when available,
  4. right-aligned token/tool metrics or idle duration.
- If no model/token/tool data exists, omit those fields rather than showing
  placeholders.
- `↑/↓` selects the phase in the left pane.
- `→` switches into the selected phase's agent detail view.
- `esc` returns to chat/previous Pi screen.

### 24.4 State B: arrow-right switches to structured agent detail

From the overview, pressing `→` opens the selected phase's agent-focused view.
This is not a raw dump. It is structured into list + detail panes.

```text
────────────────────────────────────────────────────────────────────────────────────────────────────────────
hardening_slice_and_author                                                       3/8 agents · 1m37s
Slice the workflow-correctness-hardening spec into TDD-ready implementation plans, and author a reusable spec-implementation pipeline workflow
artifacts dir: .pi/workflows/wf_hard/

┌ Slice · 7 agents ─────────────────┬ slice:P0.1-journal-keying ─────────────────────────────────────────┐
│ › ● slice:P0.1-journal-keying      │ ● Running · Opus 4.8 (1M context)                                  │
│   ● slice:P0.2-fault-isolation     │ 41.1k tok · 11 tool calls · idle 42s                               │
│   ✓ slice:P0.3-journal-clone       │                                                                    │
│   ✓ slice:P1.1-model-threading     │ Prompt · 17 lines · ↵ expand                                       │
│   ● slice:P1.2-forced-structu…     │   You are designing ONE fix from docs/workflow-correctness-         │
│   ● slice:P2.1-drain-on-abort      │   hardening-spec.md for this repo. Read the spec section AND        │
│   ● slice:P2.2-limiter-queue       │   … 15 more lines                                                   │
│                                    │                                                                    │
│                                    │ Activity · last 3 of 11 tool calls                                  │
│                                    │   Bash(grep -n "pipeline\|parallel" /Users/...)                    │
│                                    │   Read(/Users/alexanderopalic/Projects/mypiextension/tests/...)      │
│                                    │   Bash(cat > /tmp/repro.test.ts <<'EOF' import assert from "node:a…) │
│                                    │                                                                    │
│                                    │ Outcome                                                            │
│                                    │   Still running…                                                    │
└────────────────────────────────────┴────────────────────────────────────────────────────────────────────┘
↑↓ agent · ↵ prompt · x stop · r restart · p pause · esc back · s save
```

Structured detail behavior:

- Left pane lists agents in the selected phase.
- Right pane title is the selected agent label.
- Detail pane sections must appear in this order:
  1. status/model line,
  2. metrics line,
  3. `Prompt` preview,
  4. `Activity` digest,
  5. `Outcome` preview.
- Prompt preview shows a small number of lines, then `… N more lines`.
- Activity shows only recent calls/events, e.g. last 3, with a count in the
  heading.
- Outcome is short and stateful: `Still running…`, result preview, error
  summary, or cancellation summary.
- `↑/↓` moves selected agent.
- `→` returns to the overview.
- `enter`/`↵` opens the original prompt view for the selected agent.
- `r restart`, `p pause`, and agent-level stop may be disabled until runtime
  support exists, but the UI contract should reserve these keys and footer
  slots.

### 24.5 State C: enter opens the original prompt view

Pressing `enter` in the structured detail view opens a prompt-focused view for
the selected agent. This view is allowed to show the original prompt text in
full, with scrolling.

```text
┌ Prompt · 17 lines ───────────────────────────────────────────────────────────────────────────────────────┐
│ You are designing ONE fix from docs/workflow-correctness-hardening-spec.md for this repo. Read the spec  │
│ section AND the actual current code in: src/workflow.ts, src/agent.ts, src/prompts/workflow-agent.ts,     │
│ src/prompts/structured-output.ts, src/structured-output.ts. Also read the existing tests under tests/     │
│ (especially tests/workflow-journal.test.ts) and vitest.config.ts to match the test style and import paths │
│ exactly. Determine how tests are currently run.                                                          │
│                                                                                                          │
│ Produce a TDD-ready plan: (1) a complete failing test (RED) written in the repo's exact test style/imports│
│ that fails against CURRENT code and will pass after the fix, and (2) the precise implementation edits     │
│ (GREEN). Do NOT edit any files — design only. Quote real function names and line anchors. Be concrete     │
│ enough that an implementer can apply it without re-deriving anything.                                    │
│                                                                                                          │
│ FINDING P0.1 - Journal replay is non-deterministic under pipeline()/concurrency. The hash chain threads  │
│ a mutable global previousJournalKey synchronously at agent() call time, so concurrent re-runs change call │
│ ordering.                                                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
• x stop · r restart · p pause · esc back · s save                                      1-15 of 29 ↓
```

Original prompt behavior:

- This is a focused prompt reader, not the default detail pane.
- It shows all prompt lines through scrolling.
- Footer includes a right-aligned scroll indicator: `<first>-<last> of <total> ↓`.
- `j/k` and `↑/↓` scroll when inside this view.
- `esc` returns to the structured agent detail view.
- No prompt text should be lost; wrapping/truncation should preserve readability
  while respecting width.

### 24.6 State D: multiple workflows use a chooser first

When more than one workflow exists in the current session, and especially when
two or more workflows are running, `/workflows` should first show a
chooser/list screen. Selecting a workflow with `enter` opens State A or State B
for that workflow.

```text
› /workflows

────────────────────────────────────────────────────────────────────────────────────────────────────────────

  Dynamic workflows
  2 running · 0 completed

  › ↻ hardening_slice_and_author   8 agents · 266.1k tok · 5m 58s
    ↻ generate_joke                4 agents · 0s

  ↑/↓ to select · Enter to view · s to save · Esc to close
```

If the session has one running and one completed workflow, the same chooser
shape applies with the accurate counts:

```text
  Dynamic workflows
  1 running · 1 completed

  › ✓ generate_joke                4 agents · 0s
    ↻ hardening_slice_and_author   8 agents · 266.1k tok · 5m 58s
```

Chooser behavior:

- Use the `/workflows` command line header style shown above.
- Show aggregate counts on the second line:
  `<running> running · <completed> completed`.
- Rows show:
  1. selection cursor,
  2. status glyph,
  3. workflow name,
  4. agent count,
  5. token total when available,
  6. elapsed duration.
- Default selection should prefer the newest running workflow.
- `↑/↓` changes selected workflow.
- `enter` opens the selected workflow monitor.
- `s` saves the selected workflow.
- `esc` closes the chooser.

### 24.7 Navigation summary

```text
/workflows
  ├─ if 0 workflows: empty state
  ├─ if 1 active workflow: open State A directly
  └─ if multiple workflows in session: open State D chooser

State A overview
  ↑/↓ select phase
  →   open State B structured agent detail
  esc close/back

State B structured agent detail
  ↑/↓ select agent
  ←   return to State A overview
  ↵   open State C original prompt
  esc return/back

State C original prompt
  ↑/↓ or j/k scroll prompt
  esc return to State B
```

### 24.8 UI acceptance criteria

- `/workflows` with one active workflow opens directly to the overview monitor.
- The overview monitor matches State A: header, description, artifact directory,
  phases pane, agent pane, metrics, border, and footer.
- Arrow navigation can switch from overview to structured agent detail.
- Agent detail matches State B and never dumps the full prompt by default.
- `enter` opens a full original prompt reader matching State C.
- Multiple workflows in the session open a chooser matching State D before
  showing a monitor.
- All views preserve the line-width contract from Pi TUI components.
- Long labels, prompts, paths, and tool calls truncate or wrap inside their
  pane; they never break borders.
- Existing workflow lifecycle behavior is unchanged by this UI spec.

### 24.9 UI non-goals

- Implement runtime pause/restart/agent-stop if the workflow manager does not
  yet support them.
- Change workflow execution semantics.
- Change persisted workflow snapshot format unless required to expose data
  already shown in these screens.
- Add mouse support.

### 24.10 UI implementation contract

The UI implementation should be judged against the screens above, not against the
current exploratory `/workflows` component. In particular:

- `/workflows` must route by run count/state:
  - zero runs: render an empty state;
  - one active visible workflow: skip the chooser and open State A;
  - multiple visible workflows: open State D.
- State A and State B must use a two-pane bordered monitor. Do not render the old
  generic list-browser layout with standalone `Runs`, `Progress`, `Agents`, and
  `Details` sections.
- The selected phase owns the cursor in State A. The selected agent owns the
  cursor in State B. State C owns scroll position instead of row selection.
- The monitor header must include the workflow description. If no description is
  available, omit the description line rather than showing a placeholder.
- The monitor header must include the run artifact directory as
  `artifacts dir: <path>`. Prefer the compact `.pi/workflows/<runId>/` label
  when the persisted script copy lives under that standard run directory; fall
  back to the script-copy directory for non-standard paths.
- The right-aligned summary must count terminal-success agents as done and use
  the larger of visible workflow-agent rows, declared planned phase counts, and
  declared planned agent rows as the denominator.
- Agent rows should use available manifest/read-model data only. Omit missing
  model, token, tool-call, or idle fields instead of rendering `unknown`,
  `default`, `0`, or `No metrics yet` placeholders.
- The full original prompt must be available to State C. A short
  `promptPreview` alone is insufficient for this UI contract because no prompt
  text should be lost.
- The structured detail activity section should prefer recent tool-call/event
  summaries. If only one last-tool field exists, show that single recent item;
  if none exists, show a short muted empty state inside the pane.
- Save, pause, stop, and restart keys may be no-ops until controller support is
  wired, but the reserved footer labels should remain stable.
- Tests must assert that every view keeps `visibleWidth(line) <= width` for both
  narrow and wide terminal widths.

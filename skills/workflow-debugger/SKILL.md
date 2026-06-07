---
name: workflow-debugger
description: Debug Pi dynamic-workflow runs from artifacts. Use whenever the user says a workflow failed, is stuck, completed with missing or wrong output, has a failed subagent, missed structured_output, resume/cache issue, or provides a run id/artifacts dir like .pi/workflows/wf_*. This skill guides reading manifest.json, output.json, journal.jsonl, script.js, and transcripts safely before proposing fixes.
---

# Workflow Debugger

Use this skill to investigate an existing Pi dynamic-workflow run and explain what happened with evidence. Prefer diagnosis first; only edit scripts or rerun workflows after the user asks for a fix.

## Ground rules

- Do not relaunch, resume, stop, or restart a workflow unless the user explicitly asks.
- Do not edit `script.js`, saved workflow files, or source code during the diagnosis pass.
- Read cheap artifacts first. The `/workflows` overview is manifest-backed; transcripts can be large or absent.
- Keep paths explicit in the final answer so the user can inspect the same evidence.
- If artifacts contain secrets or private output, summarize rather than pasting large raw content.

## Resolve the run directory

Start by finding the exact run directory.

1. If the user gave an artifacts directory, verify it exists and contains `manifest.json`.
2. If the user gave only a run id such as `wf_abc123`, check likely roots:
   - `<cwd>/.pi/workflows/<runId>`
   - ancestor workspace `.pi/workflows/<runId>` directories
   - a bounded search such as `find .. -path '*/.pi/workflows/<runId>' -type d` if the obvious roots miss
3. Remember the project-specific root rule: `workflowRootDirForCwd(...)` uses the outermost existing `.pi/workflows` directory while walking upward. A run launched from a nested repo may live under a parent workspace, for example `/Users/.../Projects/.pi/workflows/<runId>` instead of `<repo>/.pi/workflows/<runId>`.

If no run directory can be found, ask for the `runId`, the full artifacts path, or the launch confirmation text.

## Read artifacts in this order

### 1. `manifest.json`

Read `manifest.json` first. Extract:

- `runId`, `taskId`, `sessionId`, `triggerSource`
- `workflowName`, `description`, `status`
- `defaultModel`, `defaultThinkingLevel`, `features`, `featureDecisions`
- `logs`, `failures`, `outputPath`, `durationMs`
- every `workflow_agent` row: `label`, `phaseTitle`, `state`, `lastToolName`, `resultPreview`, `toolCalls`, `durationMs`, and recent activity

Useful command when `jq` is available:

```bash
jq '{status, workflowName, description, outputPath, logs, failures, agents: [.workflowProgress[] | select(.type=="workflow_agent") | {label, phaseTitle, state, lastToolName, resultPreview, toolCalls, durationMs}]}' "$RUN_DIR/manifest.json"
```

### 2. `journal.jsonl`

Read the journal after the manifest. Count `started`, `result`, `failed`, and `stopped` events. Look for:

- `failed` events with stack traces
- `started` events without later `result` events for the same key
- duplicate stable keys where the latest non-invalidated result wins
- whether a failed agent has no `result` event, which means resume should rerun it

Useful command:

```bash
node -e 'const fs=require("fs"); const p=process.argv[1]; const rows=fs.readFileSync(p,"utf8").trim().split(/\n+/).filter(Boolean).map(JSON.parse); const counts={}; for (const r of rows) counts[r.type]=(counts[r.type]||0)+1; console.log({counts, failed: rows.filter(r=>r.type==="failed"), startedWithoutResult: [...new Set(rows.filter(r=>r.type==="started").map(r=>r.key))].filter(k=>!rows.some(r=>r.type==="result"&&r.key===k))});' "$RUN_DIR/journal.jsonl"
```

### 3. `output.json`

Read `output.json` when the run is terminal or `manifest.outputPath` exists. Compare the terminal result to the manifest agent rows.

Important pattern: a run can be `completed` even when one branch agent failed if the workflow used `parallel()` or `pipeline()`. Those helpers convert throwing thunks/stages to `null` for that item. Look for `null` entries in arrays such as `reviews`, `results`, or `verifications`.

### 4. `script.js`

Inspect `script.js` only after you understand the observed state. Check:

- `meta` is a literal object and `meta.phases[*].title` matches `phase(...)` / `agent({ phase })`
- workflow scripts are plain JavaScript, not TypeScript
- no `Date.now`, `Math.random`, or argument-less `new Date()`
- `parallel()` receives thunks, not already-started promises
- `pipeline()` item failures are intentionally nullable
- `agent({ schema })` prompts clearly require the final `structured_output` tool call
- model hints are not relied on unless `experimental-model-routing` is enabled

### 5. Transcripts

Only read transcripts when the manifest/journal is insufficient. Current or older runs may have an empty `transcripts/` directory. If transcript paths are missing, say so honestly and use manifest recent activity plus journal evidence.

## Common diagnoses

### Missing `structured_output`

Evidence usually looks like:

- manifest agent row: `state: "failed"`
- `resultPreview`: `Pi workflow subagent finished without calling structured_output.`
- journal `failed` event with `WorkflowAgentSchemaError`
- last tool is not `structured_output`

Diagnosis: the subagent had `agent(..., { schema })` but ended with normal assistant text instead of calling the terminating `structured_output` tool. Current behavior may fail immediately; bounded repair nudges are tracked as follow-up work. Recommend making the subagent prompt more explicit, reducing schema complexity, or implementing/rerunning after the structured-output retry slice.

### Completed run with failed branch

Evidence:

- top-level `status: "completed"`
- one or more agent rows `state: "failed"`
- result arrays contain `null`
- no `actionableFindings` because the workflow filtered failed reviews away

Diagnosis: `parallel()` or `pipeline()` swallowed the branch error by contract. This is useful for best-effort fan-out, but verification workflows may need explicit null checks and a run-level failure when a required verifier fails.

### Artifacts not found at the expected path

Check the outermost-workflow-root rule. If a parent workspace already has `.pi/workflows`, runs from nested repos land there. Do not assume the repo-local `.pi/workflows` is authoritative.

### Model hint surprise

If logs include `Workflow model hints are ignored because experimental-model-routing is disabled; using the current Pi model.`, then `meta.model`, phase models, planned-agent models, and `agent({ model })` were compatibility hints only. The actual model is the captured Pi model unless `experimental-model-routing` is enabled.

### Resume/cache surprise

Journal keys are based on the effective agent call: prompt, schema, label, phase, agent type, effective model, thinking level, cwd, and key version. Changing any key input can cause a cache miss. A `started` event without a later `result` is incomplete and should not replay from cache.

### Missing required tools

If launch failed before a run directory was created, inspect the main conversation tool result. Workflows with `meta.requiredTools` must preflight active external tools. The workflow package does not bundle those tools.

## Report format

Use this structure in the final answer:

```markdown
## Diagnosis
One or two sentences.

## Evidence
- `path/to/manifest.json`: status, failed/done agents, relevant previews
- `path/to/journal.jsonl`: failed/incomplete keys or error stack summary
- `path/to/output.json`: result shape/nulls/failures

## Root cause
Explain the workflow contract involved, not just the symptom.

## Recommended next step
Smallest safe action: rerun, resume, patch prompt/schema, add null handling, or implement a follow-up fix.

## Verification
Commands already run, or the exact command/user action to verify the fix.
```

Keep the answer short unless the user asks for a deep audit.

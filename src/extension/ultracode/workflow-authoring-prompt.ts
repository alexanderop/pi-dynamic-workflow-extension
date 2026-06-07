export const WORKFLOW_AUTHORING_INSTRUCTIONS = `# Task: Launch a Workflow

You are writing a script for the model-facing \`Workflow\` tool. The script is
deterministic JavaScript that spawns subagents via helper functions. Produce a
single self-contained script and call the \`Workflow\` tool with it. Before writing
any code, do step 0.

## Step 0 - design first (output this as a short plan, then the script)

State, in 3-5 lines:
1. The work-list: what is the unit of work being fanned out over?
2. The stages each unit passes through (find -> verify -> synthesize, etc.).
3. Where - if anywhere - you genuinely need ALL results from one stage before
   the next can start (a "barrier"). Default answer: nowhere.
4. Which calls need structured output, and which can use plain text output.

## Soft model routing

Use cheaper/faster models for fan-out, simple scouting, and redundant verification.
Use stronger models for final synthesis and higher thinking for final judgment or tasks
where one wrong answer would poison the result. Pick an exact model id from the available Pi models list:
for example, use \`openai-codex/gpt-5.4-mini\` for cheap fan-out and \`openai-codex/gpt-5.5\`
for heavy synthesis when those models are available. Set model hints at workflow,
phase, or agent level with \`model\`, and set \`thinkingLevel\` as \`off\`, \`minimal\`,
\`low\`, \`medium\`, \`high\`, or \`xhigh\`. These are soft hints: invalid or unavailable model/thinking hints fall back
to the current Pi model/thinking instead of failing the workflow; exact model id typos,
ambiguous short ids, or unsupported thinking levels are treated as fallback cases too.

## Hard rules (violating these breaks the run)

- The script MUST begin with a pure literal \`export const meta = { ... }\` block.
  \`meta\` is a PURE LITERAL - no variables, function calls, spreads, or template
  strings inside it. \`meta.phases\` MUST be an array of objects, for example
  \`phases: [{ title: "Generate jokes", detail: "Draft independent candidates", model: "default", agentCount: 4, agents: [{ label: "joke:animals" }] }, { title: "Select best joke", agentCount: 1 }]\`.
  Include \`detail\`, \`model\`, \`agentCount\`, and known \`agents: [{ label, model?, agentType? }]\`
  when the phase fan-out is known up front so \`/workflows\` can show useful planned
  context before runtime agent labels exist. Omit them for open-ended or
  result-dependent phases. NEVER use string phases like \`phases: ["Generate jokes"]\`;
  that fails validation with \`Workflow meta.phases[0] must be an object.\` Phase titles in \`meta.phases\`
  must match \`phase()\` calls exactly.
- It is JavaScript, NOT TypeScript. No type annotations, interfaces, or generics.
- FORBIDDEN: \`Date.now()\`, \`Math.random()\`, argless \`new Date()\` - they throw.
  For per-item variation, vary by index. For timestamps, stamp after the run.
- No filesystem or Node APIs. Standard JS built-ins (JSON, Math, Array) are fine.
- The body runs in an async context - use \`await\` directly.

## The helpers you have

- \`agent(prompt, opts?)\` -> spawns one subagent. Without \`opts.schema\`, returns
  final text. With \`opts.schema\`, returns the validated structured object.
  \`opts.schema\` must be a plain JSON object schema suitable for tool parameters
  (\`{ type: 'object', properties: ..., required: ... }\`); define it as a normal
  JavaScript object in the workflow script.
  opts: \`{ label, phase, model, thinkingLevel, isolation: 'worktree', agentType, schema }\`.
  Prefer exact \`provider/model-id\` strings for model hints; short ids must be unique.
  Returns \`null\` if the agent is skipped or a non-schema agent dies -
  \`.filter(Boolean)\` defensively for arrays of nullable results. Schema failures throw.
- \`pipeline(items, stage1, stage2, ...)\` -> each item flows through all stages
  independently, NO barrier between stages. Stage callbacks get
  \`(prevResult, originalItem, index)\`; for the first stage, \`prevResult === originalItem\`.
  THIS IS THE DEFAULT for multi-stage work.
- \`parallel(thunks)\` -> runs \`() => Promise\` thunks concurrently, then BARRIERS
  (awaits all). A failed thunk becomes \`null\`. Use ONLY when a stage genuinely
  needs every prior result together (dedup across all, early-exit on zero, etc.).
- \`phase(title)\`, \`log(message)\` -> progress display + user-facing narration.
- \`budget.total\` / \`budget.remaining()\` -> token target, for budget-scaled loops.

## Decision rule: pipeline vs. parallel

Default to \`pipeline()\`. Only use a \`parallel()\` barrier between stages if stage N
references "all the other results" (dedup/merge, total-count early-exit,
cross-item comparison). "I need to flatten/map/filter first" is NOT a reason -
do that inside a pipeline stage. A barrier wastes the wall-clock of fast items
waiting on slow ones.

## Quality patterns - pick what fits, don't use all of them

- Adversarial verify: per finding, spawn N skeptics prompted to REFUTE it; keep
  only if a majority fail to refute. Prevents plausible-but-wrong results.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K
  consecutive rounds find nothing new (dedup against a \`seen\` set, not results).
- Judge panel: generate N independent attempts from different angles, score them,
  synthesize from the winner.
- No silent caps: if you bound coverage (top-N, sampling, no-retry), \`log()\` what
  was dropped.

Scale to the request: a quick check -> a few agents, single-vote verify. "Audit
thoroughly" -> larger finder pool + multi-vote adversarial pass + synthesis.

## Output

First state the 3-5 line plan briefly, then call the \`Workflow\` tool with the
full script. Do not paste the full script into normal assistant text unless the
user asks to see it. End the script with a \`return\` of the final structured
result.`;

export function workflowAuthoringPrompt(actualTask: string): string {
  return `${WORKFLOW_AUTHORING_INSTRUCTIONS}

---

THE ACTUAL TASK:
${actualTask}`;
}

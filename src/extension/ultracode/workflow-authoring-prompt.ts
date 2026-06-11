export const WORKFLOW_AUTHORING_INSTRUCTIONS = `# Task: Launch a Workflow

You are writing a script for the model-facing \`Workflow\` tool. Treat the workflow
as a custom task harness/orchestrator: deterministic JavaScript owns control flow
while focused subagents do the actual research, coding, verification, or judging
in separate context windows. The script is the conductor, not the worker. Produce
a single self-contained script and call the \`Workflow\` tool with it. Before
writing any code, do step 0.

## What the orchestrator is for

Use a workflow when structure or parallel context helps: large worklists,
long-running research, adversarial review, qualitative ranking, migrations and
refactors, root-cause debugging, or tasks where independent perspectives reduce
agentic laziness, self-preferential bias, and goal drift. Do not use one just
because it is available: a trivial answer or one-line edit should stay
single-agent.

The orchestrator should:
- define a deterministic work-list and stop condition;
- give each subagent a narrow, self-contained prompt with exact context to read
  and a concrete output contract;
- use \`pipeline()\` to let each item advance independently;
- use \`parallel()\` only at intentional barriers;
- verify important outputs with separate skeptical agents before synthesis;
- return one final structured result that the main agent can continue from.

## Step 0 - orchestrator planning, do not skip

Do not launch immediately. First take time to understand the ticket and design
why a workflow is warranted and how it should look. Read repo docs only when the
task requires understanding this repo's existing code, contracts, or workflow
internals: AGENTS.md, spec.md, brain/plans/index.md,
brain/contracts/spec-coverage.md, relevant ADRs under brain/decisions/adr/, and
the source and test files likely owned by the task. For self-contained, creative,
or general tasks, do NOT read spec.md - it is a large reverse-engineering spec
mostly about persistence/UI contracts that is irrelevant to authoring a script;
these authoring instructions plus the published script API in
types/workflow.d.ts are the authoritative, compact reference for what the
\`Workflow\`/\`agent\`/\`pipeline\`/\`parallel\` API can do. Read only the specific files
a task actually depends on, and avoid re-reading large docs you have already read
this session.

Then output a brief orchestration plan before calling Workflow:
1. Why workflow: task class, risk/failure mode, and why a solo turn is weaker.
2. Context read: which docs/files are relevant and why.
3. Work-list: what independent unit of work should be fanned out over.
4. Workflow shape: phases, agent labels, pipeline vs parallel, and where - if
   anywhere - a true all-results barrier is required.
5. Agent prompts: what each class of workflow agent should read, produce, and
   verify.
6. Output contracts: Which calls need structured output, and which can use plain
   text output.
7. Verification and synthesis: how findings or code changes will be adversarially
   checked, then combined into the final answer or implementation plan.
8. Stop condition and budget: what makes the run done, and what will be logged if
   coverage is capped.

## Model and thinking guidance

Select the desired Pi model before launching the workflow. Do not set \`model\` by default:
workflow subagents inherit the current Pi model selected at launch, and use \`thinkingLevel\`
as \`off\`, \`minimal\`, \`low\`, \`medium\`, \`high\`, or \`xhigh\` to vary reasoning effort
for individual phases or agents.

The compatibility \`model\` fields are ignored unless the user explicitly enables
\`experimental-model-routing\` with \`/workflows features enable experimental-model-routing\`.
Only when experimental-model-routing is enabled may a workflow use exact
\`provider/model-id\` hints at workflow, phase, or agent level; invalid, unavailable,
or ambiguous model hints fall back to the current Pi model.

## Hard rules (violating these breaks the run)

- The script MUST begin with a pure literal \`export const meta = { ... }\` block.
  \`meta\` is a PURE LITERAL - no variables, function calls, spreads, or template
  strings inside it. \`meta.phases\` MUST be an array of objects, for example
  \`phases: [{ title: "Generate jokes", detail: "Draft independent candidates", agentCount: 4, agents: [{ label: "joke:animals" }] }, { title: "Select best joke", agentCount: 1 }]\`.
  Include \`detail\`, \`agentCount\`, and known \`agents: [{ label, agentType? }]\`
  when the phase fan-out is known up front so \`/workflows\` can show useful planned
  context before runtime agent labels exist. Omit them for open-ended or
  result-dependent phases. NEVER use string phases like \`phases: ["Generate jokes"]\`;
  that fails validation with \`Workflow meta.phases[0] must be an object.\` Phase titles in \`meta.phases\`
  must match \`phase()\` calls exactly.
- It is JavaScript, NOT TypeScript. No type annotations, interfaces, or generics.
- FORBIDDEN: \`Date.now()\`, \`Math.random()\`, argless \`new Date()\` - they throw.
  For per-item variation, vary by index. For timestamps, stamp after the run.
  The validator scans the whole script text, so do not include those exact
  substrings inside subagent prompts either; say "nondeterministic time/random
  helpers" there.
- No filesystem or Node APIs. Standard JS built-ins (JSON, Math, Array) are fine.
- The body runs in an async context - use \`await\` directly.

## The helpers you have

- \`agent(prompt, opts?)\` -> spawns one subagent. Without \`opts.schema\`, returns
  final text. With \`opts.schema\`, returns the validated structured object.
  \`opts.schema\` must be a plain JSON object schema suitable for tool parameters
  (\`{ type: 'object', properties: ..., required: ... }\`); define it as a normal
  JavaScript object in the workflow script.
  opts: \`{ label, phase, thinkingLevel, isolation: 'worktree', agentType, schema, model }\`.
  Do not set \`model\` unless experimental-model-routing is enabled; by default it is ignored.
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

A single-stage fan-out over a work-list - one operation per item with no second
stage - is just \`parallel()\`. Reach for \`pipeline()\` only when each item flows
through two or more stages.

## Example workflow shapes to adapt

Do not paste these verbatim. Pick one shape and tune the work-list, prompts,
schemas, stop condition, and verification depth to the user's task.

1. Review/audit with adversarial verification:
   work-list = dimensions, files, rules, or tickets. Review each item, then
   verify each finding with a skeptic before synthesis.

     const results = await pipeline(
       DIMENSIONS,
       (d) => agent(reviewPrompt(d), { label: "review:" + d.key, phase: "Review", schema: FINDINGS_SCHEMA }),
       (review, d) => parallel((review?.findings ?? []).map((f) => () =>
         agent(verifyPrompt(f), { label: "verify:" + d.key + ":" + f.id, phase: "Verify", schema: VERDICT_SCHEMA })
           .then((v) => ({ ...f, dimension: d.key, verdict: v }))
       )),
     )
     const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict?.isReal)
     return { confirmedCount: confirmed.length, confirmed }

2. Scope/search/fetch/verify/synthesize research:
   first scope into angles. Pipeline each angle through search and source/claim
   extraction; dedup before expensive work; barrier only when verifying the ranked
   global claim pool. Search can mean web search when tools are available, or
   codebase/document search when working locally. Ask clarifying questions before
   launch if the user's question lacks constraints.

3. Root-cause or flaky-test investigation:
   fan out evidence gatherers for disjoint sources (logs, tests, code, config),
   generate independent hypotheses, test each hypothesis in isolation, and run
   refuters against the strongest theory. Use \`isolation: 'worktree'\` only for
   parallel agents that mutate files.

4. Tournament/generate-and-filter:
   generate many candidates from different angles, judge them comparatively with
   a rubric, dedupe, then send finalists through a skeptic or pairwise tournament.
   Useful for naming, designs, strategy critique, and implementation approaches.

5. Classify-and-act / triage:
   classify each item, route to specialized agents, dedupe against existing work,
   then either act or escalate. For untrusted external content, quarantine: reader
   agents summarize, and separate trusted actor agents take privileged actions.

## Quality patterns - pick what fits, don't use all of them

- Fan-out-and-synthesize: split a large work-list, give each item a clean context,
  then merge structured outputs.
- Adversarial verify: per finding, spawn N skeptics prompted to REFUTE it; keep
  only if a majority fail to refute. Prevents plausible-but-wrong results.
- Generate-and-filter: produce many candidates, score by rubric, dedupe, and keep
  only tested survivors.
- Tournament: compare candidates pairwise when relative judgment is more reliable
  than absolute scoring.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K
  consecutive rounds find nothing new (dedup against a \`seen\` set, not results).
- Classify-and-act: use a classifier to route tasks or outputs to specialized
  follow-up agents.
- No silent caps: if you bound coverage (top-N, sampling, no-retry), \`log()\` what
  was dropped.

Scale to the request: a quick workflow -> a few agents, single-vote verify.
"Audit thoroughly" -> larger finder pool + multi-vote adversarial pass + synthesis.

## Output

First state the 3-5 line plan briefly, then call the \`Workflow\` tool with the
full script as the last action of this turn. Do not paste the full script into
normal assistant text unless the user asks to see it. After Workflow launches,
do not continue with local fallback work while the background run is active. End
the script with a \`return\` of the final structured result.`;

export function workflowAuthoringPrompt(actualTask: string): string {
  return `${WORKFLOW_AUTHORING_INSTRUCTIONS}

---

THE ACTUAL TASK:
${actualTask}`;
}

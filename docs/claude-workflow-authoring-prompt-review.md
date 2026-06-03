# Claude Code workflow authoring prompt review

This note reverse-engineers the workflow scripts found under `~/.claude/**/workflows/**/*.js` and proposes a stronger authoring prompt for `pi-dynamic-workflow-extension`.

## External prompt best-practice sources fetched

I fetched known authoritative prompt-engineering references and folded their guidance into the workflow prompt below:

- Anthropic prompt engineering overview: `https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview`
- Anthropic Claude prompting best practices: `https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-prompting-best-practices`
- Anthropic Claude Code best practices: `https://www.anthropic.com/engineering/claude-code-best-practices`
- OpenAI prompt engineering guide: `https://platform.openai.com/docs/guides/prompt-engineering`
- OpenAI GPT-5.5 prompt guidance: `https://platform.openai.com/docs/guides/prompt-guidance`
- Microsoft Foundry prompt engineering techniques: `https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/prompt-engineering`

Key lessons relevant to workflow authoring:

1. **Define success criteria first.** Anthropic emphasizes starting with clear success criteria and evals before prompt iteration. For workflows, the generated script should include what “done” means: expected result shape, verification phase, and final synthesis criteria.
2. **Use clear sections and syntax.** Anthropic, OpenAI, and Microsoft all recommend Markdown/XML-like structure for complex prompts. For subagents, use explicit sections like `Repo root`, `Context`, `Task`, `Constraints`, `Return`.
3. **Give examples.** Few-shot examples are repeatedly recommended. The workflow prompt should include a complete mini workflow so the model imitates correct `meta`, `phase`, `parallel`, `pipeline`, schemas, and final return shape.
4. **Provide relevant context, not everything.** Claude Code docs stress context-window management. Workflow subagents should receive narrowly scoped file paths and prior summaries instead of huge undifferentiated dumps.
5. **Use verification signals.** Claude Code best practices strongly recommend tests, builds, screenshots, evidence, or second-opinion subagents. Workflow scripts should include a verification/review phase whenever outputs will drive implementation or claims.
6. **Break complex tasks into phases.** Microsoft recommends decomposing large tasks; Claude Code recommends explore → plan → implement → verify. This maps directly to `meta.phases` and `phase()` calls.
7. **Use structured output.** OpenAI emphasizes structured outputs; Claude docs recommend controlling output format. Workflows should use JSON Schema constants for any subagent output consumed by orchestration code.
8. **Use parallelism deliberately.** Claude docs recommend parallel tool/subagent use when work is independent, and avoiding it when tasks have dependencies. That maps to `parallel()` for independent fan-out and `pipeline()` for per-item dependency chains.
9. **Ground claims in evidence.** Microsoft and OpenAI recommend citations/grounding for factual answers. Review/research workflows should ask subagents for file paths, line references, URLs, quotes, or command outputs.
10. **State stop rules.** OpenAI recommends explicit stopping conditions. Workflow scripts should not recurse, poll, or keep spawning agents indefinitely; they should cap item counts and synthesize once enough evidence exists.

## What Claude Code workflow scripts tend to do well

Across the stored scripts, Claude usually writes workflows as **fan-out / fan-in orchestration programs**:

1. Declare literal metadata with name, description, and phases.
2. Define constants and JSON Schemas near the top.
3. Validate `args` early.
4. Run one or more planning/research agents.
5. Fan out independent agents with `parallel(items.map(item => () => agent(...)))`.
6. Optionally run adversarial verification agents over findings.
7. Fan in into one final synthesis agent.
8. Return a small JSON-serializable summary object.

Common patterns observed:

- `meta.phases` is used heavily for dashboard shape.
- `phase('Name')` is called before visible work groups.
- `agent()` calls almost always benefit from `{ label, phase, schema }`.
- Prompts embed enough context for isolated subagents: paths, prior findings, constraints, expected output, and success criteria.
- Complex workflows use JSON Schema constants, then consume structured outputs in code.
- Review workflows often use an **adversarial verifier** phase before synthesis.
- Implementation workflows ask one subagent to make edits, then another to review the diff.

## Current prompt gap

The existing prompt tells the agent the raw API shape, but not enough about **how to compose a good workflow**. Agents need more guidance on:

- what each primitive means,
- when to use `parallel()` vs `pipeline()`,
- how to structure metadata and phases,
- how to pass context into isolated subagents,
- how to use schemas,
- what agent options are actually supported,
- what Claude Code options are not supported here,
- what a good complete workflow looks like.

## Recommended authoring prompt

Use this as the stronger workflow-writing instruction block for the main agent.

```text
When using the workflow tool, write a deterministic JavaScript orchestration script that coordinates isolated Pi subagents. The workflow script is not a Node script: it cannot import modules, access fs directly, call network APIs directly, or use nondeterministic APIs like Date.now(), new Date(), or Math.random(). Delegate repository, file, git, and web inspection to subagents via agent().

Start every script with literal metadata as the first statement:

export const meta = {
  name: 'short_snake_case',
  description: 'Clear one-line description of the workflow goal',
  phases: [
    { title: 'Plan' },
    { title: 'Investigate' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

Use snake_case for meta.name. Do not use kebab-case. Metadata must be literal values only. Extra metadata like whenToUse is okay, but the required fields are name and description.

Available primitives:

- args: JSON value passed into the workflow. Use this for task input, paths, limits, date ranges, or options. Validate required args near the top. If a required input is missing, return a JSON-serializable error object instead of asking follow-up questions inside the script.

- cwd: current working directory string. Include it in subagent prompts when file paths matter. Do not read files directly from the workflow script.

- phase(title): marks the current dashboard phase. Call it before every major group of work. Prefer titles that match meta.phases.

- log(message): emits progress notes into the workflow dashboard. Use it after important fan-in points, counts, decisions, and skips.

- agent(prompt, opts): runs a fresh isolated subagent. Each subagent has no shared conversation history, so the prompt must include all required context: task, repo paths, constraints, prior results, expected output, and success criteria.

  Supported opts:
  - label: short stable label shown in the dashboard, e.g. 'review:api-types'.
  - phase: phase name for this agent. Use it when an agent belongs to a phase different from the current phase.
  - schema: JSON Schema for structured output. Prefer schemas for anything consumed by later code.
  - instructions: extra system-style instructions for this subagent.
  - agentType, model, isolation: currently hints/instructions, not guaranteed hard execution controls.

  Do not rely on unsupported Claude Code options such as harness, permissions, maxRetries, or true worktree isolation unless the runtime has explicitly implemented them.

- parallel(thunks): runs independent work concurrently and returns results in input order. It expects an array of functions, not promises.

  Correct:
  const results = await parallel(items.map(item => () => agent(promptFor(item), opts)))

  Incorrect:
  const results = await parallel(items.map(item => agent(promptFor(item), opts)))

  Use parallel() for independent readers, independent reviewers, independent source collectors, or N-way verification. A failed branch rejects the workflow unless you catch errors explicitly inside the thunk.

- pipeline(items, ...stages): runs each item through a sequence of async stages. Each stage receives (previousValue, originalItem, index). Use pipeline() when each item needs multi-step processing, e.g. search result -> fetch -> extract -> verify. A stage failure rejects the workflow unless handled explicitly.

- budget: read-only budget object with spent, max, and remaining estimated output tokens. Use it to cap optional fan-out.

- console.log/info/warn/error: routed to log(). Prefer log() directly.

Workflow composition rules:

1. Prefer constants and JSON Schema definitions at the top.
2. Prefer structured output schemas for subagents whose results are consumed by code.
3. Use labels that encode role and item, e.g. 'scan:runtime', 'verify:claim-3'.
4. Use fan-out/fan-in: collect independent findings, optionally verify them, then synthesize.
5. For review tasks, include an adversarial verification phase that checks each finding against real evidence.
6. For implementation tasks, include TDD/red-green-refactor guidance, then a review/simplification phase.
7. Always await agent(), parallel(), and pipeline(). Never return unresolved promises.
8. Return a JSON-serializable result object with the useful summary, counts, top findings, and next steps.
```

## Primitive explanations for docs/prompt

### `agent(prompt, opts)`

Use this when work requires tools, repository inspection, web fetching, or LLM judgment. The subagent is isolated, so do not assume it knows anything from earlier subagents unless you paste that context into the prompt.

Good subagent prompt shape:

```text
You are reviewing <specific area>.
Repo root: <cwd>
Relevant files: <paths>
Context from previous phase: <JSON/stringified summary>
Task: <specific task>
Return: <schema-shaped expectations>
Constraints: <what not to do>
```

### `parallel(thunks)`

Use when tasks do not depend on each other:

- one reviewer per package,
- one researcher per source,
- one verifier per claim,
- one mapper per subsystem.

The thunk requirement is important because it lets the runtime control concurrency:

```js
const maps = await parallel(
  AREAS.map(area => () =>
    agent(`Map ${area.path}`, {
      label: `map:${area.key}`,
      phase: 'Map',
      schema: MAP_SCHEMA,
    })
  )
)
```

### `pipeline(items, ...stages)`

Use when every item flows through multiple stages:

```js
const verified = await pipeline(
  findings,
  finding => agent(verifyPrompt(finding), { label: `verify:${finding.id}`, schema: VERDICT_SCHEMA }),
  (verdict, originalFinding) => ({ ...originalFinding, verdict })
)
```

### `phase(title)` and `log(message)`

These are for observability. Claude Code workflows use them to make the dashboard understandable. Call `phase()` before each major fan-out or synthesis step, and `log()` after important reductions:

```js
phase('Verify')
log(`Verifying ${findings.length} findings`)
```

### `args`, `cwd`, and `budget`

- `args` carries user-supplied inputs.
- `cwd` gives subagents the repo root.
- `budget.remaining` can limit optional fan-out.

Example:

```js
const target = args && args.target
if (!target) return { error: 'Missing args.target' }
const maxItems = Math.min((args && args.maxItems) || 10, 20)
```

## Example high-quality workflow flow

```js
export const meta = {
  name: 'review_feature_slice',
  description: 'Map a feature slice, review likely risks, verify findings, and synthesize a fix plan',
  phases: [
    { title: 'Scope' },
    { title: 'Map' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

const target = args && args.target
if (!target) return { error: 'Missing args.target', expected: { target: 'feature or file area to review' } }

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'files', 'summary', 'risks'],
  properties: {
    area: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'severity', 'file', 'evidence', 'suggestion'],
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'partial'] },
    reason: { type: 'string' },
  },
}

phase('Scope')
const areas = [
  { key: 'runtime', path: 'src/workflow.ts' },
  { key: 'tool', path: 'src/workflow-tool.ts' },
  { key: 'ui', path: 'src/workflow-browser.ts' },
]
log(`Reviewing ${target} across ${areas.length} areas from ${cwd}`)

phase('Map')
const maps = await parallel(
  areas.map(area => () =>
    agent(
      `Repo root: ${cwd}\nTarget: ${target}\nRead ${area.path}. Map how this area works, relevant files, and likely risks.`,
      { label: `map:${area.key}`, phase: 'Map', schema: MAP_SCHEMA }
    )
  )
)

phase('Review')
const reviews = await parallel(
  maps.map(map => () =>
    agent(
      `Target: ${target}\nArea map:\n${JSON.stringify(map, null, 2)}\nFind concrete review findings with file evidence.`,
      { label: `review:${map.area}`, phase: 'Review', schema: FINDING_SCHEMA }
    )
  )
)
const findings = reviews.flatMap(r => r.findings)
log(`Found ${findings.length} candidate findings`)

phase('Verify')
const verified = await parallel(
  findings.map((finding, index) => () =>
    agent(
      `Repo root: ${cwd}\nAdversarially verify this finding against real files. Refute it if evidence is weak.\n\n${JSON.stringify(finding, null, 2)}`,
      { label: `verify:${index}`, phase: 'Verify', schema: VERDICT_SCHEMA }
    ).then(verdict => ({ ...finding, verdict }))
  )
)
const confirmed = verified.filter(item => item.verdict.verdict !== 'refuted')
log(`${confirmed.length}/${findings.length} findings survived verification`)

phase('Synthesize')
const report = await agent(
  `Write a concise final review for target ${target}. Include only verified findings, grouped by severity, with concrete fixes.\n\n${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesize:report', phase: 'Synthesize' }
)

return {
  target,
  candidateCount: findings.length,
  confirmedCount: confirmed.length,
  confirmed,
  report,
}
```

## Prompt-only recommendations

1. Add the recommended authoring prompt to the workflow tool guidelines or the trigger-generated workflow prompt.
2. Keep the primitive explanation close to the tool description so the model sees it before writing scripts.
3. Include the example flow because models imitate concrete examples better than abstract rules.
4. Explicitly warn that `parallel()` takes thunks, not promises.
5. Explicitly warn that supported `agent()` options are limited.
6. Explicitly require all subagent context to be included in the prompt.

## Possible primitive/API follow-ups

These are not required for the prompt, but they explain where Claude Code scripts expect more than this runtime currently guarantees:

- True `isolation: 'worktree'` behavior for implementation agents.
- Real `model` selection instead of a model hint.
- `maxRetries` for flaky subagents.
- Rich use of `meta.whenToUse` and `meta.phases[].detail` in saved workflow discovery/UI.
- Optional best-effort helper for branches where one failure should become `null` instead of aborting the whole workflow.

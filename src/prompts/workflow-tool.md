# Workflow Tool Authoring Prompt

## Workflow Overview

Use the workflow tool for explicit workflow requests, fan-out/fan-in work, multi-agent orchestration, or planned multi-step runs.

A workflow is a deterministic JavaScript orchestration script, not a Node.js script. It coordinates isolated Pi subagents, shows progress with phases/logs, and returns a JSON-serializable result.

The workflow script itself must not inspect files, call git, access the network, import modules, or use nondeterministic APIs. Delegate repository, file, git, shell, and web work to `agent()` subagents.

Good workflows usually follow this shape: validate `args`, define schemas, `phase('Map')`, run independent readers with `parallel()`, `phase('Verify')`, run adversarial checks, `phase('Synthesize')`, return counts plus the final report.

## Workflow Script Contract

- Pass one raw JavaScript string in the `script` parameter. Do not wrap it in Markdown fences.
- The first statement must be literal metadata: `export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }`.
- Use `snake_case` for `meta.name`, not kebab-case.
- Call `agent()` at least once.
- Always await `agent()`, `parallel()`, and `pipeline()`; never return unresolved promises.
- Return only JSON-serializable values.
- If required `args` are missing, return a JSON-serializable error object instead of asking the user from inside the workflow.
- Failed agent calls reject the workflow, including inside `parallel()` and `pipeline()`; catch errors inside a thunk only when best-effort behavior is intentional.
- When the workflow tool returns a background job id, do not poll, wait, or re-run it. The extension sends a workflow-completion message when the job finishes.

## Workflow Primitive Reference

```ts
/** JSON value passed through the workflow tool args parameter. Use it for task input, paths, limits, and options. */
declare const args: unknown;

/** Current working directory / repo root. Include this in subagent prompts when file paths matter. */
declare const cwd: string;

/** Estimated output-token budget. Use remaining/max to cap optional fan-out; do not mutate it. */
declare const budget: { spent: number; max: number; remaining: number };

/** Mark the visible dashboard phase. Call before each major group of work; prefer titles from meta.phases. */
declare function phase(title: string): void;

/** Emit a concise progress note into the workflow dashboard after important decisions, fan-ins, counts, or skips. */
declare function log(message: string): void;

/** JSON Schema-like object used for schema-enforced structured subagent output. */
type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: string[];
};

interface AgentOptions {
  /** Short stable dashboard label, e.g. 'map:runtime' or 'verify:finding-2'. */
  label?: string;

  /** Dashboard phase for this agent; use when it differs from the current phase. */
  phase?: string;

  /** Enforces a final structured_output tool call and returns that tool's arguments as a real JavaScript value. */
  schema?: JsonSchema | null;

  /** Extra subagent instructions, e.g. review persona, TDD loop, or output rubric. */
  instructions?: string;

  /** Hint only unless the runtime implements hard model routing. */
  model?: string;

  /** Hint only unless the runtime implements hard isolation controls. */
  isolation?: string;

  /** Role hint such as 'planner', 'implementer', 'reviewer', or 'verifier'. */
  agentType?: string;
}

/** Run a fresh isolated Pi subagent. Its prompt must include repo root, paths, prior findings, constraints, success criteria, verification expectations, and return shape. */
declare function agent(prompt: string, options?: AgentOptions): Promise<unknown>;

/** Run independent work concurrently. Pass thunks/functions, not promises, so the runtime controls scheduling and concurrency. */
declare function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;

/** Run each item through dependent async stages. Use for per-item flows such as candidate -> inspect -> verify. */
declare function pipeline<TItem, TResult>(
  items: TItem[],
  ...stages: Array<(value: unknown, item: TItem, index: number) => Promise<unknown>>
): Promise<TResult[]>;
```

## Workflow Authoring Rules

- Use structured output when later workflow code must safely read fields, map arrays, branch on statuses, merge parallel findings, or invalidate cached results when the expected shape changes.
- Avoid structured output when the subagent only needs to write prose, summarize for a human, brainstorm, draft copy, or produce a final report that no workflow code will inspect structurally.
- For implementation workflows, bias toward working code: ask implementer agents to explore, write tests first when appropriate, implement, run relevant tests/builds, and report blockers explicitly.
- For review workflows, require finding-first output with severity, file/line evidence, impact, and concrete fix; include adversarial verification before synthesis when findings drive decisions.
- For frontend workflows, preserve the existing design system unless the user asks for a new direction; otherwise request intentional, complete, responsive UI work rather than generic layouts.

## Workflow Example

This is a complete example for auditing prompt quality in this repo. Adapt the target files, schemas, and phases to the user's task.

```js
export const meta = {
  name: 'prompt_quality_audit',
  description: 'Map workflow prompt files, verify improvement opportunities, and synthesize concrete edits',
  phases: [
    { title: 'Scope' },
    { title: 'Map' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

const input = args && typeof args === 'object' ? args : {}
const target = typeof input.target === 'string' ? input.target : 'workflow prompt quality'

const FILES = [
  'src/prompts/workflow-tool.ts',
  'src/prompts/workflow-trigger.ts',
  'src/prompts/workflow-agent.ts',
]

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'summary', 'risks', 'opportunities'],
  properties: {
    file: { type: 'string' },
    summary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    opportunities: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence', 'recommendation'],
  properties: {
    verdict: { type: 'string', enum: ['keep', 'change', 'unclear'] },
    evidence: { type: 'string' },
    recommendation: { type: 'string' },
  },
}

phase('Scope')
log('Auditing ' + FILES.length + ' prompt files for ' + target)

phase('Map')
const maps = await parallel(FILES.map(file => () => agent(
  'Repo root: ' + cwd + '\n' +
  'Target: ' + target + '\n' +
  'Read ' + file + '. Summarize what this prompt currently teaches, where it may confuse an agent, and concrete improvement opportunities. Ground claims in exact file evidence.',
  { label: 'map:' + file.split('/').pop(), phase: 'Map', schema: MAP_SCHEMA, agentType: 'reviewer' }
)))
log('Mapped ' + maps.length + ' prompt files')

phase('Verify')
const candidates = maps.flatMap(map => map.opportunities.map(opportunity => ({ file: map.file, opportunity }))).slice(0, 8)
const verified = await parallel(candidates.map((candidate, index) => () => agent(
  'Repo root: ' + cwd + '\n' +
  'Adversarially verify this prompt improvement candidate against the real file. Refute it if the evidence is weak.\n' +
  JSON.stringify(candidate, null, 2),
  { label: 'verify:' + index, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'verifier' }
)))
const changes = verified.filter(item => item.verdict === 'change')
log(changes.length + '/' + candidates.length + ' candidates survived verification')

phase('Synthesize')
const report = await agent(
  'Write a concise implementation plan for improving workflow prompts. Include only verified changes, exact files to edit, and acceptance checks.\n' +
  JSON.stringify({ target, maps, changes }, null, 2),
  { label: 'synthesize:plan', phase: 'Synthesize', agentType: 'planner' }
)

return {
  target,
  mappedFiles: maps.length,
  candidateCount: candidates.length,
  verifiedChangeCount: changes.length,
  changes,
  report,
}
```

# pi-dynamic-workflow-extension

A shareable Pi package that adds a `workflow` tool and `/workflows` dashboard. The tool runs a deterministic JavaScript orchestration script in a small VM context, fans work out to isolated in-memory Pi subagents, starts the run in the background, and lets you reopen a Pi-native live dashboard while you keep chatting.

## Install locally while developing

```bash
npm install
npm run build
npm test
npm run test:e2e # optional: run only the Pi extension loading smoke test
pi install /absolute/path/to/pi-dynamic-workflow-extension
# in Pi: /reload
```

For quick testing without installing the package:

```bash
pi -e ./extensions/workflow.ts
```

The automated end-to-end smoke test launches the real Pi CLI in JSON mode with only this extension and a test probe loaded. It verifies that the `workflow` tool and public slash commands are registered without making an LLM call.

## Example workflow script

```js
export const meta = {
  name: 'inspect_project',
  description: 'Inspect the repository and summarize its modules'
}

phase('Scan')
const inventory = await agent('Inspect the repository structure.', {
  label: 'repo inventory'
})

phase('Summarize')
const summary = await agent('Summarize this inventory:\n' + inventory, {
  label: 'module summary'
})

return { inventory, summary }
```

The script can use `agent()`, `parallel()`, `pipeline()`, `artifact()`, `phase()`, `log()`, `args`, `cwd`, and `budget`. `parallel()` takes thunks: `await parallel(items.map(item => () => agent(...)))`.

Use `artifact(name, value, options?)` to register durable workflow outputs such as Markdown reports, JSON findings, text summaries, handoffs, or checklists:

```js
artifact('review.md', markdown, { type: 'markdown', description: 'Review report' })
artifact('findings.json', findings, { type: 'json' })
artifact('summary.txt', summary, { type: 'text' })
```

Artifact names must be unique safe relative names, not absolute paths or parent-traversal paths. Artifact values must be JSON-serializable. Artifacts appear in the live workflow dashboard, completion reports, and persisted job snapshots.

## Running workflows

The extension exposes a `workflow` tool for generated orchestration scripts, plus native prompt triggers that ask the main agent to plan with that tool:

- `ultracode <task>` for a larger, more thorough workflow plan
- `quick workflow <task>` for a smaller, lower-budget workflow plan
- `use [a] workflow to <task>` for standard workflow planning

Installed commands:

- `/workflows` opens the live and persisted workflow dashboard.
- `/workflow-save <job-id> [command-name]` saves a job's script globally.
- `/workflow-list` lists globally saved workflow commands.
- `/workflow-edit <command-name>` edits a saved workflow script in Pi's editor.
- `/workflow-delete <command-name>` deletes a saved workflow command file.
- `/workflow-refresh` reloads saved workflow files and registers any new commands without a full Pi reload.
- `/workflow-resume <job-id>` resumes a persisted project workflow job.
- Saved workflows are registered as slash commands such as `/audit_project` and run with any trailing command text as `args`.

## Live workflow dashboard

After a workflow starts, continue using Pi normally. Run `/workflows` to reopen the live dashboard:

- `↑↓ select` phases, agents, or detail rows in the focused pane
- `←→ focus` between panes
- `j/k scroll` the detail pane
- `enter expand` the selected detail
- `c cancel` a running workflow
- `s save` the selected workflow as a global slash command
- `r rerun` the selected workflow as a fresh job
- `R resume` the selected interrupted/failed/cancelled workflow
- `p/n`, `[/]`, or `</>` workflow switches between older/newer workflow runs
- `q close` or `esc` closes the dashboard

The footer shows `workflows:N` while background runs are active.

## How it works

The extension registers two Pi entry points:

1. A `workflow` tool that the agent can call with a raw JavaScript orchestration script.
2. A `/workflows` command that opens an interactive TUI browser for live and finished workflow jobs.

When the tool is called from the installed extension, it does **not** await the whole workflow before returning. Instead, it parses and validates the script, creates a background job in a shared `WorkflowManager`, returns immediately to Pi, and lets the workflow keep running. The `/workflows` command reads that same manager, so you can close and reopen the dashboard without losing the run state.

Project workflow runs are persisted under `.pi/workflows` in the current project. Globally saved reusable workflow commands are stored under `~/.pi/agent/workflows`.

Internally:

- `src/workflow.ts` runs the script in a constrained `node:vm` orchestration context. This is **not** a strong security sandbox; there is no separate worker/process boundary, so only run workflows from trusted packages/users.
- `src/workflow-manager.ts` owns background jobs, snapshots, cancellation, and change listeners.
- `src/workflow-browser.ts` renders the interactive Pi TUI and handles arrow-key navigation.
- `src/workflow-tool.ts` exposes the tool and can run either in foreground mode or background mode when given a manager.
- Each `agent()` call creates a fresh isolated in-memory Pi subagent session, so subagents do not share conversation history unless the workflow prompt explicitly passes context between them.

The workflow VM intentionally keeps orchestration deterministic: scripts must start with literal `export const meta = ...`, cannot use nondeterministic APIs like `Date.now()` or `Math.random()` (including obvious aliases), and should delegate file/project inspection to subagents rather than direct filesystem access. Obvious constructor-based escape attempts are blocked as a guardrail, not as a complete sandbox guarantee.

Workflow results, agent results, and artifact values must be JSON-serializable. Returning values such as `BigInt`, functions, symbols, `undefined`, or cyclic objects fails the workflow with a clear JSON boundary error before display or persistence.

Cancellation and `timeoutMs` settle workflows that are waiting at async boundaries, including never-resolving promises or agent calls. They do not preempt CPU-bound loops that run after an `await`; doing that would require moving execution into a terminable worker or process.

## Publish/share checklist

1. Pick your final npm package name in `package.json`.
2. Run `npm test`.
3. Optionally run `npm run test:e2e` by itself while iterating on Pi extension loading.
4. Publish to npm or share the git repository.
5. Users can install with `pi install git:github.com/alexanderop/pi-dynamic-workflow-extension`.

Pi packages run with full system permissions, so only install packages you trust.

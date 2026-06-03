# pi-dynamic-workflow-extension

A shareable Pi package that adds a `workflow` tool and `/workflows` dashboard. The tool runs a deterministic JavaScript orchestration script in a small VM context, fans work out to isolated in-memory Pi subagents, starts the run in the background, and lets you reopen a Pi-native live dashboard while you keep chatting.

## Install locally while developing

```bash
npm install
npm test
pi install /absolute/path/to/pi-dynamic-workflow-extension
# in Pi: /reload
```

For quick testing:

```bash
pi -e ./extensions/workflow.ts
```

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

The script can use `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `cwd`, and `budget`. `parallel()` takes thunks: `await parallel(items.map(item => () => agent(...)))`.

## Live workflow dashboard

After a workflow starts, continue using Pi normally. Run `/workflows` to reopen the live dashboard:

- `←` / `→` switch between workflow runs
- `↑` / `↓` navigate agents inside the selected run
- `c` cancels a running workflow
- `q` or `esc` closes the dashboard

The footer shows `workflows:N` while background runs are active.

## How it works

The extension registers two Pi entry points:

1. A `workflow` tool that the agent can call with a raw JavaScript orchestration script.
2. A `/workflows` command that opens an interactive TUI browser for live and finished workflow jobs.

When the tool is called from the installed extension, it does **not** await the whole workflow before returning. Instead, it parses and validates the script, creates a background job in a shared `WorkflowManager`, returns immediately to Pi, and lets the workflow keep running. The `/workflows` command reads that same manager, so you can close and reopen the dashboard without losing the run state.

Internally:

- `src/workflow.ts` runs the script in a restricted `node:vm` context.
- `src/workflow-manager.ts` owns background jobs, snapshots, cancellation, and change listeners.
- `src/workflow-browser.ts` renders the interactive Pi TUI and handles arrow-key navigation.
- `src/workflow-tool.ts` exposes the tool and can run either in foreground mode or background mode when given a manager.
- Each `agent()` call creates a fresh isolated in-memory Pi subagent session, so subagents do not share conversation history unless the workflow prompt explicitly passes context between them.

The workflow VM intentionally keeps orchestration deterministic: scripts must start with literal `export const meta = ...`, cannot use nondeterministic APIs like `Date.now()` or `Math.random()`, and should delegate file/project inspection to subagents rather than direct filesystem access.

## Publish/share checklist

1. Pick your final npm package name in `package.json`.
2. Run `npm test`.
3. Publish to npm or share the git repository.
4. Users can install with `pi install git:github.com/alexanderop/pi-dynamic-workflow-extension`.

Pi packages run with full system permissions, so only install packages you trust.

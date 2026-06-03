# pi-dynamic-workflow-extension

A shareable Pi package that adds a `workflow` tool. The tool runs a deterministic JavaScript orchestration script in a small VM context, fans work out to isolated in-memory Pi subagents, streams progress snapshots, and renders a Pi-native dashboard.

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

## Publish/share checklist

1. Pick your final npm package name in `package.json`.
2. Run `npm test`.
3. Publish to npm or share the git repository.
4. Users can install with `pi install git:github.com/alexanderop/pi-dynamic-workflow-extension`.

Pi packages run with full system permissions, so only install packages you trust.

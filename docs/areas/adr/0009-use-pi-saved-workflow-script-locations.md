# ADR 0009: Use Project-Local Pi Saved Workflow Scripts

Status: accepted, amended 2026-06-07

## Context

Claude-like saved workflows are reusable JavaScript orchestration files that live
outside run state. Observed Claude Code project artifacts use plain JavaScript
files under `<project>/.claude/workflows/*.js`.

Observed project examples include:

```text
<project>/.claude/workflows/webfetch-quality-audit.js
<project>/.claude/workflows/vue-newsletter.js
```

Most observed file basenames match `meta.name`. Command identity is still best
treated as `meta.name`, while filenames are lookup/storage details.

We want Claude-like behavior and file shape, but Pi extension data should live
under `.pi`, not `.claude`. We also want saved workflows to behave like project-local prompt/command
templates (for example, a project may expose `deep-research.js` as a retriggerable
`/deep-research <args>` workflow), not cross-project user-home commands.

## Decision

Use a Pi-namespaced, project/workspace-local saved workflow location with
Claude-like plain `.js` files:

```text
<pi-workflow-root>/*.js
```

The project/workspace scope is the same resolved `.pi/workflows` root used for
run artifacts (outermost existing ancestor root, falling back to
`ctx.cwd/.pi/workflows`).

When launching by `name`, resolve only this project/workspace-local saved
workflow root. First check the conventional exact path `<name>.js`, then scan
other `.js` files in that root and match by exported `meta.name`.

The requested name must be a command name without path separators. If the exact
`<name>.js` file exists but declares a different `meta.name`, fail clearly as an
invalid saved workflow. Non-matching scanned files are ignored.

When saving a run, copy only the run's `script.js` to
`<pi-workflow-root>/<meta.name>.js`. The save path is derived from the executed
script's `meta.name`; callers do not choose a separate saved name or scope.

When launching by explicit `scriptPath`, read that exact file and copy it into
the new run directory as `script.js`, just like inline launches. Do not mutate
the original saved workflow file.

Tests may inject an alternate project saved-workflow directory through launcher
options so they never read or write the user's real project files.

## Consequences

- Pi dynamic workflows do not write user/project state into Claude Code's
  `.claude` namespace.
- Saved workflow files keep Claude Code's plain `.js` module shape.
- Saved workflows are project/workspace-local and never global user-home state.
- Saved workflows stay separate from per-run manifests, journals, outputs, and
  transcripts even though project saved scripts share the `.pi/workflows` root
  with run directories.
- Name lookup avoids directory traversal by construction.
- Launch by name is a little more expensive because it may scan and parse `.js`
  files when `<name>.js` is absent.

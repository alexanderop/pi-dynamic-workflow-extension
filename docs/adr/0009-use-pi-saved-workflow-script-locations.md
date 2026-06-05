# ADR 0009: Use Pi-Namespace Saved Workflow Locations With Claude-Like Files

Status: accepted

## Context

Claude-like saved workflows are reusable JavaScript orchestration files that live
outside run state. Observed Claude Code artifacts use plain JavaScript files under
`<project>/.claude/workflows/*.js` and `~/.claude/workflows/*.js`.

Observed project examples include:

```text
<project>/.claude/workflows/webfetch-quality-audit.js
<project>/.claude/workflows/vue-newsletter.js
```

Observed personal examples include:

```text
~/.claude/workflows/deep-research2.js
```

Most observed file basenames match `meta.name`, but at least one observed
personal file (`deep-research2.js`) declares `meta.name: "deep-research"`. That
means command identity is best treated as `meta.name`, while filenames are a
lookup/storage detail.

We want Claude-like behavior and file shape, but Pi extension data should live
under `.pi`, not `.claude`.

## Decision

Use Pi-namespaced saved workflow locations with Claude-like plain `.js` files:

```text
<project>/.pi/workflows/*.js
~/.pi/workflows/*.js
```

When launching by `name`, resolve project-local workflows before personal
workflows. Within each scope, first check the conventional exact path
`<name>.js`, then scan other `.js` files in that scope and match by exported
`meta.name`.

The requested name must be a command name without path separators. If the exact
`<name>.js` file exists but declares a different `meta.name`, fail clearly as an
invalid saved workflow. Non-matching scanned files are ignored.

When launching by explicit `scriptPath`, read that exact file and copy it into
the new run directory as `script.js`, just like inline launches. Do not mutate
the original saved workflow file.

Tests may inject alternate project/personal saved-workflow directories through
launcher options so they never read or write the user's real home directory.

## Consequences

- Pi dynamic workflows do not write user/project state into Claude Code's
  `.claude` namespace.
- Saved workflow files keep Claude Code's plain `.js` module shape.
- Project workflows can override personal workflows predictably.
- Saved workflows stay separate from per-run manifests, journals, outputs, and
  transcripts even though project saved scripts share the `.pi/workflows` root
  with run directories.
- Name lookup avoids directory traversal by construction.
- Launch by name is a little more expensive because it may scan and parse `.js`
  files when `<name>.js` is absent.
- The extension can later add `saveRunScript` by copying the run's `script.js`
  into one of these saved-workflow directories.

# ADR 0005: Use Project-Local Pi Workflow Run Storage

Status: accepted, amended 2026-06-06

## Context

`spec.md` maps Claude-like workflow artifacts into Pi as project-local run
storage under `.pi/workflows`. The `/workflows` command already reads
`.pi/workflows/<runId>/manifest.json` files as its cheap overview read model.

The launcher now needs to create real run storage before background execution
starts. That makes the storage mapping an implementation decision rather than a
planning note.

## Decision

Use a Pi workflow root named `.pi/workflows` as the first workflow run storage
root. When launched from a nested cwd, resolve this root by walking upward from
`ctx.cwd` and choosing the outermost existing `.pi/workflows` directory. If no
ancestor already has `.pi/workflows`, fall back to `ctx.cwd/.pi/workflows`.

This keeps workflow artifacts with the existing Pi workspace state instead of
creating a new nested runtime tree in whichever package/repo happened to trigger
the extension.

Each launched run gets one directory:

```text
.pi/workflows/<runId>/
  manifest.json
  script.js
  output.json
  transcripts/
```

The launcher writes `script.js`, creates `transcripts/`, and writes the initial
`manifest.json` before starting background execution. When a run reaches a
terminal state, it writes `output.json` as the full result/failure artifact and
then persists `outputPath` on the terminal `manifest.json`. `manifest.json` is
the canonical `/workflows` read model; list/overview commands must not require
journals, outputs, or transcript files.

Reserve this run-artifact path for later slices:

```text
.pi/workflows/<runId>/journal.jsonl
```

Saved workflow script locations are a separate decision in ADR 0009 and use
Pi-namespaced `.pi/workflows/*.js` paths with Claude-like plain JavaScript files.

## Consequences

- Filesystem integration tests can use a temporary `.pi/workflows` root without
  depending on a live Pi session.
- The extension can derive the default root from `ctx.cwd` while still reusing an
  existing workspace-level Pi root for nested projects.
- `/workflows` stays cheap because it only needs manifest files for the overview.
- This storage is project-local runtime state, so later hardening still needs
  atomic manifest writes, partial-file recovery, and a clearer policy for which
  `.pi/workflows` artifacts belong in version control.

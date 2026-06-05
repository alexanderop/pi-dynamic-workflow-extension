# ADR 0005: Use Project-Local Pi Workflow Run Storage

Status: accepted

## Context

`spec.md` maps Claude-like workflow artifacts into Pi as project-local run
storage under `.pi/workflows`. The `/workflows` command already reads
`.pi/workflows/<runId>/manifest.json` files as its cheap overview read model.

The launcher now needs to create real run storage before background execution
starts. That makes the storage mapping an implementation decision rather than a
planning note.

## Decision

Use project-local `.pi/workflows` as the first workflow run storage root.

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
- The extension can derive the default root from `ctx.cwd`, keeping workflow runs
  scoped to the project being worked on.
- `/workflows` stays cheap because it only needs manifest files for the overview.
- This storage is project-local runtime state, so later hardening still needs
  atomic manifest writes, partial-file recovery, and a clearer policy for which
  `.pi/workflows` artifacts belong in version control.

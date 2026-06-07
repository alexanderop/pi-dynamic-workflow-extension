# Agent Instructions

## Project purpose

This project is a learning project. The goal is to learn **Pi** by building a Pi extension together.

A second goal is to understand how Claude Code's dynamic workflow feature works. We are doing that by reverse engineering the externally visible behavior and writing down what we learn in `spec.md`.

## Required context

Before making changes in this repo:

1. Read `spec.md`.
2. Treat `spec.md` as the current working specification for the dynamic workflow feature.
3. If working on Pi extension behavior, also read the relevant Pi docs from the installed Pi documentation before implementing.
4. If you think any local doc could help with the task, read that doc first before implementing or answering.

## Working style

- This repo is exploratory: prefer clear notes, small experiments, and explicit assumptions over polished abstractions too early.
- Preserve reverse-engineering findings in `spec.md` when they affect the workflow model.
- Do not claim exact Claude Code internals unless the evidence is present; describe observed behavior and inferred contracts separately.
- Keep implementation changes connected to the learning goal: building a Pi extension that helps us understand dynamic workflows.
- When adding or changing behavior, document how it maps back to the workflow specification.
- When making or relying on a durable architecture decision, add or update an ADR in `docs/adr/`.

## Important files

- `spec.md` — reverse-engineered specification for Claude Code-like dynamic workflows.
- `AGENTS.md` — guidance for agents working in this learning project.

## Agent commands

Use `pnpm` for project scripts:

- `pnpm run verify` — canonical local harness for code changes; runs type checking, lint, format check, and the Vitest suite.
- `pnpm run check` — run TypeScript type checking with `tsc --noEmit`.
- `pnpm test` — run the Vitest test suite once.
- `pnpm run lint` — run Oxlint on `src`, `test`, and `.pi/workflows/scripts`.
- `pnpm run lint:fix` — apply safe Oxlint fixes in the same lint scope.
- `pnpm run fmt` — run Oxfmt on code, tests, workflow scripts, and project config files.
- `pnpm run fmt:check` — check that the Oxfmt-targeted files are formatted.

For code changes, prefer `pnpm run verify` before reporting completion unless the task specifically calls for a narrower check or the user asks not to run the full harness.

The Oxfmt scripts intentionally do not target the whole repository. Do not format `spec.md`, ADRs, or exploratory docs unless the task is specifically about formatting those documents.

## Git

- Commit message format: `{feat,fix,docs}[(scope)]: <message>`. Scope is the domain module touched (`workflows`, `ultracode`, `extension`, `tui`). Keep the message concise and imperative.
- Stage explicit paths (`git add <path>`); do not `git add -A` / `git add .`.
- No emojis in commits, PRs, or code. Technical prose only.
- Do not commit unless asked.

## Docs index

Use these like wiki links when orienting:

- [[spec.md]] — current working specification for Claude-Code-like dynamic workflows.
- [[README.md]] — package overview, install commands, planned structure, and `/workflows` UI plan.
- [[docs/backlog.md]] — incremental backlog for building the dynamic workflow epic through tested slices.
- [[docs/chunks/README.md]] — agent-ready task chunks split out from broad backlog slices.
- [[docs/spec-coverage.md]] — spec-to-code ownership map showing production files, tests, status, and next gaps by spec area.
- [[docs/workflows-live-feedback-spec.md]] — planned product/technical spec for live workflow activity feedback, truthful running/idle labels, and bounded telemetry persistence.
- [[docs/learning/README.md]] — guided onboarding path for learning Pi, dynamic workflows, and the current implementation.
- [[docs/error-handling.md]] — project-local Result pattern and workflow error-handling conventions.
- [[docs/adr/README.md]] — how to record architecture decisions for this project.
- [[docs/pi-extension-reference.md]] — Pi extension/package behavior, source files to inspect, dependency rules, loader behavior, and custom UI references.
- [[docs/testing-reference.md]] — Pi testing patterns to copy from the real Pi codebase.

## Reference repositories

Source-of-truth code for libraries we depend on. Treat as **read-only reference material** — do not edit files under `repos/`. When asked about a library listed below, explore its source here first instead of guessing or relying on training data.

- `repos/pi/` — https://github.com/earendil-works/pi @ main (squashed)

# Learning Guide

This folder is the onboarding path for a developer who wants to understand both sides of this project:

1. **Pi extension development** — how Pi loads packages, registers commands, exposes UI, and stores sessions.
2. **Dynamic workflows** — the Claude-Code-like workflow model we are reverse engineering and rebuilding as a Pi extension.

It is a teaching layer, not the source of truth. When these docs disagree with code, tests, `spec.md`, or ADRs, trust the source of truth and update the learning docs.

## Recommended reading order

Read these first if you are new to the project:

1. [00-orientation.md](./00-orientation.md)
2. [01-pi-basics.md](./01-pi-basics.md)
3. [02-pi-extension-model.md](./02-pi-extension-model.md)
4. [03-pi-package-loading.md](./03-pi-package-loading.md)
5. [04-dynamic-workflow-concepts.md](./04-dynamic-workflow-concepts.md)
6. [05-spec-to-code-map.md](./05-spec-to-code-map.md)
7. [06-current-implementation-walkthrough.md](./06-current-implementation-walkthrough.md)
8. [07-workflow-script-runtime.md](./07-workflow-script-runtime.md)
9. [08-state-persistence-and-workflows-command.md](./08-state-persistence-and-workflows-command.md)
10. [09-testing-and-debugging.md](./09-testing-and-debugging.md)
11. [10-roadmap-next-slices.md](./10-roadmap-next-slices.md)

Keep these nearby while reading:

- [glossary.md](./glossary.md) — vocabulary used across the project.
- [exercises.md](./exercises.md) — small tasks to prove you understand the code.
- [references.md](./references.md) — source-of-truth docs and external Pi docs.

## Source-of-truth docs

These files define current behavior and decisions:

- [`../../spec.md`](../spec.md) — reverse-engineered dynamic workflow specification.
- [`brain/plans/index.md`](../plans/index.md) — implementation plan by tested slices.
- [`brain/decisions/adr/`](../decisions/adr) — accepted architecture decisions.
- [`../../src/`](../src) — implementation.
- [`../../test/`](../test) — executable examples and behavior locks.

## What this guide intentionally does not do

- It does not replace `spec.md`.
- It does not claim exact Claude Code internals unless `spec.md` has evidence.
- It does not duplicate the full Pi documentation.
- It does not describe future behavior as already implemented.

The goal is to give a new developer a mental model quickly, then point them to the exact files that prove or implement each behavior.

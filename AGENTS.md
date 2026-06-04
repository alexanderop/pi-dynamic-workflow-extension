# Agent Instructions

## Project purpose

This project is a learning project. The goal is to learn **Pi** by building a Pi extension together.

A second goal is to understand how Claude Code's dynamic workflow feature works. We are doing that by reverse engineering the externally visible behavior and writing down what we learn in `spec.md`.

## Required context

Before making changes in this repo:

1. Read `spec.md`.
2. Treat `spec.md` as the current working specification for the dynamic workflow feature.
3. If working on Pi extension behavior, also read the relevant Pi docs from the installed Pi documentation before implementing.

## Working style

- This repo is exploratory: prefer clear notes, small experiments, and explicit assumptions over polished abstractions too early.
- Preserve reverse-engineering findings in `spec.md` when they affect the workflow model.
- Do not claim exact Claude Code internals unless the evidence is present; describe observed behavior and inferred contracts separately.
- Keep implementation changes connected to the learning goal: building a Pi extension that helps us understand dynamic workflows.
- When adding or changing behavior, document how it maps back to the workflow specification.

## Important files

- `spec.md` — reverse-engineered specification for Claude Code-like dynamic workflows.
- `AGENTS.md` — guidance for agents working in this learning project.

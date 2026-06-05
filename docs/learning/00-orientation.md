# 00: Orientation

This project is a learning project. We are using one concrete goal — building a Pi dynamic workflow extension — to learn two things at once:

1. How Pi extensions and packages work.
2. How Claude-Code-like dynamic workflows appear to work from externally visible artifacts.

## The project in one sentence

We are building a Pi extension that can launch JavaScript workflow scripts, let those scripts orchestrate many isolated subagents, persist progress, and show that progress through `/workflows`.

## The current philosophy

The project is intentionally incremental:

```text
fake runtime first
  then filesystem persistence
    then /workflows read model
      then journal/resume
        then real Pi subagents
          then rich TUI controls
```

That means some files already look like a real workflow system, but many pieces are fake or partial on purpose.

## Evidence vs implementation choices

The project separates three kinds of knowledge:

| Kind | Where it lives | Meaning |
|---|---|---|
| Observed workflow behavior | [`../../spec.md`](../../spec.md) | What we inferred from artifacts and want to emulate. |
| Implementation plan | [`../backlog.md`](../backlog.md) | How we plan to build it in small tested slices. |
| Architecture decisions | [`../adr/`](../adr/) | Pi-specific choices that future developers should not rediscover. |

When you learn something new from real artifacts, update `spec.md`.
When you decide how this Pi extension should implement something, add or update an ADR.
When you split future work, update `docs/backlog.md`.

## What exists today

The code currently supports:

- A Pi package shell with a `/workflows` command (`src/extension/index.ts:10`, registered via `pi.registerCommand("workflows", ...)`).
- Project-local run manifest discovery from `.pi/workflows/<runId>/manifest.json` (read-only; `src/workflows/run/store.ts`).
- A workflow script parser for literal `export const meta = { ... }` (`src/workflows/script/parser.ts`).
- A restricted Node VM runtime that executes workflow scripts (`src/workflows/script/runtime.ts`).
- A real `agent()` scheduler enforcing concurrency and total-agent caps (`src/workflows/agent/scheduler.ts`); only the agent _runner_ it calls is fake/injected today.
- `parallel()` and `pipeline()` runtime helpers.
- Explicit run and agent state machines (`src/workflows/run/state-machine.ts`).
- Inline workflow launch (from an inline `script` source only) with fake agents and manifest persistence (`src/workflows/launch/launcher.ts`).

The code does **not** yet support:

- Real Pi subagent sessions.
- Journal-based resume.
- Saved workflow launch by name.
- Launch by script path.
- Output files and terminal task notifications.
- Rich interactive `/workflows` TUI.
- Pause/resume/stop/restart controllers wired into UI.

## How to read the repo

Start with these files:

```text
README.md
spec.md
docs/backlog.md
docs/adr/
docs/learning/
```

Then read implementation files in this order:

```text
src/workflows/run/model.ts
src/workflows/result.ts
src/workflows/script/parser.ts
src/workflows/run/state-machine.ts
src/workflows/agent/scheduler.ts
src/workflows/script/runtime.ts
src/workflows/run/store.ts
src/workflows/launch/launcher.ts
src/extension/index.ts
```

Finally, read the matching tests under `test/workflows/` and `test/extension/`. They are often the clearest examples of current behavior.

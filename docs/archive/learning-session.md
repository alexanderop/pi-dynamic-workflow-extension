# Learning Session: Pi Dynamic Workflow Extension

A running checklist of what to understand. We go in order, confirming mastery (high-level *why* + low-level *what/how/edge cases*) before advancing. ✅ = demonstrated understanding.

---

## Stage 0 — Orientation & scope ✅ (quiz 3/3)
- [x] What "Pi" is, and what this extension adds to it
- [x] What a "dynamic workflow" is here (script → many agents)
- [x] The branch story: `main`, `cleanup-enforce-should-style-test-names`, `codex/dynamic-workflow-scaffold`
- [x] Roughly which subsystems exist (run / script / agent / journal / launch / saved / view / tui)

## Stage 1 — The problem (the *why*) ✅ (quiz 3/3 + migration discussion)
- [x] What problem the dynamic-workflow feature solves for a Pi user
- [x] Why workflows must be **durable** (crash/resume) and **deterministic** — content-addressed keys + replay
- [x] The specific `/workflows` monitor UI problem (the open ticket): old "job browser" vs. desired Claude-Code-style monitor
- [x] Why the in-progress UI migration has *two shapes coexisting* right now — view/ (runs/agents/details) vs tui (chooser/overview/agentDetail/promptReader)

## Stage 2 — The solution & design decisions
- [x] Event-sourced run state machine (`transitionRun`, states, terminal states) — table-driven, pure/immutable, Result type, two-phase requested→ing→ed; controller brackets side effect; error≠failed-on-disk
- [x] The agent state machine (queued→running→done/failed/stopped→restarted)
- [x] The journal: stable agent keys, replay cache, why determinism matters — events written during run, folded into cache on resume
- [x] Script runtime: VM sandbox (only injected globals), the hooks (`phase/log/agent/parallel/pipeline`, null-on-failure fan-out), determinism guards (runtime layer), default runner = echo, 1s sync timeout nuance
- [x] Scheduler: bounded worker-pool drain loop, cache-hit short-circuit, pause stops new starts (not in-flight → explains 'pausing'), abort via AbortSignal
- [ ] Launch flow: background execution, resume-from-runId
- [ ] Saved workflows: project-local scope, resolve & save
- [ ] View layer (pure projection/navigation) vs TUI rendering — separation of concerns
- [ ] The monitor states: chooser / overview / agentDetail / promptReader
- [ ] Key edge cases (width safety, prompt truncation vs full prompt, omit-missing-fields)

## Stage 3 — Broader context & impact
- [ ] How the pieces flow end-to-end (launch → execute → monitor → control → persist)
- [ ] Why layering (view vs tui vs command) matters for testing & change
- [ ] What changes when the UI ticket lands; what is explicitly out of scope
- [ ] Where the risks / unfinished seams are

---

## Notes & open questions
(captured as we go)

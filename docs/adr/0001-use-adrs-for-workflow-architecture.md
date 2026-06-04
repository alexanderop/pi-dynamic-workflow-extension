# ADR 0001: Use ADRs For Workflow Architecture

Status: accepted

## Context

The dynamic workflow feature is large enough to span many implementation sessions. Some choices are direct requirements from `spec.md`, while others are Pi-specific design decisions that map Claude-Code-like behavior into a Pi extension package.

If those Pi-specific choices stay only in chat history, future agents will rediscover or accidentally change them.

## Decision

We will record architectural decisions in `docs/adr/`.

Use ADRs for durable implementation decisions such as storage layout, saved workflow locations, notification mechanism, sandbox strategy, key hashing inputs, structured-output retry policy, and `/workflows` UI state model.

Keep reverse-engineered feature facts in `spec.md`. Keep implementation planning in `docs/backlog.md`. Keep final decisions in ADRs.

## Consequences

- Future agents have a stable place to check why a design exists.
- We can distinguish observed Claude Code behavior from Pi-specific implementation choices.
- New architecture work should update or add ADRs when it settles a meaningful decision.

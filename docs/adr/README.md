# Architecture Decision Records

Use ADRs to record decisions that shape the Pi dynamic workflow extension over time.

Create or update an ADR when a change decides something that future agents should not have to rediscover, including:

- Pi-native storage layout.
- Saved workflow locations.
- Notification mechanism.
- Workflow sandbox strategy.
- Stable key hashing inputs.
- Structured-output retry policy.
- Mapping Claude-style `agentType` to Pi concepts.
- `/workflows` UI state model.

Keep ADRs short:

```md
# ADR N: Title

Status: proposed | accepted | superseded

## Context

What forces or facts led to the decision?

## Decision

What are we choosing?

## Consequences

What gets easier, harder, or deferred?
```

ADRs document implementation choices. Reverse-engineered workflow behavior still belongs in `spec.md`.

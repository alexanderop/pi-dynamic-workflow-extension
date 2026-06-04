# Workflow extension suite tests

Use `tests/suite/` for harness-based characterization and regression tests around the workflow extension.

Rules:

- Use `tests/suite/harness.ts` as the suite entry point for test doubles and cleanup helpers.
- Use faux agents/providers; do not call real provider APIs, real API keys, network services, or paid tokens.
- Keep tests CI-safe and deterministic.
- Prefer temp directories, in-memory managers, and explicit `afterEach` cleanup.

Organization:

- Put broad lifecycle and characterization tests directly under `tests/suite/`.
- Put issue-specific regression tests under `tests/suite/regressions/`.
- Name regression tests as `regression-<issue-number-or-slug>.test.ts` when there is no issue number.

# Category Mapping (problem_type → docs/solutions/ subdirectory)

Pick the narrowest category that fits. The category slug IS the subdirectory name:
`docs/solutions/<category>/<slug>.md`.

## Bug track

| Category slug | Use for |
|---------------|---------|
| `build-errors` | Compilation, bundling, packaging, dependency-resolution build failures. |
| `test-failures` | Failing/flaky tests, test-harness issues. |
| `runtime-errors` | Crashes, exceptions, unhandled errors at runtime. |
| `performance-issues` | Slowness, N+1 queries, memory, latency, bundle size. |
| `database-issues` | Migrations, query correctness, data integrity, locking. |
| `security-issues` | Vulnerabilities, auth/authz bugs, injection, secret leaks. |
| `ui-bugs` | Visual/layout/interaction defects in the frontend. |
| `integration-issues` | Third-party APIs, webhooks, cross-service failures. |
| `logic-errors` | Incorrect behavior from a reasoning/algorithm mistake. |

## Knowledge track

| Category slug | Use for |
|---------------|---------|
| `architecture-patterns` | Structural decisions: agent/skill/pipeline/workflow shape. |
| `design-patterns` | Reusable non-architectural approaches (interaction, prompt, content shapes). |
| `tooling-decisions` | Language/library/tool choices with durable rationale. |
| `conventions` | Team-agreed ways of doing something, captured to survive turnover. |
| `workflow-issues` | Friction or fixes in the development workflow itself. |
| `developer-experience` | DX improvements, ergonomics, local-setup learnings. |
| `documentation-gaps` | Missing/misleading docs and how they were resolved. |
| `best-practices` | Fallback only — use when no narrower knowledge category fits. |

## Choosing the track

- **Bug track** = something was broken and got fixed. Has symptoms + root cause.
- **Knowledge track** = a practice, pattern, or decision worth preserving. No "bug" per se.

When unsure, ask: "Would a future reader search for this to fix a failure (bug) or to learn how
we do something (knowledge)?"

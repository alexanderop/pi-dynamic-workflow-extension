# ADR 0017: Use Workflow Feature Flags

Status: proposed

## Context

The workflow extension currently supports explicit model hints on workflow, phase, and agent calls. The desired default is simpler: users pick the Pi model once, and workflow subagents inherit it while only varying thinking effort. We still want to keep the current model-routing behavior available for later experimentation.

Future workflow behavior will likely need more experimental switches. One-off booleans would make configuration, tests, manifests, and user support inconsistent.

## Decision

Introduce a typed workflow feature-flag system.

The first flag is `experimentalModelRouting`, exposed to users as `experimental-model-routing` and defaulting to `false`.

When disabled, workflow model hints are accepted for compatibility but ignored for execution; subagents use the current Pi model captured at launch and may vary `thinkingLevel`.

When enabled, the current explicit model-routing behavior is restored as an experimental feature.

Users should be able to control flags through `/workflows features`, project/user config files, environment variables, and Pi CLI flags. Resolved feature values should be persisted in run manifests.

## Consequences

- The installed extension has a simpler default mental model.
- Experimental behavior remains available without keeping it in the default path.
- Future flags get a consistent registry, resolution order, command UX, and manifest/audit story.
- Configuration code becomes a new extension subsystem that needs focused tests.
- Workflow scripts with stale `model` hints remain compatible but no longer imply routing unless the experimental flag is enabled.

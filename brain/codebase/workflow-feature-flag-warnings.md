# Workflow Feature Flag Warnings

- `resolveWorkflowFeatures(...)` returns `warnings` for invalid feature config/env values and hook failures.
- `/workflows features` displays those warnings through `formatWorkflowFeatures(...)`.
- `buildWorkflowLaunchOptions(...)` currently consumes only `features` and `decisions`, so actual Workflow launches do not surface resolver warnings.
- If future work adds launch-time warning UX, plumb `resolvedFeatures.warnings` into launch logs, notifications, manifests, or debug output instead of re-running feature resolution.

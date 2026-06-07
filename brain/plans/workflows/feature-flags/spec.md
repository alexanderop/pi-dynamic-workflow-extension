---
title: Workflow Feature Flags Spec
status: implemented
priority: P6
last_audited: 2026-06-07
implementation: "Feature registry, config/session/env/CLI resolution, /workflows features, manifest persistence, and default-off experimental model routing are implemented and covered."
next: "No active implementation gap beyond the documented Pi limitation for explicit CLI false provenance."
---

# Workflow Feature Flags Spec

## Purpose

Introduce a small feature-flag system for the dynamic workflow extension so the default user experience can stay simple while experimental behavior remains available behind explicit opt-in switches.

The first consumer is model routing:

- default: workflow subagents inherit the current Pi model and workflows may only vary `thinkingLevel`;
- experimental: restore the current per-workflow/per-phase/per-agent model-routing behavior.

## Goals

- Make feature defaults safe, simple, and stable for users who install the extension.
- Let users enable or disable experimental workflow features without editing source code.
- Support session, project, and user-wide feature choices.
- Persist resolved feature decisions in run manifests for audit/debugging.
- Provide a hook point so future extensions or local policy packages can contribute feature decisions without patching this package.
- Keep all experimental behavior explicit in authoring prompts, tool descriptions, logs, and tests.

## Non-goals

- Do not build a general Pi settings framework.
- Do not require users to edit JSON by hand for common enable/disable flows.
- Do not let third-party hooks silently override explicit user/session choices.
- Do not remove currently parsed workflow `model` fields in the first slice; keep them compatible but inert by default.

## Feature model

```ts
interface WorkflowFeatureFlags {
  /**
   * Experimental. When false, workflow model hints are ignored and every
   * subagent uses the Pi model selected at launch.
   */
  experimentalModelRouting: boolean;
}

const DEFAULT_WORKFLOW_FEATURES: WorkflowFeatureFlags = {
  experimentalModelRouting: false,
};
```

Each feature has a public kebab-case name for user-facing surfaces:

| Internal key | Public name | Default | Stage | Description |
|---|---|---:|---|---|
| `experimentalModelRouting` | `experimental-model-routing` | `false` | experimental | Allow workflow scripts to route subagents to explicit model hints. |

Feature definitions should live in one registry module, for example `src/extension/features/registry.ts`, so command output, env parsing, CLI flags, manifests, docs, and tests all share names/descriptions.

## Resolution sources and precedence

Feature resolution is last-writer-wins by source priority. Lower numbers are weaker.

| Priority | Source | Example |
|---:|---|---|
| 0 | built-in defaults | `experimentalModelRouting: false` |
| 10 | user config file | `~/.pi/agent/dynamic-workflows.json` |
| 20 | project/workspace config file | `<workflow-root>/config.json` |
| 30 | external hook contributions | Pi event-bus mutation from another extension |
| 40 | environment variables | `PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING=1` |
| 50 | Pi CLI flags | `--workflow-experimental-model-routing` |
| 60 | session toggles | `/workflows features enable experimental-model-routing --scope session` |
| 70 | explicit launch/test overrides | direct `launchWorkflow(..., { features })` in tests/integrations |

Explicit user controls (env, CLI, session) must beat external hooks. Hooks are for policy defaults and integrations, not for surprising override of a user’s direct choice.

## Config files

### User config

Path:

```text
~/.pi/agent/dynamic-workflows.json
```

Shape:

```json
{
  "features": {
    "experimentalModelRouting": false
  }
}
```

### Project/workspace config

Path:

```text
<workflow-root>/config.json
```

`<workflow-root>` is the same root resolved by `workflowRootDirForCwd(...)`, usually `.pi/workflows` at the project or workspace boundary.

Shape is the same as user config.

### File behavior

- Unknown top-level keys MUST be preserved when commands write config files.
- Unknown feature keys SHOULD be preserved but ignored by current code.
- Invalid config files should not crash extension startup; emit an actionable warning in UI/headless output and continue from weaker sources.
- Writes should be atomic: write temp file then rename.

## CLI and env controls

Register one Pi CLI flag per feature:

```ts
pi.registerFlag("workflow-experimental-model-routing", {
  description: "Enable experimental per-agent workflow model routing",
  type: "boolean",
  default: false,
});
```

Environment variable naming:

```text
PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING=1
PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING=true
PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING=0
PI_DYNAMIC_WORKFLOWS_EXPERIMENTAL_MODEL_ROUTING=false
```

Invalid env values should warn and be ignored.

## Slash-command UX

Extend `/workflows` with a feature subcommand.

### Show

```text
/workflows features
```

Output should include:

- public feature name;
- enabled/disabled value;
- stage (`stable`, `experimental`, `deprecated` later);
- winning source (`default`, `user`, `project`, `env`, `cli`, `session`, `override`);
- short description.

Example:

```text
Workflow features
- experimental-model-routing: disabled (default, experimental)
  Allow workflow scripts to route subagents to explicit model hints.
```

### Enable / disable / reset

```text
/workflows features enable experimental-model-routing
/workflows features disable experimental-model-routing
/workflows features reset experimental-model-routing
```

Default write scope should be `session` to avoid surprising durable changes. Durable scopes are explicit:

```text
/workflows features enable experimental-model-routing --scope project
/workflows features enable experimental-model-routing --scope user
```

Scopes:

| Scope | Behavior |
|---|---|
| `session` | Persist a Pi custom session entry and affect launches in the current session. |
| `project` | Write `<workflow-root>/config.json`. |
| `user` | Write `~/.pi/agent/dynamic-workflows.json`. |

In TUI mode, `/workflows features` may later open an interactive selector. The first slice can be text command output only.

## Hook API

Future hook point via Pi’s shared event bus:

```ts
interface WorkflowFeatureResolveHookPayload {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly workflowRoot: string;
  features: WorkflowFeatureFlags;
  decisions: WorkflowFeatureDecision[];
  set(
    key: keyof WorkflowFeatureFlags,
    value: boolean,
    source: string,
    reason?: string,
  ): void;
}

pi.events.emit("dynamic-workflows:features:resolve", payload);
```

Rules:

- Hooks run after config files and before env/CLI/session overrides.
- Hooks must be synchronous in the first version.
- Hook decisions must be recorded in `decisions` for audit output.
- Hook source names should be namespaced, e.g. `my-company-policy`.
- Hook failures should warn and continue from existing decisions.

## Launch and manifest integration

`WorkflowLaunchOptions` should gain:

```ts
features?: Partial<WorkflowFeatureFlags>;
```

`WorkflowRunState` should persist:

```ts
features?: WorkflowFeatureFlags;
featureDecisions?: WorkflowFeatureDecision[];
```

A decision records the final effective value and enough provenance to debug it:

```ts
interface WorkflowFeatureDecision {
  key: keyof WorkflowFeatureFlags;
  value: boolean;
  source: "default" | "user" | "project" | "hook" | "env" | "cli" | "session" | "override";
  detail?: string;
}
```

Do not make `/workflows` overview depend on reading config files for historical runs. Historical manifests should carry the resolved features used at launch.

## Model routing behavior

### Default: `experimentalModelRouting = false`

- Effective model for every subagent is the current Pi model captured at launch.
- `meta.model`, `meta.phases[].model`, `meta.phases[].agents[].model`, and `agent({ model })` are accepted for compatibility but ignored for execution.
- `thinkingLevel` remains active at workflow, phase, planned-agent, and agent-call level where currently supported.
- If any non-`default` model hint appears, add one run log:

```text
Workflow model hints are ignored because experimental-model-routing is disabled; using the current Pi model.
```

- Stable journal keys should include the effective inherited model and effective thinking level, not ignored requested model hints. Editing an ignored model hint should not invalidate resume.
- UI agent rows should show the effective inherited model. Planned model labels should be hidden or marked ignored rather than displayed as if active.
- Authoring prompts should say: do not set `model`; select the desired Pi model before launching the workflow and use `thinkingLevel` to vary effort.

### Experimental: `experimentalModelRouting = true`

- Preserve current behavior: requested model hints may resolve to exact or unique short Pi model references.
- Invalid, unavailable, or ambiguous model hints fall back to the current Pi model with a warning.
- Journal keys include effective routed model and thinking level.
- Authoring prompts may mention exact `provider/model-id` hints only when this flag is enabled.

## Testing requirements

- Unit-test feature registry defaults and public/internal name mapping.
- Unit-test source precedence, including hooks losing to env/CLI/session choices.
- Unit-test config read/write with unknown-key preservation.
- Unit-test `/workflows features` text output and enable/disable/reset parsing.
- Runtime tests:
  - default mode ignores agent/model/phase/meta model hints;
  - default mode still applies requested `thinkingLevel`;
  - default mode journal key is unchanged when only ignored model hints change;
  - experimental mode preserves current model-routing tests.
- Extension tests:
  - launch options carry resolved features;
  - CLI flag enables `experimentalModelRouting`;
  - session toggle affects later launches in the same session.

Do not add live model tests. Use fake model registries and fake agent/session factories.

## Implementation order

1. Add feature registry and resolver with tests.
2. Add config readers/writers and command parsing with tests.
3. Register CLI flag and pass resolved features into launch options.
4. Persist resolved features in run manifests.
5. Flip model routing default to inherited-current-model behavior.
6. Put current model-routing behavior behind `experimentalModelRouting`.
7. Update authoring prompt, tool description, and docs.
8. Add hook payload after the local resolver is stable.

## Open questions

- Should durable `/workflows features enable ... --scope user` be allowed in all modes, or only when `ctx.hasUI` is true?
- Should project config live at `<workflow-root>/config.json` or `.pi/workflows.json`? The proposed location keeps all workflow state under one root.
- Should hooks be synchronous only forever, or should a later Pi API add async feature providers?

# Product Owner Review: Dynamic Workflow Extension

## Executive summary

The Dynamic Workflow Extension turns Pi from a single conversational coding assistant into a lightweight workflow orchestrator. Instead of asking one agent to do everything sequentially, a developer can launch a structured JavaScript workflow that coordinates multiple isolated subagents, tracks progress in a live dashboard, persists the run, and saves successful workflows for reuse.

The product direction is strong: developers increasingly need agents to do larger, longer-running, multi-step work without losing visibility or control. This extension is a promising foundation for that. The next product opportunity is to make workflow authoring, debugging, sharing, and trust much easier for everyday developers.

## Product thesis

Developers need a way to turn repeatable AI-assisted work into reliable, inspectable, reusable workflows.

This extension should become the place where a developer can say:

> “Run my project audit workflow.”  
> “Review this codebase using multiple specialist agents.”  
> “Investigate this bug in parallel and give me a report.”  
> “Use my team’s release workflow and show me progress.”

The product is not only a tool for running scripts. It is a system for making AI work more structured, observable, repeatable, and shareable.

## What problem does it solve?

Today, many AI coding tasks are handled as one long chat. That creates problems:

- The agent loses focus over long tasks.
- Work happens sequentially even when parts could run in parallel.
- Developers cannot easily inspect what each subtask did.
- Good prompts are hard to reuse.
- Long-running work blocks the conversation.
- Finished work often disappears into chat history instead of becoming a reusable asset.

The workflow extension addresses these problems by introducing:

- **Explicit orchestration** through JavaScript workflow scripts.
- **Parallel execution** with isolated subagents.
- **Progress visibility** through the `/workflows` dashboard.
- **Persistence and resume** for longer-running work.
- **Saved workflows** that become reusable slash commands.

## Why this matters

As developers use AI agents for larger tasks, they need more than a chat box. They need operational structure.

A serious developer workflow requires:

- clear phases,
- visible progress,
- cancellation,
- resumability,
- reusable recipes,
- predictable inputs,
- durable outputs,
- and confidence that the system will not silently lose work.

This extension is valuable because it moves Pi in that direction. It gives developers a way to design agent work instead of only prompting for it.

## What is already strong

### 1. Clear core concept

The extension has a compelling purpose: run deterministic workflow scripts that coordinate subagents and show live progress.

That is easy to understand and maps to real developer needs like code review, audits, planning, debugging, and release preparation.

### 2. Useful workflow primitives

The available primitives are well chosen:

- `agent()` for isolated subagent work
- `parallel()` for fan-out/fan-in execution
- `pipeline()` for staged processing
- `phase()` for visible progress
- `log()` for status updates
- `args` for input
- `cwd` for project context
- `budget` for cost-aware orchestration

These primitives are simple enough to learn but powerful enough to express real workflows.

### 3. Live dashboard

The `/workflows` dashboard is a major differentiator. Developers need to see what is happening while work runs in the background.

The dashboard makes the extension feel like a real product instead of only a hidden tool call.

### 4. Saved workflows

The ability to save a workflow and rerun it as a slash command is strategically important. This turns one-off agent behavior into reusable developer automation.

This is where the extension can become a workflow library, not just an execution engine.

### 5. Honest trust model

The README clearly says that the VM is not a strong security sandbox. That honesty is important. Developers can accept limitations if the product explains them clearly.

## Product gaps and missing features

## 1. Workflow examples and templates

### Problem

The runtime is powerful, but developers need to know what to build with it. A tiny example is not enough to drive adoption.

A developer evaluating the extension will ask:

> “What workflows should I create first?”

### Motivation

Examples are not just documentation. They are product onboarding. They show the intended use cases, teach best practices, and help users get value quickly.

### Recommendation

Add an examples gallery with ready-to-use workflows:

- `audit-project.workflow.js`
- `code-review.workflow.js`
- `tdd-feature.workflow.js`
- `debug-investigation.workflow.js`
- `release-prep.workflow.js`
- `docs-update.workflow.js`
- `issue-triage.workflow.js`

Each example should include:

- what problem it solves,
- expected input arguments,
- workflow phases,
- what the final output looks like,
- when to use it,
- and when not to use it.

## 2. Workflow authoring guide

### Problem

The README introduces the feature, but workflow authoring is the main product surface. Developers need a deeper guide.

### Motivation

If developers cannot confidently write workflows, they will not build reusable automation. The extension should teach a developer how to think in phases, subagents, schemas, and final reports.

### Recommendation

Create:

```text
docs/workflow-authoring.md
```

Include:

- primitive reference,
- structured output examples,
- `args` conventions,
- `budget` usage,
- concurrency behavior,
- resume and journal behavior,
- cancellation behavior,
- common mistakes,
- best-practice subagent prompts,
- example workflow patterns.

## 3. Local validation and debugging

### Problem

Developers need a way to validate workflow scripts before running expensive subagents inside Pi.

### Motivation

A workflow script is closer to code than a prompt. Developers expect code-like feedback: validation, errors, previews, and dry runs.

### Recommendation

Add a CLI or command surface such as:

```bash
pi-workflow validate my.workflow.js
pi-workflow inspect my.workflow.js
pi-workflow dry-run my.workflow.js
```

This should check:

- valid `export const meta`,
- missing or invalid phases,
- banned nondeterministic APIs,
- missing `agent()` calls,
- invalid structured output schema usage,
- obvious non-JSON-serializable return values,
- and estimated workflow shape.

A good validator would make workflow authoring much safer and faster.

## 4. Workflow scaffolding

### Problem

Saved workflows are useful after a run, but there is no obvious path for creating a new workflow from scratch.

### Motivation

Developers often start from templates. A blank file creates friction. A scaffolded workflow teaches conventions and encourages consistency.

### Recommendation

Add a command like:

```text
/workflow-new <template> <name>
```

Example:

```text
/workflow-new code-review review_security_changes
```

This could create a workflow script from a template, open it in the editor, and register it after validation.

## 5. Report and export artifacts

### Problem

A workflow should not only finish in the dashboard. Developers need a durable output they can share in an issue, PR, handoff, or release note.

### Motivation

The value of a workflow is often its final artifact. If the output is hard to export, the developer has to manually copy from the UI or chat, which reduces trust and usefulness.

### Recommendation

Add export options:

```text
/workflow-export <job-id> markdown
/workflow-export <job-id> json
/workflow-copy-result <job-id>
```

Useful export formats:

- Markdown report,
- JSON run summary,
- final result only,
- agent transcript,
- phase timeline,
- failure report.

This would make workflows much more useful for teams.

## 6. Stronger safety and resource controls

### Problem

The current VM is a guardrail, not a true sandbox. CPU-bound loops cannot be preempted. Long-running workflows can also produce large logs, outputs, or persisted files.

### Motivation

Developers need confidence that a workflow will not hang their session, explode storage, or run far beyond expectations.

### Recommendation

Add configurable limits:

- max runtime,
- max agent calls,
- max concurrency,
- max result size,
- max log size,
- max journal size,
- retention policy,
- cleanup commands.

Longer term, consider moving workflow execution into a worker thread or child process so it can be terminated safely.

## 7. Privacy and persistence controls

### Problem

Workflow runs persist prompts, results, scripts, and journals. That is useful, but developers need clear control over what is stored.

### Motivation

Developers may run workflows over private code, secrets, customer data, or unreleased product plans. Persistence must be transparent and controllable.

### Recommendation

Add:

```text
/workflow-cleanup
/workflow-forget <job-id>
/workflow-persistence off
```

Also document:

- where data is stored,
- what data is stored,
- how long it remains,
- how to delete it,
- and how to disable persistence for sensitive work.

## 8. Team sharing and workflow libraries

### Problem

Saved workflows are local. There is no clear story for sharing workflows across a team or project.

### Motivation

The most valuable workflows will often be team workflows: release checks, review standards, incident response, architecture audits, migration plans, and onboarding flows.

### Recommendation

Support import/export and git-friendly workflow libraries:

```bash
pi-workflow export audit_project > audit_project.workflow.js
pi-workflow import audit_project.workflow.js
```

Potential project structure:

```text
.pi/workflows/library/
  audit_project.workflow.js
  release_prep.workflow.js
  review_pr.workflow.js
```

This would let teams version workflows alongside the codebase.

## 9. Public API and compatibility story

### Problem

The package exports runtime and UI helpers, and it persists workflow data to disk. Developers need to know what is stable and what may change.

### Motivation

If users build workflows or integrations on top of the extension, they need confidence that upgrades will not break them unexpectedly.

### Recommendation

Document:

- stable public APIs,
- experimental APIs,
- internal APIs,
- persisted format versions,
- migration policy,
- compatibility guarantees.

This will matter more as adoption grows.

## Suggested roadmap

## Phase 1: Adoption and onboarding

Goal: make the extension understandable and immediately useful.

Deliverables:

- examples gallery,
- workflow authoring guide,
- screenshots or terminal recordings,
- common use-case documentation.

## Phase 2: Authoring and debugging

Goal: make developers confident creating workflows.

Deliverables:

- workflow validator,
- workflow inspector,
- dry-run mode,
- workflow scaffolding command,
- better error messages.

## Phase 3: Outputs and sharing

Goal: make workflow results useful outside the dashboard.

Deliverables:

- Markdown export,
- JSON export,
- copy final result,
- agent transcript export,
- import/export saved workflows,
- team workflow library support.

## Phase 4: Trust and operational controls

Goal: make workflows safe enough for larger and longer-running work.

Deliverables:

- hard resource limits,
- retention cleanup,
- privacy controls,
- persistence opt-out,
- corrupt journal recovery,
- worker or child-process isolation.

## Recommended next three investments

If we want the highest product impact with the least ambiguity, prioritize:

1. **Examples and templates**  
   This helps users understand the product and get value quickly.

2. **Workflow validation/debugging**  
   This makes authoring safer and reduces frustration.

3. **Markdown/JSON export**  
   This turns workflow runs into useful team artifacts.

## Product owner conclusion

The extension already has a strong technical foundation and a compelling product direction. It solves a real developer problem: making AI-assisted work more structured, parallel, visible, persistent, and reusable.

The main missing piece is not more orchestration power. The main missing piece is productization around the developer experience:

- teach users what to build,
- help them author workflows safely,
- give them useful output artifacts,
- make persistence and safety trustworthy,
- and enable teams to share workflows.

If those pieces are added, this can become a meaningful workflow layer for Pi rather than just an advanced tool for power users.

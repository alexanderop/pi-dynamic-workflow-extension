---
created: 2026-06-04
implemented: false
---

# Spec: Rich Active Workflow Footer Status

## Problem

When a session has one or more active background workflows, the Pi footer currently shows only a coarse count:

```text
workflows:1
```

This confirms that something is running, but it does not answer the user's immediate monitoring questions:

- Which workflow is running?
- What phase is it in?
- Are agents currently active?
- How long has it been running?
- Is there more than one workflow competing for attention?

Users have to open `/workflows` for even basic context. The footer should provide a compact live summary while keeping the detailed dashboard one command away.

## Product goal

Replace the count-only workflow status with a compact active-workflow summary:

```text
workflow: audit_prompts · Verify · 3 agents · 2m13s
```

The footer should make active background work glanceable without becoming a full dashboard.

## Desired behavior

### One active workflow

When exactly one workflow is running, show:

```text
workflow: <name> · <phase> · <active agents> agents · <elapsed>
```

Example:

```text
workflow: audit_prompts · Verify · 3 agents · 2m13s
```

Field rules:

- `<name>` is `WorkflowJob.name`.
- `<phase>` is `job.snapshot.currentPhase`, if present.
- `<active agents>` counts agents whose status is `running`.
- `<elapsed>` is `Date.now() - job.startedAt`, formatted with the existing duration formatter.

If a field is unavailable, omit it rather than showing placeholder text.

Examples:

```text
workflow: audit_prompts · 2m13s
workflow: audit_prompts · Verify · 2m13s
workflow: audit_prompts · 3 agents · 2m13s
```

### Multiple active workflows

When more than one workflow is running, keep the footer compact but include the most useful current job details:

```text
workflows: 2 · audit_prompts/Verify · 3 agents · 2m13s
```

Selection rule for the displayed workflow:

1. Prefer the newest running workflow.
2. If a future UI exposes a selected workflow from `/workflows`, this may switch to the selected active workflow.

The leading `workflows: 2` communicates concurrency; the rest tells the user which run is most recent or prominent.

### No active workflows

When no workflow is running, clear the workflow footer slot:

```ts
ctx.ui.setStatus("workflow", undefined)
```

Do not show completed history in the footer.

### Width and truncation

The footer is shared with other session status items, so this summary must be short and robust.

Recommended behavior:

- Build the full summary first.
- Cap to a conservative maximum, e.g. 60 visible columns, unless Pi's status API provides a width.
- Truncate the workflow name first before dropping useful state.
- Preserve the rightmost operational fields where possible: phase, active agent count, elapsed.

Example truncation target:

```text
workflow: very_long_workflow… · Verify · 3 agents · 2m13s
```

### Status styling

Use the existing accent color for running workflows.

Optional glyphs can be added later, but the first implementation should stay text-first to avoid making the footer noisy.

Preferred initial style:

```ts
ctx.ui.theme.fg("accent", summary)
```

## Implementation notes

Likely file: `extensions/workflow.ts`.

Current implementation:

```ts
function updateStatus(ctx: ExtensionContext): void {
	const jobs = manager.getJobs();
	const running = jobs.filter((job) => job.status === "running").length;
	if (running > 0) {
		ctx.ui.setStatus(
			"workflow",
			ctx.ui.theme.fg("accent", `workflows:${running}`),
		);
		return;
	}
	ctx.ui.setStatus("workflow", undefined);
}
```

Replace the count-only formatter with a helper that derives a compact summary from running jobs.

Suggested helpers:

```ts
function activeAgentCount(job: WorkflowJob): number {
	return job.snapshot.agents.filter((agent) => agent.status === "running").length;
}

function formatFooterDuration(ms: number): string {
	// Prefer reusing formatDuration from src/workflow-ui-format.ts if exported/appropriate.
}

function formatActiveWorkflowStatus(jobs: WorkflowJob[], now = Date.now()): string | undefined {
	const running = jobs.filter((job) => job.status === "running");
	if (running.length === 0) return undefined;

	const job = running.at(-1)!;
	const parts = [];
	const prefix = running.length === 1 ? "workflow:" : `workflows: ${running.length} ·`;
	const nameAndPhase = job.snapshot.currentPhase
		? `${job.name}/${job.snapshot.currentPhase}`
		: job.name;

	parts.push(prefix, nameAndPhase);
	const agents = activeAgentCount(job);
	if (agents > 0) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
	parts.push(formatFooterDuration(now - job.startedAt));

	return compactAndTruncate(parts);
}
```

Final `updateStatus` shape:

```ts
function updateStatus(ctx: ExtensionContext): void {
	const summary = formatActiveWorkflowStatus(manager.getJobs());
	ctx.ui.setStatus(
		"workflow",
		summary ? ctx.ui.theme.fg("accent", summary) : undefined,
	);
}
```

Keep this as a pure formatting change. It should not affect workflow lifecycle, persistence, completion notifications, `/workflows`, or active tool registration.

## TDD plan

Add unit tests for the formatter. Prefer extracting the formatter into a testable module if needed, for example `src/workflow-status.ts`.

### RED

Test cases:

1. **Single running workflow shows name, phase, active agents, elapsed**
   - Given one running job named `audit_prompts`
   - Current phase `Verify`
   - Three running agents
   - Started 133 seconds ago
   - Expect `workflow: audit_prompts · Verify · 3 agents · 2m13s`

2. **Single running workflow omits missing phase**
   - Given no `currentPhase`
   - Expect no empty separator and no placeholder.

3. **Zero active agents omits agent count**
   - Given no running agents
   - Expect `workflow: audit_prompts · Verify · 2m13s`.

4. **Multiple running workflows shows count and newest workflow detail**
   - Given two running jobs
   - Newest is `release` in phase `Test`
   - Expect `workflows: 2 · release/Test · ...`.

5. **No running workflows clears status**
   - Given only done/error/cancelled jobs
   - Expect formatter returns `undefined`.

6. **Long names truncate safely**
   - Given a very long workflow name
   - Expect output does not exceed the chosen max visible width.
   - Expect phase, agent count, and elapsed remain visible when possible.

### GREEN

- Extract or add formatter helper.
- Update `extensions/workflow.ts:updateStatus` to use the formatter.
- Reuse existing duration/truncation helpers where practical.
- Ensure status updates still occur on `manager.onChange` and on session start.

### REFACTOR

- Keep footer-specific formatting separate from `/workflows` dashboard rendering.
- Avoid duplicating complex width logic if an existing truncation helper is already available.
- Keep helper inputs deterministic by accepting `now` in tests.

## Acceptance criteria

- A single active workflow footer displays: workflow name, current phase, active agent count, and elapsed time when available.
- Example target output is supported:

```text
workflow: audit_prompts · Verify · 3 agents · 2m13s
```

- Multiple active workflows display the active count plus newest workflow context.
- The footer status disappears when no workflows are running.
- Long workflow names do not break the footer layout.
- Existing `/workflows` dashboard behavior is unchanged.
- Existing tests pass, with new formatter tests covering the footer summary.

## Non-goals

- Redesign the full footer/status bar.
- Add interactive controls to the footer.
- Show completed workflow history in the footer.
- Replace `/workflows` as the detailed dashboard.
- Add warning/error summaries for completed workflows in this first pass.

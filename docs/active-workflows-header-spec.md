# Spec: Active-Only Workflow Header

## Problem

The `/workflows` dashboard header currently shows past workflow jobs alongside the active workflow. In the screenshot, completed historical workflows like `#1 software_ai_factory_research` and `#2 world_cup_winner_research` appear in the top job strip while the user is trying to monitor active workflow `#3 native_workflow_trigger_tdd`.

This makes the dashboard feel noisy and less native. When a workflow is running, the header should focus on what is active now, not past runs.

## Product goal

Make the `/workflows` header show only active workflow runs by default, so the user can immediately see current work without visual clutter from completed history.

Historical workflows should still be accessible when the user explicitly asks for history, but they should not dominate the active-run header.

## Why this matters

- **Focus:** users open `/workflows` primarily to watch live work.
- **Reduced noise:** old completed workflows make the header harder to scan.
- **Native feel:** active work should be prominent; history should be secondary.
- **Better mental model:** the dashboard becomes a live monitor first and an archive second.

## Desired behavior

### Default header behavior

When one or more workflows are active, the top workflow strip should show only active jobs:

```text
◆ Workflows
[⠋ #3 native_workflow_trigger_tdd]
⠋ #3 native_workflow_trigger_tdd — 1/2 agents · running · 2m16s
```

Completed, cancelled, failed, or interrupted workflows should not appear in this active header strip by default.

### Empty active state

When there are no active workflows, `/workflows` may show a clear empty active state:

```text
◆ Workflows
No active workflows.
Press h to show history, or start a workflow to watch it here.
```

### History access

Historical workflows should remain accessible through an explicit toggle or command.

Recommended controls:

- `h` toggles history visibility.
- When history is visible, the header can show all jobs or a separate `History` section.
- The footer should advertise the toggle:

```text
↑↓ select · ←→ focus · h history · c cancel · q close
```

### Selection rules

- On open, select the newest running workflow if any exist.
- If no workflows are running, select the newest non-running workflow only after history mode is enabled.
- If the selected active workflow completes while the dashboard is open:
  - keep it visible until the user moves selection, or
  - move it into a short “Recently completed” row below the active header.

Preferred first implementation: keep the just-completed selected job visible until close, but remove older completed jobs from the header.

## Implementation notes

Likely file: `src/workflow-browser.ts`.

Current behavior appears to come from rendering all jobs in `renderJobStrip(jobs, width)` and selecting from `manager.getJobs()` directly.

Introduce a view-mode concept:

```ts
type WorkflowJobViewMode = "active" | "history";
```

Add helpers:

```ts
function isActiveWorkflowJob(job: WorkflowJob): boolean {
  return job.status === "running";
}

function visibleJobs(jobs: WorkflowJob[], mode: WorkflowJobViewMode): WorkflowJob[] {
  return mode === "history" ? jobs : jobs.filter(isActiveWorkflowJob);
}
```

Use `visibleJobs()` for:

- header job strip rendering,
- default selected job on open,
- left/right workflow navigation.

Be careful not to break status notifications or persisted history. This is a dashboard visibility change, not a data deletion change.

## TDD plan

### RED

Add behavior tests in `tests/workflow-browser.test.ts`.

Test cases:

1. **Header hides completed workflows when active workflow exists**
   - Given jobs `#1 done`, `#2 done`, `#3 running`
   - Render `/workflows`
   - Expect header/job strip to include `#3`
   - Expect header/job strip not to include `#1` or `#2`

2. **Dashboard defaults to newest active workflow**
   - Given multiple jobs with one running
   - Render details
   - Expect selected job details to be the running job

3. **History toggle reveals past workflows**
   - Given done and running jobs
   - Press `h`
   - Render
   - Expect done jobs to appear

4. **No active workflows shows empty active state**
   - Given only completed jobs
   - Render default active view
   - Expect `No active workflows`
   - Expect hint to press `h` for history

### GREEN

Implement minimal changes in `WorkflowBrowser`:

- add `jobViewMode` state,
- filter jobs in render/navigation,
- add `h` keyboard handler,
- update footer text,
- preserve access to all jobs in history mode.

### REFACTOR

After tests pass:

- extract filtering/selection helpers,
- keep render methods small,
- ensure line width constraints still pass,
- ensure no workflow manager persistence behavior changed.

## Acceptance criteria

- Active `/workflows` header shows only running workflows by default.
- Past workflows do not appear in the top strip unless history mode is enabled.
- Users can toggle history with `h`.
- No active workflows produces a clear empty state.
- Existing workflow dashboard navigation still works.
- All rendered lines remain within terminal width.
- Existing tests pass.

## Non-goals

- Delete old workflow jobs.
- Change workflow persistence format.
- Change completion notifications.
- Redesign the full dashboard layout.
- Implement search/filter for history beyond the `h` toggle.

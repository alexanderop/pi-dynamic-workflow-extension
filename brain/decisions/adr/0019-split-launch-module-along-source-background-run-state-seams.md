# ADR 0019: Split Launch Module Along Source, Background, And Run-State Seams

Status: accepted

## Context

`src/workflows/launch/launcher.ts` had grown to ~750 lines holding six
concerns: launch-source selection, request validation, background execution,
live-manifest persistence, terminal-state transitions, and generic error
helpers. ADR 0007 organizes the domain core as small modules with one
responsibility each, and the launcher already had clean internal seams (free
functions with explicit parameters) — only the file boundary was missing.
Answering "where does a run become `failed`?" required scanning the whole
file.

The 2026-06-09 readability review (`brain/plans/readability-review-2026-06-09.md`,
Theme 1.1) identified the concrete split lines.

## Decision

Split `src/workflows/launch/` along its existing seams, keeping the public
surface of `launcher.ts` unchanged (everything previously exported is still
exported or re-exported from `launcher.ts`):

1. `launch/source.ts` — launch-source selection and validation
   (`selectLaunchSource`, `loadLaunchSource`, `workflowProjectCwdFromRootDir`).
2. `launch/background.ts` — deferred background execution, live-manifest
   persistence, and terminal-artifact writing (`startBackgroundExecution`,
   `executeWorkflowInBackground`, `finalizeRun`, `writeTerminalArtifacts`).
3. `launch/run-state.ts` — state-transition wrappers over the run state
   machine (`completeRunState`, `stopRunState`, `failRunState`,
   `mergeRuntimeState`).
4. Generic guards (`errorMessage`, `hasMessage`, `isRecord`, `isNodeError`)
   moved to the shared `src/workflows/guards.ts` (Theme 2 of the same review).

`launcher.ts` keeps only the launch recipe: validate → allocate ids → build
state (`buildInitialRunState`, `buildRuntimeOptions`) → persist → kick off
background → return confirmation.

## Consequences

- "Where does a run transition to `failed`?" is answered by opening
  `launch/run-state.ts` instead of scanning 750 lines.
- The duplicated success/failure terminal paths collapsed into one
  `finalizeRun` tail, so a new terminal step (e.g. a new artifact) is added
  in one place.
- External callers and tests are unaffected; `launcher.ts` remains the
  import point for launch types and path helpers.
- Each background-execution concern now has a file-sized test seam if
  finer-grained tests become useful later.

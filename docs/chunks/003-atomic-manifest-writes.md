# Chunk: Atomic Manifest Writes

## Goal

Make workflow persistence resilient to interruption by writing run manifests atomically and making journal replay tolerant of partial trailing JSONL lines. The `/workflows` read model should never require loading corrupt manifests, and resume should ignore incomplete journal fragments without hiding earlier valid events.

## Non-goals

- Do not change the manifest schema except where an explicit compatibility guard is needed.
- Do not implement restart-agent invalidation in this chunk.
- Do not change saved workflow storage locations.
- Do not add live Pi or model tests.

## Spec sections

- `spec.md` §12 Run State Model: run state is the UI/read model and must update on meaningful transitions.
- `spec.md` §13 Journal Model: journal is append-only JSONL and consumers must not assume one event pair per key.
- `spec.md` §14 Resume Semantics: incomplete calls must not be returned from cache.
- `spec.md` §18 Storage Layout: `/workflows` list view reads only `manifest.json`.
- `spec.md` §21 Acceptance Criteria 3, 11, 12, 13, and 16.

## ADR dependencies

- Read `docs/adr/0005-use-project-local-pi-workflow-run-storage.md`.
- Read `docs/adr/0008-use-v2-stable-agent-keys-and-jsonl-journals.md`.
- Add a new ADR only if the implementation chooses a durable atomic-write strategy that should be preserved as architecture policy.

## Production files

- `src/workflows/run/store.ts`
- `src/workflows/journal/store.ts`
- `src/workflows/launch/launcher.ts`
- `src/workflows/run/root-dir.ts` only if path helpers need adjustment.

## Tests

- `test/workflows/run/store.test.ts`
- `test/workflows/journal/store.test.ts`
- `test/workflows/launch/launcher.test.ts`
- Add filesystem integration-style cases with temp directories; do not use live Pi.

## Acceptance criteria

- Manifest writes use an atomic temp-file then rename strategy in the same run directory.
- Failed or interrupted manifest writes do not leave a malformed `manifest.json` visible to `/workflows`.
- Run listing continues to skip invalid manifests predictably.
- Journal replay ignores one partial trailing line while preserving all prior valid events.
- Journal replay still rejects or reports malformed non-trailing JSONL lines according to the existing store convention.
- Resume cache construction continues to ignore started-only attempts and uses the latest valid non-invalidated result.

## Verification

- Run `pnpm test -- test/workflows/run/store.test.ts test/workflows/journal/store.test.ts test/workflows/launch/launcher.test.ts`.
- Run `pnpm run check`.
- Run `pnpm run verify` before marking the implementation complete, unless an unrelated existing formatter or lint failure is documented.

## Notes for agents

- Base this on the open backlog slice `8.2 Failure Recovery And Atomic Persistence`.
- Keep `manifest.json` as the only overview read-model file; do not make `/workflows` depend on journals or output files.
- Use same-directory temp files so rename is atomic on the target filesystem.
- Be explicit in tests about trailing partial journal lines versus malformed complete lines.

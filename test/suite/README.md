# test/suite — shared test harness

Cross-cutting fakes and fixtures the rest of the suite reuses. Tests must never
touch real API keys, the network, or real tokens; drive everything through the
fakes here.

- `tmpdir.ts` — `tempWorkflowDir(prefix)` creates a tracked temp directory and a
  single module-level `afterEach` removes it. Call it (usually in `beforeEach`)
  instead of hand-rolling `mkdtemp` + `afterEach(rm)`.
- `fake-pi-session.ts` — `FakePiSession`, the provider-level fake satisfying
  `PiWorkflowAgentSession`. Use it to run the real Pi runner adapter against a
  fake session. For the higher-level scheduler/runtime agent boundary, use
  `test/workflows/agent/agent-mock.ts` instead.

---
title: Align With Pi Author Conventions
status: partial
priority: P7
last_audited: 2026-06-07
implementation: "W1 (docs/process) done, W2 (parser `any` removal) done, and W3 (the 9 dotted-infix test files renamed behavior-first) done; structural workstreams W4-W6 remain planned."
next: "Continue with the remaining W4-W6 workstreams only when convention alignment is the active goal."
---

# Refactor plan: align with pi author conventions

Review-first plan. No code changes are applied by this document.

## Context

This repo is a **standalone pi extension**, not a package inside the pi monorepo
(`/tmp/pi-source`). The goal is to align its **code structure, test organization,
and process discipline** with how the pi author works, while keeping our own
toolchain. Toolchain stays: `oxlint`, `oxfmt`, `jscpd`, `pnpm`, `vitest`, `tsc`
— no swap to biome / tsgo / npm. Monorepo-only conventions (lockstep versioning,
npm-shrinkwrap, workspace build, per-package release flow) are out of scope.

Tests import source through the `src` subpath alias, so file renames are
low-risk: the alias absorbs most of the churn.

16 divergences were confirmed (audited against pi, then adversarially verified to
drop false positives and non-applicable monorepo rules). They group into six
ordered workstreams below, sequenced by dependency then risk — mechanical/low-risk
first, structural moves later.

---

## W1 — Docs & process discipline  (effort: S–M, risk: low)

Adopt the portable parts of pi's `AGENTS.md` / `CONTRIBUTING.md` discipline.

- Add a **Git section + commit-message format** to `AGENTS.md`:
  `{feat,fix,docs}[(scope)]: <message>` — matches our existing history
  (`feat(workflows): …`), just makes it a written rule.
- Backfill a **Keep-a-Changelog `## [Unreleased]`** section (single changelog,
  not per-package since we are standalone).
- Normalize **ADR `Status:` headers** — `brain/decisions/adr/0013` and `0014` are
  inconsistent with the rest.

**How pi does it** — commit format is enforced by habit in the log:

```
89a92207 feat(coding-agent): add project trust gating
db594d3a feat(coding-agent): show cache hit rate in footer
```

and the changelog keeps a live `[Unreleased]` section that PRs append to,
with issue links, before it rolls into a version:

```markdown
## [Unreleased]

### Added
- Added project trust gating for project-local settings ([#5332](…)).

### Fixed
- Fixed built-in tool expand hints to style closing parentheses ([#5359](…)).

## [0.78.1] - 2026-06-04
```

## W2 — Remove `any` from the parser  (effort: M, risk: low) — DONE

`src/workflows/script/parser.ts` — drop both `any` casts (line 24) in favor of
acorn's real types: type the parse result as acorn `Program`, and narrow helpers
via acorn `AnyNode` on `node.type`. Direct hit on pi's "no `any` unless absolutely
necessary" rule. Self-contained, well covered by parser tests.

**Our current state** — `any` is load-bearing across the whole parser:

```ts
// parser.ts:24
const program = parse(source, { … } as any) as any;
// then every AST helper inherits it:
function isMetaExport(node: any): boolean { … }
function literalValue(node: any, path: string): unknown { … }
function walk(node: any, visit: (node: any) => void): void { … }
```

**How pi does it** — pi keeps `any` out of `src` entirely (it has no acorn
dependency; this is the rule, not a snippet to copy). The fix is to lean on
acorn's published types instead of erasing them:

```ts
import { parse, type Program, type AnyNode } from "acorn";
const program: Program = parse(source, { … });            // no cast
function isMetaExport(node: AnyNode): boolean { … }        // narrow on node.type
```

## W3 — Behavior-first test naming  (effort: S + M, risk: low) — DONE (dotted-infix renames)

pi names tests by behavior (`agent-session-branching.test.ts`), not by source
file, and uses single-hyphen names — never dotted infixes.

- DONE: `git mv` the **9 dotted-infix** test files to behavior-first hyphenated
  names. The renames landed as (directory carries the domain, so no domain prefix):
  `agent/scheduler.property` → `agent/scheduler-caps`,
  `journal/key.property` → `journal/key-canonicalization`,
  `run/state-machine.graph` → `run/transition-graph`,
  `run/state-machine.property` → `run/state-machine-replay`,
  `saved/resolver.property` → `saved/resolver-command-naming`,
  `script/parser.property` → `script/parser-literal-metadata`,
  `script/runtime.property` → `script/runtime-parallel-pipeline`,
  `view/layout.property` → `view/layout-width-contract`,
  `view/navigation.property` → `view/navigation-clamping`.
- STILL PLANNED: rename the remaining module-mirrored unit tests to behavior-first
  (e.g. `parser.test.ts` → `workflow-script-parsing.test.ts`).

The `src` alias means imports do not move, so this is rename-only.

**Our current state** — dotted infixes encode the test *technique*, not behavior:

```
test/workflows/script/parser.property.test.ts
test/workflows/run/state-machine.graph.test.ts
test/workflows/view/navigation.property.test.ts
```

**How pi does it** — flat, hyphenated, behavior-named:

```
packages/agent/test/agent-loop.test.ts
packages/coding-agent/test/agent-session-branching.test.ts
packages/coding-agent/test/agent-session-compaction.test.ts
```

So `parser.property.test.ts` → e.g. `workflow-script-parsing.test.ts`,
`state-machine.graph.test.ts` → `run-state-machine.test.ts`.

## W4 — Domain-encode source filenames  (effort: L, risk: medium)

We repeat bare role-nouns across folders (`model.ts`, `store.ts`, `projector.ts`,
`runtime.ts` in each of `workflows/agent`, `run`, `view`, …). pi encodes the
**domain then role**. `git mv` ~23 bare-noun files to domain-then-role names,
update the `src` alias + relative imports + doc references, then run `verify`.

Largest filename change set — do it after W1–W3 land so the diff is isolated.

**Our current state** — the role is the whole filename; the domain lives only in
the directory, so `model.ts` appears 6+ times:

```
src/workflows/run/model.ts      src/workflows/run/store.ts
src/workflows/view/model.ts     src/workflows/view/projector.ts
src/workflows/agent/model.ts    src/workflows/journal/store.ts
```

**How pi does it** — the filename carries the domain *and* the role, so it is
unambiguous in a grep or a tab bar:

```
packages/coding-agent/src/core/agent-session-runtime.ts
packages/coding-agent/src/core/model-registry.ts
packages/coding-agent/src/core/session-manager.ts
packages/coding-agent/src/core/settings-manager.ts
```

So `run/model.ts` → `run/run-model.ts` (or `run-state.ts`), `view/projector.ts`
→ `view/view-projector.ts`, etc.

## W5 — Flatten the test tree + add `test/suite/`  (effort: M–L, risk: medium)

Today `test/` mirrors `src/` as a nested tree. pi uses a **flat** `test/` plus a
`test/suite/` harness.

- Flatten the per-feature test directories into a flat `test/`.
- Add `test/suite/` with a `harness.ts` (single shared cleanup) + `README` +
  `regressions/` directory, following pi's faux-provider harness shape.
- Optional: push the `pi-runner` `FakePiSession` down to the provider boundary
  so the harness owns the fake, matching pi's faux-provider pattern.

We adapt rather than copy: we do **not** import pi's verbatim `registerFauxProvider`.

**How pi does it** — `test/suite/` holds a shared `harness.ts` that owns setup +
a single cleanup, a `README.md` stating the rules, and a `regressions/` dir named
`<issue>-<slug>.test.ts`:

```
packages/coding-agent/test/suite/
  harness.ts        # tmpdir setup, faux provider, one rmSync cleanup
  README.md         # "Use the faux provider… no real API keys, network, tokens"
  regressions/
    2791-fswatch-error-crash.test.ts
    2835-tools-allowlist-filters-extension-tools.test.ts
```

`harness.ts` centralizes the fake instead of each test building its own:

```ts
// test/suite/harness.ts
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { AgentSession } from "../../src/core/agent-session.ts";
// → exposes one builder + one cleanup the whole suite reuses
```

For us that means a `test/suite/harness.ts` owning the `FakePiSession` we
currently re-wire per test, plus `test/suite/regressions/<issue>-<slug>.test.ts`
for issue-specific regressions.

## W6 — TUI color extraction  (optional, effort: M, risk: low)

`src/extension/tui/workflows-component.ts` carries inline color helpers. Extract
them to `workflow-colors.ts` for headroom and single-responsibility, matching
pi's util-splitting. Optional cleanup, not an alignment requirement.

**How pi does it** — pi peels self-contained helpers out of components into named
`*-utils.ts` siblings rather than letting them accrete:

```
packages/coding-agent/src/core/ansi-utils.ts
packages/coding-agent/src/core/path-utils.ts
packages/coding-agent/src/utils/…
```

---

## Quick wins (high value, S effort)

1. W1: `AGENTS.md` Git section + commit-format rule. — DONE
2. W3: rename the 9 dotted-infix test files. — DONE
3. W1: normalize ADR `Status:` headers (0013/0014). — DONE
4. W1: add the `## [Unreleased]` changelog section. — DONE

## Out of scope / deliberately skipped

These pi conventions were considered and excluded:

- **Toolchain swaps** — keeping oxlint/oxfmt/jscpd/pnpm/vitest/tsc per request.
- **Monorepo versioning** — lockstep versions, npm-shrinkwrap, workspace build.
- **Per-package CHANGELOG releasing** — we use a single changelog.
- **Verbatim `registerFauxProvider` import** — we adapt the harness shape, not the code.
- **kebab-case findings that already comply** — dropped in verification.
- **"Files are too large" relative to pi** — pi has large files too; not a divergence.

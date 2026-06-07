# Saved-Workflow Storage: Align with Claude Code (.pi Namespace)

## 1. Purpose

This spec defines a refactor that aligns this extension's saved-workflow storage and resolution with Claude Code's (CC's) model, using the `.pi` namespace in place of `.claude`. Today saved workflows are stored and resolved in a single hardcoded project scope (`<project>/.pi/workflows/`); the CC reference model supports **two scopes** — a project scope and a user-home scope — with **project-over-user precedence** and cross-scope dedupe by canonical `meta.name`. This spec specifies the dual-scope storage model, the name-resolution and listing algorithms across both scopes, how saving targets a chosen scope, and the file-by-file refactor needed to widen the current single-scope implementation. The `.pi` namespace, the inline run-script persistence/resume model, the parser, and the error tags are kept; only the scope dimension is widened.

### Reference-truth note (read before implementing)

The live precedence evidence — a byte-identical `deep-research2.js` pair (declaring `meta.name: 'deep-research'`) present in both a project directory and a user-home directory — is observed in the **`.claude` reference namespace** (`<project>/.claude/workflows/` and `~/.claude/workflows/`), which is the CC model being ported. It is **not** observed in `.pi`. In this repo's actual state:

- `<project>/.pi/workflows/` contains ONLY a run subdirectory (`wf_0986122badb729a0/`) and NO saved `.js` files.
- `~/.pi/workflows/` does **not exist at all**.

Therefore this spec defines the `.pi` dual-scope behavior **by analogy to the verified `.claude` reference**, not from existing `.pi` fixtures. An implementer MUST NOT assume any `.pi/workflows/*.js` saved file or `~/.pi/workflows/` directory already exists; all `.pi` saved-workflow fixtures referenced in the Test Plan (§11) are new artifacts to author.

## 2. Goals & Non-Goals

### Goals

- G1: Add a second saved-workflow scope: user-home `~/.pi/workflows/`, alongside the existing project scope `<project>/.pi/workflows/`.
- G2: Resolve and list saved workflows across BOTH scopes with **project-over-user precedence**, deduped by canonical `meta.name`.
- G3: Let `saveRunScript` target either scope (project default), with the chosen scope surfaced in the result.
- G4: Eliminate the misleading `projectSavedWorkflowDir` strip-and-rebuild (`src/workflows/saved/resolver.ts:63-65`) and the duplicated `candidateScopes` / double-parse in listing (`src/workflows/saved/list.ts:54-71`).
- G5: Preserve the existing parser, meta schema (including this project's superset fields), error tags, and the inline run-script persistence/resume model unchanged.

### Non-Goals

- NG1: NOT changing the toolchain, build, module system, or `#src/...` import scheme. In particular, the module-level direct import of `tryParseWorkflowScript` (`list.ts:5`, `resolver.ts:5`) is NOT replaced with an injectable parser seam.
- NG2: NOT changing the inline run-script persistence and resume model. It already matches the CC reference (see §8): inline scripts persist to the session/run directory and resume replays an unchanged agent-call prefix. No change is required there.
- NG3: NOT changing the `.pi` namespace itself (it is already `.pi`, not `.claude`). The conflict to resolve is project-local-only vs. user-home, NOT the namespace.
- NG4: NOT changing the parser's pure-literal contract, determinism guards, or any meta field's semantics.
- NG5: NOT introducing a separate metadata store. Meta stays inline in each `.js` file (per CC RULE G2).
- NG6: NOT adding a "builtin" or any third scope. Exactly two scopes: `project` and `user`.

### Already-matching parts (no change)

- The `.pi` namespace and plain one-workflow-per-`.js`-file layout match CC RULE A1/A2 for the project scope **in the code path**. Note (per §1): no live `.pi` saved-workflow artifact currently demonstrates this; the match is structural, not fixture-backed.
- The exact-path-then-scan-and-match-`meta.name` resolution order already matches CC RULE E1/E2 within a single scope (`resolver.ts:80-108`).
- The pure-literal `export const meta` requirement matches CC RULE C1/C2 (`parser.ts:46-49`, `76-88`).
- The completed-run save precondition (`save-run-script.ts:88-95`) is a project-specific addition with no CC equivalent (CC RULE G3); this spec **keeps** it deliberately (see §7).
- Inline run-script persistence (`<runId>/script.js`) and `resumeFromRunId` replay (`launcher.ts:186-205`) already match CC RULE H1–H5 (see §8).

## 3. Storage Model

RULE 3.1 (project scope): Project-scope saved workflows are plain JavaScript files at `<projectRoot>/.pi/workflows/<name>.js`, one workflow per file. This is the existing behavior; the resolved `<projectRoot>/.pi/workflows` directory is the outermost existing ancestor `.pi/workflows`, falling back to `join(cwd, ".pi", "workflows")`. See `src/workflows/run/root-dir.ts:12-15` (`workflowRootDirForCwd`) and `src/workflows/run/root-dir.ts:33-45` (`existingWorkflowRootsFrom`, the ancestor walk). Note: `root-dir.ts` lives under `run/`, NOT under `saved/` alongside `resolver.ts`/`list.ts`, and NOT under `launch/`.

RULE 3.2 (NEW user scope): User-scope saved workflows are plain JavaScript files at `~/.pi/workflows/<name>.js`, one workflow per file. The user-scope directory MUST be derived as `join(os.homedir(), ".pi", "workflows")`. It MUST NOT walk ancestors; it is always exactly the home-rooted path. Additional clauses:

- RULE 3.2a (empty/throwing homedir): If `os.homedir()` returns an empty string or throws, the user scope MUST be treated as ABSENT (`userDir` undefined) — resolution and listing proceed with the project scope only. No error is raised for an unavailable home directory.
- RULE 3.2b (project===user collapse): If the resolved project directory and the resolved user directory are the SAME absolute path (e.g. Pi launched from `$HOME`, so `rootDir === join(homedir(), ".pi", "workflows")`), the two scopes MUST collapse to a single candidate. `candidateScopes` MUST dedupe by resolved absolute directory: a scope whose `dir` equals an earlier scope's `dir` MUST be skipped (project, being first, wins; the duplicate user entry is dropped). This prevents double-reading and double-parsing every file and prevents a single physical file appearing twice.
- RULE 3.2c (test injection seam): The user-scope directory MUST be injectable so the test suite never reads or writes the developer's real `~/.pi/workflows`. Tests MUST be able to supply an explicit `userDir` (and an explicit `projectDir`) through `WorkflowSavedWorkflowLocations`. The shared `savedWorkflowLocations` helper (§10 item 5) MUST accept an injected home/user root rather than always calling `os.homedir()` directly, OR every entry point MUST already thread `savedWorkflowDirs` so tests pass an explicit `userDir`. This generalizes the existing project-injection seam mandated by ADR 0009 ("Tests may inject an alternate project saved-workflow directory through launcher options").

RULE 3.3 (both are candidates): Both scopes are always candidate sources for resolution (§5) and listing (§6) when their directories are defined and distinct. A `.js` file in either scope is a valid saved workflow.

RULE 3.4 (precedence): Project scope MUST take precedence over user scope. When the same canonical `meta.name` resolves in both scopes, the project-scope file MUST be selected and the user-scope file MUST be shadowed (CC RULE B1).

RULE 3.5 (canonical-name precedence): Precedence and dedupe MUST key on canonical `meta.name`, NOT on filename (CC RULE B2). In practice both must coincide for a collision, but the key is `meta.name`.

RULE 3.6 (dedupe in listing): A `meta.name` present in both scopes MUST appear once in listing, attributed to the winning (project) scope (CC RULE B4, F2). The current `byName` map already dedupes by name (`list.ts:38-40`); it MUST keep first-writer-wins with scopes iterated in precedence order (project first).

RULE 3.7 (shared directory with run artifacts): The project scope continues to share its directory with run subdirectories (`.pi/workflows/<runId>/`). Listing/scanning MUST filter to `*.js` files only (`resolver.ts:153`, `list.ts:94`), which excludes run subdirectories (directories, not `.js` files). The user scope `~/.pi/workflows/` is NOT a run-artifact root and contains only saved `.js` files; the same `*.js` filter applies and is harmless there.

RULE 3.8 (scope set is closed): The scope set is exactly `{ "project", "user" }`. No other scope value is permitted. The `"project"` string-literal type (`resolver.ts:15,55`, `list.ts:26`, `save-run-script.ts:27`) MUST be widened to `"project" | "user"`.

## 4. File Format & Meta Schema

RULE 4.1 (module form): Each saved workflow file MUST be an ES module that BEGINS with a named export `meta` (`parser.ts:46-49`):
```js
export const meta = { name, description, /* optional */ }
```

RULE 4.2 (pure literal): `meta` MUST be a pure object literal — no variables, function/method calls, spreads, template interpolation, or computed values — so it is statically extractable without executing the module (`parser.ts:76-88`). Determinism guards forbidding `Date.now`/`Math.random`/`new Date()` MUST be retained (`parser.ts:222-257`).

RULE 4.3 (required fields):
- `name` (non-empty string) — canonical command identity (`parser.ts:137-139`).
- `description` (non-empty string) (`parser.ts:143`).

RULE 4.4 (CC-standard optional fields):
- `whenToUse?` (string) — selection guidance (`parser.ts:145-146`).
- `model?` (string) — per-workflow default model override (`parser.ts:147`).
- `phases?` (array of phase objects) (`parser.ts:150`).

RULE 4.5 (phases[] shape): Each `phases[]` element is an object validated at `parser.ts:154-179`:
- `title` (required string) (`parser.ts:159`).
- `detail?` (string) (`parser.ts:161-162`).
- `model?` (string) — per-phase model override (`parser.ts:163-164`).

RULE 4.6 (project superset fields — KEEP): This project's schema is a documented SUPERSET of the CC base schema. The following project-only extras MUST be retained as-is; they coexist with the CC fields and are forward-compatible additions, not violations:
- `meta.thinkingLevel?` (string) — per-workflow thinking level (`parser.ts:148-149`).
- `phase.thinkingLevel?` (string) — per-phase thinking (`parser.ts:165-169`).
- `phase.agentCount?` (non-negative integer) — per-phase agent-count planning hint (`parser.ts:170-174`).
- `phase.agents?` (array of `WorkflowPlannedAgent`) (`parser.ts:175-176`, validated `181-197`), each with required `label` and optional `model?`/`thinkingLevel?`/`agentType?` (`parser.ts:187-194`).

RULE 4.7 (extras are storage-agnostic): The superset fields are carried into the run read model (`run/model.ts:17-31`), normalized at `run/store.ts:297-321`, and consumed by the model-routing resolver at runtime (`model-routing/resolve.ts:39-59`). NONE of this is involved in saved-workflow storage or scope. The refactor MUST NOT alter how these fields flow; they ride along inside the `.js` file content in both scopes identically.

RULE 4.8 (forward-compat): Fields beyond the documented set SHOULD be ignored, not rejected (CC RULE C7).

## 5. Name Resolution Algorithm

Given a requested name `N` from `Workflow({ name: N })`:

RULE 5.1 (validate first): `N` MUST be validated by `validateSavedWorkflowName` (`resolver.ts:210-222`): non-empty, no path separators, `basename(N) === N`. Invalid names return `WorkflowSavedWorkflowInvalidNameError` and resolution stops before any scope I/O (`resolver.ts:75-76`).

RULE 5.2 (scope iteration in precedence order): Resolution MUST iterate candidate scopes in precedence order — **project first, then user**. `candidateScopes` MUST return up to two scopes: `{ dir: projectDir, scope: "project" }` when `projectDir` is defined, followed by `{ dir: userDir, scope: "user" }` when `userDir` is defined AND `userDir !== projectDir` (RULE 3.2b dedupe). A `userDir` that is undefined per RULE 3.2a yields a single project-only scope list.

RULE 5.3 (per-scope, exact-path first): Within each scope, the algorithm MUST first try the exact path `<scope.dir>/<N>.js` (`resolver.ts:80-89`):
- If it exists and parses with `meta.name === N`, return it (`resolver.ts:88`).
- If it exists but `meta.name !== N`, this is a HARD error (`parseSavedWorkflowCandidate`, `resolver.ts:181-190`) — resolution fails immediately with `WorkflowSavedWorkflowInvalidError`; it MUST NOT fall through to other scopes (this preserves current behavior). See RULE 5.4a and the §9.3 cross-scope note for the deliberate consequence.
- If it does not exist, continue to scan in this scope.

RULE 5.4 (per-scope, scan + meta-match): If the exact path does not exist, scan all other `*.js` files in `scope.dir` (`scannedSavedWorkflowPaths`, `resolver.ts:134-158`), parse each, and return the first whose `meta.name === N` (`resolver.ts:91-108`). Non-exact (scanned) files that fail to parse MUST be silently skipped (`resolver.ts:166-168`).

RULE 5.4a (unparseable-file branching across scopes — CRITICAL): The handling of an unparseable file differs by how it was reached, and this difference has cross-scope consequences that MUST be preserved exactly:
- (a) **Scanned (non-exact) unparseable file**: skipped silently within its scope (`resolver.ts:166-168`); resolution MAY continue to that scope's remaining files AND to later scopes. Consequence: if the project scope contains a scanned file (e.g. `deep-research2.js`) that fails to parse, and the user scope contains a VALID matching workflow, resolution FALLS THROUGH to the user scope. The user-scope match is returned; the project does NOT shadow it. This is intended and preserves current single-scope behavior generalized to two scopes.
- (b) **Exact-path unparseable file** (`<scope.dir>/<N>.js` that fails to parse, including a `meta.name !== N` mismatch): this is a HARD error (`resolver.ts:167`, `181-190`); resolution ABORTS immediately with `WorkflowSavedWorkflowInvalidError` and MUST NOT consult any later scope. Consequence: a malformed project exact-path `foo.js` will prevent resolution from ever reaching an otherwise-valid user-scope `foo`. This is a conscious decision (it preserves current semantics), not an oversight.

RULE 5.5 (precedence is structural): Because scopes iterate project-then-user (RULE 5.2) and a match in an earlier scope returns immediately, project-over-user precedence is enforced structurally by iteration order. No extra precedence logic is needed inside the loop. The one exception is the fall-through described in RULE 5.4a(a), which is the deliberate, current-behavior-preserving consequence of silently skipping unparseable scanned files.

RULE 5.6 (not found): If no file matches `N` in any candidate scope, return `WorkflowSavedWorkflowNotFoundError` with `searchedPaths` covering every candidate scope (`resolver.ts:111-119`). `searchedPaths` MUST be an **ordered array, project-scope first**, produced by flat-mapping candidate scopes in precedence order; for each scope the two entries are `[<scope.dir>/<N>.js, join(scope.dir, "*.js")]`. For the standard two-scope case the exact ordered array is:
```
[ "<projectDir>/<N>.js", join("<projectDir>", "*.js"),
  "<userDir>/<N>.js",    join("<userDir>", "*.js") ]
```
(4 entries). When the user scope is absent (RULE 3.2a) or collapsed (RULE 3.2b), `searchedPaths` has 2 entries (project only). The existing `scopes.flatMap` already produces this ordering once `candidateScopes` returns both scopes in precedence order.

RULE 5.7 (deep-research case — prescribed NEW fixture): As a prescribed new test fixture (authored in T-R3, §11 — NOT an existing repo artifact; no `deep-research2.js` currently exists in `.pi`), a file named `deep-research2.js` declaring `meta.name: 'deep-research'`, present byte-identically in both `.pi` scopes, MUST resolve `Workflow({ name: 'deep-research' })` via the project-scope scan (RULE 5.4, project iterated first), shadowing the user-scope copy. This documents the analog of the verified `.claude` reference case (§1) in the `.pi` namespace.

## 6. Listing Semantics

RULE 6.1 (enumerate both scopes): `listSavedWorkflows` MUST enumerate `*.js` in both `<project>/.pi/workflows/` and `~/.pi/workflows/` (subject to RULE 3.2a absence and RULE 3.2b collapse), statically read each `meta`, and present one entry per canonical `meta.name` (CC RULE F1).

RULE 6.2 (cross-scope dedupe + precedence): Entries MUST be deduped by `meta.name`. Scopes MUST be iterated in precedence order (project first); the `byName` map MUST keep first-writer-wins so the project instance shadows the user instance (`list.ts:38-40`). This already holds once `candidateScopes` returns both scopes in order.

RULE 6.3 (sort): The final list MUST be sorted by `compareSavedWorkflows` (`list.ts:43,125-127`), which sorts ascending by `name.localeCompare`. The secondary `|| left.scope.localeCompare(right.scope)` key is **provably unreachable** after dedupe-by-name: `byName` guarantees every entry has a unique `name`, so the primary `name.localeCompare` is never `0` for two distinct entries and the secondary key can never fire. It is therefore dead code. **DECISION: remove the `|| left.scope.localeCompare(right.scope)` clause** (see §10 item 11). If a maintainer prefers to retain it, it MUST carry a code comment stating it is unreachable — but the prescribed action is removal.

RULE 6.4 (surfaced fields): Each entry MUST surface `meta.name`, `meta.description`, and `meta.whenToUse` when present (CC RULE F3). These already ride inside `WorkflowSavedWorkflow.meta` (`resolver.ts:17`).

RULE 6.5 (skip unparseable): A file whose meta cannot be statically parsed MUST be skipped, not crash the listing (`list.ts:62`, `resolver.ts:166-168`).

RULE 6.6 (eliminate double-parse): The current implementation parses every file twice — once in `listSavedWorkflowScope` to collect names (`list.ts:54-64`), then again via `resolveSavedWorkflowByName` per collected name (`list.ts:67-71`). The refactor MUST build each `WorkflowSavedWorkflow` directly from the single parse in the scan loop and MUST NOT call `resolveSavedWorkflowByName` per name. See §10 item 6.

## 7. Saving a Run as a Saved Workflow

RULE 7.1 (source): The source MUST be the run's persisted `script.js` content read from `run.value.scriptPath` (`save-run-script.ts:97-107`), re-parsed (`save-run-script.ts:109-117`). Only the `.js` source is written — no manifest/journal is copied (asserted by `save-run-script.test.ts:70-73`). This matches CC RULE G2 (meta lives inline; no separate store).

RULE 7.2 (completed-run precondition — KEEP): Saving MUST require `run.value.status === "completed"`, else reject with `WorkflowSaveRunScriptInvalidRunStatusError` (`save-run-script.ts:88-95`). This is a deliberate project-specific gate with NO CC equivalent (CC RULE G3 is INFERRED/unverified). Rationale to document in the ADR: this extension's save flow is "promote a finished run to a reusable workflow," so an incomplete run has no validated, complete script to promote. This is an addition beyond CC parity, intentionally retained.

RULE 7.3 (target scope — user-selectable, project default): `saveRunScript` MUST accept a target scope. Callers MAY choose `"project"` or `"user"`; the default MUST be `"project"`. **Note (parity framing):** user-selectable save scope is a **design decision for this extension**, NOT a verified CC behavior being ported — CC RULE G1 (save-time scope selection) is INFERRED/unverifiable (CC offers no verified evidence that its save command lets the user pick a scope). This is consistent with how §7.2 flags the completed-run gate as a project-specific addition; it is reasonable as a design choice but MUST NOT be presented as confirmed CC parity. Concretely:
- `WorkflowSaveRunScriptRequest` (`save-run-script.ts:15-17`) SHOULD gain `scope?: "project" | "user"` (default `"project"`).
- `targetSavedWorkflowPath` (`save-run-script.ts:144-150`) MUST select the directory by scope: project → `options.savedWorkflowDirs?.projectDir`; user → `options.savedWorkflowDirs?.userDir`.
- The result `WorkflowSavedRunScript.scope` (`save-run-script.ts:27`; set at `save-run-script.ts:139` inside the `return ok({...})` block at `save-run-script.ts:136-142`) MUST reflect the actual chosen scope, not the literal `"project"`.

RULE 7.4 (target filename): The target path MUST be `savedWorkflowPath(dir, meta.name)` = `<dir>/<meta.name>.js` (`save-run-script.ts:122,148`). The filename is derived from canonical `meta.name`. The name MUST be re-validated before writing (`save-run-script.ts:119-120`).

RULE 7.5 (write): The target directory MUST be created with `mkdir(dirname(target.path), { recursive: true })` then `writeFile` (`save-run-script.ts:124-134`). For the user scope this transparently creates `~/.pi/workflows/` if absent.

RULE 7.6 (no strip-and-rebuild): The target directory MUST come directly from the threaded locations (`savedWorkflowDirs.projectDir` / `.userDir`); it MUST NOT be derived via the `projectSavedWorkflowDir` strip-and-rebuild (see §10 item 4).

## 8. Inline Run-Script Persistence & Resume

This section documents current behavior and confirms it already matches the CC reference; NO change is required (NG2). All `root-dir.ts` anchors below refer to `src/workflows/run/root-dir.ts`.

RULE 8.1 (persistence — already matches CC H1): Every inline `Workflow({ script })` invocation persists the script to `<rootDir>/<runId>/script.js` (`src/workflows/run/root-dir.ts:17-19`, `workflowRunScriptPath`), written by `prepareRunFiles` during launch (`operations.ts:64-75`, which writes via `workflowRunScriptPath` at `operations.ts:69`; `launcher.ts:93,109,127-132`). `launcher.ts:93` sets `scriptPath`; the path is recorded on `initialState.scriptPath` (`launcher.ts:109`) and is available to callers. CC RULE H1 (auto-persist + return path) is satisfied. (Anchors verified accurate.)

RULE 8.2 (iterate — already matches CC H3): To iterate, edit the persisted file and re-run with `Workflow({ scriptPath })`. `selectLaunchSource` precedence is `scriptPath > script > name` (`launcher.ts:234-267`); `scriptPath` is read via `readSavedWorkflowScriptPath` (`launcher.ts:227`).

RULE 8.3 (resume — already matches CC H4/H5): `Workflow({ scriptPath, resumeFromRunId })` resumes by reading the prior run's journal at `workflowRunJournalPath(rootDir, resumeFromRunId)` (`launcher.ts:198`), building a replay cache (`buildWorkflowJournalResultCache`, `launcher.ts:201`), and passing it as `replayCache` (`launcher.ts:165`). The longest unchanged prefix of `agent()` calls returns cached results; execution resumes at the first changed/new call. The resume reads the OLD run's journal but writes a NEW `runId` with its own `script.js`/`journal.jsonl`/`manifest.json`.

RULE 8.4 (mode separation — already matches CC H6): Named saved workflows (`.pi/workflows/`) and ad-hoc `script`/`scriptPath` workflows (session/run directory) are distinct invocation modes of the same `Workflow` tool. The user-scope addition affects only the `name` mode; the `script`/`scriptPath` modes are untouched.

RULE 8.5 (run-root resolution is independent): `workflowRootDirForCwd` (`src/workflows/run/root-dir.ts:12-15`) governs run artifacts and the PROJECT saved-workflow scope's base; it MUST remain the run-artifact resolver. The user scope (`~/.pi/workflows/`) is computed separately (RULE 3.2) and is NOT derived from the run root.

## 9. Error Model

RULE 9.1: All existing tagged error variants MUST be preserved unchanged in tag, shape, and meaning:
- Resolver (`resolver.ts:20-51`): `WorkflowSavedWorkflowInvalidNameError`, `WorkflowSavedWorkflowNotFoundError`, `WorkflowSavedWorkflowReadError`, `WorkflowSavedWorkflowInvalidError`.
- Listing (`list.ts:13-22`): `WorkflowSavedWorkflowListReadError` (plus the re-exported resolver error union).
- Save (`save-run-script.ts:31-72`): `WorkflowSaveRunScriptRunReadError`, `WorkflowSaveRunScriptInvalidRunStatusError`, `WorkflowSaveRunScriptReadError`, `WorkflowSaveRunScriptInvalidWorkflowError`, `WorkflowSaveRunScriptWriteError`.

RULE 9.2 (not-found searchedPaths): `WorkflowSavedWorkflowNotFoundError.searchedPaths` MUST now include both scopes' paths in the project-first ordered shape pinned by RULE 5.6. This is a content change to an existing field, NOT a new error variant.

RULE 9.3 (name-mismatch / exact-path hard error): The exact-path failure — `meta.name !== N` or any parse failure of `<scope.dir>/<N>.js` (`resolver.ts:167`, `181-190`) — MUST remain a per-scope HARD failure that aborts ALL resolution (RULE 5.3, 5.4a(b)). It MUST NOT be softened into a fall-through to the other scope. **Acknowledged consequence:** preserving this means a malformed project exact-path file shadows an otherwise-valid user-scope match (the user scope is never consulted). This is intended — it preserves current semantics — and is a conscious decision, not an oversight.

RULE 9.4 (read errors propagate): A non-ENOENT read/`readdir` failure in EITHER scope MUST propagate as `WorkflowSavedWorkflowReadError` / `WorkflowSavedWorkflowListReadError` (`resolver.ts:83-84,143-148`; `list.ts:56-58,84-89`). A missing scope directory (ENOENT) MUST be treated as "no candidates," not an error (`resolver.ts:142`, `list.ts:83`); this applies to a missing `~/.pi/workflows/` (the common case — it does not exist yet) exactly as to a missing project dir.

## 10. Refactor Checklist

Numbered, file-by-file. Each item: what / where / why.

1. **Widen the locations shape.** Add `userDir?` to `WorkflowSavedWorkflowLocations`.
   - Where: `resolver.ts:8-10`.
   - What: `interface WorkflowSavedWorkflowLocations { readonly projectDir?: string; readonly userDir?: string }`.
   - Why: carry both scope directories through resolution, listing, and save, and expose the test-injection seam for `userDir` (RULE 3.2, 3.2c, 5.2).

2. **Widen the `scope` literal type to `"project" | "user"`.**
   - Where: `resolver.ts:15` (`WorkflowSavedWorkflow.scope`), `resolver.ts:55` (`WorkflowSavedWorkflowScope.scope`), `list.ts:26` (`WorkflowSavedWorkflowScope.scope`), `save-run-script.ts:27` (`WorkflowSavedRunScript.scope`), `save-run-script.ts:147` (`targetSavedWorkflowPath` return type).
   - Why: scopes are now two-valued (RULE 3.8).

3. **Extend `candidateScopes` to return both scopes in precedence order, with absence + collapse handling.**
   - Where: `resolver.ts:128-132` and `list.ts:115-119` (duplicated).
   - What: build `[]`; push `{ dir: projectDir, scope: "project" }` when `projectDir` defined; then push `{ dir: userDir, scope: "user" }` when `userDir` is defined (RULE 3.2a treats empty/throwing `homedir()` as undefined) AND `userDir` is not already present as an earlier scope's resolved absolute `dir` (RULE 3.2b collapse). Project MUST come first.
   - Why: structural project-over-user precedence plus the empty-home and project===user edge cases (RULE 5.2, 5.5, 6.2, 3.2a, 3.2b). RECOMMENDATION: extract into ONE shared helper to remove the duplication and guarantee both call sites apply identical absence/collapse logic.

4. **Remove the `projectSavedWorkflowDir` strip-and-rebuild; replace with explicit scope-dir computation.**
   - Where: `resolver.ts:63-65` (definition: `join(dirname(dirname(rootDir)), ".pi", "workflows")`). Known callers: `save-run-script.ts:8` (import), `save-run-script.ts:148` (use), `launcher.ts:219-222`.
   - What: `projectSavedWorkflowDir` strips `rootDir`'s last two segments and re-appends `.pi/workflows`, which reproduces `rootDir` ONLY for the standard layout (when `rootDir`'s last two segments are exactly `.pi/workflows`); it is a lossy strip-and-rebuild, not a literal no-op. Since `workflowRootDirForCwd` always returns the resolved `.pi/workflows` dir (standard and nested-workspace layouts alike), replace it by passing the already-resolved `rootDir` directly as `projectDir`. Add `userSavedWorkflowDir()` returning `join(os.homedir(), ".pi", "workflows")` (guarded per RULE 3.2a).
   - Deletion-vs-shim criterion (execute deterministically): **`grep -rn "projectSavedWorkflowDir" src test`** before deleting. If the only matches are the listed `src` callers (which are being rewritten) plus the test consumer at `save-run-script.test.ts:60-73,143`, **DELETE the export** and update those tests (item 4 of §11 / T-S5). If grep reveals any other importer (e.g. a not-yet-removed `list.ts` `resolverLocations`, item 6, or any other module), keep a thin compatibility shim until those callers are migrated, then delete. List every importer found by the grep in the PR description.
   - Why: the strip-and-rebuild is misleading and masks the project-vs-launcher inconsistency (the command passes `rootDir` directly at `workflows-command.ts:46-48` while launcher/save route through `projectSavedWorkflowDir`); both currently coincide only by accident (RULE 7.6, G4).

5. **Add a single source of truth for both scope dirs, with an injectable home seam.**
   - Where: new helper in `resolver.ts` (e.g. `savedWorkflowLocations(rootDir, opts?): WorkflowSavedWorkflowLocations`).
   - What: return `{ projectDir: rootDir, userDir: <home>/.pi/workflows }` where `<home>` is `opts?.homeDir ?? os.homedir()`; if the resolved home is empty/throws, omit `userDir` (RULE 3.2a). The optional `homeDir` (or `userDir`) parameter is the test-injection seam (RULE 3.2c) so the suite never reads the real `~/.pi/workflows`.
   - Why: every entry point (command, launcher, save) MUST build identical locations and MUST be overridable in tests (RULE 3.1, 3.2, 3.2c).

6. **De-dupe the listing double-parse; build entries from the single scan parse.**
   - Where: `list.ts:46-74` (`listSavedWorkflowScope`).
   - What: in the scan loop (`list.ts:54-64`), construct each `WorkflowSavedWorkflow` directly from the one `tryParseWorkflowScript` result (set `name`, `path`, `scope: scope.scope`, `source`, `meta`) instead of collecting names into a Set and re-resolving (`list.ts:67-71`). Apply first-name-wins within a scope (matching exact/scan precedence) and drop the per-name `resolveSavedWorkflowByName` call and `resolverLocations` (`list.ts:121-123`). NOTE: per NG1, do NOT introduce a parser-injection seam; `tryParseWorkflowScript` stays a direct import (`list.ts:5`). The observable proof of single-parse is the removal of the per-name `resolveSavedWorkflowByName` dependency (see T-L5).
   - Why: every workflow is currently parsed at least twice; collapsing to one parse per file is correct and faster (RULE 6.6).

7. **Thread `userDir` from the command into listing.**
   - Where: `workflows-command.ts:45-49`.
   - What: pass `commandCtx.savedWorkflowDirs ?? savedWorkflowLocations(rootDir)` (item 5), which now includes `userDir`, instead of `{ projectDir: rootDir }`.
   - Why: the `/workflows` command must list user-scope workflows too (RULE 6.1). Also fixes the bug-adjacent shortcut noted at `workflows-command.ts:46-48`.

8. **Thread `userDir` into the launcher's name-resolution locations.**
   - Where: `launcher.ts:219-222` (`loadLaunchSource`).
   - What: build locations via the shared helper (item 5) so `Workflow({ name })` resolves across both scopes (RULE 5.2).
   - Why: launching by name must honor user scope. The tool layer at `src/extension/tools/workflow-tool.ts:185-200` (`toLaunchOptions`) builds `WorkflowLaunchOptions` WITHOUT `savedWorkflowDirs`, so the `launcher.ts:219-222` fallback is the SOLE source of `userDir` for tool-launched workflows. That fallback MUST construct `userDir` via the shared `savedWorkflowLocations` helper (item 5). (Path note: `workflow-tool.ts` lives at `src/extension/tools/`, NOT under `src/workflows/launch/`.)

9. **Add user-scope target selection to `saveRunScript`.**
   - Where: `save-run-script.ts:15-17` (request), `save-run-script.ts:144-150` (`targetSavedWorkflowPath`), `save-run-script.ts:136-142` (result `return ok({...})`).
   - What: accept `scope?: "project" | "user"` (default `"project"`); select `projectDir` vs `userDir` from `options.savedWorkflowDirs`; return the actual chosen scope at `save-run-script.ts:139` (RULE 7.3, 7.6).
   - Why: enable saving to user scope while keeping project default.

10. **Keep the completed-run precondition; document it in the ADR.**
    - Where: `save-run-script.ts:88-95` (no code change).
    - Why: deliberate project-specific gate, retained (RULE 7.2, CC RULE G3 INFERRED). The ADR must state this is an addition beyond CC parity.

11. **Remove `compareSavedWorkflows`'s unreachable scope tie-break.**
    - Where: `list.ts:125-127`.
    - What: **REMOVE the `|| left.scope.localeCompare(right.scope)` clause.** It is provably dead post-dedupe: `byName` makes every `name` unique, so the primary `name.localeCompare` is never `0` for distinct entries and the secondary key can never fire. (If a maintainer insists on retaining it, it MUST carry a comment marking it unreachable — but removal is the prescribed action.)
    - Why: eliminate dead code; avoid implying scope participates in ordering (RULE 6.3).

12. **Import `os.homedir`.**
    - Where: `resolver.ts` (and the new shared helper if separate).
    - What: `import { homedir } from "node:os";`.
    - Why: user-scope directory derivation (RULE 3.2).

## 11. Test Plan

### Resolver (`test/workflows/saved/resolver.test.ts`)

- T-R1: `Workflow({ name })` resolves a workflow that exists ONLY in user scope (`~/.pi/workflows/`), via an injected home/user dir.
- T-R2: Precedence — same `meta.name` in both scopes resolves to the PROJECT file; assert returned `scope === "project"` and project path.
- T-R3: deep-research case (prescribed NEW fixture, RULE 5.7) — author `deep-research2.js` with `meta.name: 'deep-research'` byte-identical in both `.pi` scopes; `name: 'deep-research'` resolves via project scan; assert project path/scope.
- T-R4: User-scope scan + meta-match — filename ≠ meta.name in user scope resolves by `meta.name`.
- T-R5: Exact-path `meta.name !== N` in project scope is a HARD error (`WorkflowSavedWorkflowInvalidError`) and does NOT fall through to a matching user-scope file (RULE 5.3, 5.4a(b), 9.3).
- T-R6: Not found in both scopes — `searchedPaths` is the EXACT ordered array `[ "<projectDir>/<N>.js", join("<projectDir>","*.js"), "<userDir>/<N>.js", join("<userDir>","*.js") ]` (RULE 5.6, 9.2). Assert ordered equality, not set membership.
- T-R7: Missing user-scope directory (ENOENT) is treated as no candidates, not an error, when a project match exists (RULE 9.4).
- T-R8: Invalid name (path separator) still returns `WorkflowSavedWorkflowInvalidNameError` before any scope I/O (RULE 5.1).
- T-R9a (fall-through branch — RULE 5.4a(a)): Project scope has a SCANNED unparseable file (e.g. `deep-research2.js` that fails to parse) and user scope has a VALID matching `deep-research`; assert resolution FALLS THROUGH and returns the user-scope match (`scope === "user"`), confirming a scanned unparseable file does NOT shadow the user scope.
- T-R9b (abort branch — RULE 5.4a(b)): Project scope has an EXACT-path unparseable `foo.js` and user scope has a VALID `foo`; assert resolution HARD-ERRORS with `WorkflowSavedWorkflowInvalidError` and the user scope is NEVER consulted (no user-scope result returned).
- T-R10 (project===user collapse — RULE 3.2b): When `projectDir === userDir`, assert the directory is read once and a single physical file is NOT returned/listed twice (the user scope collapses into project).
- T-R11 (empty/throwing homedir — RULE 3.2a): When the injected home resolves empty (or `homedir()` would throw), assert resolution proceeds with project scope only and `searchedPaths` has 2 entries (project) on not-found.
- T-R12 (injected home never touches real `~`): Assert the user scope honors an injected home root and the suite never reads the developer's real `~/.pi/workflows` (RULE 3.2c).

### Resolver property tests (`test/workflows/saved/resolver.property.test.ts`)

- T-R-PROP: AUDIT AND UPDATE this existing property-test file (referenced in `docs/areas/spec-coverage.md:24`) for the dual-scope model. Widening `WorkflowSavedWorkflowLocations` to two scopes and changing `searchedPaths`/precedence will affect its invariants — in particular: (a) round-trip name-resolution invariants must hold across both scopes; (b) the not-found `searchedPaths` cardinality is now 4 (two-scope) or 2 (collapsed/absent), and ordered project-first (RULE 5.6); (c) precedence invariant: when a name exists in both scopes the resolved `scope` is `"project"`. Update generators/assertions accordingly so the build does not silently regress.

### Listing (`test/workflows/saved/list.test.ts`)

- T-L1: Lists workflows from both scopes; project-only + user-only names both appear.
- T-L2: Cross-scope dedupe — name in both scopes appears once, attributed to project scope (RULE 6.2).
- T-L3: Sort order is ascending by `meta.name` across merged scopes (e.g. `align-with-pi` before `deep-research`) (RULE 6.3).
- T-L4: Unparseable file in either scope is skipped, list still returns the parseable ones (RULE 6.5).
- T-L5: Single-parse / no-redundant-resolve assertion — since `tryParseWorkflowScript` is a direct module import with no injection seam (NG1), assert single-parse via the observable proxy: `list.ts` no longer depends on `resolveSavedWorkflowByName` (e.g. assert no per-name `resolveSavedWorkflowByName` call occurs — verifiable by removing the import and asserting the listing path compiles/passes without it, OR by counting injected `fs` `readFile`/`readdir` invocations through the threaded fs operations object so each file is read exactly once per list call). Implement whichever the listing code structure supports; the no-`resolveSavedWorkflowByName`-dependency assertion is the minimum bar. Guards against the double-parse regression (RULE 6.6).
- T-L6: Run subdirectories under project `.pi/workflows/<runId>/` are NOT listed (RULE 3.7).
- T-L7 (collapse — RULE 3.2b): When `projectDir === userDir`, a file appears exactly once in the listing (no double-read).

### Save (`test/workflows/saved/save-run-script.test.ts`)

- T-S1: Default save targets project scope; result `scope === "project"`, path under `<projectDir>` (RULE 7.3 default).
- T-S2: `scope: "user"` save writes under the injected user dir (analog of `~/.pi/workflows/<meta.name>.js`); result `scope === "user"`; directory auto-created (RULE 7.3, 7.5).
- T-S3: Completed-run precondition still rejects non-completed runs with `WorkflowSaveRunScriptInvalidRunStatusError` (RULE 7.2).
- T-S4: Only `.js` source is written; no manifest/journal under the saved dir (existing assertion `save-run-script.test.ts:70-73`), for BOTH scopes.
- T-S5: Update tests at `save-run-script.test.ts:60-73,143` that depend on `projectSavedWorkflowDir` to use the new explicit locations (item 4). If item 4 deletes the export, these tests MUST migrate to passing `savedWorkflowDirs` explicitly.
- T-S6: Filename derived from `meta.name` (not the run's `script.js` name) in both scopes (RULE 7.4).

### Page objects / TUI (`test/extension/tui/workflows-command-page.ts`, `test/workflows/launch/workflow-scenario.ts`)

- T-P1: The `/workflows` page object can stage BOTH a project and a user scope fixture (user dir injected) and assert the merged, deduped, sorted saved-workflow list renders (threading from `workflows-command.ts:45-49`).
- T-P2: Launch-by-name scenario resolves a user-scope-only workflow through the launcher fallback locations (item 8); assert the run launches.
- T-P3: Launch-by-name precedence — project shadows user for the same `meta.name`.

### Coverage tracking

- T-C1: Update `docs/areas/spec-coverage.md` §15 row to point at the dual-scope owners (`src/workflows/saved/resolver.ts`, `list.ts`, `save-run-script.ts`) and their tests, explicitly listing `test/workflows/saved/resolver.property.test.ts` among the coverage owners (it is updated by T-R-PROP). Replace the §15 "Recheck … project-local scope before changing lookup behavior" note with the dual-scope precedence + dedupe status.

## 12. ADR Impact

RULE 12.1: ADR 0009 (`docs/areas/adr/0009-use-pi-saved-workflow-script-locations.md`, "Use Project-Local Pi Saved Workflow Scripts") MUST be amended. It currently forbids the user-home scope this spec adds.

RULE 12.2: The contradicting consequence to amend (quote): ADR 0009 states "Saved workflows are project/workspace-local and **never global user-home state**." (`0009:63`). This is directly contradicted by the new `~/.pi/workflows` user scope. The amendment MUST revise this to: saved workflows resolve from project scope first, then user-home scope (`~/.pi/workflows`), with project precedence.

RULE 12.3: The decision text "When launching by `name`, resolve **only** this project/workspace-local saved workflow root." (`0009:39-40`) MUST be amended to resolve project scope then user scope in precedence order.

RULE 12.4 (save-scope decision text): The decision text "The save path is derived from the executed script's `meta.name`; **callers do not choose a separate saved name or scope**." (`0009:47-49`) directly contradicts user-selectable save scope (RULE 7.3) and MUST be amended: the saved NAME is still derived from `meta.name`, but callers MAY now choose the target SCOPE (`project` default, `user` optional).

RULE 12.5 (unchanged stance): "Pi dynamic workflows do not write user/project state into Claude Code's `.claude` namespace." (`0009:60-61`) REMAINS true — the new scope is `~/.pi/workflows`, not `~/.claude/workflows`. The conflict is the project-local-only / never-user-home stance, NOT the `.pi` vs `.claude` namespace.

RULE 12.6 (new ADR): A new ADR `docs/areas/adr/0016-add-user-scope-saved-workflows.md` MUST be authored (next free number is 0016, following the 15 existing ADRs `0001`–`0015`). Use the template structure in `docs/areas/adr/README.md:18-34` (`Status:` / `## Context` / `## Decision` / `## Consequences`). **Heading: `# ADR 0016: Add User-Scope Saved Workflows`** — use the ZERO-PADDED number to match the established house style of all 15 existing ADRs (file `0009-…md` with heading `# ADR 0009: …`, etc.); the README template's literal `# ADR N: Title` is illustrative/unpadded and MUST NOT be copied verbatim. The ADR MUST record: the dual-scope model; project-over-user precedence; dedupe by `meta.name`; the unparseable-file branching (scanned = skip + fall-through; exact = hard-error abort, RULE 5.4a); project===user collapse and empty-home handling (RULE 3.2a/b); user-selectable save scope (project default) as a DESIGN DECISION (CC RULE G1 INFERRED, not verified parity); and that the completed-run save precondition is a retained project-specific addition beyond CC parity (RULE 7.2).

RULE 12.7 (spec.md amendments): The following `spec.md` lines contradict the dual-scope model and MUST be amended to permit the user-home `~/.pi/workflows` scope with project precedence:
- The §15 lead sentence "Saving a workflow copies only the executed script to the **project/workspace-local** saved workflow location." (`spec.md:671`) — broaden to allow the user scope as a save target.
- "this extension MUST NOT save or resolve them from a **user-home** or cross-project workflow directory." (`spec.md:680-681`) — revise to permit the user-home `.pi` scope (while still forbidding cross-PROJECT directories and the `.claude` namespace).
- §21 acceptance #2 "…resolves the project/workspace-local workflow location correctly and **does not read cross-project workflow directories**." (`spec.md:974-975`) — revise so reading the user-home `~/.pi/workflows` scope is allowed (cross-PROJECT directories remain out of scope).
- The `docs/areas/spec-coverage.md` §15 row MUST be updated alongside (see T-C1).

RULE 12.8 (spec location convention): This spec lives at `docs/projects/saved-workflow-scopes/spec.md`, matching the house `docs/<topic>-spec.md` convention — NOT `specs/pending/`, which does not exist in this repo.

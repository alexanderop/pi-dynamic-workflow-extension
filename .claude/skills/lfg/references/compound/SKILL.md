---
name: compound
description: Document a recently solved problem into a searchable project-local knowledge store so each unit of engineering work makes the next one easier. Use after a non-trivial problem is solved and verified, when the user says "that worked" / "it's fixed" / "problem solved", or when invoked headless by the lfg pipeline. Writes one doc to docs/solutions/ and makes it discoverable.
argument-hint: "[optional: brief context] [mode:headless]"
---

# Compound — Compounding Knowledge Loop

**Announce at start:** "I'm using the compound skill to document this so it makes future work easier."

## Overview

Captures a solved problem while context is fresh into `docs/solutions/<category>/<slug>.md`, with
YAML frontmatter for search and dedup. The store is committed with the repo, so it travels with
the code and benefits collaborators and future agents.

**Why "compound"?** The first time you solve a problem it takes research. Document it, and the
next occurrence takes minutes. **Each unit of engineering work should make subsequent units
easier — not harder.**

The closed loop: this skill is the **write side**. The **read side** is any agent (including
`lfg` Step 1) searching `docs/solutions/` before starting work — which only happens if the store
is discoverable, so the Discoverability Check below is mandatory.

## Modes

| Mode | When | Behavior |
|------|------|----------|
| **Interactive** (default) | no `mode:headless` token | Ask Full vs Lightweight, end with a "What's next?" prompt. |
| **Headless** | `mode:headless` in `$ARGUMENTS` | No questions. Run Full. Apply the discoverability edit silently if needed. End with a structured terminal report. |

Strip `mode:headless` from `$ARGUMENTS` before treating the remainder as the brief context hint.

## Preconditions (advisory)

- The problem is **solved**, not in-progress.
- The solution is **verified** working.
- It is **non-trivial** (not a typo or an obvious one-liner). If trivial, in headless mode emit
  `Documentation skipped` with a reason; in interactive mode say so and stop.

---

## Full Mode

<CRITICAL>
The primary output is ONE file — the final documentation. Research subagents return TEXT DATA
to the orchestrator and MUST NOT use Write/Edit or create any files. Only the orchestrator
writes: the solution doc, plus an optional small edit to CLAUDE.md/AGENTS.md for discoverability.
</CRITICAL>

### Phase 1 — Research (parallel subagents)

Use `references/dispatching-parallel-agents/SKILL.md` to launch these three in parallel. Each returns
text only. Pass the relevant support-file contents into each task prompt so subagents have the
contract without cross-skill paths.

1. **Context Analyzer** — read `references/schema.md`. Determine the **track** (bug vs knowledge)
   from the problem, the category, the frontmatter skeleton (must include `category:`), and a
   suggested filename `<sanitized-problem-slug>.md` (no date suffix; the `date:` field is
   canonical). Read `references/categories.md` for the problem_type → directory mapping.

2. **Solution Extractor** — pull the substance from the conversation. Conversation history and
   the verified fix take priority over everything else.
   - **Bug track:** Problem · Symptoms · What Didn't Work · Solution (with before/after code) ·
     Why This Works (root cause) · Prevention.
   - **Knowledge track:** Context · Guidance · Why This Matters · When to Apply · Examples.

3. **Related Docs Finder** — grep `docs/solutions/` for overlap (frontmatter-first filtering: run
   `grep -i` on `title:`, `tags:`, `module:`, `component:` before reading bodies; read full text
   only for strong matches). Score overlap across five dimensions (problem, root cause, solution,
   referenced files, prevention):
   - **High** = 4-5 match (same problem solved again)
   - **Moderate** = 2-3 match (same area, different angle)
   - **Low** = 0-1 match.
   Return links, relationships, and the overlap score + matched dimensions.

### Phase 2 — Assemble & write

WAIT for all Phase 1 subagents to finish, then the orchestrator (main context):

1. Collect the text results.
2. Act on the overlap score:
   | Overlap | Action |
   |---------|--------|
   | **High** | UPDATE the existing doc with fresher context; keep its path/structure; add `last_updated: YYYY-MM-DD`. Do not create a duplicate. |
   | **Moderate** | Create the new doc; note the related doc for a future consolidation pass. |
   | **Low / none** | Create the new doc. |
3. Assemble the markdown from `assets/solution-template.md` (preserve section order).
4. Validate frontmatter against `references/schema.md`. Quote any scalar value containing ` # `
   or `: ` and quote every array item — these silently corrupt YAML parsing.
5. `mkdir -p docs/solutions/<category>/` and write the file.

   You do NOT need to hand-maintain `docs/solutions/index.md` — the `index-solutions` PostToolUse
   hook rebuilds it automatically (pure bash, no LLM) whenever a solution file changes, and the
   `inject-solutions-index` SessionStart hook injects that index into every future session. That
   injection is the always-on read side of the loop; the Discoverability Check below is the
   durable fallback for sessions/agents running without these hooks.

### Phase 3 — Discoverability Check (always runs)

The store only compounds value if agents can find it.

1. Identify which root instruction file holds substantive content — `AGENTS.md`, `CLAUDE.md`, or
   both (one may be a shim that `@`-includes the other; edit the substantive one). If neither
   exists, skip this phase.
2. Assess whether an agent reading it would learn: (a) a searchable solutions store exists,
   (b) enough structure to search it (category dirs, frontmatter fields `module`/`tags`/
   `problem_type`), (c) that it's relevant when implementing or debugging in documented areas.
   This is a semantic check, not a string match.
3. If the spirit is already met, do nothing.
4. If not, add the **smallest** natural addition. Prefer one line in an existing architecture/
   directory/docs section over a new heading. Keep the tone informational, not imperative —
   "relevant when implementing or debugging in documented areas," never "always search first."

   Example line for a directory/architecture listing:
   ```
   docs/solutions/  # documented solutions to past problems (bugs + knowledge), by category, with YAML frontmatter (module, tags, problem_type)
   ```

   In **interactive** mode, show the proposed edit and get consent (use `AskUserQuestion`; load
   its schema with `ToolSearch select:AskUserQuestion` first if needed) before editing. In
   **headless** mode, apply it silently and report it.

---

## Lightweight Mode (interactive only)

Single pass, no subagents — same doc, fewer tokens, no overlap detection. The orchestrator does
it all sequentially: extract problem+solution from the conversation → classify track/category/
filename via the reference files → write `docs/solutions/<category>/<slug>.md` from the template
with the track-appropriate sections. Then run the Discoverability Check. Headless never enters
Lightweight.

---

## Output

### Headless
```
✓ Documentation complete (headless mode)

File: docs/solutions/<category>/<slug>.md  (created | updated)
Track: <bug | knowledge>
Overlap: <none | low | moderate — see <path> | high — existing doc updated>
Instruction-file edit: <none needed | applied to <path>>

Documentation complete
```
If nothing was written (e.g. trivial / unsolved):
```
✗ Documentation skipped (headless mode)
Reason: <one sentence>
Documentation skipped
```

### Interactive
Report the file written, the track/category, overlap result, and any discoverability edit, then
present a "What's next?" prompt via `AskUserQuestion`.

## Auto-invoke

Trigger phrases that suggest offering to compound: "that worked", "it's fixed", "working now",
"problem solved". Manual: `/compound [context]` to document immediately.

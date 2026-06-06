# Solution Doc Frontmatter Schema

Every doc in `docs/solutions/` starts with a YAML frontmatter block. Fields below are the
canonical contract. Unknown fields are allowed but discouraged.

## Required fields (all tracks)

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Human-readable, specific. e.g. "N+1 query in brief generation". |
| `date` | `YYYY-MM-DD` | Creation date. Canonical — do NOT put dates in the filename. |
| `track` | enum | `bug` or `knowledge`. |
| `category` | enum | One of the category slugs in `categories.md`. Maps to the subdirectory. |
| `problem_type` | string | Free-form short tag that drove the category choice. |
| `tags` | string[] | Lowercase keywords for search. Quote every item. |

## Optional / common fields

| Field | Type | Notes |
|-------|------|-------|
| `module` | string | Primary code module/area the problem lived in. |
| `component` | string | Narrower component within the module. |
| `last_updated` | `YYYY-MM-DD` | Added only when an existing doc is updated (High overlap). |
| `related` | string[] | Relative paths to related docs in `docs/solutions/`. |

## Bug-track fields (optional but encouraged)

| Field | Type | Notes |
|-------|------|-------|
| `symptoms` | string | Short observable-symptom summary. |
| `root_cause` | string | One-line root cause. |
| `resolution_type` | string | e.g. `code-fix`, `config-change`, `dependency-upgrade`. |

## Knowledge-track fields

| Field | Type | Notes |
|-------|------|-------|
| `applies_when` | string | The situation/condition where this guidance applies. |

## YAML Safety Rules (these prevent silent corruption)

1. Quote any scalar value containing ` # ` — otherwise everything after it is parsed as a comment.
2. Quote any scalar value containing `: ` — otherwise it's parsed as a nested mapping.
3. Quote **every** array item under `tags`/`related` — unquoted items with special chars break parsing.
4. Use plain `---` delimiter lines (three hyphens, nothing else) to open and close the block.

## Example (bug track)

```yaml
---
title: "N+1 query in brief generation"
date: 2026-05-29
track: bug
category: performance-issues
problem_type: "performance_issue"
module: "brief_system"
tags: ["n+1", "activerecord", "performance", "eager-loading"]
symptoms: "Brief page load 8s; hundreds of repeated SELECTs in logs"
root_cause: "association loaded inside a render loop without includes"
resolution_type: "code-fix"
---
```

## Example (knowledge track)

```yaml
---
title: "Bypass interactive brainstorming in autopilot pipelines"
date: 2026-05-29
track: knowledge
category: architecture-patterns
problem_type: "workflow_pattern"
tags: ["pipeline", "autonomy", "skills"]
applies_when: "building a hands-off orchestrator over human-in-the-loop skills"
---
```

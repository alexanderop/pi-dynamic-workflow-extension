<!--
Template for docs/solutions/<category>/<slug>.md
Use the BUG TRACK or KNOWLEDGE TRACK body below — not both. Keep the frontmatter from
references/schema.md. Preserve section order.
-->

---
title: ""
date: YYYY-MM-DD
track: # bug | knowledge
category: # see references/categories.md
problem_type: ""
tags: []
---

<!-- ============================== BUG TRACK ============================== -->

# {title}

## Problem
1-2 sentences describing the issue.

## Symptoms
Observable symptoms — exact error messages, logs, behavior.

## What Didn't Work
Failed investigation attempts and why they failed. (Saves the next person the dead ends.)

## Solution
The actual fix, with before/after code where applicable.

```diff
- before
+ after
```

## Why This Works
Root-cause explanation and why the fix addresses it.

## Prevention
How to avoid recurrence — best practices, test cases, lint rules, config. Concrete examples.

<!-- ============================ KNOWLEDGE TRACK ============================ -->

# {title}

## Context
What situation, gap, or friction prompted this guidance.

## Guidance
The practice, pattern, or recommendation — with code examples when useful.

## Why This Matters
Rationale and impact of following (or not following) this.

## When to Apply
The conditions or situations where this applies.

## Examples
Concrete before/after or usage examples showing the practice in action.

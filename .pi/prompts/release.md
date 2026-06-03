---
description: Release this project: test, version bump, tag, push, and create GitHub release notes
argument-hint: "[patch|minor|major|vX.Y.Z] [notes]"
---
Read and follow the project-only release skill at `.agents/skills/release/SKILL.md`.

Release arguments from `/release`: $ARGUMENTS

Release this project end-to-end: choose/bump the version, run tests, commit release metadata, create the annotated tag, push, create the GitHub Release with proper release notes, verify, and report the result.

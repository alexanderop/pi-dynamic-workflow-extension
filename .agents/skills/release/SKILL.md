---
name: release
description: Project-only release automation for pi-dynamic-workflow-extension. Use this skill whenever the user asks to release, publish a new version, create a tag, create GitHub release notes, or invokes the project /release prompt. It bumps package/package-lock versions, runs tests, commits release changes, pushes, creates an annotated git tag, and creates or updates the GitHub Release with proper notes.
compatibility: Requires git, npm, gh CLI authenticated for alexanderop/pi-dynamic-workflow-extension, and push access to origin.
---

# Project Release

This skill releases **this repository only**: `alexanderop/pi-dynamic-workflow-extension`.

Use it when the user invokes `/release` or otherwise asks to publish/tag/release this project.

## Command shape

The project prompt template passes arguments as free text. Interpret them as:

```text
/release [patch|minor|major|vX.Y.Z|X.Y.Z] [extra release-note guidance]
```

Defaults:

- Bump: `patch`
- Branch: release from `main`
- Remote: `origin`
- GitHub repo: `alexanderop/pi-dynamic-workflow-extension`

## Non-negotiable safety rules

- Do not release if `npm test` fails.
- Do not release if `gh auth status` fails.
- Do not overwrite an existing tag.
- Do not force-push.
- Do not delete tags or releases.
- Ask before continuing only when there is an ambiguity that could publish the wrong thing, such as being on a non-`main` branch, a conflicting existing tag/release, or unclear version arguments.

## Release workflow

### 1. Preflight

Run:

```bash
git status --short
git branch --show-current
git remote -v
gh auth status
gh repo view --json nameWithOwner,url,defaultBranchRef
git fetch --tags origin
```

Expected repo: `alexanderop/pi-dynamic-workflow-extension`.

If the current branch is not `main`, ask the user whether to release from that branch or switch to `main`.

If `main` is behind origin, run:

```bash
git pull --ff-only origin main
```

### 2. Determine the next version

Read `package.json` and the latest semver tag.

- If the user supplied `vX.Y.Z` or `X.Y.Z`, use exactly that version.
- If the user supplied `major`, `minor`, or `patch`, bump from `package.json`'s current version.
- If no bump is supplied, use `patch`.

The tag is always `v<version>`.

Verify the tag does not already exist locally or remotely:

```bash
git rev-parse -q --verify "refs/tags/vX.Y.Z"
git ls-remote --tags origin "vX.Y.Z"
```

### 3. Update package metadata

Use npm so `package.json` and `package-lock.json` stay in sync:

```bash
npm version <version-or-bump> --no-git-tag-version
```

Examples:

```bash
npm version patch --no-git-tag-version
npm version 0.1.7 --no-git-tag-version
```

After this, confirm `package.json` reports the intended version.

### 4. Test

Run the full project test command:

```bash
npm test
```

If it fails, stop. Report the failure and do not commit, tag, push, or create a release.

### 5. Commit the release

Stage all non-ignored release/project changes:

```bash
git add -A
git status --short
```

Commit if there are staged changes:

```bash
git commit -m "Release vX.Y.Z"
```

If there are no staged changes, continue only if `HEAD` is already the exact commit to tag.

### 6. Write release notes

Generate useful release notes from commits and touched files since the previous tag:

```bash
previous_tag=$(git describe --tags --abbrev=0 "vX.Y.Z^" 2>/dev/null || true)
git log --oneline "${previous_tag}..HEAD"
git diff --stat "${previous_tag}..HEAD"
```

If there is no previous tag, summarize the initial release.

Write notes to a temporary file such as `/tmp/pi-dynamic-workflow-extension-vX.Y.Z-notes.md`.

Release notes should be concise and structured:

```markdown
Short one-sentence summary.

## Highlights

- Concrete user-facing or maintainer-facing change.
- Concrete user-facing or maintainer-facing change.

## Testing

- `npm test`

**Full Changelog**: https://github.com/alexanderop/pi-dynamic-workflow-extension/compare/vPREVIOUS...vX.Y.Z
```

For an initial release, omit the compare link or link to the tag page.

Prefer real details from commits/diffs over generic text. Include any extra guidance the user supplied in `/release` arguments.

### 7. Tag and push

Create an annotated tag on the release commit:

```bash
git tag -a "vX.Y.Z" -m "Release vX.Y.Z"
```

Push the branch first, then the tag:

```bash
git push origin main
git push origin "vX.Y.Z"
```

Never use `--force`.

### 8. Create the GitHub Release

Create the GitHub Release with the notes file:

```bash
gh release create "vX.Y.Z" \
  --repo alexanderop/pi-dynamic-workflow-extension \
  --verify-tag \
  --title "vX.Y.Z" \
  --notes-file /tmp/pi-dynamic-workflow-extension-vX.Y.Z-notes.md \
  --latest
```

If the release already exists but the tag is correct, ask before editing it. To update notes after confirmation:

```bash
gh release edit "vX.Y.Z" \
  --repo alexanderop/pi-dynamic-workflow-extension \
  --title "vX.Y.Z" \
  --notes-file /tmp/pi-dynamic-workflow-extension-vX.Y.Z-notes.md
```

### 9. Verify and report

Run:

```bash
gh release view "vX.Y.Z" --repo alexanderop/pi-dynamic-workflow-extension --json tagName,name,url,isLatest
git status --short
```

Final response must include:

- Version released
- Tag name
- GitHub Release URL
- Test result
- Whether working tree is clean

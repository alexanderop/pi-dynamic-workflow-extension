# 03: Pi Package Loading

This repository is shaped as an installable Pi package. This note explains how Pi discovers and loads the extension entrypoint, and how the `package.json` manifest is wired up.

For the broader picture of what an extension *is* and how its API is shaped, read [`02-pi-extension-model.md`](./02-pi-extension-model.md) first. Terms like "Pi package" and "Pi extension" are defined in [`glossary.md`](./glossary.md). Note that the `pi` field in `package.json` (sometimes called the package manifest) is not a glossary term but is explained in this document under "Package manifest".

## Package manifest

The package declaration is in [`../../package.json`](../../../package.json) (`pi.extensions` at `package.json:41-45`):

```json
{
  "name": "pi-dynamic-workflow-extension",
  "keywords": ["pi-extension", "pi-package", "workflows"],
  "pi": {
    "extensions": ["./src/extension/index.ts"]
  }
}
```

Pi reads the `pi.extensions` array and loads the listed extension entrypoints. The single entrypoint here is `src/extension/index.ts`, whose default export is `dynamicWorkflowExtension(pi: ExtensionAPI)` (`src/extension/index.ts:10`). That function registers one command, `/workflows`.

## Local development

Try the local checkout without installing it globally:

```bash
pi -e .
```

The project also defines a `pi` script (`package.json:18`):

```bash
pnpm run pi
```

which currently expands to:

```bash
pi --no-extensions -e .
```

`--no-extensions` (alias `-ne`) disables auto-discovery of unrelated user/global extensions while testing this package. The explicit `-e .` path still loads, so this package's extension runs in isolation. See `repos/pi/packages/coding-agent/src/cli/args.ts:151` and `repos/pi/packages/coding-agent/docs/usage.md`.

## Git install shape

The README documents installing tagged releases:

```bash
pi install git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.0
```

By default `pi install` writes to user settings (`~/.pi/agent/settings.json`). Use `-l` to write to project settings (`.pi/settings.json`) instead, so the install can be shared with a team:

```bash
pi install -l git:github.com/alexanderopalic/pi-dynamic-workflow-extension@v0.1.0
```

Pi pins git refs, so release tags matter. See `repos/pi/packages/coding-agent/docs/packages.md` (Install and Manage).

## TypeScript loading

Pi loads extensions through `jiti`, so TypeScript entrypoints can work without a separate build step. The loader imports the module and requires the default export to be a function (`repos/pi/packages/coding-agent/src/core/extensions/loader.ts`).

That is why this package can point directly at the `.ts` source:

```text
src/extension/index.ts
```

## Dependency rules

Pi bundles core packages. If this package imports Pi core packages, they should be peer dependencies with `"*"` ranges.

Current peer dependencies include:

```json
{
  "@earendil-works/pi-agent-core": "*",
  "@earendil-works/pi-ai": "*",
  "@earendil-works/pi-coding-agent": "*",
  "@earendil-works/pi-tui": "*",
  "typebox": "*"
}
```

These ranges match the rule in `repos/pi/packages/coding-agent/docs/packages.md`: import a bundled core package, list it as a `peerDependency` with `"*"`, and do not bundle it.

Third-party runtime dependencies belong in `dependencies`, not `devDependencies`, because Pi runs `npm install` when it installs a git/npm package.

Current runtime dependency:

```json
{
  "acorn": "^8.16.0"
}
```

`acorn` is used by the workflow parser to validate and extract `meta` from workflow scripts (`src/workflows/script/parser.ts`).

## What to inspect when package loading fails

Use this checklist:

1. Does `package.json` have a `pi.extensions` entry?
2. Does the referenced file exist?
3. Does the file default-export a function? (Pi's loader rejects non-function default exports.)
4. Are runtime dependencies listed in `dependencies`?
5. Are Pi core packages listed as `peerDependencies` with `"*"`?
6. Does `pi -e .` show extension loading errors?
7. Does `test/extension/index.test.ts` still pass? (`pnpm test`)

## Source references

Project notes:

- [`brain/references/pi-extension-reference.md`](../references/pi-extension-reference.md) — map of the vendored Pi source for extensions and packages.
- [`02-pi-extension-model.md`](./02-pi-extension-model.md) — the extension API and command model.

Vendored Pi docs to read when changing package loading (under `repos/pi/`):

- `repos/pi/packages/coding-agent/docs/packages.md`
- `repos/pi/packages/coding-agent/docs/extensions.md`
- `repos/pi/packages/coding-agent/src/core/extensions/loader.ts`

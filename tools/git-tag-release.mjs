#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const RELEASE_FILES = ["package.json", "CHANGELOG.md"];
const INSTALL_SPEC = "git:github.com/alexanderopalic/pi-dynamic-workflow-extension";

const USAGE = `Usage:
  pnpm run release:patch [-- --commit --push --no-verify]
  pnpm run release:minor [-- --commit --push --no-verify]
  pnpm run release:major [-- --commit --push --no-verify]
  pnpm run release:version -- 0.2.0 [--commit --push --no-verify]

Default behavior updates package.json and CHANGELOG.md, then prints the exact git commands.
Use --commit to create the release commit and annotated tag.
Use --push with --commit to push main and the new tag.
A standalone -- argument is accepted for npm/pnpm separator compatibility.
`;

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const VALID_BUMPS = new Set(["patch", "minor", "major"]);
const VALID_FLAGS = new Set(["--commit", "--push", "--no-verify", "--dry-run"]);

main();

function main() {
  const { bumpOrVersion, flags } = parseArgs(process.argv.slice(2));
  const commit = flags.has("--commit");
  const push = flags.has("--push");
  const verify = !flags.has("--no-verify");
  const dryRun = flags.has("--dry-run");

  if (push && !commit) {
    fail("--push requires --commit so there is a release commit and tag to push.");
  }

  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (process.cwd() !== repoRoot) {
    fail(`Run this from the repository root:\n  cd ${repoRoot}`);
  }

  if (!dryRun) {
    ensureCleanWorktree();
  }

  const packageJson = readPackageJson();
  const packageVersion = parseVersion(packageJson.version, "package.json version");
  const latestTagVersion = getLatestTagVersion();
  const baseVersion = maxVersion(packageVersion, latestTagVersion ?? packageVersion);
  const nextVersion = resolveNextVersion(bumpOrVersion, baseVersion);
  const tagName = formatTag(nextVersion);

  ensureVersionIncreases(nextVersion, baseVersion);
  ensureTagDoesNotExist(tagName);

  const changedFiles = updateReleaseFiles({ packageJson, version: nextVersion, dryRun });
  const releaseInstallSpec = `${INSTALL_SPEC}@${tagName}`;

  console.log(`Prepared ${tagName} from base ${formatVersion(baseVersion)}.`);
  console.log(`Pi install spec: ${releaseInstallSpec}`);

  if (dryRun) {
    console.log("\nDry run only; no files were changed.");
    return;
  }

  if (verify) {
    runChecked("pnpm", ["run", "verify"]);
  } else {
    console.log("\nSkipped verification because --no-verify was passed.");
  }

  if (commit) {
    gitInherit(["add", ...changedFiles]);
    gitInherit(["commit", "-m", `docs: release ${tagName}`]);
    gitInherit(["tag", "-a", tagName, "-m", tagName]);

    if (push) {
      gitInherit(["push", "origin", "HEAD"]);
      gitInherit(["push", "origin", tagName]);
    }

    console.log(`\nRelease tag ready: ${tagName}`);
    console.log(`Users install with:\n  pi install ${releaseInstallSpec}`);
    return;
  }

  console.log("\nReview the release diff, then run:");
  console.log(`  git add ${changedFiles.join(" ")}`);
  console.log(`  git commit -m "docs: release ${tagName}"`);
  console.log(`  git tag -a ${tagName} -m "${tagName}"`);
  console.log("  git push origin HEAD");
  console.log(`  git push origin ${tagName}`);
  console.log(`\nUsers install with:\n  pi install ${releaseInstallSpec}`);
}

function parseArgs(args) {
  const positional = [];
  const flags = new Set();

  for (const arg of args) {
    if (arg === "--") continue;

    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }

    if (arg.startsWith("--")) {
      if (!VALID_FLAGS.has(arg)) {
        fail(`Unknown flag: ${arg}\n\n${USAGE}`);
      }
      flags.add(arg);
      continue;
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    fail(`Expected at most one bump or version argument.\n\n${USAGE}`);
  }

  return {
    bumpOrVersion: positional[0] ?? "patch",
    flags,
  };
}

function ensureCleanWorktree() {
  const status = git(["status", "--porcelain"]);
  if (status.length === 0) return;

  fail(
    `Release requires a clean worktree so the release commit only contains release files.\n\n${status}`,
  );
}

function readPackageJson() {
  return JSON.parse(readFileSync("package.json", "utf8"));
}

function getLatestTagVersion() {
  const tags = git(["tag", "--list", "v[0-9]*", "--sort=-version:refname"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const tag of tags) {
    const parsed = tryParseVersion(tag);
    if (parsed) return parsed;
  }

  return undefined;
}

function resolveNextVersion(bumpOrVersion, baseVersion) {
  const explicitVersion = tryParseVersion(bumpOrVersion);
  if (explicitVersion) return explicitVersion;

  if (!VALID_BUMPS.has(bumpOrVersion)) {
    fail(
      `Expected patch, minor, major, or an explicit x.y.z version. Got: ${bumpOrVersion}\n\n${USAGE}`,
    );
  }

  if (bumpOrVersion === "major") {
    return { major: baseVersion.major + 1, minor: 0, patch: 0 };
  }

  if (bumpOrVersion === "minor") {
    return { major: baseVersion.major, minor: baseVersion.minor + 1, patch: 0 };
  }

  return { major: baseVersion.major, minor: baseVersion.minor, patch: baseVersion.patch + 1 };
}

function ensureVersionIncreases(nextVersion, baseVersion) {
  if (compareVersions(nextVersion, baseVersion) > 0) return;

  fail(
    `Next version ${formatVersion(nextVersion)} must be greater than current release base ${formatVersion(
      baseVersion,
    )}.`,
  );
}

function ensureTagDoesNotExist(tagName) {
  const result = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tagName}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) {
    fail(`Tag already exists: ${tagName}`);
  }
}

function updateReleaseFiles({ packageJson, version, dryRun }) {
  const formattedVersion = formatVersion(version);
  const nextPackageJson = {
    ...packageJson,
    version: formattedVersion,
  };

  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const nextChangelog = updateChangelog(
    changelog,
    formattedVersion,
    new Date().toISOString().slice(0, 10),
  );

  if (!dryRun) {
    writeFileSync("package.json", `${JSON.stringify(nextPackageJson, null, 2)}\n`);
    writeFileSync("CHANGELOG.md", nextChangelog);
  }

  return RELEASE_FILES;
}

function updateChangelog(changelog, version, date) {
  const marker = "## [Unreleased]";
  const markerIndex = changelog.indexOf(marker);

  if (markerIndex === -1) {
    return `${changelog.trimEnd()}\n\n## ${version} - ${date}\n\n- No changes recorded.\n`;
  }

  const afterMarkerIndex = markerIndex + marker.length;
  const nextHeadingIndex = changelog.indexOf("\n## ", afterMarkerIndex);
  const before = changelog.slice(0, markerIndex);
  const unreleasedBody = changelog
    .slice(afterMarkerIndex, nextHeadingIndex === -1 ? changelog.length : nextHeadingIndex)
    .trim();
  const after = nextHeadingIndex === -1 ? "" : changelog.slice(nextHeadingIndex + 1).trimStart();
  const releaseBody = unreleasedBody.length > 0 ? unreleasedBody : "- No changes recorded.";

  return `${before}${marker}\n\n## ${version} - ${date}\n\n${releaseBody}\n\n${after}`;
}

function parseVersion(input, label) {
  const parsed = tryParseVersion(input);
  if (parsed) return parsed;

  fail(`Invalid ${label}: ${input}`);
}

function tryParseVersion(input) {
  const match = VERSION_RE.exec(input);
  if (!match) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function maxVersion(a, b) {
  return compareVersions(a, b) >= 0 ? a : b;
}

function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function formatTag(version) {
  return `v${formatVersion(version)}`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitInherit(args) {
  runChecked("git", args);
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) return;

  fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the workflow artifact root for a Pi cwd.
 *
 * Pi can be started from a nested package/repo inside a larger workspace. In that
 * case workflow runs should join the existing workspace-level `.pi/workflows`
 * tree instead of creating another nested `.pi/workflows` in the package that
 * happened to launch the extension.
 */
export function workflowRootDirForCwd(cwd: string): string {
  const candidates = existingWorkflowRootsFrom(cwd);
  return candidates.at(-1) ?? join(cwd, ".pi", "workflows");
}

export function workflowRunScriptPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "script.js");
}

export function workflowRunTranscriptDir(rootDir: string, runId: string): string {
  return join(rootDir, runId, "transcripts");
}

export function workflowRunOutputPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "output.json");
}

export function workflowRunJournalPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "journal.jsonl");
}

function existingWorkflowRootsFrom(cwd: string): string[] {
  const candidates: string[] = [];
  let current = resolve(cwd);

  for (;;) {
    const candidate = join(current, ".pi", "workflows");
    if (isDirectory(candidate)) candidates.push(candidate);

    const parent = dirname(current);
    if (parent === current) return candidates;
    current = parent;
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
    /* v8 ignore start -- existsSync guards statSync; the throw requires a TOCTOU race */
  } catch {
    return false;
  }
  /* v8 ignore stop */
}

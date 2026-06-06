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
  } catch {
    return false;
  }
}

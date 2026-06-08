import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Shared temp-directory helper for the test suite.
 *
 * Each call creates a fresh `mkdtemp` directory and registers it for cleanup.
 * A single module-level `afterEach` removes every directory created during a
 * test, so individual tests no longer hand-roll their own `mkdtemp` +
 * `afterEach(rm)` pair. Importing this module is enough to wire the cleanup;
 * call `tempWorkflowDir()` (typically inside `beforeEach`) to get a directory.
 */
const activeDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...activeDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  activeDirs.clear();
});

/** Create a tracked temp directory; it is removed after the current test. */
export async function tempWorkflowDir(prefix = "pi-workflow-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  activeDirs.add(dir);
  return dir;
}

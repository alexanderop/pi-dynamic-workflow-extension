import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";

describe("workflowRootDirForCwd", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-workflow-root-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should fall back to the cwd-local workflow root when no Pi workflow root exists", () => {
    expect(workflowRootDirForCwd(tempDir)).toBe(join(tempDir, ".pi", "workflows"));
  });

  it("should use the outer existing Pi workflow root for nested project cwd values", async () => {
    const workspaceWorkflowRoot = join(tempDir, ".pi", "workflows");
    const nestedProject = join(tempDir, "packages", "nested-app");
    await mkdir(workspaceWorkflowRoot, { recursive: true });
    await mkdir(join(nestedProject, ".pi", "workflows"), { recursive: true });

    expect(workflowRootDirForCwd(nestedProject)).toBe(workspaceWorkflowRoot);
  });
});

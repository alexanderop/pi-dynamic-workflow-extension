import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";

describe("workflowRootDirForCwd", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-workflow-root-");
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

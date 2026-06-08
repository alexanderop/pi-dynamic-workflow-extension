import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
import { resolveSavedWorkflowByName, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { invalidWorkflowScript, workflowScript } from "../script/workflow-factory.ts";
import { unwrap } from "../../support.ts";

async function writeSavedWorkflow(dir: string, name: string, source: string): Promise<void> {
  await writeSavedWorkflowFile(dir, `${name}.js`, source);
}

async function writeSavedWorkflowFile(
  dir: string,
  fileName: string,
  source: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), source, "utf8");
}

describe("saved workflow resolver", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-saved-workflows-");
    projectDir = join(tempDir, "project", ".pi", "workflows");
  });

  it("should resolve a project saved workflow by command name", async () => {
    const source = workflowScript({
      meta: {
        name: "review",
        description: "Review the project",
        phases: [{ title: "Review" }],
      },
      body: "return 'project';",
    });
    await writeSavedWorkflow(projectDir, "review", source);

    const result = unwrap(await resolveSavedWorkflowByName("review", { projectDir }));

    expect(result).toMatchObject({
      name: "review",
      path: savedWorkflowPath(projectDir, "review"),
      scope: "project",
      source,
      meta: { name: "review", description: "Review the project" },
    });
  });

  it("should try an exact saved workflow path before scanning fallback files", async () => {
    const source = workflowScript({ meta: { name: "review" }, body: "return 'project';" });
    await writeSavedWorkflow(projectDir, "review", source);
    await chmod(projectDir, 0o300);

    try {
      const result = unwrap(await resolveSavedWorkflowByName("review", { projectDir }));

      expect(result).toMatchObject({
        name: "review",
        path: savedWorkflowPath(projectDir, "review"),
        scope: "project",
        source,
      });
    } finally {
      await chmod(projectDir, 0o700);
    }
  });

  it("should resolve a saved workflow by meta name when the file basename differs", async () => {
    const source = workflowScript({ meta: { name: "deep-research" }, body: "return 'found';" });
    await writeSavedWorkflowFile(projectDir, "deep-research2.js", source);

    const result = unwrap(await resolveSavedWorkflowByName("deep-research", { projectDir }));

    expect(result).toMatchObject({
      name: "deep-research",
      path: join(projectDir, "deep-research2.js"),
      scope: "project",
      source,
    });
  });

  it("should return a not-found error with searched project paths for missing saved workflows", async () => {
    const result = await resolveSavedWorkflowByName("missing", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowNotFoundError",
        name: "missing",
        searchedPaths: [savedWorkflowPath(projectDir, "missing"), join(projectDir, "*.js")],
      },
    });
  });

  it("should reject saved workflow names that would escape the workflow directory", async () => {
    const result = await resolveSavedWorkflowByName("../escape", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowInvalidNameError", name: "../escape" },
    });
  });

  it("should reject a saved workflow whose meta name does not match the command name", async () => {
    await writeSavedWorkflow(
      projectDir,
      "review",
      workflowScript({ meta: { name: "other" }, body: "return 'wrong';" }),
    );

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowInvalidError",
        path: savedWorkflowPath(projectDir, "review"),
        message: expect.stringContaining("meta.name"),
      },
    });
  });

  it("should reject saved workflows with invalid metadata", async () => {
    await writeSavedWorkflow(
      projectDir,
      "review",
      invalidWorkflowScript({ metaSource: "{ name: buildName() }", body: "return null;" }),
    );

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowInvalidError",
        path: savedWorkflowPath(projectDir, "review"),
        message: expect.stringContaining("literal"),
      },
    });
  });
});

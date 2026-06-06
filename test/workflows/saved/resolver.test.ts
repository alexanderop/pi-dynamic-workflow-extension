import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  let personalDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-saved-workflows-"));
    projectDir = join(tempDir, "project", ".pi", "workflows");
    personalDir = join(tempDir, "home", ".pi", "workflows");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
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

    const result = unwrap(await resolveSavedWorkflowByName("review", { projectDir, personalDir }));

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

  it("should resolve a personal saved workflow when the project workflow is absent", async () => {
    const source = workflowScript({ meta: { name: "review" }, body: "return 'personal';" });
    await writeSavedWorkflow(personalDir, "review", source);

    const result = unwrap(await resolveSavedWorkflowByName("review", { projectDir, personalDir }));

    expect(result).toMatchObject({
      name: "review",
      path: savedWorkflowPath(personalDir, "review"),
      scope: "personal",
      source,
    });
  });

  it("should prefer the project saved workflow on name conflict", async () => {
    const projectSource = workflowScript({ meta: { name: "review" }, body: "return 'project';" });
    const personalSource = workflowScript({ meta: { name: "review" }, body: "return 'personal';" });
    await writeSavedWorkflow(projectDir, "review", projectSource);
    await writeSavedWorkflow(personalDir, "review", personalSource);

    const result = unwrap(await resolveSavedWorkflowByName("review", { projectDir, personalDir }));

    expect(result).toMatchObject({
      path: savedWorkflowPath(projectDir, "review"),
      scope: "project",
      source: projectSource,
    });
  });

  it("should resolve a saved workflow by meta name when the file basename differs", async () => {
    const source = workflowScript({ meta: { name: "deep-research" }, body: "return 'found';" });
    await writeSavedWorkflowFile(personalDir, "deep-research2.js", source);

    const result = unwrap(
      await resolveSavedWorkflowByName("deep-research", { projectDir, personalDir }),
    );

    expect(result).toMatchObject({
      name: "deep-research",
      path: join(personalDir, "deep-research2.js"),
      scope: "personal",
      source,
    });
  });

  it("should return a not-found error with searched paths for missing saved workflows", async () => {
    const result = await resolveSavedWorkflowByName("missing", { projectDir, personalDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowNotFoundError",
        name: "missing",
        searchedPaths: [
          savedWorkflowPath(projectDir, "missing"),
          join(projectDir, "*.js"),
          savedWorkflowPath(personalDir, "missing"),
          join(personalDir, "*.js"),
        ],
      },
    });
  });

  it("should reject saved workflow names that would escape the workflow directory", async () => {
    const result = await resolveSavedWorkflowByName("../escape", { projectDir, personalDir });

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

    const result = await resolveSavedWorkflowByName("review", { projectDir, personalDir });

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

    const result = await resolveSavedWorkflowByName("review", { projectDir, personalDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowInvalidError",
        path: savedWorkflowPath(projectDir, "review"),
        message: expect.stringContaining("literal"),
      },
    });
  });

  it("should surface a non-missing error when the exact saved workflow path is a directory", async () => {
    await mkdir(savedWorkflowPath(projectDir, "review"), { recursive: true });

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowReadError",
        path: savedWorkflowPath(projectDir, "review"),
        cause: { code: "EISDIR" },
      },
    });
  });

  it("should skip a scanned fallback file whose script is invalid", async () => {
    await writeSavedWorkflowFile(
      personalDir,
      "notes.js",
      invalidWorkflowScript({ metaSource: "{ name: buildName() }", body: "return null;" }),
    );

    const result = await resolveSavedWorkflowByName("deep-research", { personalDir });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowNotFoundError", name: "deep-research" },
    });
  });

  it("should skip a scanned fallback file whose meta name does not match", async () => {
    await writeSavedWorkflowFile(
      personalDir,
      "unrelated.js",
      workflowScript({ meta: { name: "other" }, body: "return 'other';" }),
    );

    const result = await resolveSavedWorkflowByName("deep-research", { personalDir });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowNotFoundError", name: "deep-research" },
    });
  });
});

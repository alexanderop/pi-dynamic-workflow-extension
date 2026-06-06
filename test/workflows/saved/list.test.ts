import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSavedWorkflows } from "#src/workflows/saved/list.ts";
import { savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
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

describe("saved workflow listing", () => {
  let tempDir: string;
  let projectDir: string;
  let personalDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-saved-workflow-list-"));
    projectDir = join(tempDir, "project", ".pi", "workflows");
    personalDir = join(tempDir, "home", ".pi", "workflows");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should list project and personal saved workflows with user-facing metadata", async () => {
    const projectSource = workflowScript({
      meta: {
        name: "review",
        description: "Review source files",
        whenToUse: "Use before merging code changes",
      },
      body: "return 'project';",
    });
    const personalSource = workflowScript({
      meta: {
        name: "deep-research",
        description: "Research a topic",
        whenToUse: "Use when a question needs broad exploration",
      },
      body: "return 'personal';",
    });
    await writeSavedWorkflow(projectDir, "review", projectSource);
    await writeSavedWorkflow(personalDir, "deep-research", personalSource);

    const workflows = unwrap(await listSavedWorkflows({ projectDir, personalDir }));

    expect(workflows).toMatchObject([
      {
        name: "deep-research",
        scope: "personal",
        path: savedWorkflowPath(personalDir, "deep-research"),
        meta: {
          description: "Research a topic",
          whenToUse: "Use when a question needs broad exploration",
        },
      },
      {
        name: "review",
        scope: "project",
        path: savedWorkflowPath(projectDir, "review"),
        meta: {
          description: "Review source files",
          whenToUse: "Use before merging code changes",
        },
      },
    ]);
  });

  it("should prefer the project saved workflow when project and personal names conflict", async () => {
    await writeSavedWorkflow(
      projectDir,
      "review",
      workflowScript({ meta: { name: "review" }, body: "return 'project';" }),
    );
    await writeSavedWorkflow(
      personalDir,
      "review",
      workflowScript({ meta: { name: "review" }, body: "return 'personal';" }),
    );

    const workflows = unwrap(await listSavedWorkflows({ projectDir, personalDir }));

    expect(workflows).toMatchObject([
      {
        name: "review",
        scope: "project",
        path: savedWorkflowPath(projectDir, "review"),
      },
    ]);
  });

  it("should prefer an exact saved workflow file over an earlier-scanned duplicate meta name", async () => {
    const fallbackSource = workflowScript({
      meta: {
        name: "review",
        description: "Fallback duplicate",
      },
      body: "return 'fallback';",
    });
    const exactSource = workflowScript({
      meta: {
        name: "review",
        description: "Exact command file",
      },
      body: "return 'exact';",
    });
    await writeSavedWorkflowFile(projectDir, "aaa-review-copy.js", fallbackSource);
    await writeSavedWorkflow(projectDir, "review", exactSource);

    const workflows = unwrap(await listSavedWorkflows({ projectDir, personalDir }));

    expect(workflows).toMatchObject([
      {
        name: "review",
        path: savedWorkflowPath(projectDir, "review"),
        meta: { description: "Exact command file" },
      },
    ]);
  });

  it("should return an exact-file error when a fallback workflow is shadowed by an invalid exact file", async () => {
    await writeSavedWorkflow(
      projectDir,
      "review",
      invalidWorkflowScript({ metaSource: "{ name: buildName() }", body: "return null;" }),
    );
    await writeSavedWorkflowFile(
      projectDir,
      "review-copy.js",
      workflowScript({ meta: { name: "review" }, body: "return 'fallback';" }),
    );

    const result = await listSavedWorkflows({ projectDir, personalDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowInvalidError",
        path: savedWorkflowPath(projectDir, "review"),
      },
    });
  });

  it("should ignore unrelated invalid javascript files while scanning saved workflows", async () => {
    await writeSavedWorkflow(
      projectDir,
      "review",
      workflowScript({ meta: { name: "review" }, body: "return 'project';" }),
    );
    await writeSavedWorkflowFile(
      projectDir,
      "notes.js",
      invalidWorkflowScript({ metaSource: "{ name: buildName() }", body: "return null;" }),
    );

    const workflows = unwrap(await listSavedWorkflows({ projectDir, personalDir }));

    expect(workflows).toMatchObject([{ name: "review", scope: "project" }]);
  });

  it("should treat a missing personal directory as having no saved workflows", async () => {
    await writeSavedWorkflow(
      personalDir,
      "deep-research",
      workflowScript({ meta: { name: "deep-research" }, body: "return 'personal';" }),
    );

    const workflows = unwrap(await listSavedWorkflows({ personalDir }));

    expect(workflows.map((workflow) => workflow.name)).toEqual(["deep-research"]);
  });

  it("should return a read error when the saved workflow directory cannot be listed", async () => {
    const filePath = join(tempDir, "not-a-directory");
    await writeFile(filePath, "i am a file", "utf8");

    const result = await listSavedWorkflows({ projectDir: filePath });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowListReadError",
        path: filePath,
        cause: { code: "ENOTDIR" },
      },
    });
  });

  it("should fall back to scope ordering when two saved workflow names collate equally", async () => {
    const nfc = "café";
    const nfd = "café";
    expect(nfc).not.toBe(nfd);
    expect(nfc.localeCompare(nfd)).toBe(0);
    await writeSavedWorkflow(projectDir, nfc, workflowScript({ meta: { name: nfc } }));
    await writeSavedWorkflow(personalDir, nfd, workflowScript({ meta: { name: nfd } }));

    const collated = unwrap(await listSavedWorkflows({ projectDir, personalDir }));

    expect(collated).toHaveLength(2);
    expect(collated.map((workflow) => workflow.scope)).toEqual(["personal", "project"]);
  });
});

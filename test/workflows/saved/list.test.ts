import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempWorkflowDir } from "../../suite/tmpdir.ts";
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

  beforeEach(async () => {
    tempDir = await tempWorkflowDir("pi-saved-workflow-list-");
    projectDir = join(tempDir, "project", ".pi", "workflows");
  });

  it("should list project saved workflows with user-facing metadata", async () => {
    const reviewSource = workflowScript({
      meta: {
        name: "review",
        description: "Review source files",
        whenToUse: "Use before merging code changes",
      },
      body: "return 'review';",
    });
    const researchSource = workflowScript({
      meta: {
        name: "deep-research",
        description: "Research a topic",
        whenToUse: "Use when a question needs broad exploration",
      },
      body: "return 'research';",
    });
    await writeSavedWorkflow(projectDir, "review", reviewSource);
    await writeSavedWorkflow(projectDir, "deep-research", researchSource);

    const workflows = unwrap(await listSavedWorkflows({ projectDir }));

    expect(workflows).toMatchObject([
      {
        name: "deep-research",
        scope: "project",
        path: savedWorkflowPath(projectDir, "deep-research"),
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

    const workflows = unwrap(await listSavedWorkflows({ projectDir }));

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

    const result = await listSavedWorkflows({ projectDir });

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

    const workflows = unwrap(await listSavedWorkflows({ projectDir }));

    expect(workflows).toMatchObject([{ name: "review", scope: "project" }]);
  });
});

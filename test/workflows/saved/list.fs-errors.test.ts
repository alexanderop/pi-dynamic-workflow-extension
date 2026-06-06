import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";

const readFileMock = vi.hoisted(() => vi.fn<(...args: any[]) => any>());
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, readFile: readFileMock };
});

import { listSavedWorkflows } from "#src/workflows/saved/list.ts";
import { workflowScript } from "../script/workflow-factory.ts";
import { unwrap } from "../../support.ts";

let actual: typeof import("node:fs/promises");
let tempDir: string;
let projectDir: string;

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("saved workflow listing filesystem errors", () => {
  beforeEach(async () => {
    actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readFileMock.mockImplementation(actual.readFile);
    tempDir = await actual.mkdtemp(join(tmpdir(), "pi-list-fs-"));
    projectDir = join(tempDir, "project", ".pi", "workflows");
    await actual.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await actual.rm(tempDir, { recursive: true, force: true });
  });

  it("should skip a listed saved workflow file that vanishes before it is read", async () => {
    const goodPath = join(projectDir, "review.js");
    const missingPath = join(projectDir, "aaa-vanishes.js");
    await actual.writeFile(
      goodPath,
      workflowScript({ meta: { name: "review" }, body: "return 'review';" }),
      "utf8",
    );
    await actual.writeFile(
      missingPath,
      workflowScript({ meta: { name: "vanishes" }, body: "return 'gone';" }),
      "utf8",
    );
    readFileMock.mockImplementation(
      async (path: Parameters<typeof actual.readFile>[0], ...rest) => {
        if (path === missingPath) throw nodeError("ENOENT");
        return actual.readFile(path, ...(rest as []));
      },
    );

    const result = await listSavedWorkflows({ projectDir });

    expect(unwrap(result).map((workflow) => workflow.name)).toEqual(["review"]);
  });

  it("should return a read error when a listed saved workflow file fails for a non-missing reason", async () => {
    const failingPath = join(projectDir, "review.js");
    await actual.writeFile(
      failingPath,
      workflowScript({ meta: { name: "review" }, body: "return 'review';" }),
      "utf8",
    );
    readFileMock.mockImplementation(
      async (path: Parameters<typeof actual.readFile>[0], ...rest) => {
        if (path === failingPath) throw nodeError("EACCES");
        return actual.readFile(path, ...(rest as []));
      },
    );

    const result = await listSavedWorkflows({ projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowListReadError",
        path: failingPath,
        cause: { code: "EACCES" },
      },
    });
  });
});

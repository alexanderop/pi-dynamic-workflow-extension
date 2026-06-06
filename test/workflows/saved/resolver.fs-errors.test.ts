import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const readdirMock = vi.hoisted(() => vi.fn<(...args: any[]) => any>());
const readFileMock = vi.hoisted(() => vi.fn<(...args: any[]) => any>());
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, readdir: readdirMock, readFile: readFileMock };
});

import { resolveSavedWorkflowByName, savedWorkflowPath } from "#src/workflows/saved/resolver.ts";
import { workflowScript } from "../script/workflow-factory.ts";

let actual: typeof import("node:fs/promises");
let tempDir: string;
let projectDir: string;

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("saved workflow resolver filesystem errors", () => {
  beforeEach(async () => {
    actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readdirMock.mockImplementation(actual.readdir);
    readFileMock.mockImplementation(actual.readFile);
    tempDir = await actual.mkdtemp(join((await import("node:os")).tmpdir(), "pi-resolver-fs-"));
    projectDir = join(tempDir, "project", ".pi", "workflows");
    await actual.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await actual.rm(tempDir, { recursive: true, force: true });
  });

  it("should return a read error when scanning the directory fails for a non-missing reason", async () => {
    readdirMock.mockRejectedValueOnce(nodeError("EACCES"));

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowReadError",
        path: projectDir,
        cause: { code: "EACCES" },
      },
    });
  });

  it("should continue past a scanned fallback file that disappears before it is read", async () => {
    const fallbackPath = join(projectDir, "fallback.js");
    await actual.writeFile(
      fallbackPath,
      workflowScript({ meta: { name: "review" }, body: "return 'gone';" }),
      "utf8",
    );
    readFileMock.mockImplementation(
      async (path: Parameters<typeof actual.readFile>[0], ...rest) => {
        if (path === fallbackPath) throw nodeError("ENOENT");
        return actual.readFile(path, ...(rest as []));
      },
    );

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "WorkflowSavedWorkflowNotFoundError", name: "review" },
    });
  });

  it("should return a read error when a scanned fallback file fails for a non-missing reason", async () => {
    const fallbackPath = join(projectDir, "fallback.js");
    await actual.writeFile(
      fallbackPath,
      workflowScript({ meta: { name: "review" }, body: "return 'boom';" }),
      "utf8",
    );
    readFileMock.mockImplementation(
      async (path: Parameters<typeof actual.readFile>[0], ...rest) => {
        if (path === fallbackPath) throw nodeError("EACCES");
        return actual.readFile(path, ...(rest as []));
      },
    );

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "WorkflowSavedWorkflowReadError",
        path: fallbackPath,
        cause: { code: "EACCES" },
      },
    });
  });

  it("should resolve a scanned fallback file whose meta name matches the request", async () => {
    const fallbackPath = join(projectDir, "fallback.js");
    await actual.writeFile(
      fallbackPath,
      workflowScript({ meta: { name: "review" }, body: "return 'fallback';" }),
      "utf8",
    );

    const result = await resolveSavedWorkflowByName("review", { projectDir });

    expect(result).toMatchObject({
      status: "ok",
      value: { name: "review", path: fallbackPath, scope: "project" },
    });
    expect(savedWorkflowPath(projectDir, "review")).not.toBe(fallbackPath);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  listSavedWorkflows,
  type WorkflowSavedWorkflowListError,
} from "#src/workflows/saved/list.ts";
import {
  resolveSavedWorkflowByName,
  savedWorkflowPath,
  type WorkflowSavedWorkflow,
  type WorkflowSavedWorkflowError,
} from "#src/workflows/saved/resolver.ts";
import { pathExists } from "../../support.ts";

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Build the `{ status: "error", error }` shape from either an error `_tag` or a partial matcher. */
function errorMatcher(tagOrMatcher: string | object): { status: "error"; error: object } {
  return {
    status: "error",
    error: typeof tagOrMatcher === "string" ? { _tag: tagOrMatcher } : tagOrMatcher,
  };
}

export interface SavedWorkflowScenarioOptions {
  readonly tempDir?: string;
  readonly projectDir?: string;
}

const activeScenarios = new Set<SavedWorkflowScenario>();

afterEach(async () => {
  await Promise.all([...activeScenarios].map((scenario) => scenario.cleanup()));
  activeScenarios.clear();
});

/**
 * Project-local saved-workflow harness for listing and resolution tests. It
 * owns an isolated temp project directory and never creates run storage, so it
 * stays lighter than {@link import("../launch/workflow-scenario.ts")}.
 */
export function savedWorkflowScenario(
  options: SavedWorkflowScenarioOptions = {},
): SavedWorkflowScenario {
  const scenario = new SavedWorkflowScenario(options);
  activeScenarios.add(scenario);
  return scenario;
}

export class SavedWorkflowScenario {
  #tempDir?: string;
  #projectDir?: string;
  #ownsTempDir = false;

  constructor(options: SavedWorkflowScenarioOptions = {}) {
    this.#tempDir = options.tempDir;
    this.#projectDir = options.projectDir;
  }

  get tempDir(): string {
    if (this.#tempDir === undefined)
      throw new Error("Saved workflow scenario temp dir is not ready.");
    return this.#tempDir;
  }

  get projectDir(): string {
    if (this.#projectDir === undefined) {
      throw new Error("Saved workflow scenario project dir is not ready.");
    }
    return this.#projectDir;
  }

  /** Write `${name}.js` into the project workflow directory. */
  async withProjectWorkflow(name: string, source: string): Promise<this> {
    await this.withProjectWorkflowFile(`${name}.js`, source);
    return this;
  }

  /** Write an arbitrarily-named `.js` file (for basename-differs cases). */
  async withProjectWorkflowFile(fileName: string, source: string): Promise<this> {
    await this.#ensureProjectDir();
    await writeFile(join(this.projectDir, fileName), source, "utf8");
    return this;
  }

  async resolve(name: string): Promise<ReturnType<typeof resolveSavedWorkflowByName>> {
    await this.#ensureProjectDir();
    return resolveSavedWorkflowByName(name, { projectDir: this.projectDir });
  }

  async list(): Promise<ReturnType<typeof listSavedWorkflows>> {
    await this.#ensureProjectDir();
    return listSavedWorkflows({ projectDir: this.projectDir });
  }

  async shouldResolve(
    name: string,
    matcher: DeepPartial<WorkflowSavedWorkflow> = {},
  ): Promise<this> {
    const result = await this.resolve(name);
    expect(result, `Expected '${name}' to resolve, got ${JSON.stringify(result)}.`).toMatchObject({
      status: "ok",
      value: { name, scope: "project", ...matcher },
    });
    return this;
  }

  async shouldResolveToPath(name: string, fileName: string): Promise<this> {
    const result = await this.resolve(name);
    expect(result).toMatchObject({
      status: "ok",
      value: { path: join(this.projectDir, fileName) },
    });
    return this;
  }

  async shouldFailToResolve(
    name: string,
    tagOrMatcher: string | Partial<WorkflowSavedWorkflowError>,
  ): Promise<this> {
    const result = await this.resolve(name);
    expect(result, `Expected '${name}' to fail resolution.`).toMatchObject(
      errorMatcher(tagOrMatcher),
    );
    return this;
  }

  async shouldListNames(names: readonly string[]): Promise<this> {
    const result = await this.list();
    if (result.status === "error") {
      throw new Error(`Expected listing to succeed, got ${JSON.stringify(result.error)}.`);
    }
    expect(result.value.map((workflow) => workflow.name)).toEqual([...names]);
    return this;
  }

  async shouldFailToList(
    tagOrMatcher: string | Partial<WorkflowSavedWorkflowListError>,
  ): Promise<this> {
    const result = await this.list();
    expect(result).toMatchObject(errorMatcher(tagOrMatcher));
    return this;
  }

  /** Project-relative path the resolver would search for an exact command name. */
  pathFor(name: string): string {
    return savedWorkflowPath(this.projectDir, name);
  }

  async shouldNotHaveCreatedRunStorage(): Promise<this> {
    const runDir = join(this.tempDir, ".pi", "workflows");
    expect(await pathExists(runDir)).toBe(false);
    return this;
  }

  async cleanup(): Promise<void> {
    activeScenarios.delete(this);
    if (this.#ownsTempDir && this.#tempDir !== undefined) {
      await rm(this.#tempDir, { recursive: true, force: true });
    }
  }

  async #ensureProjectDir(): Promise<void> {
    if (this.#tempDir === undefined) {
      this.#tempDir = await mkdtemp(join(tmpdir(), "pi-saved-workflow-scenario-"));
      this.#ownsTempDir = true;
    }
    if (this.#projectDir === undefined) {
      this.#projectDir = join(this.#tempDir, "project", ".pi", "workflows");
    }
    await mkdir(this.#projectDir, { recursive: true });
  }
}

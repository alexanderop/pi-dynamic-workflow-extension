// Run-manifest persistence: read/write/cache under the workflow root dir.
// Deserialization lives in manifest-codec.ts; the agent journal store is
// separate in src/workflows/journal/store.ts.
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "#src/workflows/guards.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { toWorkflowRunState } from "./manifest-codec.ts";
import type { WorkflowRunState } from "./model.ts";

export interface WorkflowRunStoreOptions {
  rootDir: string;
}

export type WorkflowRunStoreError =
  | WorkflowRunNotFoundError
  | WorkflowRunReadError
  | WorkflowRunWriteError
  | WorkflowRunInvalidError;

export interface WorkflowRunNotFoundError {
  readonly _tag: "WorkflowRunNotFoundError";
  readonly message: string;
  readonly runId: string;
  readonly path: string;
}

export interface WorkflowRunReadError {
  readonly _tag: "WorkflowRunReadError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowRunWriteError {
  readonly _tag: "WorkflowRunWriteError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowRunInvalidError {
  readonly _tag: "WorkflowRunInvalidError";
  readonly message: string;
  readonly path: string;
}

interface WorkflowRunCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly state: WorkflowRunState;
}

export class WorkflowRunStore {
  readonly #rootDir: string;
  readonly #cache = new Map<string, WorkflowRunCacheEntry>();

  constructor(options: WorkflowRunStoreOptions) {
    this.#rootDir = options.rootDir;
  }

  async listRuns(): Promise<Result<WorkflowRunState[], WorkflowRunStoreError>> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.#rootDir, { withFileTypes: true });
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
      return err(readError(this.#rootDir, cause));
    }

    const runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const present = new Set(runIds);
    for (const runId of this.#cache.keys()) {
      if (!present.has(runId)) this.#cache.delete(runId);
    }

    const results = await Promise.all(runIds.map((runId) => this.#loadCachedManifest(runId)));
    const runs: WorkflowRunState[] = [];
    for (const result of results) {
      if (result !== undefined) runs.push(result);
    }

    return ok(runs.toSorted(compareRunsNewestFirst));
  }

  async #loadCachedManifest(runId: string): Promise<WorkflowRunState | undefined> {
    const path = manifestPath(this.#rootDir, runId);
    let stats: { mtimeMs: number; size: number };
    try {
      stats = await stat(path);
    } catch {
      this.#cache.delete(runId);
      return undefined;
    }

    const cached = this.#cache.get(runId);
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.state;
    }

    const result = await this.#readManifest(runId);
    if (result.status !== "ok") {
      this.#cache.delete(runId);
      return undefined;
    }

    this.#cache.set(runId, { mtimeMs: stats.mtimeMs, size: stats.size, state: result.value });
    return result.value;
  }

  async readRun(runId: string): Promise<Result<WorkflowRunState, WorkflowRunStoreError>> {
    const result = await this.#readManifest(runId);
    if (result.status === "error" && isWorkflowRunReadError(result.error)) {
      const cause = result.error.cause;
      if (isNodeError(cause) && cause.code === "ENOENT") {
        const path = manifestPath(this.#rootDir, runId);
        return err({
          _tag: "WorkflowRunNotFoundError",
          message: `Workflow run '${runId}' was not found.`,
          runId,
          path,
        });
      }
    }
    return result;
  }

  async writeRun(state: WorkflowRunState): Promise<Result<void, WorkflowRunWriteError>> {
    const path = manifestPath(this.#rootDir, state.runId);
    try {
      const runDir = join(this.#rootDir, state.runId);
      await mkdir(runDir, { recursive: true });
      const tempPath = join(runDir, `.manifest.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tempPath, path);
      return ok(undefined);
    } catch (cause) {
      return err({
        _tag: "WorkflowRunWriteError",
        message: `Could not write workflow run manifest at '${path}'.`,
        path,
        cause,
      });
    }
  }

  async #readManifest(runId: string): Promise<Result<WorkflowRunState, WorkflowRunStoreError>> {
    const path = manifestPath(this.#rootDir, runId);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (cause) {
      return err(readError(path, cause));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return err({
        _tag: "WorkflowRunInvalidError",
        message: `Workflow run manifest '${path}' is not valid JSON.`,
        path,
      });
    }

    const state = toWorkflowRunState(parsed);
    if (state === undefined) {
      return err({
        _tag: "WorkflowRunInvalidError",
        message: `Workflow run manifest '${path}' does not match the run-state read model.`,
        path,
      });
    }

    return ok(state);
  }
}

export function workflowRunManifestPath(rootDir: string, runId: string): string {
  return manifestPath(rootDir, runId);
}

function manifestPath(rootDir: string, runId: string): string {
  return join(rootDir, runId, "manifest.json");
}

function compareRunsNewestFirst(left: WorkflowRunState, right: WorkflowRunState): number {
  return runSortTime(right) - runSortTime(left) || right.runId.localeCompare(left.runId);
}

function runSortTime(run: WorkflowRunState): number {
  return run.startTime || timestampMs(run.timestamp) || 0;
}

function timestampMs(timestamp: string | undefined): number {
  if (timestamp === undefined) return 0;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? 0 : ms;
}

function readError(path: string, cause: unknown): WorkflowRunReadError {
  return {
    _tag: "WorkflowRunReadError",
    message: `Could not read workflow run storage at '${path}'.`,
    path,
    cause,
  };
}

function isWorkflowRunReadError(error: WorkflowRunStoreError): error is WorkflowRunReadError {
  return error["_tag"] === "WorkflowRunReadError";
}

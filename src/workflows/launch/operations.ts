import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowRunScriptPath, workflowRunTranscriptDir } from "#src/workflows/run/root-dir.ts";
import { WorkflowJournalStore } from "#src/workflows/journal/store.ts";
import type { WorkflowJournalEvent } from "#src/workflows/journal/model.ts";
import { err, ok, type Result } from "#src/workflows/result.ts";
import { WorkflowRunStore } from "#src/workflows/run/store.ts";
import type { WorkflowRunState } from "#src/workflows/run/model.ts";
import {
  readSavedWorkflowScriptPath,
  resolveSavedWorkflowByName,
  type WorkflowSavedWorkflow,
  type WorkflowSavedWorkflowError,
  type WorkflowSavedWorkflowLocations,
  type WorkflowSavedWorkflowReadError,
} from "#src/workflows/saved/resolver.ts";
import type { WorkflowAgentJournal } from "#src/workflows/journal/model.ts";
import type { WorkflowLaunchPersistenceError, WorkflowTerminalOutput } from "./model.ts";

export interface PrepareWorkflowRunFilesInput {
  readonly rootDir: string;
  readonly runId: string;
  readonly script: string;
  readonly initialState: WorkflowRunState;
}

export interface WriteWorkflowRunInput {
  readonly rootDir: string;
  readonly state: WorkflowRunState;
}

export interface WriteWorkflowTerminalOutputInput {
  readonly outputPath: string;
  readonly output: WorkflowTerminalOutput;
}

export interface WorkflowLaunchOperations {
  readonly resolveSavedWorkflowByName: (
    name: string,
    locations: WorkflowSavedWorkflowLocations,
  ) => Promise<Result<WorkflowSavedWorkflow, WorkflowSavedWorkflowError>>;
  readonly readSavedWorkflowScriptPath: (
    path: string,
  ) => Promise<Result<string, WorkflowSavedWorkflowReadError>>;
  readonly readJournalEvents: (journalPath: string) => Promise<WorkflowJournalEvent[]>;
  readonly createJournal: (journalPath: string) => WorkflowAgentJournal;
  readonly prepareRunFiles: (
    input: PrepareWorkflowRunFilesInput,
  ) => Promise<Result<void, WorkflowLaunchPersistenceError>>;
  readonly writeRun: (
    input: WriteWorkflowRunInput,
  ) => Promise<Result<void, WorkflowLaunchPersistenceError>>;
  readonly writeTerminalOutput: (
    input: WriteWorkflowTerminalOutputInput,
  ) => Promise<Result<void, WorkflowLaunchPersistenceError>>;
}

export const defaultWorkflowLaunchOperations: WorkflowLaunchOperations = {
  resolveSavedWorkflowByName,
  readSavedWorkflowScriptPath,
  readJournalEvents: async (journalPath) =>
    await new WorkflowJournalStore({ journalPath }).readEvents(),
  createJournal: (journalPath) => new WorkflowJournalStore({ journalPath }),
  prepareRunFiles: async ({ rootDir, runId, script, initialState }) => {
    try {
      await mkdir(rootDir, { recursive: true });
      await mkdir(join(rootDir, runId));
      await mkdir(workflowRunTranscriptDir(rootDir, runId));
      await writeFile(workflowRunScriptPath(rootDir, runId), script, "utf8");
    } catch (cause) {
      return err(persistenceError(join(rootDir, runId), cause));
    }

    return defaultWorkflowLaunchOperations.writeRun({ rootDir, state: initialState });
  },
  writeRun: async ({ rootDir, state }) => {
    const result = await new WorkflowRunStore({ rootDir }).writeRun(state);
    if (result.status === "error") {
      return err(persistenceError(result.error.path, result.error.cause));
    }
    return ok(undefined);
  },
  writeTerminalOutput: async ({ outputPath, output }) => {
    try {
      await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      return ok(undefined);
    } catch (cause) {
      return err(persistenceError(outputPath, cause));
    }
  },
};

export function persistenceError(path: string, cause: unknown): WorkflowLaunchPersistenceError {
  return {
    _tag: "WorkflowLaunchPersistenceError",
    message: `Could not prepare workflow run storage at '${path}'.`,
    path,
    cause,
  };
}

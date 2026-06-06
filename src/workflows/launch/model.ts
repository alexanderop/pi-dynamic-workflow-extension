import type { Result } from "#src/workflows/result.ts";
import type { WorkflowFailure, WorkflowRunState } from "#src/workflows/run/model.ts";
import type { WorkflowParseError } from "#src/workflows/script/parser.ts";
import type { WorkflowRuntimeOptions } from "#src/workflows/script/model.ts";
import type {
  WorkflowSavedWorkflowError,
  WorkflowSavedWorkflowLocations,
} from "#src/workflows/saved/resolver.ts";

export interface WorkflowLaunchRequest {
  readonly script?: string;
  readonly name?: string;
  readonly scriptPath?: string;
  readonly args?: unknown;
  readonly resumeFromRunId?: string;
  readonly description?: string;
}

export interface WorkflowLaunchOptions {
  readonly rootDir: string;
  readonly cwd?: string;
  readonly now?: () => number;
  readonly createTaskId?: () => string;
  readonly createRunId?: () => string;
  readonly defer?: (start: () => void) => void;
  readonly agentRunner?: WorkflowRuntimeOptions["agentRunner"];
  readonly schedulerRunner?: WorkflowRuntimeOptions["schedulerRunner"];
  readonly maxConcurrentAgents?: number;
  readonly maxTotalAgents?: number;
  readonly budgetTotal?: number | null;
  readonly onRuntimeControlReady?: WorkflowRuntimeOptions["onControlReady"];
  readonly notifyTerminal?: WorkflowTerminalNotifier;
  readonly inlineResultMaxChars?: number;
  readonly savedWorkflowDirs?: WorkflowSavedWorkflowLocations;
}

export interface WorkflowLaunch {
  readonly taskId: string;
  readonly runId: string;
  readonly scriptPath: string;
  readonly transcriptDir: string;
  readonly confirmation: string;
  readonly completion: Promise<Result<WorkflowRunState, WorkflowLaunchBackgroundError>>;
}

export type WorkflowTerminalNotifier = (
  notification: WorkflowTaskNotification,
) => void | Promise<void>;

export interface WorkflowTaskUsage {
  readonly agentCount: number;
  readonly subagentTokens: number;
  readonly toolUses: number;
  readonly durationMs: number;
}

export interface WorkflowTerminalOutput {
  readonly runId: string;
  readonly taskId: string;
  readonly workflowName: string;
  readonly status: WorkflowRunState["status"];
  readonly timestamp?: string;
  readonly durationMs?: number;
  readonly outputPath: string;
  readonly result?: unknown;
  readonly failures?: WorkflowFailure[];
  readonly usage: WorkflowTaskUsage;
}

export interface WorkflowTaskNotification {
  readonly customType: "workflow-task-notification";
  readonly display: true;
  readonly content: string;
  readonly details: WorkflowTaskNotificationDetails;
}

export interface WorkflowTaskNotificationDetails {
  readonly taskId: string;
  readonly runId: string;
  readonly outputFile: string;
  readonly status: WorkflowRunState["status"];
  readonly summary: string;
  readonly result: string;
  readonly failures?: string[];
  readonly usage: WorkflowTaskUsage;
}

export type WorkflowLaunchError =
  | WorkflowLaunchInvalidRequestError
  | WorkflowSavedWorkflowError
  | WorkflowLaunchParseError
  | WorkflowLaunchPersistenceError;

export interface WorkflowLaunchInvalidRequestError {
  readonly _tag: "WorkflowLaunchInvalidRequestError";
  readonly message: string;
}

export interface WorkflowLaunchParseError {
  readonly _tag: "WorkflowLaunchParseError";
  readonly message: string;
  readonly cause: WorkflowParseError;
}

export interface WorkflowLaunchPersistenceError {
  readonly _tag: "WorkflowLaunchPersistenceError";
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

export interface WorkflowLaunchBackgroundError {
  readonly _tag: "WorkflowLaunchBackgroundError";
  readonly message: string;
  readonly runId: string;
  readonly cause: unknown;
}

export interface WorkflowTerminalNotificationError {
  readonly _tag: "WorkflowTerminalNotificationError";
  readonly message: string;
  readonly cause: unknown;
}

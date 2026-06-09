import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { PiWorkflowAgentRunnerOptions } from "#src/extension/agent/pi-runner.ts";
import { buildWorkflowLaunchOptions } from "#src/extension/workflow-launch-options.ts";
import { terminalNotifier } from "#src/extension/workflow-notifications.ts";
import {
  emitWorkflowCommandOutput,
  type WorkflowCommandMode,
} from "#src/extension/commands/command-output.ts";
import {
  launchWorkflow,
  type WorkflowLaunch,
  type WorkflowLaunchError,
  type WorkflowLaunchOptions,
  type WorkflowLaunchRequest,
} from "#src/workflows/launch/launcher.ts";
import type { Result } from "#src/workflows/result.ts";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";
import { listSavedWorkflows } from "#src/workflows/saved/list.ts";
import {
  resolveSavedWorkflowByName,
  type WorkflowSavedWorkflow,
} from "#src/workflows/saved/resolver.ts";

/** The generic launch-by-name command name. */
export const GENERIC_WORKFLOW_COMMAND_NAME = "workflow";

/**
 * Command names that the workflows extension owns directly. A saved workflow
 * whose `meta.name` collides with one of these is never registered as a direct
 * command; it stays reachable through {@link GENERIC_WORKFLOW_COMMAND_NAME}.
 */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  GENERIC_WORKFLOW_COMMAND_NAME,
  "workflows",
]);

export type SavedWorkflowCommandStatus =
  | "registered"
  | "skipped_invalid_name"
  | "skipped_reserved"
  | "skipped_collision"
  | "error";

export interface SavedWorkflowCommandRegistration {
  readonly workflowName: string;
  readonly commandName: string;
  readonly path: string;
  readonly status: SavedWorkflowCommandStatus;
  readonly reason?: string;
}

/**
 * The command-handler context fields the saved-workflow launch path reads.
 * Mirrors the richer shape Pi passes at runtime without depending on private
 * SDK types; every extra field is optional so tests can supply a partial mock.
 */
export type SavedWorkflowCommandContext = ExtensionCommandContext & {
  readonly mode?: WorkflowCommandMode;
  readonly model?: PiWorkflowAgentRunnerOptions["model"];
  readonly modelRegistry?: PiWorkflowAgentRunnerOptions["modelRegistry"] & {
    readonly getAvailable?: () =>
      | Promise<WorkflowLaunchOptions["availableModels"]>
      | WorkflowLaunchOptions["availableModels"];
  };
  readonly env?: Record<string, string | undefined>;
  readonly featureConfigPaths?: {
    readonly userConfigPath?: string;
    readonly projectConfigPath?: string;
  };
};

/** The slice of the host API that the saved-workflow command registry depends on. */
export type RegisterSavedWorkflowCommandsPi = Pick<ExtensionAPI, "registerCommand"> &
  Partial<
    Pick<
      ExtensionAPI,
      "getCommands" | "sendMessage" | "getThinkingLevel" | "appendEntry" | "getFlag" | "events"
    >
  >;

export interface SavedWorkflowCommandRegistryOptions {
  readonly launchWorkflow?: (
    request: WorkflowLaunchRequest,
    options: WorkflowLaunchOptions,
  ) => Promise<Result<WorkflowLaunch, WorkflowLaunchError>>;
}

export type SyncDirectCommandsResult =
  | { readonly status: "ok"; readonly registrations: SavedWorkflowCommandRegistration[] }
  | { readonly status: "error"; readonly message: string };

/**
 * Render a user-facing diagnostic for a sync result, or `undefined` when every
 * saved workflow was handled cleanly. Listing failures and per-command
 * registration failures are surfaced; expected skips (reserved/collision/invalid
 * name) are not — those are normal and reported through `/workflows` instead.
 */
export function formatSyncDirectCommandsDiagnostics(
  result: SyncDirectCommandsResult,
): string | undefined {
  if (result.status === "error") {
    return `Could not load saved workflows: ${result.message}`;
  }

  const failed = result.registrations.filter((registration) => registration.status === "error");
  if (failed.length === 0) return undefined;

  return [
    "Some saved workflow commands could not be registered:",
    ...failed.map(
      (registration) => `- /${registration.commandName}: ${registration.reason ?? "unknown error"}`,
    ),
  ].join("\n");
}

/**
 * Is `name` shaped like a safe Pi slash command? Pure structural check; does
 * not consider reserved names or collisions (see {@link classifySavedWorkflowCommand}).
 */
export function isCommandSafeName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith("/") &&
    !name.startsWith("skill:") &&
    !/\s/.test(name) &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/**
 * Decide whether a saved workflow can be registered as a direct slash command,
 * and if not, why. Pure: takes the current command list so callers control when
 * collisions are evaluated. Discovery never executes workflow JavaScript.
 */
export function classifySavedWorkflowCommand(
  workflow: { readonly name: string; readonly path: string },
  existingCommands: readonly Pick<SlashCommandInfo, "name" | "source">[],
): SavedWorkflowCommandRegistration {
  const commandName = workflow.name;
  const base = { workflowName: workflow.name, commandName, path: workflow.path } as const;

  if (!isCommandSafeName(commandName)) {
    return {
      ...base,
      status: "skipped_invalid_name",
      reason: `'${commandName}' is not a valid slash command name.`,
    };
  }

  if (RESERVED_COMMAND_NAMES.has(commandName)) {
    return {
      ...base,
      status: "skipped_reserved",
      reason: `/${commandName} is reserved by the workflows extension.`,
    };
  }

  const collision = existingCommands.find((command) => command.name === commandName);
  if (collision !== undefined) {
    return {
      ...base,
      status: "skipped_collision",
      reason: collisionReason(commandName, collision.source),
    };
  }

  return { ...base, status: "registered" };
}

function collisionReason(commandName: string, source: SlashCommandInfo["source"]): string {
  const sourceLabel =
    source === "prompt"
      ? "a prompt template"
      : source === "skill"
        ? "a skill command"
        : "another command";
  return `/${commandName} is already used by ${sourceLabel}; launch with /${GENERIC_WORKFLOW_COMMAND_NAME} ${commandName} <args> or Workflow({ name: "${commandName}" }).`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers saved workflows as Pi slash commands. Owns the generic
 * `/workflow <name>` command plus safe direct `/<name>` commands. Handlers
 * launch by `name` at invocation time so edits to the saved script are picked
 * up without re-registering.
 */
export class SavedWorkflowCommandRegistry {
  private readonly registeredDirectNames = new Set<string>();
  private completionCache: readonly WorkflowSavedWorkflow[] | undefined;

  constructor(
    private readonly pi: RegisterSavedWorkflowCommandsPi,
    private readonly options: SavedWorkflowCommandRegistryOptions = {},
  ) {}

  /** Register the stable generic `/workflow <name> [args]` command. */
  registerGenericCommand(): void {
    this.pi.registerCommand(GENERIC_WORKFLOW_COMMAND_NAME, {
      description: "Launch a saved workflow by name: /workflow <name> [args]",
      getArgumentCompletions: (prefix) => this.savedNameCompletions(prefix),
      handler: async (args, ctx) => {
        await this.handleGenericInvocation(args, ctx as SavedWorkflowCommandContext);
      },
    });
  }

  /**
   * Scan the workflow root and register safe direct commands. Returns one
   * registration record per saved workflow for diagnostics. Listing or read
   * errors are reported via the returned `error` and never throw. Idempotent:
   * a workflow already registered as a direct command is left untouched.
   */
  async syncDirectCommands(ctx: Pick<ExtensionContext, "cwd">): Promise<SyncDirectCommandsResult> {
    const rootDir = workflowRootDirForCwd(ctx.cwd);

    const saved = await listSavedWorkflows({ projectDir: rootDir });
    if (saved.status === "error") {
      return { status: "error", message: saved.error.message };
    }
    this.completionCache = saved.value;

    const existing = this.currentCommands();
    const registrations: SavedWorkflowCommandRegistration[] = [];
    for (const workflow of saved.value) {
      registrations.push(this.registerDirectCommand(workflow, existing));
    }
    return { status: "ok", registrations };
  }

  /**
   * Resolve and register a single saved workflow as a direct command, returning
   * its registration record (or `undefined` when it cannot be resolved). Reads
   * only the named workflow so the save path registers a just-saved command
   * without re-scanning every saved workflow.
   */
  async registerSavedWorkflowByName(
    ctx: Pick<ExtensionContext, "cwd">,
    name: string,
  ): Promise<SavedWorkflowCommandRegistration | undefined> {
    const rootDir = workflowRootDirForCwd(ctx.cwd);
    const resolved = await resolveSavedWorkflowByName(name, { projectDir: rootDir });
    if (resolved.status === "error") return undefined;
    return this.registerDirectCommand(resolved.value, this.currentCommands());
  }

  private registerDirectCommand(
    workflow: WorkflowSavedWorkflow,
    existing: readonly Pick<SlashCommandInfo, "name" | "source">[],
  ): SavedWorkflowCommandRegistration {
    if (this.registeredDirectNames.has(workflow.name)) {
      return {
        workflowName: workflow.name,
        commandName: workflow.name,
        path: workflow.path,
        status: "registered",
      };
    }

    const classification = classifySavedWorkflowCommand(workflow, existing);
    if (classification.status !== "registered") return classification;

    const name = classification.commandName;
    try {
      this.pi.registerCommand(name, {
        description: workflow.meta.description ?? `Launch saved workflow '${name}'`,
        handler: async (args, ctx) => {
          await this.handleDirectInvocation(name, args, ctx as SavedWorkflowCommandContext);
        },
      });
    } catch (error) {
      return {
        workflowName: workflow.name,
        commandName: name,
        path: workflow.path,
        status: "error",
        reason: `Failed to register /${name}: ${errorMessage(error)}`,
      };
    }
    this.registeredDirectNames.add(name);
    return classification;
  }

  private currentCommands(): Pick<SlashCommandInfo, "name" | "source">[] {
    try {
      return this.pi.getCommands?.() ?? [];
    } catch {
      return [];
    }
  }

  private savedNameCompletions(prefix: string): AutocompleteItem[] | null {
    // getArgumentCompletions has no ctx; complete against the saved set captured
    // by the last sync. Before any sync there is nothing to offer.
    const saved = this.completionCache;
    if (saved === undefined) return null;

    const normalized = prefix.trim().toLowerCase();
    return saved
      .filter((workflow) => workflow.name.toLowerCase().startsWith(normalized))
      .map((workflow) => ({
        value: workflow.name,
        label: workflow.name,
        description: workflow.meta.description,
      }));
  }

  private async handleGenericInvocation(
    args: string,
    ctx: SavedWorkflowCommandContext,
  ): Promise<void> {
    const trimmed = args.trimStart();
    if (trimmed.length === 0) {
      emitWorkflowCommandOutput(
        ctx,
        GENERIC_WORKFLOW_COMMAND_NAME,
        `Usage: /${GENERIC_WORKFLOW_COMMAND_NAME} <name> [args]`,
        "error",
      );
      return;
    }

    const separator = trimmed.search(/\s/);
    const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const workflowArgs = separator === -1 ? "" : trimmed.slice(separator + 1).trimStart();
    await this.launchByName(name, workflowArgs, ctx, GENERIC_WORKFLOW_COMMAND_NAME);
  }

  private async handleDirectInvocation(
    name: string,
    args: string,
    ctx: SavedWorkflowCommandContext,
  ): Promise<void> {
    // The direct command name is the workflow name, so it doubles as the
    // invoked command name for non-interactive output envelopes.
    await this.launchByName(name, args.trimStart(), ctx, name);
  }

  private async launchByName(
    name: string,
    args: string,
    ctx: SavedWorkflowCommandContext,
    commandName: string,
  ): Promise<void> {
    const rootDir = workflowRootDirForCwd(ctx.cwd);
    const launchOptions = await buildWorkflowLaunchOptions(ctx, this.pi, {
      rootDir,
      triggerSource: "saved",
      notifyTerminal: terminalNotifier(this.pi.sendMessage),
    });

    const launch = await (this.options.launchWorkflow ?? launchWorkflow)(
      { name, args },
      launchOptions,
    );

    if (launch.status === "error") {
      emitWorkflowCommandOutput(ctx, commandName, launch.error.message, "error");
      return;
    }

    emitWorkflowCommandOutput(
      ctx,
      commandName,
      `Launched workflow '${name}' as ${launch.value.runId}. Watch with /workflows.`,
      "info",
    );
  }
}

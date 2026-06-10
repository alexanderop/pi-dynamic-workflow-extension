import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiWorkflowAgentRunnerOptions } from "#src/extension/agent/pi-runner.ts";
import type { WorkflowCommandMode } from "#src/extension/commands/command-output.ts";
import type { WorkflowLaunchOptions } from "#src/workflows/launch/launcher.ts";

/**
 * The command-handler context fields every workflow command reads. Mirrors the
 * richer shape Pi passes at runtime without depending on private SDK types;
 * every extra field is optional so tests can supply a partial mock. Shared by
 * `/workflows` and the saved-workflow commands so the two cannot drift apart
 * (notably the `modelRegistry & { getAvailable? }` intersection).
 */
export type WorkflowCommandHandlerContext = ExtensionCommandContext & {
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

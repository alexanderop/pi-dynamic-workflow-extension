import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowsCommand } from "./commands/workflows-command.ts";
import {
  formatSyncDirectCommandsDiagnostics,
  SavedWorkflowCommandRegistry,
} from "./commands/saved-workflow-commands.ts";
import { registerWorkflowFeatureFlags } from "./features/register.ts";
import { registerSessionModelAvailability } from "./session-model-availability.ts";
import { registerWorkflowStatusline } from "./statusline/workflow-statusline.ts";
import { registerUltracode } from "./ultracode/register-ultracode.ts";

export default function dynamicWorkflowExtension(pi: ExtensionAPI): void {
  registerWorkflowFeatureFlags(pi);

  const savedCommandRegistry = new SavedWorkflowCommandRegistry(pi);
  savedCommandRegistry.registerGenericCommand();
  pi.on("session_start", async (_event, ctx) => {
    // Discovery/registration must never crash startup; surface failures as a
    // diagnostic instead of letting them escape the session_start handler.
    try {
      const result = await savedCommandRegistry.syncDirectCommands(ctx);
      const diagnostic = formatSyncDirectCommandsDiagnostics(result);
      if (diagnostic !== undefined && ctx.hasUI) {
        ctx.ui.notify(diagnostic, "warning");
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Could not register saved workflow commands: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
      }
    }
  });

  registerWorkflowsCommand(pi, { savedCommandRegistry });
  registerSessionModelAvailability(pi);
  registerWorkflowStatusline(pi);
  registerUltracode(pi);
}

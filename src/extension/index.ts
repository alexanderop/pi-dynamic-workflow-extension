import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowsCommand } from "./commands/workflows-command.ts";
import { SavedWorkflowCommandRegistry } from "./commands/saved-workflow-commands.ts";
import { registerWorkflowFeatureFlags } from "./features/register.ts";
import { registerSessionModelAvailability } from "./session-model-availability.ts";
import { registerWorkflowStatusline } from "./statusline/workflow-statusline.ts";
import { registerUltracode } from "./ultracode/register-ultracode.ts";

export default function dynamicWorkflowExtension(pi: ExtensionAPI): void {
  registerWorkflowFeatureFlags(pi);

  const savedCommandRegistry = new SavedWorkflowCommandRegistry(pi);
  savedCommandRegistry.registerGenericCommand();
  pi.on("session_start", async (_event, ctx) => {
    await savedCommandRegistry.syncDirectCommands(ctx);
  });

  registerWorkflowsCommand(pi, { savedCommandRegistry });
  registerSessionModelAvailability(pi);
  registerWorkflowStatusline(pi);
  registerUltracode(pi);
}

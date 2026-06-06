import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowsCommand } from "./commands/workflows-command.ts";
import { registerUltracode } from "./ultracode/register-ultracode.ts";

export default function dynamicWorkflowExtension(pi: ExtensionAPI): void {
  registerWorkflowsCommand(pi);
  registerUltracode(pi);
}

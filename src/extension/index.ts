import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function dynamicWorkflowExtension(pi: ExtensionAPI) {
  pi.registerCommand("workflows", {
    description: "Show dynamic workflow runs",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Dynamic workflows are not implemented yet. This package currently provides the scaffold.",
        "info",
      );
    },
  });
}

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** Invocation mode Pi runs a slash command under. */
export type WorkflowCommandMode = "tui" | "rpc" | "json" | "print";

export type WorkflowCommandOutputType = "info" | "error";

/** The command-context fields that command output emission reads. */
export type WorkflowCommandOutputContext = Pick<ExtensionCommandContext, "ui" | "hasUI"> & {
  readonly mode?: WorkflowCommandMode;
};

/** Resolve the effective output mode, defaulting to `tui` when a UI is present. */
export function resolveWorkflowCommandMode(ctx: {
  readonly mode?: WorkflowCommandMode;
  readonly hasUI: boolean;
}): WorkflowCommandMode {
  return ctx.mode ?? (ctx.hasUI ? "tui" : "print");
}

/**
 * Emit a workflow command result honoring the invocation mode: interactive
 * modes notify through the UI, `json` writes a `workflow_command_output`
 * envelope, and `print` writes the bare message. Errors go to stderr.
 */
export function emitWorkflowCommandOutput(
  ctx: WorkflowCommandOutputContext,
  command: string,
  message: string,
  type: WorkflowCommandOutputType,
): void {
  const mode = resolveWorkflowCommandMode(ctx);
  if (mode !== "json" && mode !== "print") {
    ctx.ui.notify(message, type);
    return;
  }

  const stream = type === "error" ? process.stderr : process.stdout;
  const line =
    mode === "json"
      ? `${JSON.stringify({ type: "workflow_command_output", command, severity: type, message })}\n`
      : `${message}\n`;
  stream.write(line);
}

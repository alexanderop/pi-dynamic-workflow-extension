import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  launchUltracodeWorkflow,
  type LaunchUltracodeWorkflowDependencies,
} from "./launch-ultracode-workflow.ts";
import { isEmptyUltracodeInput, parseUltracodeInput } from "./input-trigger.ts";
import { UltracodeEditor } from "./rainbow-editor.ts";

export interface RegisterUltracodeOptions {
  readonly launchDependencies?: LaunchUltracodeWorkflowDependencies;
}

export function registerUltracode(pi: ExtensionAPI, options: RegisterUltracodeOptions = {}): void {
  let activeEditor: UltracodeEditor | undefined;

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeEditor?.dispose?.();
      activeEditor = new UltracodeEditor(tui, theme, keybindings);
      return activeEditor;
    });
  });

  pi.on("session_shutdown", () => {
    activeEditor?.dispose?.();
    activeEditor = undefined;
  });

  pi.on(
    "input",
    async (event, ctx) =>
      await handleUltracodeInput(event, ctx, {
        sendMessage: (notification, deliveryOptions) =>
          pi.sendMessage(notification, deliveryOptions),
        launchDependencies: options.launchDependencies,
      }),
  );
}

interface HandleUltracodeInputOptions {
  readonly sendMessage?: Parameters<typeof launchUltracodeWorkflow>[1]["sendMessage"];
  readonly launchDependencies?: LaunchUltracodeWorkflowDependencies;
}

export async function handleUltracodeInput(
  event: InputEvent,
  ctx: ExtensionContext,
  options: HandleUltracodeInputOptions = {},
): Promise<InputEventResult> {
  if (event.source === "extension") return { action: "continue" };

  const trigger = parseUltracodeInput(event.text);
  if (trigger === undefined) {
    if (isEmptyUltracodeInput(event.text)) {
      ctx.ui.notify("Usage: ultracode <workflow goal>", "warning");
      return { action: "handled" };
    }

    return { action: "continue" };
  }

  const launch = await launchUltracodeWorkflow(
    trigger.goal,
    {
      cwd: ctx.cwd,
      sessionId: currentSessionId(ctx),
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
      sendMessage: options.sendMessage,
    },
    options.launchDependencies,
  );

  if (launch.status === "error") {
    ctx.ui.notify(`Could not launch ultracode workflow: ${launch.error.message}`, "error");
    return { action: "handled" };
  }

  ctx.ui.notify(launch.value.confirmation, "info");
  return { action: "handled" };
}

function currentSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

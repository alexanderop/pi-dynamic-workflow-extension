import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isUltracodeModeActive, transitionUltracodeMode } from "./mode-state-machine.ts";
import type { UltracodeModeState } from "./mode-state-machine.ts";
import {
  createUltracodeModeEntryData,
  restoreUltracodeModeFromEntries,
  ULTRACODE_MODE_CUSTOM_TYPE,
  type EntryLike,
  type UltracodeModeEntryData,
} from "./session-mode-store.ts";
import { isEmptyUltracodeInput, parseUltracodeInput } from "./input-trigger.ts";
import { UltracodeEditor } from "./rainbow-editor.ts";
import { registerWorkflowTool, WORKFLOW_TOOL_NAME } from "#src/extension/tools/workflow-tool.ts";
import { ultracodeBeforeAgentSystemPrompt, ultracodePolicyMessage } from "./system-reminder.ts";

export function registerUltracode(pi: ExtensionAPI): void {
  let activeEditor: UltracodeEditor | undefined;
  let mode: UltracodeModeState = { state: "off" };

  registerWorkflowTool(pi, {
    getTriggerSource: () => (isUltracodeModeActive(mode) ? "ultracode" : "manual"),
  });

  pi.on("session_start", (_event, ctx) => {
    mode = restoreUltracodeModeFromEntries(readSessionEntries(ctx));

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeEditor?.dispose?.();
      activeEditor = new UltracodeEditor(tui, theme, keybindings);
      return activeEditor;
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    activeEditor?.dispose?.();
    activeEditor = undefined;
    mode = transitionUltracodeMode(mode, { type: "session_shutdown" });
    ctx.ui.setWorkingMessage();
  });

  pi.on("input", async (event, ctx) =>
    handleUltracodeInput(event, ctx, {
      getMode: () => mode,
      setMode: (next) => {
        mode = next;
      },
      appendModeEntry: (next) => {
        pi.appendEntry<UltracodeModeEntryData>(
          ULTRACODE_MODE_CUSTOM_TYPE,
          createUltracodeModeEntryData(next),
        );
      },
    }),
  );

  pi.on("before_agent_start", (event, ctx) => {
    const result = handleUltracodeBeforeAgentStart(event, mode);
    if (result !== undefined) {
      ctx.ui.setWorkingMessage("Authoring and launching a Workflow…");
      mode = transitionUltracodeMode(mode, { type: "policy_injected" });
    }
    return result;
  });

  pi.on("agent_end", (_event, ctx) => {
    ctx.ui.setWorkingMessage();
  });

  pi.on("tool_call", (event) => handleUltracodeToolCall(event, mode));
}

export function handleUltracodeToolCall(
  event: ToolCallEvent,
  mode: UltracodeModeState,
): ToolCallEventResult | undefined {
  if (event.toolName !== WORKFLOW_TOOL_NAME) return undefined;
  if (isUltracodeModeActive(mode)) return undefined;

  return {
    block: true,
    reason:
      "Workflow is disabled outside ultracode because it can spawn many subagents and be expensive. Ask the user to type `ultracode <goal>` to opt into multi-agent orchestration, then retry.",
  };
}

interface HandleUltracodeInputOptions {
  readonly getMode?: () => UltracodeModeState;
  readonly setMode?: (mode: UltracodeModeState) => void;
  readonly appendModeEntry?: (mode: UltracodeModeState) => void;
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

  const current = options.getMode?.() ?? { state: "off" };
  const next = transitionUltracodeMode(current, {
    type: "valid_trigger",
    goal: trigger.goal,
    activatedBy: currentSessionId(ctx) ?? "current-session",
  });

  if (next.state === "disabled") {
    ctx.ui.notify(
      `ultracode is disabled${next.reason === undefined ? "" : `: ${next.reason}`}`,
      "warning",
    );
    return { action: "handled" };
  }

  options.setMode?.(next);
  options.appendModeEntry?.(next);
  ctx.ui.notify("ultracode is ON for this session", "info");
  return { action: "transform", text: trigger.goal };
}

export function handleUltracodeBeforeAgentStart(
  event: BeforeAgentStartEvent,
  mode: UltracodeModeState,
): BeforeAgentStartEventResult | undefined {
  if (!isUltracodeModeActive(mode)) return undefined;

  return {
    message: ultracodePolicyMessage(mode),
    systemPrompt: ultracodeBeforeAgentSystemPrompt(event.systemPrompt, mode),
  };
}

function currentSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function readSessionEntries(ctx: ExtensionContext): readonly EntryLike[] {
  try {
    return ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

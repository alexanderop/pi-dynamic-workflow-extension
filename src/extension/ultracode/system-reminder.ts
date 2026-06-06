import type { UltracodeModeState } from "./mode-state-machine.ts";
import { workflowAuthoringPrompt } from "./workflow-authoring-prompt.ts";

export const ULTRACODE_POLICY_CUSTOM_TYPE = "ultracode-policy";

export function ultracodeSystemReminder(mode: UltracodeModeState): string {
  const goal =
    mode.state === "arming" || mode.state === "on" ? `\nActivated by task: ${mode.goal}` : "";

  return `<system-reminder>
ultracode is ON for this Pi session.${goal}
For every substantive task, author and launch a dynamic workflow by calling the Workflow tool.
Trivial conversational turns and one-line mechanical edits may be handled solo.
Token cost is not a constraint; optimize for correctness.
Adversarially verify findings before relying on them.
</system-reminder>`;
}

export function ultracodeBeforeAgentSystemPrompt(
  currentSystemPrompt: string,
  mode: UltracodeModeState,
): string {
  return [
    currentSystemPrompt,
    "",
    ultracodeSystemReminder(mode),
    "",
    workflowAuthoringPrompt(
      "Use the current user task. If the task is substantive, design and launch an appropriate dynamic workflow. If it is trivial, handle it directly and briefly state why no workflow was needed.",
    ),
  ].join("\n");
}

export function ultracodePolicyMessage(mode: UltracodeModeState) {
  return {
    customType: ULTRACODE_POLICY_CUSTOM_TYPE,
    content: ultracodeSystemReminder(mode),
    display: false,
  };
}

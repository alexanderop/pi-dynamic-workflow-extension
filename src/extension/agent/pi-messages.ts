// Extracts the final assistant text from a Pi sidechain session's message
// list. Pure message-shape inspection; the session lifecycle lives in
// pi-runner.ts.

/** The message-bearing slice of a Pi agent session that text extraction reads. */
export interface PiWorkflowMessageSource {
  readonly messages?: readonly unknown[];
  readonly agent?: {
    readonly state?: {
      readonly messages?: readonly unknown[];
    };
  };
}

export function extractFinalAssistantText(session: PiWorkflowMessageSource): string {
  const messages = session.messages ?? session.agent?.state?.messages ?? [];
  const text = lastAssistantText(messages);
  if (text.length === 0) {
    throw new Error("Pi workflow subagent finished without a final assistant text response.");
  }
  return text;
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    return contentText(message.content).trim();
  }
  return "";
}

function isAssistantMessage(
  value: unknown,
): value is { readonly role: "assistant"; readonly content: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!isTextPart(part)) return "";
      return part.text;
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

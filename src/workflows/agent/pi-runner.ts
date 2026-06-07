import {
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveWorkflowModelHint } from "#src/workflows/model-routing/resolve.ts";
import {
  createWorkflowStructuredOutputToolBundle,
  WorkflowAgentSchemaError,
  type WorkflowStructuredOutputToolBundle,
} from "./structured-output-tool.ts";
import type {
  WorkflowAgentLiveEvent,
  WorkflowAgentRunRequest,
  WorkflowAgentRunner,
} from "./scheduler.ts";
import type { WorkflowAgentActivityState } from "./model.ts";

export interface PiWorkflowAgentSession {
  readonly messages?: readonly unknown[];
  readonly agent?: {
    readonly state?: {
      readonly messages?: readonly unknown[];
    };
  };
  prompt(
    text: string,
    options?: { readonly expandPromptTemplates?: boolean; readonly source?: "extension" },
  ): Promise<void>;
  subscribe?(listener: (event: unknown) => void): () => void;
  abort(): void | Promise<void>;
  dispose(): void;
}

export interface PiWorkflowAgentSessionFactoryResult {
  readonly session: PiWorkflowAgentSession;
}

export type PiWorkflowAgentSessionFactory = (
  options: CreateAgentSessionOptions,
) => Promise<PiWorkflowAgentSessionFactoryResult>;

export interface PiWorkflowAgentRunnerOptions {
  readonly cwd: string;
  readonly model?: CreateAgentSessionOptions["model"];
  readonly thinkingLevel?: string;
  readonly modelRegistry?: CreateAgentSessionOptions["modelRegistry"];
  readonly sessionFactory?: PiWorkflowAgentSessionFactory;
}

export function createPiWorkflowAgentRunner(
  options: PiWorkflowAgentRunnerOptions,
): WorkflowAgentRunner {
  return async (request) => await runPiWorkflowAgent(request, options);
}

async function runPiWorkflowAgent(
  request: WorkflowAgentRunRequest,
  options: PiWorkflowAgentRunnerOptions,
): Promise<unknown> {
  const structuredOutputBundle =
    request.options.schema === undefined
      ? undefined
      : createWorkflowStructuredOutputToolBundle(request.options.schema);

  const availableModels = options.modelRegistry?.getAll();
  const resolvedRouting = resolveWorkflowModelHint({
    requestedModel: request.options.model,
    requestedThinkingLevel: request.options.thinkingLevel,
    availableModels,
    currentModel: options.model,
    currentThinkingLevel: options.thinkingLevel,
  });
  request.onEvent?.({ type: "sidechain_starting", at: Date.now() });
  const { session } = await (options.sessionFactory ?? defaultSessionFactory)({
    cwd: options.cwd,
    model: resolvedRouting.model,
    thinkingLevel: resolvedRouting.thinkingLevel,
    modelRegistry: options.modelRegistry,
    sessionManager: SessionManager.inMemory(options.cwd),
    customTools:
      structuredOutputBundle === undefined ? undefined : [...structuredOutputBundle.tools],
  });
  const unsubscribe = session.subscribe?.((event) => {
    const liveEvent = piSessionEventToWorkflowLiveEvent(event);
    if (liveEvent !== undefined) request.onEvent?.(liveEvent);
  });
  const abort = () => {
    void session.abort();
  };

  if (request.signal.aborted) {
    abort();
    session.dispose();
    throw new Error(`Workflow agent '${request.agentId}' was aborted before it started.`);
  }

  request.signal.addEventListener("abort", abort, { once: true });
  try {
    await promptOrThrowIfAborted(
      session,
      buildPiSubagentPrompt(request, structuredOutputBundle?.toolSchema),
      request,
    );

    if (structuredOutputBundle !== undefined) {
      return await finishStructuredOutputAgent(session, request, structuredOutputBundle);
    }

    return extractFinalAssistantText(session);
  } finally {
    request.signal.removeEventListener("abort", abort);
    unsubscribe?.();
    session.dispose();
  }
}

async function defaultSessionFactory(
  options: CreateAgentSessionOptions,
): Promise<PiWorkflowAgentSessionFactoryResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true });
  await resourceLoader.reload();

  return (await createAgentSession({
    ...options,
    cwd,
    agentDir,
    resourceLoader,
  })) as PiWorkflowAgentSessionFactoryResult;
}

function buildPiSubagentPrompt(
  request: WorkflowAgentRunRequest,
  structuredOutputToolSchema?: unknown,
): string {
  const lines = [
    "You are a dynamic-workflow subagent running in an isolated Pi sidechain.",
    "Complete only the assigned task below and return the final result concisely.",
    "Do not mention that you are a subagent unless it is relevant to the result.",
    "",
    `Agent id: ${request.agentId}`,
    `Label: ${request.options.label ?? "agent"}`,
    request.options.phase === undefined ? undefined : `Phase: ${request.options.phase}`,
    request.options.agentType === undefined
      ? undefined
      : `Agent type: ${request.options.agentType}`,
    "",
    "Assigned task:",
    request.prompt,
    structuredOutputToolSchema === undefined
      ? undefined
      : structuredOutputInstructions(structuredOutputToolSchema),
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

const STRUCTURED_OUTPUT_NUDGE_LIMIT = 2;

async function finishStructuredOutputAgent(
  session: PiWorkflowAgentSession,
  request: WorkflowAgentRunRequest,
  bundle: WorkflowStructuredOutputToolBundle,
): Promise<unknown> {
  for (let nudgesSent = 0; nudgesSent <= STRUCTURED_OUTPUT_NUDGE_LIMIT; nudgesSent += 1) {
    const outcome = bundle.getOutcome();
    if (outcome.type === "finished") return outcome.value;
    if (outcome.type === "gave_up") {
      throw new WorkflowAgentSchemaError(`Pi workflow subagent called give_up: ${outcome.reason}`);
    }

    if (nudgesSent === STRUCTURED_OUTPUT_NUDGE_LIMIT) break;
    request.onEvent?.({
      type: "agent_event",
      at: Date.now(),
      eventType: "structured_output_retry",
      label: `structured output missing; nudge ${nudgesSent + 1}/${STRUCTURED_OUTPUT_NUDGE_LIMIT}`,
      activityState: "waiting_for_model",
    });
    await promptOrThrowIfAborted(session, buildStructuredOutputFollowUpPrompt(), request);
  }

  throw new WorkflowAgentSchemaError(
    `Pi workflow subagent finished without calling structured_output after ${STRUCTURED_OUTPUT_NUDGE_LIMIT} nudges.`,
  );
}

async function promptOrThrowIfAborted(
  session: PiWorkflowAgentSession,
  prompt: string,
  request: WorkflowAgentRunRequest,
): Promise<void> {
  if (request.signal.aborted) {
    throw new Error(`Workflow agent '${request.agentId}' was aborted.`);
  }
  await session.prompt(prompt, {
    expandPromptTemplates: false,
    source: "extension",
  });
  if (request.signal.aborted) {
    throw new Error(`Workflow agent '${request.agentId}' was aborted.`);
  }
}

export function buildStructuredOutputFollowUpPrompt(): string {
  return [
    "You ended your turn without calling `structured_output` or `give_up`.",
    "Either call `structured_output` with your final answer, or call `give_up` with a reason if you cannot produce valid structured output.",
    "Plain text does not count as a result.",
  ].join("\n");
}

function structuredOutputInstructions(schema: unknown): string {
  return [
    "",
    "Structured output is required.",
    "When the task is complete, call `structured_output` with your final answer as its arguments.",
    "The arguments are validated against the required schema; if validation fails you may receive an error and try again.",
    "If you cannot complete the task or cannot produce valid structured output, call `give_up` with a clear reason.",
    "Do not answer with prose instead of calling `structured_output`; plain text does not count.",
    "The `structured_output` arguments must satisfy this JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

const AGENT_EVENT_ACTIVITY: Record<
  string,
  { readonly label: string; readonly activityState: WorkflowAgentActivityState }
> = {
  agent_start: { label: "agent started", activityState: "starting" },
  turn_start: { label: "waiting for model", activityState: "waiting_for_model" },
  turn_end: { label: "turn completed", activityState: "finalizing" },
  agent_end: { label: "agent finished", activityState: "finalizing" },
};

function piSessionEventToWorkflowLiveEvent(event: unknown): WorkflowAgentLiveEvent | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  const at = Date.now();
  const agentActivity = AGENT_EVENT_ACTIVITY[event.type];
  if (agentActivity !== undefined) {
    return { type: "agent_event", at, eventType: event.type, ...agentActivity };
  }
  switch (event.type) {
    case "message_update":
      return { type: "message_update", at, summary: messageUpdateSummary(event) };
    case "tool_execution_start":
      return {
        type: "tool_start",
        at,
        toolCallId: stringField(event, "toolCallId") ?? "unknown",
        toolName: stringField(event, "toolName") ?? "tool",
        summary: summarizeUnknown(event.args),
      };
    case "tool_execution_update":
      return {
        type: "tool_update",
        at,
        toolCallId: stringField(event, "toolCallId") ?? "unknown",
        toolName: stringField(event, "toolName") ?? "tool",
        summary: summarizeUnknown(event.partialResult),
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        at,
        toolCallId: stringField(event, "toolCallId") ?? "unknown",
        toolName: stringField(event, "toolName") ?? "tool",
        summary: summarizeUnknown(event.result),
        isError: event.isError === true,
      };
    default:
      return undefined;
  }
}

function messageUpdateSummary(event: Record<string, unknown>): string | undefined {
  const assistantEvent = event.assistantMessageEvent;
  if (isRecord(assistantEvent)) {
    const text = stringField(assistantEvent, "text") ?? stringField(assistantEvent, "delta");
    if (text !== undefined) return truncateSummary(text);
    if (typeof assistantEvent.type === "string") return assistantEvent.type;
  }
  return undefined;
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncateSummary(value);
  try {
    return truncateSummary(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function truncateSummary(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}…`;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function extractFinalAssistantText(session: PiWorkflowAgentSession): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

import {
  createAgentSession,
  type CreateAgentSessionOptions,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createWorkflowStructuredOutputTool,
  WorkflowAgentSchemaError,
} from "./structured-output-tool.ts";
import type { WorkflowAgentRunRequest, WorkflowAgentRunner } from "./scheduler.ts";

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
  readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  readonly modelRegistry?: CreateAgentSessionOptions["modelRegistry"];
  readonly sessionFactory?: PiWorkflowAgentSessionFactory;
}

type PiModel = Model<Api>;
type PiModelRegistry = NonNullable<CreateAgentSessionOptions["modelRegistry"]>;

export function createPiWorkflowAgentRunner(
  options: PiWorkflowAgentRunnerOptions,
): WorkflowAgentRunner {
  return async (request) => await runPiWorkflowAgent(request, options);
}

async function runPiWorkflowAgent(
  request: WorkflowAgentRunRequest,
  options: PiWorkflowAgentRunnerOptions,
): Promise<unknown> {
  let structuredOutput: unknown;
  let hasStructuredOutput = false;
  const structuredOutputTool =
    request.options.schema === undefined
      ? undefined
      : createWorkflowStructuredOutputTool(request.options.schema, (value) => {
          structuredOutput = value;
          hasStructuredOutput = true;
        });

  const { session } = await (options.sessionFactory ?? defaultSessionFactory)({
    cwd: options.cwd,
    model: resolveRequestedModel(request.options.model, options.model, options.modelRegistry),
    thinkingLevel: request.options.thinkingLevel ?? options.thinkingLevel,
    modelRegistry: options.modelRegistry,
    sessionManager: SessionManager.inMemory(options.cwd),
    customTools: structuredOutputTool === undefined ? undefined : [structuredOutputTool],
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
    await session.prompt(buildPiSubagentPrompt(request), {
      expandPromptTemplates: false,
      source: "extension",
    });

    if (request.signal.aborted) {
      throw new Error(`Workflow agent '${request.agentId}' was aborted.`);
    }

    if (request.options.schema !== undefined) {
      if (!hasStructuredOutput) {
        throw new WorkflowAgentSchemaError(
          "Pi workflow subagent finished without calling structured_output.",
        );
      }
      return structuredOutput;
    }

    return extractFinalAssistantText(session);
  } finally {
    request.signal.removeEventListener("abort", abort);
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

function resolveRequestedModel(
  requestedModel: string | undefined,
  fallbackModel: PiModel | undefined,
  modelRegistry: PiModelRegistry | undefined,
): PiModel | undefined {
  if (requestedModel === undefined || isDefaultModelPlaceholder(requestedModel))
    return fallbackModel;

  if (
    fallbackModel !== undefined &&
    (modelReferencesEqual(requestedModel, `${fallbackModel.provider}/${fallbackModel.id}`) ||
      modelReferencesEqual(requestedModel, fallbackModel.id))
  ) {
    return fallbackModel;
  }

  if (modelRegistry === undefined) {
    throw new Error(
      `Workflow agent requested model '${requestedModel}', but no Pi model registry is available to resolve it.`,
    );
  }

  const models = modelRegistry.getAll();
  const canonicalMatch = models.find((model) =>
    modelReferencesEqual(requestedModel, `${model.provider}/${model.id}`),
  );
  if (canonicalMatch !== undefined) return canonicalMatch;

  const idMatches = models.filter((model) => modelReferencesEqual(requestedModel, model.id));
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) {
    throw new Error(
      `Workflow agent requested ambiguous model '${requestedModel}'. Use provider/model-id.`,
    );
  }

  throw new Error(
    `Workflow agent requested unknown model '${requestedModel}'. Use provider/model-id or a unique model id.`,
  );
}

function modelReferencesEqual(left: string | undefined, right: string | undefined): boolean {
  return left?.trim().toLowerCase() === right?.trim().toLowerCase();
}

function isDefaultModelPlaceholder(model: string): boolean {
  return model.trim().toLowerCase() === "default";
}

function buildPiSubagentPrompt(request: WorkflowAgentRunRequest): string {
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
    request.options.schema === undefined
      ? undefined
      : structuredOutputInstructions(request.options.schema),
    "",
    "Assigned task:",
    request.prompt,
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function structuredOutputInstructions(schema: unknown): string {
  return [
    "",
    "Structured output is required.",
    "When you finish the assigned task, call the structured_output tool as your final action.",
    "Do not answer with prose instead of calling structured_output.",
    "The structured_output arguments must satisfy this JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n");
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

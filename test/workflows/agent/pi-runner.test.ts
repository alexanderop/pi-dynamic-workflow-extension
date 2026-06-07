import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  createPiWorkflowAgentRunner,
  type PiWorkflowAgentSession,
  type PiWorkflowAgentSessionFactory,
} from "#src/workflows/agent/pi-runner.ts";
import type { WorkflowAgentRunRequest } from "#src/workflows/agent/scheduler.ts";

class FakePiSession implements PiWorkflowAgentSession {
  readonly messages: unknown[] = [];
  readonly prompt = vi.fn<(text: string, options?: unknown) => Promise<void>>(async (text) => {
    this.promptText = text;
    await this.onPrompt?.(text);
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "subagent result" }] });
  });
  readonly abort = vi.fn<() => void>();
  readonly dispose = vi.fn<() => void>();
  promptText = "";

  constructor(private readonly onPrompt?: (text: string) => Promise<void> | void) {}
}

describe("createPiWorkflowAgentRunner", () => {
  it("should run a Pi sidechain session and return the final assistant text", async () => {
    const session = new FakePiSession();
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    const result = await runner(requestForTest({ prompt: "inspect src" }));

    expect(result).toBe("subagent result");
    expect(sessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        sessionManager: expect.any(Object),
      }),
    );
    expect(session.promptText).toContain("Assigned task:\ninspect src");
    expect(session.prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ expandPromptTemplates: false, source: "extension" }),
    );
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("should pass the requested workflow agent model into the Pi session", async () => {
    const session = new FakePiSession();
    const contextModel = modelForTest("anthropic", "claude-sonnet-4-6");
    const requestedModel = modelForTest("anthropic", "claude-opus-4-8");
    const modelRegistry = {
      getAll: () => [contextModel, requestedModel],
    } as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      model: contextModel,
      modelRegistry,
      sessionFactory,
    });

    await runner(
      requestForTest({ options: { label: "test-agent", model: "anthropic/claude-opus-4-8" } }),
    );

    expect(sessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: requestedModel,
        modelRegistry,
      }),
    );
  });

  it("should treat the scheduler default model placeholder as the current Pi model", async () => {
    const session = new FakePiSession();
    const contextModel = modelForTest("anthropic", "claude-sonnet-4-6");
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      model: contextModel,
      sessionFactory,
    });

    await runner(requestForTest({ options: { label: "test-agent", model: "default" } }));

    expect(sessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: contextModel,
      }),
    );
  });

  it("should fall back to the current Pi model when the requested workflow model is unknown", async () => {
    const session = new FakePiSession();
    const contextModel = modelForTest("openai-codex", "gpt-5.5");
    const modelRegistry = {
      getAll: () => [contextModel],
    } as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      model: contextModel,
      modelRegistry,
      sessionFactory,
    });

    await expect(
      runner(
        requestForTest({
          options: { label: "test-agent", model: "openai-codex/gpt-5.55" },
        }),
      ),
    ).resolves.toBe("subagent result");

    expect(sessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        model: contextModel,
        modelRegistry,
      }),
    );
  });

  it("should fall back to the current Pi model when a short model id is ambiguous", async () => {
    const session = new FakePiSession();
    const contextModel = modelForTest("openai-codex", "gpt-5.5");
    const first = modelForTest("provider-a", "same-id");
    const second = modelForTest("provider-b", "same-id");
    const modelRegistry = {
      getAll: () => [contextModel, first, second],
    } as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      model: contextModel,
      modelRegistry,
      sessionFactory,
    });

    await expect(
      runner(requestForTest({ options: { label: "test-agent", model: "same-id" } })),
    ).resolves.toBe("subagent result");

    expect(sessionFactory).toHaveBeenCalledWith(expect.objectContaining({ model: contextModel }));
  });

  it("should fall back to the current thinking level when the requested thinking level is invalid", async () => {
    const session = new FakePiSession();
    const contextModel = modelForTest("openai-codex", "gpt-5.5");
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      model: contextModel,
      thinkingLevel: "high",
      sessionFactory,
    });

    await runner(
      requestForTest({
        options: { label: "test-agent", thinkingLevel: "hihg" },
      }),
    );

    expect(sessionFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        thinkingLevel: "high",
      }),
    );
  });

  it("should abort and dispose the Pi sidechain session when the workflow agent is cancelled", async () => {
    const session = new FakePiSession();
    session.prompt.mockImplementationOnce(
      async () => await new Promise((resolve) => setTimeout(resolve, 10)),
    );
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });
    const controller = new AbortController();

    const running = runner(requestForTest({ signal: controller.signal }));
    controller.abort();

    await expect(running).rejects.toThrow("aborted");
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("should return captured structured output when the Pi subagent calls structured_output", async () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string" }, items: { type: "array" } },
      required: ["source", "items"],
    };
    let sessionOptions: CreateAgentSessionOptions | undefined;
    const structuredResult = { source: "vue-blog", items: [{ title: "Vue 3.5" }] };
    const session = new FakePiSession(async () => {
      const tool = sessionOptions?.customTools?.[0];
      if (tool === undefined) throw new Error("structured_output tool was not registered");
      await tool.execute("tool_1", structuredResult as never, undefined, undefined, {} as never);
    });
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async (options) => {
      sessionOptions = options;
      return { session };
    });
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    const result = await runner(
      requestForTest({
        options: { label: "structured", phase: "Research", schema },
      }),
    );

    expect(result).toEqual(structuredResult);
    expect(sessionOptions?.customTools).toHaveLength(1);
    expect(sessionOptions?.customTools?.[0]).toMatchObject({
      name: "structured_output",
      parameters: schema,
    });
    expect(session.promptText).toContain("Structured output is required.");
    expect(session.promptText).toContain(JSON.stringify(schema, null, 2));
  });

  it("should fail schema agents when the Pi subagent finishes without structured_output", async () => {
    const session = new FakePiSession();
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    await expect(
      runner(
        requestForTest({
          options: { label: "structured", schema: { type: "object" } },
        }),
      ),
    ).rejects.toMatchObject({ variant: "schema" });
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

function requestForTest(overrides: Partial<WorkflowAgentRunRequest> = {}): WorkflowAgentRunRequest {
  return {
    agentId: "agent_1",
    prompt: "do work",
    options: { label: "test-agent", phase: "Test" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function modelForTest(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

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

describe("createPiWorkflowAgentRunner model resolution", () => {
  it("should reuse the context model when the requested model matches its bare id", async () => {
    const session = new FakePiSession();
    const contextModel = modelForTest("anthropic", "claude-opus-4-8");
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      model: contextModel,
      sessionFactory,
    });

    await runner(
      requestForTest({ options: { label: "a", model: "claude-opus-4-8", agentType: "explorer" } }),
    );

    expect(sessionFactory).toHaveBeenCalledWith(expect.objectContaining({ model: contextModel }));
    expect(session.promptText).toContain("Agent type: explorer");
  });

  it("should throw when a model is requested but no registry is available to resolve it", async () => {
    const session = new FakePiSession();
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    await expect(
      runner(requestForTest({ options: { label: "a", model: "anthropic/some-model" } })),
    ).rejects.toThrow(/no Pi model registry is available/);
  });

  it("should resolve a requested model by its unique bare id through the registry", async () => {
    const session = new FakePiSession();
    const wanted = modelForTest("anthropic", "claude-haiku");
    const modelRegistry = {
      getAll: () => [modelForTest("openai", "gpt"), wanted],
    } as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", modelRegistry, sessionFactory });

    await runner(requestForTest({ options: { label: "a", model: "claude-haiku" } }));

    expect(sessionFactory).toHaveBeenCalledWith(expect.objectContaining({ model: wanted }));
  });

  it("should throw when a requested bare id is ambiguous across providers", async () => {
    const session = new FakePiSession();
    const modelRegistry = {
      getAll: () => [modelForTest("anthropic", "shared"), modelForTest("openai", "shared")],
    } as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", modelRegistry, sessionFactory });

    await expect(
      runner(requestForTest({ options: { label: "a", model: "shared" } })),
    ).rejects.toThrow(/ambiguous model/);
  });

  it("should throw when a requested model matches nothing in the registry", async () => {
    const session = new FakePiSession();
    const modelRegistry = {
      getAll: () => [modelForTest("anthropic", "known")],
    } as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", modelRegistry, sessionFactory });

    await expect(
      runner(requestForTest({ options: { label: "a", model: "anthropic/unknown" } })),
    ).rejects.toThrow(/unknown model/);
  });
});

describe("createPiWorkflowAgentRunner final-text extraction", () => {
  function sessionWith(messages: unknown[]): PiWorkflowAgentSession {
    return {
      messages,
      prompt: vi.fn<(...args: any[]) => any>(async () => undefined),
      abort: vi.fn<(...args: any[]) => any>(),
      dispose: vi.fn<(...args: any[]) => any>(),
    };
  }

  it("should join multiple text parts and skip non-text parts in the final message", async () => {
    const session = sessionWith([
      { role: "user", content: "ignored" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "line one" },
          { type: "image", url: "x" },
          { type: "text", text: "line two" },
        ],
      },
    ]);
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    const result = await runner(requestForTest());

    expect(result).toBe("line one\nline two");
  });

  it("should accept plain string assistant content as the final text", async () => {
    const session = sessionWith([{ role: "assistant", content: "string content" }]);
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    expect(await runner(requestForTest())).toBe("string content");
  });

  it("should fall back to agent state messages when the session has none", async () => {
    const session: PiWorkflowAgentSession = {
      agent: { state: { messages: [{ role: "assistant", content: "from agent state" }] } },
      prompt: vi.fn<(...args: any[]) => any>(async () => undefined),
      abort: vi.fn<(...args: any[]) => any>(),
      dispose: vi.fn<(...args: any[]) => any>(),
    };
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    expect(await runner(requestForTest())).toBe("from agent state");
  });

  it("should default to an empty message list when neither messages nor agent state exist", async () => {
    const session: PiWorkflowAgentSession = {
      prompt: vi.fn<(...args: any[]) => any>(async () => undefined),
      abort: vi.fn<(...args: any[]) => any>(),
      dispose: vi.fn<(...args: any[]) => any>(),
    };
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    await expect(runner(requestForTest())).rejects.toThrow(/without a final assistant text/);
  });

  it("should treat non-array, non-string assistant content as empty and fail extraction", async () => {
    const session = sessionWith([{ role: "assistant", content: { unexpected: true } }]);
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    await expect(runner(requestForTest())).rejects.toThrow(/without a final assistant text/);
  });

  it("should ignore non-assistant trailing messages when extracting final text", async () => {
    const session = sessionWith([
      { role: "assistant", content: "earlier" },
      { role: "tool", content: "tool output" },
    ]);
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    expect(await runner(requestForTest())).toBe("earlier");
  });
});

describe("createPiWorkflowAgentRunner abort handling", () => {
  it("should reject before starting when the signal is already aborted", async () => {
    const session = new FakePiSession();
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(runner(requestForTest({ signal: controller.signal }))).rejects.toThrow(
      /aborted before it started/,
    );
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("should reject after the prompt resolves when the signal aborted mid-run", async () => {
    const controller = new AbortController();
    const session = new FakePiSession(() => {
      controller.abort();
    });
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    await expect(runner(requestForTest({ signal: controller.signal }))).rejects.toThrow(
      /'agent_1' was aborted\.$/,
    );
  });

  it("should omit phase and agent-type lines from the prompt when they are unset", async () => {
    const session = new FakePiSession();
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: async () => ({ session }),
    });

    await runner({
      agentId: "agent_1",
      prompt: "bare task",
      options: {},
      signal: new AbortController().signal,
    });

    expect(session.promptText).not.toContain("Phase:");
    expect(session.promptText).not.toContain("Agent type:");
    expect(session.promptText).toContain("Label: agent");
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

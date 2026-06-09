import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  buildStructuredOutputFollowUpPrompt,
  createPiWorkflowAgentRunner,
  type PiWorkflowAgentSessionFactory,
} from "#src/extension/agent/pi-runner.ts";
import type { WorkflowAgentRunRequest } from "#src/workflows/agent/scheduler.ts";
import { FakePiSession } from "../../suite/fake-pi-session.ts";

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

  it("should reject without prompting when the signal is already aborted", async () => {
    const session = new FakePiSession();
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });
    const controller = new AbortController();
    controller.abort();

    await expect(runner(requestForTest({ signal: controller.signal }))).rejects.toThrow(
      "was aborted before it started",
    );
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("should reject when the Pi subagent finishes without a final assistant text response", async () => {
    const session = new FakePiSession();
    // Suppress the default assistant message so no final text is produced.
    session.prompt.mockImplementationOnce(async () => undefined);
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    await expect(runner(requestForTest())).rejects.toThrow(
      "finished without a final assistant text response",
    );
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("should translate Pi AgentSession events into compact workflow live events", async () => {
    const session = new FakePiSession(() => {
      session.emit({ type: "turn_start" });
      session.emit({
        type: "tool_execution_start",
        toolCallId: "tool_1",
        toolName: "read",
        args: { path: "src/index.ts" },
      });
      session.emit({
        type: "tool_execution_end",
        toolCallId: "tool_1",
        toolName: "read",
        result: "ok",
        isError: false,
      });
      session.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "working" },
      });
    });
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });
    const onEvent = vi.fn<NonNullable<WorkflowAgentRunRequest["onEvent"]>>();

    await runner(requestForTest({ onEvent }));

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "sidechain_starting" }));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "agent_event", eventType: "turn_start" }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_start", toolCallId: "tool_1", toolName: "read" }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool_end", toolCallId: "tool_1", toolName: "read" }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "message_update", summary: "working" }),
    );
    expect(session.unsubscribes).toHaveLength(1);
    expect(session.unsubscribes[0]).toHaveBeenCalledOnce();
    expect(session.listenerCount).toBe(0);
  });

  it("should remove only its own listener when a subscription is unsubscribed", () => {
    const session = new FakePiSession();
    const first = vi.fn<(event: unknown) => void>();
    const second = vi.fn<(event: unknown) => void>();

    const unsubscribeFirst = session.subscribe(first);
    session.subscribe(second);
    expect(session.listenerCount).toBe(2);

    unsubscribeFirst();
    session.emit({ type: "turn_start" });

    expect(session.listenerCount).toBe(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ type: "turn_start" });
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
    expect(sessionOptions?.customTools).toHaveLength(2);
    expect(sessionOptions?.customTools?.[0]).toMatchObject({
      name: "structured_output",
      parameters: schema,
    });
    expect(sessionOptions?.customTools?.[1]).toMatchObject({ name: "give_up" });
    expect(session.promptText).toContain("Assigned task:\ndo work");
    expect(session.promptText).toContain("Structured output is required.");
    expect(session.promptText).toContain(JSON.stringify(schema, null, 2));
    expect(session.promptText.indexOf("Assigned task:")).toBeLessThan(
      session.promptText.indexOf("Structured output is required."),
    );
  });

  it("should nudge once when structured output is missing and then return the captured result", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    let sessionOptions: CreateAgentSessionOptions | undefined;
    const session = new FakePiSession(async (_text, _options, callIndex) => {
      if (callIndex !== 1) return;
      const structuredOutput = sessionOptions?.customTools?.find(
        (tool) => tool.name === "structured_output",
      );
      if (structuredOutput === undefined) throw new Error("structured_output missing");
      await structuredOutput.execute(
        "tool_1",
        { ok: true } as never,
        undefined,
        undefined,
        {} as never,
      );
    });
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async (options) => {
      sessionOptions = options;
      return { session };
    });
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });
    const onEvent = vi.fn<NonNullable<WorkflowAgentRunRequest["onEvent"]>>();

    await expect(
      runner(requestForTest({ options: { label: "structured", schema }, onEvent })),
    ).resolves.toEqual({ ok: true });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.promptTexts[1]).toBe(buildStructuredOutputFollowUpPrompt());
    expect(session.promptOptions[1]).toEqual({ expandPromptTemplates: false, source: "extension" });
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_event",
        eventType: "structured_output_retry",
        label: "structured output missing; nudge 1/2",
        activityState: "waiting_for_model",
      }),
    );
  });

  it("should send two nudges before failing missing structured output", async () => {
    const session = new FakePiSession();
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });
    const onEvent = vi.fn<NonNullable<WorkflowAgentRunRequest["onEvent"]>>();

    await expect(
      runner(
        requestForTest({
          options: { label: "structured", schema: { type: "object" } },
          onEvent,
        }),
      ),
    ).rejects.toMatchObject({
      variant: "schema",
      message: "Pi workflow subagent finished without calling structured_output after 2 nudges.",
    });

    expect(session.prompt).toHaveBeenCalledTimes(3);
    expect(session.promptTexts.slice(1)).toEqual([
      buildStructuredOutputFollowUpPrompt(),
      buildStructuredOutputFollowUpPrompt(),
    ]);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "structured_output_retry",
        label: "structured output missing; nudge 1/2",
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "structured_output_retry",
        label: "structured output missing; nudge 2/2",
      }),
    );
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("should fail schema agents when the Pi subagent calls give_up", async () => {
    let sessionOptions: CreateAgentSessionOptions | undefined;
    const session = new FakePiSession(async () => {
      const giveUp = sessionOptions?.customTools?.find((tool) => tool.name === "give_up");
      if (giveUp === undefined) throw new Error("give_up missing");
      await giveUp.execute(
        "tool_1",
        { reason: "not enough evidence" } as never,
        undefined,
        undefined,
        {} as never,
      );
    });
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async (options) => {
      sessionOptions = options;
      return { session };
    });
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    await expect(
      runner(
        requestForTest({
          options: { label: "structured", schema: { type: "object" } },
        }),
      ),
    ).rejects.toMatchObject({
      variant: "schema",
      message: "Pi workflow subagent called give_up: not enough evidence",
    });
  });

  it("should unwrap structured output envelopes for non-object schemas", async () => {
    const schema = { type: "array", items: { type: "string" } };
    let sessionOptions: CreateAgentSessionOptions | undefined;
    const session = new FakePiSession(async () => {
      const tool = sessionOptions?.customTools?.[0];
      if (tool === undefined) throw new Error("structured_output tool was not registered");
      await tool.execute(
        "tool_1",
        { result: ["alpha", "beta"] } as never,
        undefined,
        undefined,
        {} as never,
      );
    });
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async (options) => {
      sessionOptions = options;
      return { session };
    });
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    await expect(
      runner(requestForTest({ options: { label: "structured", schema } })),
    ).resolves.toEqual(["alpha", "beta"]);
    const envelopeSchema = {
      type: "object",
      additionalProperties: false,
      properties: { result: schema },
      required: ["result"],
    };
    expect(sessionOptions?.customTools?.[0]?.parameters).toEqual(envelopeSchema);
    expect(session.promptText).toContain(JSON.stringify(envelopeSchema, null, 2));
  });

  it("should abort and dispose once during a structured-output retry", async () => {
    const session = new FakePiSession();
    const controller = new AbortController();
    session.prompt.mockImplementation(async (_text, _options) => {
      if (session.prompt.mock.calls.length === 2) {
        controller.abort();
      }
    });
    const sessionFactory = vi.fn<PiWorkflowAgentSessionFactory>(async () => ({ session }));
    const runner = createPiWorkflowAgentRunner({ cwd: "/repo", sessionFactory });

    await expect(
      runner(
        requestForTest({
          signal: controller.signal,
          options: { label: "structured", schema: { type: "object" } },
        }),
      ),
    ).rejects.toThrow("aborted");

    expect(session.abort).toHaveBeenCalledOnce();
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

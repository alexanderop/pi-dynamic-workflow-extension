import { describe, expect, it, vi } from "vitest";
import { deferred, delay } from "../../support.ts";
import {
  AgentMockError,
  AgentResponse,
  agent,
  setupAgentMock,
  setupAgentServer,
  setupAgentTestServer,
  setupDefaultAgentTestServer,
  type AgentMockCall,
  type AgentMockUnhandledPrint,
} from "./agent-mock.ts";

const sharedAgents = setupDefaultAgentTestServer(
  agent.label("global-scan").replyText("global scan default"),
);

const strictSharedAgents = setupAgentTestServer(
  agent.label("strict-scan").replyText("strict scan default"),
);

describe("setupAgentMock", () => {
  it("should return handler responses for matching agent calls", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "scan src", label: "scan-agent" }, ({ prompt }) => {
        return AgentResponse.json({ summary: `handled:${prompt}` });
      }),
    );

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toEqual({
      summary: "handled:scan src",
    });
    agents.expectNoUnhandledAgents();
    expect(agents.calls()).toMatchObject([
      { prompt: "scan src", options: { label: "scan-agent" }, handled: true },
    ]);
  });

  it("should fail clearly when an agent call is unhandled by default", async () => {
    const agents = setupAgentMock();

    await expect(agents.runner("scan src", { label: "scan-agent" })).rejects.toThrow(
      /Unhandled agent call: agent\("scan src" label="scan-agent"\)/,
    );
    expect(() => agents.expectNoUnhandledAgents()).toThrow(/Expected no unhandled agent calls/);
  });

  it("should let runtime handlers override initial handlers", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "scan-agent" }, () => AgentResponse.text("initial")),
    );

    agents.use(agent.call({ label: "scan-agent" }, () => AgentResponse.text("override")));

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("override");
  });

  it("should reject arrays of handlers with a spread hint", () => {
    const handler = agent.any(() => AgentResponse.text("ok"));

    expect(() => setupAgentMock([handler] as never)).toThrow(/forget to spread/);

    const agents = setupAgentMock();
    expect(() => agents.use([handler] as never)).toThrow(/forget to spread/);
    expect(() => agents.resetHandlers([handler] as never)).toThrow(/forget to spread/);
  });

  it("should reset handlers and recorded calls", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "scan-agent" }, () => AgentResponse.text("initial")),
    );
    agents.use(agent.call({ label: "scan-agent" }, () => AgentResponse.text("override")));

    await agents.runner("scan src", { label: "scan-agent" });
    agents.resetHandlers();

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("initial");
    expect(agents.calls()).toHaveLength(1);
  });

  it("should support one-time handlers and restore them", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "scan-agent" }, () => AgentResponse.text("once"), { once: true }),
      agent.call({ label: "scan-agent" }, () => AgentResponse.text("fallback")),
    );

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("once");
    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("fallback");

    agents.restoreHandlers();

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("once");
  });

  it("should consume one-time handlers before async resolver completion", async () => {
    const agents = setupAgentMock(
      agent.call(
        { label: "scan-agent" },
        async () => {
          await delay(5);
          return AgentResponse.text("once");
        },
        { once: true },
      ),
      agent.call({ label: "scan-agent" }, () => AgentResponse.text("fallback")),
    );

    await expect(
      Promise.all([
        agents.runner("scan src", { label: "scan-agent" }),
        agents.runner("scan src", { label: "scan-agent" }),
      ]),
    ).resolves.toEqual(["once", "fallback"]);
    agents.expectAgentCalledTimes({ label: "scan-agent" }, 2);
  });

  it("should support sequential responses from generator resolvers", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "poll-agent" }, function* () {
        yield AgentResponse.text("pending");
        yield AgentResponse.text("still pending");
        return AgentResponse.text("done");
      }),
    );

    await expect(agents.runner("poll", { label: "poll-agent" })).resolves.toBe("pending");
    await expect(agents.runner("poll", { label: "poll-agent" })).resolves.toBe("still pending");
    await expect(agents.runner("poll", { label: "poll-agent" })).resolves.toBe("done");
    await expect(agents.runner("poll", { label: "poll-agent" })).resolves.toBe("done");
  });

  it("should match calls with regex and predicate matchers", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: /^scan/, model: (value) => value === "opus" }, () =>
        AgentResponse.text("matched"),
      ),
    );

    await expect(agents.runner("scan src", { model: "opus" })).resolves.toBe("matched");
    await expect(agents.runner("build src", { model: "opus" })).rejects.toThrow(/Unhandled/);
    await expect(agents.runner("scan src", { model: "sonnet" })).rejects.toThrow(/Unhandled/);
  });

  it("should match schema regardless of key order", async () => {
    const agents = setupAgentMock(
      agent.call({ schema: { type: "object", required: ["id"] } }, () =>
        AgentResponse.json({ id: "schema-matched" }),
      ),
    );

    await expect(
      agents.runner("scan src", { schema: { required: ["id"], type: "object" } }),
    ).resolves.toEqual({ id: "schema-matched" });
  });

  it("should support sequential responses from async generator resolvers", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "poll-agent" }, async function* () {
        await delay(1);
        yield AgentResponse.text("pending");
        return AgentResponse.text("done");
      }),
    );

    await expect(agents.runner("poll", { label: "poll-agent" })).resolves.toBe("pending");
    await expect(agents.runner("poll", { label: "poll-agent" })).resolves.toBe("done");
  });

  it("should throw when a resolver returns an error response", async () => {
    const agents = setupAgentMock(agent.any(() => AgentResponse.error("agent exploded")));

    await expect(agents.runner("scan src")).rejects.toThrow(/agent exploded/);
  });

  it("should warn and echo the prompt for unhandled calls when configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agents = setupAgentMock({ onUnhandledAgent: "warn" });

    await expect(agents.runner("scan src")).resolves.toBe("scan src");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Unhandled agent call/));
    warn.mockRestore();
  });

  it("should bypass unhandled calls by echoing the prompt without warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agents = setupAgentMock({ onUnhandledAgent: "bypass" });

    await expect(agents.runner("scan src")).resolves.toBe("scan src");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should support custom unhandled-agent callbacks", async () => {
    const onUnhandledAgent = vi.fn<(call: AgentMockCall, print: AgentMockUnhandledPrint) => string>(
      (call) => {
        return AgentResponse.text(`custom:${call.prompt}`);
      },
    );
    const agents = setupAgentMock({ onUnhandledAgent });

    await expect(agents.runner("scan src")).resolves.toBe("custom:scan src");
    expect(onUnhandledAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "scan src", handled: false }),
      expect.objectContaining({
        warning: expect.any(Function),
        error: expect.any(Function),
        bypass: expect.any(Function),
      }),
    );
  });

  it("should print registered handlers for debugging", () => {
    const agents = setupAgentMock(
      agent.call({ label: "scan-agent" }, () => AgentResponse.text("ok")),
      agent.call({ phase: "Verify" }, () => AgentResponse.text("ok")),
    );

    expect(agents.printHandlers()).toContain('label: "scan-agent"');
    expect(agents.printHandlers()).toContain('phase: "Verify"');
  });

  it("should fail when expectNoAgents finds recorded calls", async () => {
    const agents = setupAgentMock(agent.any(() => AgentResponse.text("ok")));

    await agents.runner("scan src");

    expect(() => agents.expectNoAgents()).toThrow(/Expected no agent calls, but found 1/);
  });

  it("should replace handlers when resetHandlers receives new handlers", async () => {
    const agents = setupAgentMock(agent.any(() => AgentResponse.text("initial")));

    agents.resetHandlers(agent.any(() => AgentResponse.text("replaced")));

    await expect(agents.runner("scan src")).resolves.toBe("replaced");
    agents.resetHandlers();
    await expect(agents.runner("scan src")).resolves.toBe("replaced");
  });

  it("should snapshot recorded call options", async () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const agents = setupAgentMock(agent.any(() => AgentResponse.json({ summary: "ok" })));

    await agents.runner("scan src", { schema });
    schema.properties.summary.type = "number";

    expect(agents.calls()).toMatchObject([
      {
        options: {
          schema: { type: "object", properties: { summary: { type: "string" } } },
        },
      },
    ]);
  });

  it("should validate JSON responses against the requested schema subset", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "structured" }, () => {
        return AgentResponse.json({ summary: "ok", count: 1, tags: ["stable"] });
      }),
    );

    await expect(
      agents.runner("scan src", {
        label: "structured",
        schema: {
          type: "object",
          required: ["summary", "count", "tags"],
          properties: {
            summary: { type: "string" },
            count: { type: "integer" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      }),
    ).resolves.toEqual({ summary: "ok", count: 1, tags: ["stable"] });
  });

  it("should fail when JSON responses do not satisfy the requested schema subset", async () => {
    const agents = setupAgentMock(
      agent.call({ label: "structured" }, () => {
        return AgentResponse.json({ count: "one" });
      }),
    );

    await expect(
      agents.runner("scan src", {
        label: "structured",
        schema: {
          type: "object",
          required: ["summary", "count"],
          properties: {
            summary: { type: "string" },
            count: { type: "integer" },
          },
        },
      }),
    ).rejects.toThrow(/does not satisfy agent schema/);
    expect(agents.events().map((event) => event.type)).toEqual([
      "agent:start",
      "agent:match",
      "agent:error",
      "agent:end",
    ]);
  });

  it("should let tests control when a pending agent resolves", async () => {
    const scan = agent.pending({ label: "scan-agent" });
    const agents = setupAgentMock(scan);

    const inflight = agents.runner("scan src", { label: "scan-agent" });
    let settled = false;
    void inflight.then(() => {
      settled = true;
      return undefined;
    });

    await scan.waitUntilStarted();
    expect(scan.started).toBe(true);
    expect(scan.prompt).toBe("scan src");
    expect(settled).toBe(false);

    scan.resolve(AgentResponse.text("done"));
    await expect(inflight).resolves.toBe("done");
  });

  it("should reject the in-flight call when a pending agent fails", async () => {
    const scan = agent.pending();
    const agents = setupAgentMock(scan);

    const inflight = agents.runner("scan src");
    await scan.waitUntilStarted();
    scan.reject("boom");

    await expect(inflight).rejects.toThrow(/boom/);
  });

  it("should apply a preset resolution when resolved before the agent is called", async () => {
    const scan = agent.pending({ label: "scan-agent" });
    const agents = setupAgentMock(scan);

    scan.resolve(AgentResponse.text("preset"));

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("preset");
    expect(scan.callCount).toBe(1);
  });

  it("should expose abort signals through the scheduler runner", async () => {
    const aborted = vi.fn<() => void>();
    const agents = setupAgentMock(
      agent.any(async ({ signal }) => {
        signal?.addEventListener("abort", aborted, { once: true });
        await delay(1);
        return AgentResponse.text("ok");
      }),
    );
    const controller = new AbortController();

    const result = agents.schedulerRunner({
      prompt: "scan src",
      options: {},
      agentId: "agent_0",
      signal: controller.signal,
    });
    controller.abort();

    await expect(result).resolves.toBe("ok");
    expect(aborted).toHaveBeenCalledOnce();
  });

  it("should expose scheduler request metadata to resolvers and recorded calls", async () => {
    const agents = setupAgentMock(
      agent.any(({ agentId, journalKey }) => {
        return AgentResponse.json({ agentId, journalKey });
      }),
    );
    const controller = new AbortController();

    await expect(
      agents.schedulerRunner({
        prompt: "scan src",
        options: { label: "scan-agent" },
        agentId: "agent_0",
        journalKey: "v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      agentId: "agent_0",
      journalKey: "v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(agents.calls()).toMatchObject([
      {
        prompt: "scan src",
        options: { label: "scan-agent" },
        agentId: "agent_0",
        journalKey: "v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
    expect(agents.events().map((event) => event.type)).toEqual([
      "agent:start",
      "agent:match",
      "agent:result",
      "agent:end",
    ]);
  });
});

describe("setupAgentServer", () => {
  it("should require listen before runner use", async () => {
    const agents = setupAgentServer(agent.any().replyText("ok"));

    await expect(agents.runner("scan src")).rejects.toThrow(/not listening/);

    agents.listen();
    await expect(agents.runner("scan src")).resolves.toBe("ok");
    agents.close();
  });

  it("should fail clearly when listen is called twice", () => {
    const agents = setupAgentServer();

    agents.listen();

    expect(() => agents.listen()).toThrow(/already listening/);
    agents.close();
  });

  it("should apply listen-time unhandled behavior", async () => {
    const agents = setupAgentServer();

    agents.listen({ onUnhandledAgent: "bypass" });

    await expect(agents.runner("scan src")).resolves.toBe("scan src");
    agents.close();
  });
});

describe("setupAgentTestServer", () => {
  it("should fail when a shared strict server receives an agent call with no mock", async () => {
    await expect(
      strictSharedAgents.runner("unknown work", { label: "unknown-agent" }),
    ).rejects.toThrow(/Unhandled agent call: agent\("unknown work" label="unknown-agent"\)/);
  });
});

describe("setupDefaultAgentTestServer", () => {
  it("should provide a catch-all default mocked agent response", async () => {
    await expect(sharedAgents.runner("unknown work", { label: "unknown-agent" })).resolves.toBe(
      '[default mocked agent label="unknown-agent"] unknown work',
    );
  });

  it("should prefer global explicit handlers over the catch-all default", async () => {
    await expect(sharedAgents.runner("scan src", { label: "global-scan" })).resolves.toBe(
      "global scan default",
    );
  });

  it("should let a test override global defaults inside a boundary", async () => {
    await sharedAgents.boundary(async () => {
      sharedAgents.use(agent.label("global-scan").replyText("test override"));

      await expect(sharedAgents.runner("scan src", { label: "global-scan" })).resolves.toBe(
        "test override",
      );
    });

    await expect(sharedAgents.runner("scan src", { label: "global-scan" })).resolves.toBe(
      "global scan default",
    );
  });
});

describe("agent mock boundaries", () => {
  it("should scope runtime handlers to the boundary callback", async () => {
    const agents = setupAgentMock(agent.label("scan-agent").replyText("initial"));

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("initial");

    await agents.boundary(async () => {
      agents.use(agent.label("scan-agent").replyText("scoped"));

      await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("scoped");
    });

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("initial");
  });

  it("should let nested boundaries inherit parent handlers without leaking child overrides", async () => {
    const agents = setupAgentMock(agent.label("scan-agent").replyText("initial"));

    await agents.boundary(async () => {
      agents.use(agent.label("scan-agent").replyText("outer"));
      await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("outer");

      await agents.boundary(async () => {
        agents.use(agent.label("scan-agent").replyText("inner"));
        await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("inner");
      });

      await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("outer");
    });

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("initial");
  });

  it("should reset handlers inside a boundary to the boundary starting handlers", async () => {
    const agents = setupAgentMock(agent.label("scan-agent").replyText("initial"));
    agents.use(agent.label("scan-agent").replyText("global override"));

    await agents.boundary(async () => {
      await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe(
        "global override",
      );

      agents.use(agent.label("scan-agent").replyText("scoped"));
      await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("scoped");

      agents.resetHandlers();
      await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe(
        "global override",
      );
    });

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe(
      "global override",
    );

    agents.resetHandlers();
    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("initial");
  });

  it("should isolate concurrent boundary handler overrides", async () => {
    const agents = setupAgentMock(agent.label("scan-agent").replyText("initial"));
    const firstCanRun = deferred<void>();

    const first = agents.boundary(async () => {
      agents.use(agent.label("scan-agent").replyText("first"));
      await firstCanRun.promise;
      return await agents.runner("scan src", { label: "scan-agent" });
    });

    const second = agents.boundary(async () => {
      agents.use(agent.label("scan-agent").replyText("second"));
      firstCanRun.resolve();
      await delay(1);
      return await agents.runner("scan src", { label: "scan-agent" });
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("initial");
  });
});

describe("agent fluent handlers", () => {
  it("should match prompt and metadata with fluent builders", async () => {
    const agents = setupAgentMock(
      agent
        .prompt(/^scan /)
        .withLabel("scan-agent")
        .withPhase("Scan")
        .withModel("default")
        .replyJson({ summary: "ok" }),
      agent.label("verify-agent").replyText("verified"),
      agent.any().replyText("fallback"),
    );

    await expect(
      agents.runner("scan src", {
        label: "scan-agent",
        phase: "Scan",
        model: "default",
      }),
    ).resolves.toEqual({ summary: "ok" });
    await expect(agents.runner("verify", { label: "verify-agent" })).resolves.toBe("verified");
    await expect(agents.runner("other")).resolves.toBe("fallback");
    expect(agents.printHandlers()).toContain(
      'agent.prompt(/^scan /).withLabel("scan-agent").withPhase("Scan").withModel("default")',
    );
  });

  it("should support one-time fluent handlers", async () => {
    const agents = setupAgentMock(
      agent.label("scan-agent").once().replyText("once"),
      agent.label("scan-agent").replyText("fallback"),
    );

    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("once");
    await expect(agents.runner("scan src", { label: "scan-agent" })).resolves.toBe("fallback");
  });

  it("should pass a defensive request snapshot to resolvers", async () => {
    const agents = setupAgentMock(
      agent.label("scan-agent").replyJson(({ request, options }) => {
        options.label = "mutated";
        request.options.phase = "mutated";
        return {
          prompt: request.prompt,
          label: request.options.label,
          phase: request.options.phase,
          agentId: request.agentId,
          journalKey: request.journalKey,
        };
      }),
    );

    await expect(
      agents.schedulerRunner({
        prompt: "scan src",
        options: { label: "scan-agent", phase: "Scan" },
        agentId: "agent_0",
        journalKey: "v2:key",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      prompt: "scan src",
      label: "scan-agent",
      phase: "mutated",
      agentId: "agent_0",
      journalKey: "v2:key",
    });
    expect(agents.calls()).toMatchObject([{ options: { label: "scan-agent", phase: "Scan" } }]);
  });

  it("should expose pending agents through the fluent DSL", async () => {
    const scan = agent.label("scan-agent").pending();
    const agents = setupAgentMock(scan);

    const inflight = agents.runner("scan src", { label: "scan-agent" });

    await scan.waitUntilStarted();
    scan.resolve(AgentResponse.json({ summary: "ok" }));

    await expect(inflight).resolves.toEqual({ summary: "ok" });
  });
});

describe("AgentResponse helpers", () => {
  it("should delay a response", async () => {
    vi.useFakeTimers();
    const agents = setupAgentMock(
      agent.any().replyWith(() => AgentResponse.delay(100, AgentResponse.text("slow"))),
    );

    const result = agents.runner("scan src");
    await vi.advanceTimersByTimeAsync(99);
    await expect(Promise.race([result, Promise.resolve("pending")])).resolves.toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe("slow");
    vi.useRealTimers();
  });

  it("should throw distinguishable network and schema errors", async () => {
    const networkAgents = setupAgentMock(
      agent.any().replyWith(() => AgentResponse.networkError("connection reset")),
    );
    const schemaAgents = setupAgentMock(
      agent.any().replyWith(() => AgentResponse.schemaError("invalid structured output")),
    );

    await expect(networkAgents.runner("scan src")).rejects.toMatchObject({
      variant: "network",
    } satisfies Partial<AgentMockError>);
    await expect(schemaAgents.runner("scan src")).rejects.toMatchObject({
      variant: "schema",
    } satisfies Partial<AgentMockError>);
  });
});

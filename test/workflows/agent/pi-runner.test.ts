import { describe, expect, it, vi } from "vitest";
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
    this.messages.push({ role: "assistant", content: [{ type: "text", text: "subagent result" }] });
  });
  readonly abort = vi.fn<() => void>();
  readonly dispose = vi.fn<() => void>();
  promptText = "";
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

  it("should fail clearly for structured-output agents until the structured tool slice exists", async () => {
    const runner = createPiWorkflowAgentRunner({
      cwd: "/repo",
      sessionFactory: vi.fn<PiWorkflowAgentSessionFactory>(),
    });

    await expect(
      runner(
        requestForTest({
          options: { label: "structured", schema: { type: "object" } },
        }),
      ),
    ).rejects.toThrow("does not support agent({ schema }) yet");
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

import { describe, expect, it, vi } from "vitest";

const reload = vi.fn<(...args: any[]) => any>(async () => undefined);
const createAgentSession = vi.fn<(...args: any[]) => any>();
const getAgentDir = vi.fn<(...args: any[]) => any>(() => "/fake/agent-dir");
const DefaultResourceLoader = vi.fn<(...args: any[]) => any>(
  function (this: Record<string, unknown>) {
    this.reload = reload;
  },
);

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager: { inMemory: vi.fn<(...args: any[]) => any>(() => ({ kind: "in-memory" })) },
}));

const { createPiWorkflowAgentRunner } = await import("#src/workflows/agent/pi-runner.ts");

describe("defaultSessionFactory", () => {
  it("should build a resource loader and create a session when no factory is injected", async () => {
    const session = {
      messages: [{ role: "assistant", content: "real-factory result" }],
      prompt: vi.fn<(...args: any[]) => any>(async () => undefined),
      abort: vi.fn<(...args: any[]) => any>(),
      dispose: vi.fn<(...args: any[]) => any>(),
    };
    createAgentSession.mockResolvedValueOnce({ session });

    const runner = createPiWorkflowAgentRunner({ cwd: "/repo" });
    const result = await runner({
      agentId: "agent_1",
      prompt: "do work",
      options: { label: "real" },
      signal: new AbortController().signal,
    });

    expect(result).toBe("real-factory result");
    expect(DefaultResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", agentDir: "/fake/agent-dir", noExtensions: true }),
    );
    expect(reload).toHaveBeenCalledOnce();
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        agentDir: "/fake/agent-dir",
        resourceLoader: expect.any(Object),
      }),
    );
  });
});

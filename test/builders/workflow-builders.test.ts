import { describe, expect, it } from "vitest";
import { workflowAgent } from "./workflow-agent.ts";
import { workflowRun } from "./workflow-run.ts";

describe("workflow test builders", () => {
  it("should build workflow agents with deterministic defaults and explicit overrides", () => {
    const agent = workflowAgent.running("review:security", {
      phase: "Review",
      tool: "Read",
      tokens: 41_100,
      toolCalls: 11,
      result: { summary: "ok" },
    });

    expect(agent).toMatchObject({
      type: "workflow_agent",
      index: 0,
      label: "review:security",
      agentId: "agent_0",
      state: "running",
      phaseTitle: "Review",
      lastToolName: "Read",
      tokens: 41_100,
      toolCalls: 11,
      resultPreview: '{"summary":"ok"}',
    });
  });

  it("should derive run progress rows and counters from phases and agents", () => {
    const run = workflowRun.running("hardening", {
      phases: ["Slice", "Author"],
      agents: [
        workflowAgent.running("slice:one", { tokens: 10, toolCalls: 2 }),
        workflowAgent.done("author:one", { tokens: 30, toolCalls: 4 }),
      ],
    });

    expect(run.workflowProgress.map((entry) => entry.type)).toEqual([
      "workflow_phase",
      "workflow_phase",
      "workflow_agent",
      "workflow_agent",
    ]);
    expect(run.agentCount).toBe(2);
    expect(run.totalTokens).toBe(40);
    expect(run.totalToolCalls).toBe(6);
  });

  it("should add terminal fields only through terminal builders by default", () => {
    expect(workflowRun.running("audit")).not.toHaveProperty("durationMs");
    expect(workflowRun.completed("audit", { result: "ok" })).toMatchObject({
      status: "completed",
      durationMs: 0,
      result: "ok",
    });
  });
});

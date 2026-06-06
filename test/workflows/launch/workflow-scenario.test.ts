import { describe, it } from "vitest";
import { agent } from "../agent/agent-mock.ts";
import { workflowScript } from "../script/workflow-factory.ts";
import { workflowScenario } from "./workflow-scenario.ts";

describe("workflow scenario test helper", () => {
  it("should launch a workflow and assert persisted terminal artifacts", async () => {
    let now = 100;
    const script = workflowScript({
      meta: {
        name: "review",
        phases: [{ title: "Review" }],
      },
      body: `
phase("Review");
return await agent("review src", { label: "review-agent", phase: "Review" });
`,
    });

    const scenario = await workflowScenario()
      .withNow(() => now)
      .withScript(script)
      .withAgents(agent.label("review-agent").replyText("ok"))
      .launch();

    scenario
      .shouldHaveReturnedTask("task_test")
      .shouldHaveReturnedRun("wf_test")
      .shouldHaveLaunchConfirmation()
      .shouldHaveReturnedImmediately();
    await scenario.shouldHaveWrittenScriptCopy(script);
    await scenario.shouldHaveWrittenInitialManifest({ workflowName: "review" });

    now = 175;
    await scenario.complete();

    scenario.shouldHaveCompletedWithResult("ok");
    await scenario.shouldHaveManifest({ status: "completed", durationMs: 75 });
    await scenario.shouldHaveOutputFile({
      status: "completed",
      result: "ok",
      usage: { agentCount: 1, subagentTokens: 0, toolUses: 0, durationMs: 75 },
    });
    scenario.shouldHaveTaskNotification({
      details: {
        taskId: "task_test",
        runId: "wf_test",
        status: "completed",
        outputFile: scenario.outputPath,
        result: "ok",
        usage: { agentCount: 1, subagentTokens: 0, toolUses: 0, durationMs: 75 },
        summary: 'Dynamic workflow "review" completed',
      },
    });
    await scenario.shouldHaveJournalEvent("started");
    await scenario.shouldHaveJournalEvent("result", { result: "ok" });
    scenario.agents.expectNoUnhandledAgents();
  });

  it("should assert launch errors without creating run storage", async () => {
    const scenario = await workflowScenario()
      .withScript(workflowScript({ meta: { name: "bad" }, body: "return Date.now();" }))
      .expectLaunchError("WorkflowLaunchParseError");

    await scenario.shouldNotHaveCreatedRunStorage();
  });
});

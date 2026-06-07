import { describe, expect, it } from "vitest";
import { workflowAgent } from "../../builders/workflow-agent.ts";
import { workflowRun } from "../../builders/workflow-run.ts";
import { workflowsCommandPage } from "./workflows-command-page.ts";

describe("workflows command page test helper", () => {
  it("should open the TUI with runs and persist callback side effects", async () => {
    expect.hasAssertions();

    const page = await workflowsCommandPage().withRun(workflowRun.running("audit")).openTui();

    page
      .shouldHavePassedRunsToTui(1)
      .shouldHaveRegisteredCallbacks(
        "onPauseRun",
        "onResumeRun",
        "onResumeStoppedRun",
        "onStopRun",
        "onStopAgent",
      )
      .pauseRun("wf_test");

    await page.shouldHavePersistedRunStatus("wf_test", "paused");
  });

  it("should assert print and JSON command output", async () => {
    expect.hasAssertions();

    await (
      await workflowsCommandPage()
        .withRun(workflowRun.completed("review", { result: "ok" }))
        .openPrint()
    )
      .shouldPrintText("Workflow runs")
      .shouldPrintText("review");

    (
      await workflowsCommandPage().withRun(workflowRun.running("audit")).openJson()
    ).shouldReturnJson({
      type: "workflow_command_output",
      command: "workflows",
      severity: "info",
    });
  });

  it("should persist stopped agent status through TUI callbacks", async () => {
    expect.hasAssertions();

    const page = await workflowsCommandPage()
      .withRun(
        workflowRun.running("audit", {
          agents: [workflowAgent.running("scan-agent", { agentId: "agent_0" })],
        }),
      )
      .openTui();

    page.stopAgent("wf_test", "agent_0");

    await page.shouldHavePersistedAgentStatus("wf_test", "agent_0", "stopped");
  });
});

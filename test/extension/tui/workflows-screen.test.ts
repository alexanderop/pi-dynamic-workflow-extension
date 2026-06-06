import { describe, expect, it } from "vitest";
import { workflowAgent } from "../../builders/workflow-agent.ts";
import { workflowRun } from "../../builders/workflow-run.ts";
import { workflowsScreen } from "./workflows-screen.ts";

describe("workflows screen test helper", () => {
  it("should render overview text and width diagnostics through semantic assertions", () => {
    const run = workflowRun.running("hardening", {
      phases: ["Slice"],
      agents: [workflowAgent.running("slice:one", { phase: "Slice" })],
    });

    const screen = workflowsScreen([run])
      .atWidth(120)
      .render()
      .shouldShowOverview()
      .shouldShowPhase("Slice")
      .shouldShowAgent("slice:one")
      .shouldFitWidth({ widths: [42, 120] });

    expect(screen.plainText()).toContain("slice:one");
  });

  it("should drive raw keys through semantic actions", () => {
    const run = workflowRun.running("audit", {
      phases: ["Review"],
      agents: [
        workflowAgent.running("review:security", {
          phase: "Review",
          prompt: "review security",
        }),
      ],
    });

    const screen = workflowsScreen([run])
      .openSelectedAgent()
      .shouldShowAgentDetail("review:security")
      .openOriginalPrompt()
      .shouldShowOriginalPrompt();

    expect(screen.plainText()).toContain("review security");
  });

  it("should expose confirmation callback assertions", () => {
    const run = workflowRun.running("audit", { runId: "wf_audit" });
    const screen = workflowsScreen([run]);

    screen.requestStopWorkflow().shouldAskForConfirmation("Stop workflow?");

    expect(screen.plainText()).toContain("audit");
    screen.confirm().shouldHaveStoppedRun("wf_audit");
  });
});

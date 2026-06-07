import { describe, it } from "vitest";
import { workflowScript } from "../script/workflow-factory.ts";
import { savedWorkflowScenario } from "./saved-workflow-scenario.ts";

describe("saved workflow scenario test helper", () => {
  it("should resolve a project saved workflow by command name", async () => {
    const source = workflowScript({
      meta: { name: "review", description: "Review the project", phases: [{ title: "Review" }] },
      body: "return 'project';",
    });

    const saved = await savedWorkflowScenario().withProjectWorkflow("review", source);

    await saved.shouldResolve("review", { source, meta: { name: "review" } });
    await saved.shouldResolveToPath("review", "review.js");
    await saved.shouldNotHaveCreatedRunStorage();
  });

  it("should resolve a saved workflow by meta name when the file basename differs", async () => {
    const source = workflowScript({ meta: { name: "deep-research" }, body: "return 'found';" });

    const saved = await savedWorkflowScenario().withProjectWorkflowFile(
      "deep-research2.js",
      source,
    );

    await saved.shouldResolve("deep-research", { source });
    await saved.shouldResolveToPath("deep-research", "deep-research2.js");
  });

  it("should report missing and invalid saved workflows with their error tags", async () => {
    const saved = await savedWorkflowScenario().withProjectWorkflow(
      "review",
      workflowScript({ meta: { name: "other" }, body: "return 'wrong';" }),
    );

    await saved.shouldFailToResolve("missing", "WorkflowSavedWorkflowNotFoundError");
    await saved.shouldFailToResolve("review", {
      _tag: "WorkflowSavedWorkflowInvalidError",
      path: saved.pathFor("review"),
    });
    await saved.shouldFailToResolve("../escape", "WorkflowSavedWorkflowInvalidNameError");
  });

  it("should list saved workflows sorted by name", async () => {
    const saved = savedWorkflowScenario();
    await saved.withProjectWorkflow("review", workflowScript({ meta: { name: "review" } }));
    await saved.withProjectWorkflow("audit", workflowScript({ meta: { name: "audit" } }));

    await saved.shouldListNames(["audit", "review"]);
  });
});

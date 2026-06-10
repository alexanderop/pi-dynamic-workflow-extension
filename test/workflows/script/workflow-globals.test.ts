import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runWorkflowScript, WORKFLOW_SCRIPT_GLOBALS } from "#src/workflows/script/runtime.ts";
import { WORKFLOW_TOOL_DESCRIPTION } from "#src/extension/tools/workflow-tool.ts";
import { workflowScript } from "./workflow-factory.ts";

const workflowTypesPath = fileURLToPath(new URL("../../../types/workflow.d.ts", import.meta.url));

describe("workflow script globals contract", () => {
  it("should define every advertised global in the sandbox", async () => {
    const body = `${WORKFLOW_SCRIPT_GLOBALS.map((name) => `void ${name};`).join("\n")}\nreturn null;`;

    const state = await runWorkflowScript(workflowScript({ body }));

    expect(state.result).toBeNull();
  });

  it("should declare every advertised global in the published author types", () => {
    const declarations = readFileSync(workflowTypesPath, "utf8");

    for (const name of WORKFLOW_SCRIPT_GLOBALS) {
      expect(declarations).toMatch(new RegExp(`\\b(?:function|const)\\s+${name}\\b`));
    }
  });

  it("should advertise every global in the model-facing Workflow tool description", () => {
    for (const name of WORKFLOW_SCRIPT_GLOBALS) {
      expect(WORKFLOW_TOOL_DESCRIPTION).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

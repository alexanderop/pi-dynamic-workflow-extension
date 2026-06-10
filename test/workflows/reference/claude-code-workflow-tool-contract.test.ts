import { describe, expect, it, vi } from "vitest";
import { registerWorkflowTool } from "#src/extension/tools/workflow-tool.ts";
import { parseWorkflowScript } from "#src/workflows/script/parser.ts";
import {
  createPipeline,
  runWorkflowScript,
  WORKFLOW_COLLECTION_ITEM_LIMIT,
} from "#src/workflows/script/runtime.ts";
import { AgentResponse, agent, setupAgentMock } from "../agent/agent-mock.ts";
import { invalidWorkflowScript, workflowScript } from "../script/workflow-factory.ts";
import { fakePi } from "../../support.ts";

describe("Claude Code Workflow tool reference contract", () => {
  it("should keep the model-facing parameter schema aligned with the captured Workflow contract", () => {
    let tool: { readonly parameters: unknown } | undefined;

    registerWorkflowTool(
      fakePi({
        registerTool: vi.fn<(registered: { readonly parameters: unknown }) => void>(
          (registered) => {
            tool = registered;
          },
        ),
        sendMessage: vi.fn<(...args: unknown[]) => void>(),
      }),
    );

    expect(tool?.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        script: { type: "string", maxLength: 524_288 },
        scriptPath: { type: "string" },
        name: { type: "string" },
        resumeFromRunId: { type: "string", pattern: "^wf_[a-z0-9-]{6,}$" },
        args: {},
        title: { type: "string" },
        description: { type: "string" },
      },
    });
    const parameters = tool?.parameters as
      | {
          readonly required?: unknown;
          readonly properties: { readonly args: { readonly type?: unknown } };
        }
      | undefined;
    expect(parameters?.required).toBeUndefined();
    expect(parameters?.properties.args.type).toBeUndefined();
  });

  it("should require literal meta.name and meta.description while accepting optional model", () => {
    const parsed = parseWorkflowScript(
      workflowScript({
        meta: {
          name: "reference-contract",
          description: "Exercise the captured Workflow metadata contract",
          model: "sonnet",
        },
      }),
    );

    expect(parsed.meta).toEqual({
      name: "reference-contract",
      description: "Exercise the captured Workflow metadata contract",
      model: "sonnet",
    });
    expect(() =>
      parseWorkflowScript(invalidWorkflowScript({ metaSource: '{ name: "missing-description" }' })),
    ).toThrow(/meta\.description/);
  });

  it("should enforce the 4096 item collection cap from the captured Workflow contract", async () => {
    const tooMany = Array.from({ length: WORKFLOW_COLLECTION_ITEM_LIMIT + 1 }, (_, index) => index);

    await expect(createPipeline()(tooMany, async (_previous, item) => item)).rejects.toThrow(
      /at most 4096/,
    );
  });

  it("should reject new agent calls once the runtime token budget is exhausted", async () => {
    const agents = setupAgentMock(
      agent.call({ prompt: "first" }, () => AgentResponse.text("first result")),
    );

    await expect(
      runWorkflowScript(
        workflowScript({
          meta: {
            name: "budget-reference",
            description: "Exercise the captured Workflow budget contract",
          },
          body: `
await agent("first");
return await agent("second");
`,
        }),
        { budgetTotal: 1, schedulerRunner: agents.schedulerRunner },
      ),
    ).rejects.toThrow(/budget exhausted/);

    agents.expectAgentsInOrder([{ prompt: "first" }]);
    agents.expectNoUnhandledAgents();
  });
});

// Registers the Workflow tool with Pi: input schema, validation, and launch
// wiring. Call/result rendering lives in workflow-tool-render.ts.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  launchWorkflow,
  type WorkflowLauncher,
  type WorkflowLaunchOptions,
  type WorkflowLaunchRequest,
} from "#src/workflows/launch/launcher.ts";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";
import { WORKFLOW_SCRIPT_MAX_LENGTH } from "#src/workflows/launch/model.ts";
import type { WorkflowLaunchOperations } from "#src/workflows/launch/operations.ts";
import type { WorkflowRunTriggerSource } from "#src/workflows/run/model.ts";
import { buildWorkflowLaunchOptions } from "#src/extension/workflow-launch-options.ts";
import { terminalNotifier } from "#src/extension/workflow-notifications.ts";
import {
  formatWorkflowToolCall,
  formatWorkflowToolResult,
  workflowToolSourceLabel,
  type WorkflowToolDetails,
  type WorkflowToolProgressDetails,
  type WorkflowToolResultLike,
} from "#src/extension/tools/workflow-tool-render.ts";

export { WORKFLOW_SCRIPT_MAX_LENGTH };
export const WORKFLOW_TOOL_NAME = "Workflow";

export const WORKFLOW_TOOL_DESCRIPTION = `Orchestrates many subagents deterministically by running a self-contained JavaScript workflow script in the background.

Think of Workflow as a custom harness/conductor for tasks where one context window is weak: the JavaScript orchestrator owns deterministic control flow, each subagent gets a focused prompt and separate context window, and synthesis/verification happen explicitly to reduce agentic laziness, self-preferential bias, and goal drift.

Use Workflow only when the user explicitly opted into multi-agent orchestration, such as by typing ultracode, asking to use a workflow, being in an ultracode session, or invoking a skill that instructs workflow use. Otherwise, use ordinary single-agent work or ask first.

Workflow accepts one of script, scriptPath, or name. Precedence is scriptPath > script > name. Every launch persists the script under the workflow run directory and returns the path in the tool result. To iterate, edit that persisted script file and relaunch with scriptPath instead of resending the full script.

A workflow script must begin with a pure literal export const meta = { ... } block: no variables, function calls, computed keys, spreads, or template interpolation. meta.name and meta.description are required. meta.phases must be an array of objects such as [{ title: "Generate", detail: "Draft candidates", agentCount: 4, agents: [{ label: "generate:angle-a" }] }, { title: "Select", agentCount: 1 }], never strings such as ["Generate"]. Phase titles must match phase() calls exactly. Include phase detail/agentCount/agents only when the planned fan-out is known before execution.

The script body is plain JavaScript, not TypeScript. Use top-level await. Do not use filesystem, Node.js APIs, Date.now(), Math.random(), or argument-less new Date(). Pass timestamps through args and vary work by stable item indexes.

Available workflow globals: args, budget, agent(prompt, opts?), pipeline(items, ...stages), parallel(thunks), phase(title), and log(message). agent() spawns one subagent; without opts.schema it returns final text, and with opts.schema it returns the validated structured object. opts.schema must be a plain JSON object schema suitable for Pi tool parameters, such as { type: 'object', properties: ..., required: ... }. Other opts may include label, phase, thinkingLevel, agentType, the compatibility field model, and isolation: 'worktree' (accepted for forward compatibility but not yet implemented; agents do not currently run in isolated worktrees). By default, select the desired Pi model before launching the workflow, do not set model hints by default, and use thinkingLevel to vary reasoning effort. The model field is ignored unless /workflows features enables experimental-model-routing; with experimental-model-routing enabled, exact model hints may route agents and invalid hints fall back to the current Pi model. pipeline() has no cross-item barrier; each item advances through stages as soon as it can. Stage callbacks receive (prevResult, originalItem, index); for the first stage, prevResult === originalItem. parallel() is a barrier over thunks and returns null for failed thunks.

Default to pipeline() for multi-stage work. Use a parallel() barrier only when a stage genuinely needs all earlier results together, such as deduplication, global merge, zero-count early exit, or cross-item comparison. Filter null results defensively after parallel() or pipeline() stages that may fail. A single parallel() or pipeline() call accepts at most 4096 items.

Concurrency is capped by the runtime, a workflow run has a lifetime agent limit, and budget.total is a hard ceiling for future agent() calls once spent. Use /workflows to watch live progress. A task notification is sent when the run completes or fails.

After Workflow launches successfully, stop the current assistant turn. Do not continue with fallback local work while the background workflow is running; wait for the workflow notification or the user's next message.`;

const WorkflowToolParameters = Type.Object(
  {
    script: Type.Optional(
      Type.String({
        maxLength: WORKFLOW_SCRIPT_MAX_LENGTH,
        description:
          'Self-contained workflow script. Must begin with a pure literal `export const meta = { ... }` block. Use `phases: [{ title: "Phase", detail: "What this phase does", agentCount: 3, agents: [{ label: "phase:one" }] }]` when planned context is known, not string phases like `["Phase"]`, followed by the script body using agent()/parallel()/pipeline()/phase(). Select the Pi model before launch; do not set `model` unless experimental-model-routing is enabled.',
      }),
    ),
    scriptPath: Type.Optional(
      Type.String({
        description:
          "Path to a workflow script file on disk. Every Workflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke Workflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Name of a predefined workflow (built-in or from .pi/workflows/). Resolves to a self-contained script.",
      }),
    ),
    resumeFromRunId: Type.Optional(
      Type.String({
        pattern: "^wf_[a-z0-9-]{6,}$",
        description:
          "Run ID of a prior Workflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first before resuming.",
      }),
    ),
    args: Type.Optional(
      Type.Any({
        description:
          "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Ignored — set the workflow title in the script's `meta` block.",
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: "Ignored — set the workflow description in the script's `meta` block.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WorkflowToolParams = Static<typeof WorkflowToolParameters>;

export interface RegisterWorkflowToolOptions {
  readonly getTriggerSource?: () => WorkflowRunTriggerSource;
  readonly operations?: WorkflowLaunchOperations;
  readonly launchWorkflow?: WorkflowLauncher;
}

/** The slice of the host API that registering the Workflow tool actually depends on. */
export type RegisterWorkflowToolPi = Pick<ExtensionAPI, "registerTool" | "sendMessage"> &
  Partial<Pick<ExtensionAPI, "getThinkingLevel">>;

export function registerWorkflowTool(
  pi: RegisterWorkflowToolPi,
  options: RegisterWorkflowToolOptions = {},
): void {
  pi.registerTool({
    name: WORKFLOW_TOOL_NAME,
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: "Launch a deterministic background workflow that orchestrates many subagents",
    promptGuidelines: [
      "Use Workflow only after explicit multi-agent opt-in, such as ultracode, a user request to use a workflow, or a skill that instructs workflow orchestration.",
      "When using Workflow, pass exactly one effective source: prefer scriptPath when iterating, otherwise script for a new self-contained workflow, otherwise name for a saved workflow.",
      "After Workflow launches, do not continue with additional local work in the same assistant turn; the terminating tool result should hand control back while the background run proceeds.",
      'Workflow scripts must begin with a pure literal `export const meta = { ... }` block; `meta.phases` must be objects like `{ title: "Phase", detail: "...", agentCount: 3, agents: [{ label: "phase:one" }] }` when planned context is known, never bare strings, and scripts must use pipeline() rather than parallel() unless a true barrier is needed.',
    ],
    parameters: WorkflowToolParameters,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Validating ${workflowToolSourceLabel(params)} and preparing background run storage…`,
          },
        ],
        details: { stage: "validating" },
      });

      const launch = await (options.launchWorkflow ?? launchWorkflow)(
        toLaunchRequest(params),
        await toLaunchOptions(ctx, pi, options),
      );
      if (launch.status === "error") throw new Error(launch.error.message);

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Workflow ${launch.value.runId} launched; writing confirmation and running in background…`,
          },
        ],
        details: {
          stage: "launching",
          taskId: launch.value.taskId,
          runId: launch.value.runId,
          scriptPath: launch.value.scriptPath,
          transcriptDir: launch.value.transcriptDir,
        } satisfies WorkflowToolProgressDetails,
      });

      return {
        content: [{ type: "text", text: launch.value.confirmation }],
        details: {
          taskId: launch.value.taskId,
          runId: launch.value.runId,
          scriptPath: launch.value.scriptPath,
          transcriptDir: launch.value.transcriptDir,
        } satisfies WorkflowToolDetails,
        terminate: true,
      };
    },
    renderCall(args, theme, context) {
      return new Text(formatWorkflowToolCall(args, theme, context), 0, 0);
    },
    renderResult(result, resultOptions, theme, context) {
      return new Text(
        formatWorkflowToolResult(result as WorkflowToolResultLike, resultOptions, theme, context),
        0,
        0,
      );
    },
  });
}

function toLaunchRequest(params: WorkflowToolParams): WorkflowLaunchRequest {
  return {
    script: params.script,
    scriptPath: params.scriptPath,
    name: params.name,
    resumeFromRunId: params.resumeFromRunId,
    args: params.args,
  };
}

function toLaunchOptions(
  ctx: ExtensionContext,
  pi: RegisterWorkflowToolPi,
  options: RegisterWorkflowToolOptions,
): Promise<WorkflowLaunchOptions> {
  return buildWorkflowLaunchOptions(ctx, pi, {
    rootDir: workflowRootDirForCwd(ctx.cwd),
    triggerSource: options.getTriggerSource?.() ?? "manual",
    operations: options.operations,
    notifyTerminal: terminalNotifier(pi.sendMessage),
  });
}

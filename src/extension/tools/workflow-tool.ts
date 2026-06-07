import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  launchWorkflow,
  type WorkflowLaunch,
  type WorkflowLaunchError,
  type WorkflowLaunchOptions,
  type WorkflowLaunchRequest,
} from "#src/workflows/launch/launcher.ts";
import { tryParseWorkflowScript } from "#src/workflows/script/parser.ts";
import type { Result } from "#src/workflows/result.ts";
import { workflowRootDirForCwd } from "#src/workflows/run/root-dir.ts";
import { WORKFLOW_SCRIPT_MAX_LENGTH } from "#src/workflows/launch/model.ts";
import type { WorkflowLaunchOperations } from "#src/workflows/launch/operations.ts";
import type { WorkflowRunTriggerSource } from "#src/workflows/run/model.ts";
import { buildWorkflowLaunchOptions } from "#src/extension/workflow-launch-options.ts";
import { prepareWorkflowNotification } from "#src/extension/workflow-notifications.ts";

export { WORKFLOW_SCRIPT_MAX_LENGTH };
export const WORKFLOW_TOOL_NAME = "Workflow";

export const WORKFLOW_TOOL_DESCRIPTION = `Orchestrates many subagents deterministically by running a self-contained JavaScript workflow script in the background.

Use Workflow only when the user explicitly opted into multi-agent orchestration, such as by typing ultracode, asking to use a workflow, being in an ultracode session, or invoking a skill that instructs workflow use. Otherwise, use ordinary single-agent work or ask first.

Workflow accepts one of script, scriptPath, or name. Precedence is scriptPath > script > name. Every launch persists the script under the workflow run directory and returns the path in the tool result. To iterate, edit that persisted script file and relaunch with scriptPath instead of resending the full script.

A workflow script must begin with a pure literal export const meta = { ... } block: no variables, function calls, computed keys, spreads, or template interpolation. meta.name and meta.description are required. meta.phases must be an array of objects such as [{ title: "Generate", detail: "Draft candidates", model: "default", agentCount: 4, agents: [{ label: "generate:angle-a" }] }, { title: "Select", agentCount: 1 }], never strings such as ["Generate"]. Phase titles must match phase() calls exactly. Include phase detail/model/agentCount/agents only when the planned fan-out is known before execution.

The script body is plain JavaScript, not TypeScript. Use top-level await. Do not use filesystem, Node.js APIs, Date.now(), Math.random(), or argument-less new Date(). Pass timestamps through args and vary work by stable item indexes.

Available workflow globals: args, budget, agent(prompt, opts?), pipeline(items, ...stages), parallel(thunks), phase(title), and log(message). agent() spawns one subagent; without opts.schema it returns final text, and with opts.schema it returns the validated structured object. opts.schema must be a plain JSON object schema suitable for Pi tool parameters, such as { type: 'object', properties: ..., required: ... }. Other opts may include label, phase, model, thinkingLevel, isolation: 'worktree', and agentType. Treat model and thinking hints as soft routing hints: use cheaper/faster models for cheap fan-out and stronger models with higher thinking for heavy synthesis, but exact model id typos, unavailable models, ambiguous short ids, or unsupported thinking levels fall back to the current Pi model/thinking instead of failing. pipeline() has no cross-item barrier; each item advances through stages as soon as it can. Stage callbacks receive (prevResult, originalItem, index); for the first stage, prevResult === originalItem. parallel() is a barrier over thunks and returns null for failed thunks.

Default to pipeline() for multi-stage work. Use a parallel() barrier only when a stage genuinely needs all earlier results together, such as deduplication, global merge, zero-count early exit, or cross-item comparison. Filter null results defensively after parallel() or pipeline() stages that may fail. A single parallel() or pipeline() call accepts at most 4096 items.

Concurrency is capped by the runtime, a workflow run has a lifetime agent limit, and budget.total is a hard ceiling for future agent() calls once spent. Use /workflows to watch live progress. A task notification is sent when the run completes or fails.

After Workflow launches successfully, stop the current assistant turn. Do not continue with fallback local work while the background workflow is running; wait for the workflow notification or the user's next message.`;

const WorkflowToolParameters = Type.Object(
  {
    script: Type.Optional(
      Type.String({
        maxLength: WORKFLOW_SCRIPT_MAX_LENGTH,
        description:
          'Self-contained workflow script. Must begin with a pure literal `export const meta = { ... }` block. Use `phases: [{ title: "Phase", detail: "What this phase does", model: "default", agentCount: 3, agents: [{ label: "phase:one" }] }]` when planned context is known, not string phases like `["Phase"]`, followed by the script body using agent()/parallel()/pipeline()/phase().',
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

interface WorkflowToolDetails {
  readonly taskId: string;
  readonly runId: string;
  readonly scriptPath: string;
  readonly transcriptDir: string;
}

export interface RegisterWorkflowToolOptions {
  readonly getTriggerSource?: () => WorkflowRunTriggerSource;
  readonly operations?: WorkflowLaunchOperations;
  readonly launchWorkflow?: (
    request: WorkflowLaunchRequest,
    options: WorkflowLaunchOptions,
  ) => Promise<Result<WorkflowLaunch, WorkflowLaunchError>>;
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
      'Workflow scripts must begin with a pure literal `export const meta = { ... }` block; `meta.phases` must be objects like `{ title: "Phase", detail: "...", model: "default", agentCount: 3, agents: [{ label: "phase:one" }] }` when planned context is known, never bare strings, and scripts must use pipeline() rather than parallel() unless a true barrier is needed.',
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
    notifyTerminal: async (notification) => {
      const { message, delivery } = prepareWorkflowNotification(notification);
      await pi.sendMessage(message, delivery);
    },
  });
}

interface WorkflowToolRenderTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

interface WorkflowToolProgressDetails extends Partial<WorkflowToolDetails> {
  readonly stage?: "validating" | "launching";
}

interface WorkflowToolResultLike {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly details?: WorkflowToolProgressDetails;
}

interface WorkflowToolRenderContext {
  readonly argsComplete?: boolean;
  readonly executionStarted?: boolean;
  readonly isError?: boolean;
}

interface WorkflowToolRenderResultOptions {
  readonly isPartial?: boolean;
}

function formatWorkflowToolCall(
  args: Partial<WorkflowToolParams> | undefined,
  theme: WorkflowToolRenderTheme,
  context: WorkflowToolRenderContext = {},
): string {
  const source = workflowToolSourceLabel(args);
  const status = workflowToolCallStatus(context);
  const lines = [
    `${theme.fg("toolTitle", theme.bold("Workflow"))} ${theme.fg("accent", source)} ${theme.fg("dim", status)}`,
  ];

  lines.push(...workflowToolSourceDetails(args, context, theme));
  return lines.join("\n");
}

function workflowToolSourceLabel(args: Partial<WorkflowToolParams> | undefined): string {
  if (typeof args?.scriptPath === "string" && args.scriptPath.length > 0) {
    return `scriptPath ${args.scriptPath}`;
  }
  if (typeof args?.name === "string" && args.name.length > 0) return `name ${args.name}`;
  if (typeof args?.script === "string" && args.script.length > 0) return "inline script";
  return "launch";
}

function workflowToolCallStatus(context: WorkflowToolRenderContext): string {
  if (context.executionStarted === true) return "· validating and launching…";
  if (context.argsComplete === false) return "· authoring…";
  return "· ready to launch";
}

function workflowToolSourceDetails(
  args: Partial<WorkflowToolParams> | undefined,
  context: WorkflowToolRenderContext,
  theme: WorkflowToolRenderTheme,
): string[] {
  if (typeof args?.script === "string" && args.script.length > 0) {
    return inlineScriptDetails(args.script, context, theme);
  }
  if (typeof args?.scriptPath === "string" && args.scriptPath.length > 0) {
    return [theme.fg("dim", `  source: ${args.scriptPath}`)];
  }
  if (typeof args?.name === "string" && args.name.length > 0) {
    return [theme.fg("dim", `  saved workflow: ${args.name}`)];
  }
  return [theme.fg("dim", "  waiting for workflow source arguments…")];
}

const INLINE_SCRIPT_PREVIEW_HEAD_LINES = 8;
const INLINE_SCRIPT_PREVIEW_TAIL_LINES = 12;
const INLINE_SCRIPT_PREVIEW_LINE_MAX_CHARS = 160;

function inlineScriptDetails(
  script: string,
  context: WorkflowToolRenderContext,
  theme: WorkflowToolRenderTheme,
): string[] {
  const size = `${script.length.toLocaleString("en-US")} chars`;
  if (context.argsComplete === false) {
    return inlineScriptAuthoringDetails(script, size, theme);
  }

  const parsed = tryParseWorkflowScript(script);
  if (parsed.status === "error") {
    return [theme.fg("error", `  invalid before launch: ${parsed.error.message}`)];
  }

  const phases = parsed.value.meta.phases
    ?.map((phase) =>
      phase.agentCount === undefined ? phase.title : `${phase.title} (${phase.agentCount})`,
    )
    .join(" → ");
  const lines = [
    theme.fg("dim", `  ${parsed.value.meta.name} · ${size}`),
    theme.fg("dim", `  ${parsed.value.meta.description}`),
  ];
  if (phases !== undefined && phases.length > 0) {
    lines.push(theme.fg("dim", `  phases: ${phases}`));
  }
  return lines;
}

function inlineScriptAuthoringDetails(
  script: string,
  size: string,
  theme: WorkflowToolRenderTheme,
): string[] {
  const lines = script.split("\n");
  const lineCount = `${lines.length.toLocaleString("en-US")} ${lines.length === 1 ? "line" : "lines"}`;
  return [
    theme.fg("dim", `  drafting inline script · ${size} · ${lineCount}`),
    theme.fg("dim", "  live preview:"),
    ...inlineScriptPreviewLines(lines, theme),
  ];
}

function inlineScriptPreviewLines(lines: string[], theme: WorkflowToolRenderTheme): string[] {
  const visible = selectInlineScriptPreviewLines(lines);
  const lineNumberWidth = String(lines.length).length;
  return visible.map((line) => {
    if (line === "omitted") return theme.fg("dim", "    …");
    const lineNumber = String(line.index + 1).padStart(lineNumberWidth, " ");
    return theme.fg("dim", `    ${lineNumber} │ ${truncateInlineScriptPreviewLine(line.text)}`);
  });
}

function truncateInlineScriptPreviewLine(line: string): string {
  if (line.length <= INLINE_SCRIPT_PREVIEW_LINE_MAX_CHARS) return line;
  return `${line.slice(0, INLINE_SCRIPT_PREVIEW_LINE_MAX_CHARS - 1)}…`;
}

function selectInlineScriptPreviewLines(
  lines: string[],
): Array<{ readonly index: number; readonly text: string } | "omitted"> {
  const maxPreviewLines = INLINE_SCRIPT_PREVIEW_HEAD_LINES + INLINE_SCRIPT_PREVIEW_TAIL_LINES;
  if (lines.length <= maxPreviewLines) {
    return lines.map((text, index) => ({ index, text }));
  }

  const head = lines.slice(0, INLINE_SCRIPT_PREVIEW_HEAD_LINES).map((text, index) => ({
    index,
    text,
  }));
  const tailStart = lines.length - INLINE_SCRIPT_PREVIEW_TAIL_LINES;
  const tail = lines.slice(tailStart).map((text, offset) => ({
    index: tailStart + offset,
    text,
  }));
  return [...head, "omitted", ...tail];
}

function formatWorkflowToolResult(
  result: WorkflowToolResultLike,
  options: WorkflowToolRenderResultOptions | undefined,
  theme: WorkflowToolRenderTheme,
  context: WorkflowToolRenderContext = {},
): string {
  const runId = result.details?.runId;
  const scriptPath = result.details?.scriptPath;
  if (runId !== undefined && scriptPath !== undefined) {
    const state = options?.isPartial === true ? "launching" : "launched";
    return [
      `${theme.fg("success", state)} ${theme.fg("accent", runId)}`,
      theme.fg("dim", `  script: ${scriptPath}`),
      theme.fg("dim", "  live progress: /workflows"),
    ].join("\n");
  }

  const text = result.content?.find((entry) => entry.type === "text")?.text ?? "";
  const line = text.split("\n")[0] ?? "";
  if (context.isError === true) return theme.fg("error", `failed ${line}`);
  return theme.fg("dim", line);
}

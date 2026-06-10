// TUI rendering for the Workflow tool's renderCall/renderResult hooks: status
// lines, inline-script live preview, and result formatting. Pure string
// assembly — tool registration and launch wiring live in workflow-tool.ts.
import { stripMarkdownFence, tryParseWorkflowScript } from "#src/workflows/script/parser.ts";

/** The subset of the tool params the render hooks read. */
export interface WorkflowToolSourceArgs {
  readonly script?: string;
  readonly scriptPath?: string;
  readonly name?: string;
}

export interface WorkflowToolDetails {
  readonly taskId: string;
  readonly runId: string;
  readonly scriptPath: string;
  readonly transcriptDir: string;
}

export interface WorkflowToolRenderTheme {
  fg(name: string, text: string): string;
  bold(text: string): string;
}

export interface WorkflowToolProgressDetails extends Partial<WorkflowToolDetails> {
  readonly stage?: "validating" | "launching";
}

export interface WorkflowToolResultLike {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly details?: WorkflowToolProgressDetails;
}

export interface WorkflowToolRenderContext {
  readonly argsComplete?: boolean;
  readonly executionStarted?: boolean;
  readonly isError?: boolean;
}

export interface WorkflowToolRenderResultOptions {
  readonly isPartial?: boolean;
}

export function formatWorkflowToolCall(
  args: WorkflowToolSourceArgs | undefined,
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

export function workflowToolSourceLabel(args: WorkflowToolSourceArgs | undefined): string {
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
  args: WorkflowToolSourceArgs | undefined,
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

  // Match the launcher's inline-script normalization so the preview verdict
  // agrees with what would actually launch.
  const parsed = tryParseWorkflowScript(stripMarkdownFence(script));
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

export function formatWorkflowToolResult(
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

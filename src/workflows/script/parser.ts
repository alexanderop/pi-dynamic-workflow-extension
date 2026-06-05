import { parse } from "acorn";
import { err, ok, type Result } from "../result.ts";
import type { WorkflowMeta, WorkflowPhase } from "./model.ts";

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  body: string;
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    ranges: true,
  } as any) as any;

  const first = program.body[0];
  if (!isMetaExport(first)) {
    throw new WorkflowParseError("Workflow script must start with `export const meta = { ... }`.");
  }

  const declaration = first.declaration.declarations[0];
  const rawMeta = literalValue(declaration.init, "meta");
  const meta = validateWorkflowMeta(rawMeta);
  const body = `${source.slice(0, first.start)}${source.slice(first.end)}`;
  assertDeterministic(program.body.slice(1));

  return { meta, body };
}

export function tryParseWorkflowScript(
  source: string,
): Result<ParsedWorkflowScript, WorkflowParseError> {
  try {
    return ok(parseWorkflowScript(source));
  } catch (cause) {
    return err(toWorkflowParseError(cause));
  }
}

function toWorkflowParseError(cause: unknown): WorkflowParseError {
  if (cause instanceof WorkflowParseError) return cause;
  if (cause instanceof Error) return new WorkflowParseError(cause.message);
  return new WorkflowParseError(String(cause));
}

function isMetaExport(node: any): boolean {
  if (node?.type !== "ExportNamedDeclaration") return false;
  const declaration = node.declaration;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return false;
  if (declaration.declarations.length !== 1) return false;

  const declarator = declaration.declarations[0];
  return (
    declarator.id?.type === "Identifier" &&
    declarator.id.name === "meta" &&
    declarator.init?.type === "ObjectExpression"
  );
}

function literalValue(node: any, path: string): unknown {
  switch (node?.type) {
    case "ObjectExpression":
      return objectValue(node, path);
    case "ArrayExpression":
      return node.elements.map((element: any, index: number) => {
        if (!element) throw new WorkflowParseError(`${path}[${index}] must not be empty.`);
        return literalValue(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    default:
      throw new WorkflowParseError(
        `${path} must contain only literal object, array, string, number, boolean, or null values.`,
      );
  }
}

function objectValue(node: any, path: string): Record<string, unknown> {
  const value: Record<string, unknown> = {};

  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      throw new WorkflowParseError(`${path} must not use object spreads.`);
    }
    if (property.computed) {
      throw new WorkflowParseError(`${path} must not use computed property keys.`);
    }
    if (property.kind !== "init" || property.method) {
      throw new WorkflowParseError(`${path} must contain only plain data properties.`);
    }

    const key = propertyKey(property.key);
    value[key] = literalValue(property.value, `${path}.${key}`);
  }

  return value;
}

function propertyKey(node: any): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  throw new WorkflowParseError("Workflow meta keys must be identifiers or string literals.");
}

function validateWorkflowMeta(value: unknown): WorkflowMeta {
  if (!isRecord(value)) throw new WorkflowParseError("Workflow meta must be an object.");
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new WorkflowParseError("Workflow meta.name must be a non-empty string.");
  }

  const meta: WorkflowMeta = { name: value.name };
  if (value.description !== undefined)
    meta.description = requireString(value.description, "meta.description");
  if (value.whenToUse !== undefined)
    meta.whenToUse = requireString(value.whenToUse, "meta.whenToUse");
  if (value.phases !== undefined) meta.phases = validatePhases(value.phases);
  return meta;
}

function validatePhases(value: unknown): WorkflowPhase[] {
  if (!Array.isArray(value)) throw new WorkflowParseError("Workflow meta.phases must be an array.");
  return value.map((phase, index) => {
    if (!isRecord(phase))
      throw new WorkflowParseError(`Workflow meta.phases[${index}] must be an object.`);
    const title = requireString(phase.title, `meta.phases[${index}].title`);
    const validated: WorkflowPhase = { title };
    if (phase.detail !== undefined)
      validated.detail = requireString(phase.detail, `meta.phases[${index}].detail`);
    if (phase.model !== undefined)
      validated.model = requireString(phase.model, `meta.phases[${index}].model`);
    return validated;
  });
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new WorkflowParseError(`Workflow ${path} must be a string.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDeterministic(nodes: any[]): void {
  for (const node of nodes) {
    walk(node, (current) => {
      if (isMemberCall(current, "Date", "now")) {
        throw new WorkflowParseError(
          "Workflow scripts must not call Date.now(); pass timestamps through args instead.",
        );
      }
      if (isMemberCall(current, "Math", "random")) {
        throw new WorkflowParseError(
          "Workflow scripts must not call Math.random(); use stable indexes instead.",
        );
      }
      if (
        current.type === "NewExpression" &&
        current.callee?.type === "Identifier" &&
        current.callee.name === "Date" &&
        current.arguments.length === 0
      ) {
        throw new WorkflowParseError(
          "Workflow scripts must not call argument-less new Date(); pass timestamps through args instead.",
        );
      }
    });
  }
}

function isMemberCall(node: any, objectName: string, propertyName: string): boolean {
  return (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === objectName &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === propertyName
  );
}

function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);

  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walk(child, visit);
    }
  }
}

import vm from "node:vm";
import { parse } from "acorn";

export interface WorkflowMeta {
	name: string;
	description: string;
	phases?: Array<{ title: string; description?: string }>;
	[key: string]: unknown;
}

export interface RuntimePhaseEvent {
	title: string;
}

export interface AgentStartEvent {
	id: number;
	label: string;
	phase?: string;
	prompt: string;
}

export interface AgentEndEvent {
	id: number;
	label: string;
	phase?: string;
	result: unknown;
	error?: Error;
}

export interface AgentActivityEvent {
	id: number;
	label: string;
	type: "text" | "tool" | "log";
	text?: string;
	toolName?: string;
	argsPreview?: string;
}

export interface WorkflowAgentLike {
	run(prompt: string, options?: WorkflowAgentRunOptions): Promise<unknown>;
}

export interface WorkflowAgentRunOptions {
	label?: string;
	schema?: unknown;
	signal?: AbortSignal;
	instructions?: string;
	onActivity?: (event: Omit<AgentActivityEvent, "id" | "label">) => void;
}

export interface RunWorkflowOptions {
	cwd?: string;
	args?: unknown;
	signal?: AbortSignal;
	agent?: WorkflowAgentLike;
	session?: unknown;
	concurrency?: number;
	maxEstimatedTokens?: number;
	onPhase?: (title: string) => void;
	onLog?: (message: string) => void;
	onAgentStart?: (event: AgentStartEvent) => void;
	onAgentEnd?: (event: AgentEndEvent) => void;
	onAgentActivity?: (event: AgentActivityEvent) => void;
}

export interface WorkflowResult {
	meta: WorkflowMeta;
	result: unknown;
	phases: string[];
	logs: string[];
	agentCount: number;
	estimatedTokens: number;
}

interface RuntimeState {
	currentPhase?: string;
	logs: string[];
	phases: string[];
	agentCount: number;
	nextAgentId: number;
	spent: number;
}

type AnyNode = Record<string, any>;

const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseWorkflowScript(script: string): {
	meta: WorkflowMeta;
	body: string;
} {
	let ast: AnyNode;
	try {
		ast = parse(script, {
			ecmaVersion: "latest",
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
		}) as AnyNode;
	} catch (error) {
		throw new Error(
			`Failed to parse workflow script: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	assertDeterministicAst(ast);

	const first = ast.body?.[0] as AnyNode | undefined;
	if (first?.type !== "ExportNamedDeclaration") {
		throw new Error(
			"`export const meta = { name, description }` must be the first statement",
		);
	}

	const declaration = first.declaration as AnyNode | undefined;
	if (
		declaration?.type !== "VariableDeclaration" ||
		declaration.kind !== "const" ||
		declaration.declarations?.length !== 1
	) {
		throw new Error(
			"workflow metadata must be exactly `export const meta = { ... }`",
		);
	}

	const declarator = declaration.declarations[0] as AnyNode | undefined;
	if (declarator?.id?.type !== "Identifier" || declarator.id.name !== "meta") {
		throw new Error("workflow metadata export must be named `meta`");
	}

	const value = evaluateLiteralNode(declarator.init, "meta");
	if (!isPlainRecord(value))
		throw new Error("workflow metadata must be a literal object");
	const meta = value as WorkflowMeta;
	validateWorkflowMeta(meta);

	return {
		meta,
		body: `${script.slice(0, first.start ?? 0)}${script.slice(first.end ?? 0)}`,
	};
}

function validateWorkflowMeta(meta: WorkflowMeta): void {
	if (
		typeof meta.name !== "string" ||
		!/^[a-z][a-z0-9_]{1,63}$/.test(meta.name)
	) {
		throw new Error(
			"workflow meta.name must be short snake_case starting with a lowercase letter",
		);
	}
	if (
		typeof meta.description !== "string" ||
		meta.description.trim().length === 0
	) {
		throw new Error("workflow meta.description must be a non-empty string");
	}
	if (meta.phases !== undefined) {
		if (!Array.isArray(meta.phases))
			throw new Error("workflow meta.phases must be an array when provided");
		for (const phase of meta.phases) {
			if (
				!isPlainRecord(phase) ||
				typeof phase.title !== "string" ||
				phase.title.trim().length === 0
			) {
				throw new Error(
					"workflow meta.phases entries must include a non-empty literal title",
				);
			}
		}
	}
}

function evaluateLiteralNode(
	node: AnyNode | null | undefined,
	path: string,
): unknown {
	if (!node) throw new Error(`${path} is missing`);
	switch (node.type) {
		case "Literal":
			return node.value;
		case "TemplateLiteral": {
			if (node.expressions.length !== 0)
				throw new Error(`${path} template literal must not interpolate values`);
			return node.quasis
				.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw)
				.join("");
		}
		case "ObjectExpression": {
			const output: Record<string, unknown> = Object.create(null);
			for (const property of node.properties as AnyNode[]) {
				if (property.type === "SpreadElement")
					throw new Error(`${path} must not use object spreads`);
				if (property.type !== "Property")
					throw new Error(
						`${path} contains unsupported object property ${property.type}`,
					);
				if (property.kind !== "init" || property.method)
					throw new Error(`${path} must only contain data properties`);
				const key = getObjectKey(property, path);
				if (RESERVED_OBJECT_KEYS.has(key))
					throw new Error(`${path} must not contain reserved key ${key}`);
				output[key] = evaluateLiteralNode(property.value, `${path}.${key}`);
			}
			return output;
		}
		case "ArrayExpression":
			return (node.elements as Array<AnyNode | null>).map((element, index) => {
				if (!element)
					throw new Error(`${path}[${index}] must not be a sparse array hole`);
				return evaluateLiteralNode(element, `${path}[${index}]`);
			});
		case "UnaryExpression": {
			const value = evaluateLiteralNode(node.argument, path);
			if (typeof value !== "number")
				throw new Error(`${path} unary expression must target a number`);
			if (node.operator === "-") return -value;
			if (node.operator === "+") return value;
			throw new Error(`${path} unsupported unary operator ${node.operator}`);
		}
		default:
			throw new Error(`${path} contains non-literal node type ${node.type}`);
	}
}

function getObjectKey(property: AnyNode, path: string): string {
	if (property.computed)
		throw new Error(`${path} must not use computed object keys`);
	const key = property.key;
	if (key.type === "Identifier") return key.name;
	if (key.type === "Literal" && typeof key.value === "string") return key.value;
	throw new Error(`${path} contains unsupported object key ${key.type}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertDeterministicAst(ast: AnyNode): void {
	walkAst(ast, (node) => {
		if (node.type === "CallExpression") {
			const callee = node.callee as AnyNode;
			const member = staticMember(callee);
			if (member?.object === "Date" && member.property === "now") {
				throw new Error(
					"workflow scripts must be deterministic; Date.now() is not allowed",
				);
			}
			if (member?.object === "Math" && member.property === "random") {
				throw new Error(
					"workflow scripts must be deterministic; Math.random() is not allowed",
				);
			}
		}
		if (
			node.type === "NewExpression" &&
			node.callee?.type === "Identifier" &&
			node.callee.name === "Date"
		) {
			throw new Error(
				"workflow scripts must be deterministic; new Date() is not allowed",
			);
		}
	});
}

function staticMember(
	node: AnyNode,
): { object: string; property: string } | undefined {
	if (node.type !== "MemberExpression") return undefined;
	if (node.object?.type !== "Identifier") return undefined;
	const property = staticPropertyName(node);
	return property ? { object: node.object.name, property } : undefined;
}

function staticPropertyName(node: AnyNode): string | undefined {
	if (!node.computed && node.property?.type === "Identifier")
		return node.property.name;
	return staticString(node.property);
}

function staticString(node: AnyNode | undefined): string | undefined {
	if (!node) return undefined;
	if (node.type === "Literal" && typeof node.value === "string")
		return node.value;
	if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis
			.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw)
			.join("");
	}
	if (node.type === "BinaryExpression" && node.operator === "+") {
		const left = staticString(node.left);
		const right = staticString(node.right);
		return left !== undefined && right !== undefined ? left + right : undefined;
	}
	return undefined;
}

function walkAst(node: AnyNode, visit: (node: AnyNode) => void): void {
	visit(node);
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) {
			for (const child of value)
				if (child && typeof child.type === "string") walkAst(child, visit);
		} else if (
			value &&
			typeof value === "object" &&
			typeof (value as AnyNode).type === "string"
		) {
			walkAst(value as AnyNode, visit);
		}
	}
}

export async function runWorkflow(
	script: string,
	options: RunWorkflowOptions = {},
): Promise<WorkflowResult> {
	const parsed = parseWorkflowScript(script);
	const state: RuntimeState = {
		logs: [],
		phases: [],
		agentCount: 0,
		nextAgentId: 1,
		spent: 0,
	};
	const pendingAgentRuns = new Set<Promise<unknown>>();
	const concurrency = Math.max(
		1,
		Math.min(
			options.concurrency ??
				Math.max(
					1,
					((globalThis.navigator?.hardwareConcurrency ?? 8) as number) - 2,
				),
			16,
		),
	);
	const limiter = createLimiter(concurrency, options.signal);
	const agentRunner = options.agent ?? createDefaultWorkflowAgent(options);
	const maxEstimatedTokens = options.maxEstimatedTokens ?? 80_000;

	const throwIfAborted = () => {
		if (options.signal?.aborted) throw new Error("Workflow was aborted");
	};

	const log = (message: unknown) => {
		const text = String(message);
		state.logs.push(text);
		options.onLog?.(text);
	};

	const phase = (title: unknown) => {
		const text = requireString(title, "phase title");
		state.currentPhase = text;
		if (!state.phases.includes(text)) state.phases.push(text);
		options.onPhase?.(text);
	};

	const budget = Object.freeze({
		get spent() {
			return state.spent;
		},
		get max() {
			return maxEstimatedTokens;
		},
		get remaining() {
			return Math.max(0, maxEstimatedTokens - state.spent);
		},
	});

	const agent = (prompt: unknown, agentOptions: unknown = {}) => {
		throwIfAborted();
		if (state.spent >= maxEstimatedTokens)
			throw new Error("workflow estimated token budget exceeded");
		const taskPrompt = requireString(prompt, "agent prompt");
		const normalizedOptions = normalizeAgentOptions(agentOptions);
		const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
		const id = state.nextAgentId++;
		const label =
			normalizedOptions.label || defaultAgentLabel(assignedPhase, id);

		const run = limiter(async () => {
			throwIfAborted();
			state.agentCount++;
			options.onAgentStart?.({
				id,
				label,
				phase: assignedPhase,
				prompt: taskPrompt,
			});
			try {
				const result = await agentRunner.run(taskPrompt, {
					label,
					schema: normalizedOptions.schema,
					signal: options.signal,
					instructions: buildAgentInstructions(
						assignedPhase,
						normalizedOptions,
					),
					onActivity: (activity) =>
						options.onAgentActivity?.({ id, label, ...activity }),
				});
				state.spent += estimateTokens(result);
				options.onAgentEnd?.({ id, label, phase: assignedPhase, result });
				return result;
			} catch (error) {
				if (options.signal?.aborted) throw error;
				const actualError =
					error instanceof Error ? error : new Error(String(error));
				log(`agent ${label} failed: ${actualError.message}`);
				options.onAgentEnd?.({
					id,
					label,
					phase: assignedPhase,
					result: null,
					error: actualError,
				});
				return null;
			}
		});

		pendingAgentRuns.add(run);
		run.finally(() => pendingAgentRuns.delete(run));
		return run;
	};

	const parallel = async (thunks: unknown) => {
		throwIfAborted();
		if (!Array.isArray(thunks))
			throw new TypeError("parallel() expects an array of functions");
		if (thunks.some((thunk) => typeof thunk !== "function")) {
			throw new TypeError(
				"parallel() expects an array of functions, not promises.",
			);
		}
		return Promise.all(
			thunks.map(async (thunk, index) => {
				try {
					return await (thunk as () => Promise<unknown>)();
				} catch (error) {
					if (options.signal?.aborted) throw error;
					log(
						`parallel[${index}] failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				}
			}),
		);
	};

	const pipeline = async (items: unknown, ...stages: unknown[]) => {
		throwIfAborted();
		if (!Array.isArray(items))
			throw new TypeError("pipeline() expects an array");
		if (stages.some((stage) => typeof stage !== "function"))
			throw new TypeError("pipeline() stages must be functions");
		return Promise.all(
			items.map(async (item, index) => {
				let value = item;
				for (const stage of stages as Array<
					(value: unknown, item: unknown, index: number) => Promise<unknown>
				>) {
					try {
						value = await stage(value, item, index);
					} catch (error) {
						if (options.signal?.aborted) throw error;
						log(
							`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`,
						);
						return null;
					}
				}
				return value;
			}),
		);
	};

	const wrapped = `(async () => {\n${parsed.body}\n})()`;
	const context = vm.createContext(
		{
			agent,
			parallel,
			pipeline,
			log,
			phase,
			args: options.args,
			cwd: options.cwd ?? process.cwd(),
			process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
			budget,
			console: Object.freeze({
				log,
				info: log,
				warn: (message: unknown) => log(`[warn] ${String(message)}`),
				error: (message: unknown) => log(`[error] ${String(message)}`),
			}),
			JSON,
			Math,
			Array,
			Object,
			String,
			Number,
			Boolean,
			Set,
			Map,
			Promise,
		},
		{ codeGeneration: { strings: false, wasm: false } },
	);

	throwIfAborted();
	const result = await new vm.Script(wrapped, {
		filename: `${parsed.meta.name}.workflow.js`,
	}).runInContext(context, {
		timeout: 1000,
	});

	await Promise.allSettled([...pendingAgentRuns]);
	const clonedResult = assertStructuredCloneable(result, "workflow result");
	return {
		meta: parsed.meta,
		result: clonedResult,
		phases: [...state.phases],
		logs: [...state.logs],
		agentCount: state.agentCount,
		estimatedTokens: state.spent,
	};
}

function createDefaultWorkflowAgent(
	options: RunWorkflowOptions,
): WorkflowAgentLike {
	return {
		async run(prompt, agentOptions) {
			const { WorkflowAgent } = await import("./agent.js");
			const agent = new WorkflowAgent({
				cwd: options.cwd,
				session: options.session as any,
			});
			return agent.run(prompt, agentOptions);
		},
	};
}

function normalizeAgentOptions(value: unknown): {
	label?: string;
	phase?: string;
	agentType?: string;
	model?: string;
	isolation?: string;
	schema?: unknown;
	instructions?: string;
} {
	if (value === undefined || value === null) return {};
	if (!isPlainRecord(value))
		throw new TypeError("agent options must be an object");
	return {
		label: typeof value.label === "string" ? value.label : undefined,
		phase: typeof value.phase === "string" ? value.phase : undefined,
		agentType:
			typeof value.agentType === "string" ? value.agentType : undefined,
		model: typeof value.model === "string" ? value.model : undefined,
		isolation:
			typeof value.isolation === "string" ? value.isolation : undefined,
		schema: value.schema,
		instructions:
			typeof value.instructions === "string" ? value.instructions : undefined,
	};
}

function buildAgentInstructions(
	phase: string | undefined,
	options: ReturnType<typeof normalizeAgentOptions>,
): string | undefined {
	const lines: string[] = [];
	if (phase) lines.push(`Workflow phase: ${phase}.`);
	if (options.agentType)
		lines.push(`Act as this subagent type: ${options.agentType}.`);
	if (options.model) lines.push(`Requested model hint: ${options.model}.`);
	if (options.isolation)
		lines.push(`Requested isolation hint: ${options.isolation}.`);
	if (options.instructions) lines.push(options.instructions);
	if (options.schema)
		lines.push(
			"Return your final answer by calling the structured_output tool exactly once.",
		);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function defaultAgentLabel(phase: string | undefined, id: number): string {
	return phase ? `${phase} agent ${id}` : `agent ${id}`;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function assertStructuredCloneable(value: unknown, label: string): unknown {
	try {
		return structuredClone(value);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${label} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()? ${reason}`,
		);
	}
}

function createLimiter(limit: number, signal?: AbortSignal) {
	let active = 0;
	const queue: Array<() => void> = [];

	const next = () => {
		active--;
		queue.shift()?.();
	};

	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (signal?.aborted) throw new Error("Workflow was aborted");
		if (active >= limit) {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => reject(new Error("Workflow was aborted"));
				if (signal) signal.addEventListener("abort", onAbort, { once: true });
				queue.push(() => {
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve();
				});
			});
		}
		if (signal?.aborted) throw new Error("Workflow was aborted");
		active++;
		try {
			return await fn();
		} finally {
			next();
		}
	};
}

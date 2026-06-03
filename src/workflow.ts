import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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
	model?: string;
	cached?: boolean;
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

export interface WorkflowJournalStartedRecord {
	type: "started";
	key: string;
	agentId: number;
	label: string;
	phase?: string;
	prompt: string;
}

export interface WorkflowJournalResultRecord {
	type: "result";
	key: string;
	agentId: number;
	result: unknown;
}

export interface WorkflowJournalCachedResult {
	result: unknown;
}

export interface WorkflowJournal {
	getResult(key: string): WorkflowJournalCachedResult | undefined;
	appendStarted(record: WorkflowJournalStartedRecord): void;
	appendResult(record: WorkflowJournalResultRecord): void;
}

export interface RunWorkflowOptions {
	cwd?: string;
	args?: unknown;
	signal?: AbortSignal;
	agent?: WorkflowAgentLike;
	journal?: WorkflowJournal;
	session?: unknown;
	concurrency?: number;
	maxEstimatedTokens?: number;
	onPhase?: (title: string) => void;
	onLog?: (message: string) => void;
	onAgentStart?: (event: AgentStartEvent) => void;
	onAgentEnd?: (event: AgentEndEvent) => void;
	onAgentActivity?: (event: AgentActivityEvent) => void;
	timeoutMs?: number;
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
const JOURNAL_KEY_VERSION = "v1";
const JOURNAL_MISSING = Symbol("workflow-journal-missing");
const DETERMINISTIC_MATH = Object.freeze(
	Object.assign(
		Object.create(null),
		Object.fromEntries(
			Object.getOwnPropertyNames(Math).map((name) => {
				if (name === "random")
					return [name, forbiddenDeterminismApi(name, "Math")];
				const value = (Math as unknown as Record<string, unknown>)[name];
				return [
					name,
					typeof value === "function"
						? forbidConstructorEscape(value.bind(Math))
						: value,
				];
			}),
		),
	),
);
const DETERMINISTIC_DATE = Object.freeze(
	Object.assign(Object.create(null), {
		now: forbiddenDeterminismApi("now", "Date"),
		parse: forbidConstructorEscape(Date.parse.bind(Date)),
		UTC: forbidConstructorEscape(Date.UTC.bind(Date)),
	}),
);

function forbiddenDeterminismApi(name: string, object: string): () => never {
	return forbidConstructorEscape(() => {
		throw new Error(
			`workflow scripts must be deterministic; ${object}.${name}() is not allowed`,
		);
	});
}

function forbidConstructorEscape<T extends (...args: any[]) => unknown>(
	fn: T,
): T {
	if (Object.hasOwn(fn, "constructor")) return fn;
	Object.defineProperty(fn, "constructor", {
		value: () => {
			throw new Error("constructor escape is not allowed in workflow scripts");
		},
		writable: false,
		configurable: false,
	});
	return fn;
}

export function createInMemoryWorkflowJournal(): WorkflowJournal {
	const results = new Map<string, unknown>();
	return {
		getResult(key) {
			return results.has(key) ? { result: results.get(key) } : undefined;
		},
		appendStarted() {},
		appendResult(record) {
			results.set(record.key, record.result);
		},
	};
}

export function createFileWorkflowJournal(path: string): WorkflowJournal {
	mkdirSync(dirname(path), { recursive: true });
	const results = new Map<string, unknown>();
	if (existsSync(path)) {
		for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			const record = JSON.parse(line) as
				| WorkflowJournalStartedRecord
				| WorkflowJournalResultRecord;
			if (record.type === "result") results.set(record.key, record.result);
		}
	}
	const append = (
		record: WorkflowJournalStartedRecord | WorkflowJournalResultRecord,
	) => {
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	};
	return {
		getResult(key) {
			return results.has(key) ? { result: results.get(key) } : undefined;
		},
		appendStarted(record) {
			append(record);
		},
		appendResult(record) {
			results.set(record.key, record.result);
			append(record);
		},
	};
}

export function computeWorkflowAgentKey(
	prompt: string,
	previousKey: string,
	options: {
		agentType?: string;
		model?: string;
		isolation?: string;
		schema?: unknown;
		instructions?: string;
	},
): string {
	const canonicalOptions = stableStringify({
		agentType: options.agentType,
		instructions: options.instructions,
		isolation: options.isolation,
		model: options.model,
		schema: options.schema,
	});
	const digest = createHash("sha256")
		.update(prompt)
		.update("\0")
		.update(previousKey)
		.update("\0")
		.update(canonicalOptions)
		.digest("hex");
	return `${JOURNAL_KEY_VERSION}:${digest}`;
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortForJson(value));
}

function sortForJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortForJson);
	if (!isPlainRecord(value)) return value;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (item !== undefined) output[key] = sortForJson(item);
	}
	return output;
}

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
	let previousJournalKey = "";
	let journalDiverged = false;
	let stoppedError: Error | undefined;

	const throwIfAborted = () => {
		if (options.signal?.aborted) throw new Error("Workflow was aborted");
		if (stoppedError) throw stoppedError;
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

	const getBudgetSpent = forbidConstructorEscape(() => state.spent);
	const getBudgetMax = forbidConstructorEscape(() => maxEstimatedTokens);
	const getBudgetRemaining = forbidConstructorEscape(() =>
		Math.max(0, maxEstimatedTokens - state.spent),
	);
	const budget = Object.freeze(
		Object.defineProperties(Object.create(null), {
			spent: { enumerable: true, get: getBudgetSpent },
			max: { enumerable: true, get: getBudgetMax },
			remaining: { enumerable: true, get: getBudgetRemaining },
		}),
	);

	const agent = (prompt: unknown, agentOptions: unknown = {}) => {
		throwIfAborted();
		if (state.spent >= maxEstimatedTokens)
			throw new Error("workflow estimated token budget exceeded");
		const taskPrompt = requireString(prompt, "agent prompt");
		const normalizedOptions = normalizeAgentOptions(agentOptions);
		const assignedPhase = normalizedOptions.phase ?? state.currentPhase;
		const id = state.nextAgentId++;
		state.agentCount++;
		const label =
			normalizedOptions.label || defaultAgentLabel(assignedPhase, id);
		const journalKey = computeWorkflowAgentKey(
			taskPrompt,
			previousJournalKey,
			normalizedOptions,
		);
		previousJournalKey = journalKey;

		const cached = !journalDiverged
			? (options.journal?.getResult(journalKey) ?? JOURNAL_MISSING)
			: JOURNAL_MISSING;
		if (cached !== JOURNAL_MISSING) {
			options.onAgentStart?.({
				id,
				label,
				phase: assignedPhase,
				prompt: taskPrompt,
				model: normalizedOptions.model,
				cached: true,
			});
			try {
				const result = assertJsonSerializable(cached.result, "agent result");
				options.onAgentEnd?.({
					id,
					label,
					phase: assignedPhase,
					result,
				});
				return Promise.resolve(result);
			} catch (error) {
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
				return Promise.reject(actualError);
			}
		}
		if (options.journal) journalDiverged = true;

		const run = limiter(async () => {
			throwIfAborted();
			options.journal?.appendStarted({
				type: "started",
				key: journalKey,
				agentId: id,
				label,
				phase: assignedPhase,
				prompt: taskPrompt,
			});
			options.onAgentStart?.({
				id,
				label,
				phase: assignedPhase,
				prompt: taskPrompt,
				model: normalizedOptions.model,
			});
			try {
				const rawResult = await agentRunner.run(taskPrompt, {
					label,
					schema: normalizedOptions.schema,
					signal: options.signal,
					instructions: buildAgentInstructions(
						assignedPhase,
						normalizedOptions,
					),
					onActivity: (activity) => {
						if (options.signal?.aborted || stoppedError) return;
						options.onAgentActivity?.({ id, label, ...activity });
					},
				});
				throwIfAborted();
				const result = assertJsonSerializable(rawResult, "agent result");
				state.spent += estimateTokens(result, "agent result");
				options.journal?.appendResult({
					type: "result",
					key: journalKey,
					agentId: id,
					result,
				});
				options.onAgentEnd?.({ id, label, phase: assignedPhase, result });
				return result;
			} catch (error) {
				if (options.signal?.aborted || stoppedError) throw error;
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
				throw actualError;
			}
		});

		pendingAgentRuns.add(run);
		run.then(
			() => pendingAgentRuns.delete(run),
			() => pendingAgentRuns.delete(run),
		);
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
			thunks.map(async (thunk) => await (thunk as () => Promise<unknown>)()),
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
					value = await stage(value, item, index);
				}
				return value;
			}),
		);
	};

	const wrapped = `(async () => {\n${parsed.body}\n})()`;
	const cwdValue = options.cwd ?? process.cwd();
	const processFacade = Object.freeze(
		Object.assign(Object.create(null), {
			cwd: forbidConstructorEscape(() => cwdValue),
		}),
	);
	const consoleFacade = Object.freeze(
		Object.assign(Object.create(null), {
			log: forbidConstructorEscape(log),
			info: forbidConstructorEscape(log),
			warn: forbidConstructorEscape((message: unknown) =>
				log(`[warn] ${String(message)}`),
			),
			error: forbidConstructorEscape((message: unknown) =>
				log(`[error] ${String(message)}`),
			),
		}),
	);
	const workflowArgsJson =
		options.args === undefined
			? undefined
			: safeJsonStringify(options.args, "workflow args");
	const context = vm.createContext(
		{
			agent: forbidConstructorEscape(agent),
			parallel: forbidConstructorEscape(parallel),
			pipeline: forbidConstructorEscape(pipeline),
			log: forbidConstructorEscape(log),
			phase: forbidConstructorEscape(phase),
			args: undefined,
			__workflowArgsJson: workflowArgsJson,
			cwd: cwdValue,
			process: processFacade,
			budget,
			console: consoleFacade,
			Date: DETERMINISTIC_DATE,
			Math: DETERMINISTIC_MATH,
		},
		{ codeGeneration: { strings: false, wasm: false } },
	);
	new vm.Script(
		"if (globalThis.__workflowArgsJson !== undefined) globalThis.args = JSON.parse(globalThis.__workflowArgsJson); delete globalThis.__workflowArgsJson;",
	).runInContext(context, { timeout: 1000 });

	throwIfAborted();
	const vmResult = Promise.resolve(
		new vm.Script(wrapped, {
			filename: `${parsed.meta.name}.workflow.js`,
		}).runInContext(context, {
			timeout: 1000,
		}),
	);
	const result = await raceWithAbortAndTimeout(vmResult, options, (error) => {
		stoppedError = error;
	});

	await Promise.allSettled([...pendingAgentRuns]);
	const jsonResult = assertJsonSerializable(result, "workflow result");
	const clonedResult = assertStructuredCloneable(jsonResult, "workflow result");
	return {
		meta: parsed.meta,
		result: clonedResult,
		phases: [...state.phases],
		logs: [...state.logs],
		agentCount: state.agentCount,
		estimatedTokens: state.spent,
	};
}

function raceWithAbortAndTimeout<T>(
	promise: Promise<T>,
	options: Pick<RunWorkflowOptions, "signal" | "timeoutMs">,
	onStop?: (error: Error) => void,
): Promise<T> {
	if (!options.signal && options.timeoutMs === undefined) return promise;
	if (options.signal?.aborted) {
		const error = new Error("Workflow was aborted");
		onStop?.(error);
		return Promise.reject(error);
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = <V>(fn: (value: V) => void, value: V) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn(value);
		};
		const stop = (message: string) => {
			const error = new Error(message);
			onStop?.(error);
			finish(reject, error);
		};
		const onAbort = () => stop("Workflow was aborted");

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) {
			timeout = setTimeout(
				() => stop(`Workflow timed out after ${options.timeoutMs}ms`),
				options.timeoutMs,
			);
		}
		promise.then(
			(value) => finish(resolve, value),
			(error) =>
				finish(
					reject,
					error instanceof Error ? error : new Error(String(error)),
				),
		);
	});
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

function estimateTokens(value: unknown, label: string): number {
	return Math.ceil(safeJsonStringify(value ?? "", label).length / 4);
}

export function safeJsonStringify(
	value: unknown,
	label: string,
	space?: string | number,
): string {
	assertJsonSerializable(value, label);
	try {
		const text = JSON.stringify(value, null, space);
		if (text === undefined) {
			if (label === "agent result" && value === undefined) return "";
			throw new TypeError("JSON.stringify returned undefined");
		}
		return text;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${label} must be JSON-serializable; ${reason}`);
	}
}

export function assertJsonSerializable<T>(value: T, label: string): T {
	const visit = (item: unknown, path: string, ancestors: WeakSet<object>) => {
		switch (typeof item) {
			case "string":
			case "boolean":
				return;
			case "number":
				if (!Number.isFinite(item)) {
					throw new Error(
						`${label} must be JSON-serializable; ${path} must be a finite number`,
					);
				}
				return;
			case "bigint":
				throw new Error(
					`${label} must be JSON-serializable; ${path} is a bigint`,
				);
			case "function":
				throw new Error(
					`${label} must be JSON-serializable; ${path} is a function`,
				);
			case "symbol":
				throw new Error(
					`${label} must be JSON-serializable; ${path} is a symbol`,
				);
			case "undefined":
				if (label === "agent result" && path === "$") return;
				throw new Error(
					`${label} must be JSON-serializable; ${path} is undefined`,
				);
			case "object":
				break;
		}

		if (item === null) return;
		if (isPromiseLike(item)) {
			if (label === "workflow result") {
				throw new Error(
					`${label} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()? ${path} is a Promise`,
				);
			}
			throw new Error(
				`${label} must be JSON-serializable; ${path} is a Promise`,
			);
		}
		if (ancestors.has(item)) {
			throw new Error(
				`${label} must be JSON-serializable; ${path} contains a cycle`,
			);
		}

		ancestors.add(item);
		if (Array.isArray(item)) {
			for (let index = 0; index < item.length; index++) {
				if (!(index in item)) {
					throw new Error(
						`${label} must be JSON-serializable; ${path}[${index}] is a sparse array hole`,
					);
				}
				visit(item[index], `${path}[${index}]`, ancestors);
			}
		} else {
			for (const key of Reflect.ownKeys(item)) {
				if (typeof key === "symbol") {
					throw new Error(
						`${label} must be JSON-serializable; ${path} has a symbol key`,
					);
				}
				if (!Object.prototype.propertyIsEnumerable.call(item, key)) continue;
				visit(
					(item as Record<string, unknown>)[key],
					`${path}.${key}`,
					ancestors,
				);
			}
		}
		ancestors.delete(item);
	};

	visit(value, "$", new WeakSet<object>());
	return value;
}

function isPromiseLike(value: object): boolean {
	return typeof (value as { then?: unknown }).then === "function";
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

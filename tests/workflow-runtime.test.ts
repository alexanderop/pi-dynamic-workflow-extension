import assert from "node:assert/strict";
import test from "node:test";
import {
	createInMemoryWorkflowJournal,
	runWorkflow,
	type WorkflowAgentLike,
} from "../src/workflow.js";

const fakeAgent: WorkflowAgentLike = {
	async run(prompt: string): Promise<string> {
		return `result:${prompt}`;
	},
};

async function rejectIfStillPending<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`promise still pending after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

test("runWorkflow executes an agent with runtime phases", async () => {
	const result = await runWorkflow(
		`export const meta = {
  name: 'dynamic_demo',
  description: 'Use runtime phases'
}

phase('Scan')
const scan = await agent('scan', { label: 'scan' })
return { scan }
`,
		{ agent: fakeAgent },
	);

	assert.deepEqual(result.phases, ["Scan"]);
	assert.equal(result.agentCount, 1);
	assert.deepEqual(result.result, { scan: "result:scan" });
});

test("runWorkflow supports parallel thunks in input order", async () => {
	const result = await runWorkflow(
		`export const meta = { name: 'parallel_demo', description: 'demo' }
phase('Check')
const items = ['a', 'b', 'c']
const out = await parallel(items.map(item => () => agent('check ' + item)))
return out
`,
		{ agent: fakeAgent, concurrency: 2 },
	);

	assert.deepEqual(result.result, [
		"result:check a",
		"result:check b",
		"result:check c",
	]);
	assert.equal(result.agentCount, 3);
});

test("runWorkflow supports pipeline stages", async () => {
	const result = await runWorkflow(
		`export const meta = { name: 'pipeline_demo', description: 'demo' }
const out = await pipeline(
  ['a', 'b'],
  (item) => agent('inspect ' + item),
  (inspection, item) => agent('summarize ' + item + ': ' + inspection)
)
return out
`,
		{ agent: fakeAgent, concurrency: 2 },
	);

	assert.deepEqual(result.result, [
		"result:summarize a: result:inspect a",
		"result:summarize b: result:inspect b",
	]);
});

test("runWorkflow rejects when an agent throws", async () => {
	const failingAgent: WorkflowAgentLike = {
		async run(): Promise<never> {
			throw new Error("boom");
		},
	};

	await assert.rejects(
		() =>
			runWorkflow(
				`export const meta = { name: 'agent_failure', description: 'demo' }
return await agent('inspect')
`,
				{ agent: failingAgent },
			),
		/boom/,
	);
});

test("runWorkflow rejects when a parallel agent branch throws", async () => {
	const failingAgent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			if (prompt === "bad") throw new Error("branch failed");
			return `ok:${prompt}`;
		},
	};

	await assert.rejects(
		() =>
			runWorkflow(
				`export const meta = { name: 'parallel_failure', description: 'demo' }
return await parallel(['ok', 'bad'].map(item => () => agent(item)))
`,
				{ agent: failingAgent, concurrency: 2 },
			),
		/branch failed/,
	);
});

test("runWorkflow rejects when a pipeline agent stage throws", async () => {
	const failingAgent: WorkflowAgentLike = {
		async run(prompt: string): Promise<string> {
			if (prompt === "bad") throw new Error("stage failed");
			return `ok:${prompt}`;
		},
	};

	await assert.rejects(
		() =>
			runWorkflow(
				`export const meta = { name: 'pipeline_failure', description: 'demo' }
return await pipeline(['bad'], item => agent(item))
`,
				{ agent: failingAgent },
			),
		/stage failed/,
	);
});

test("runWorkflow rejects when its signal aborts an async script that never resolves", async () => {
	const controller = new AbortController();
	const run = runWorkflow(
		`export const meta = { name: 'abort_never_resolves', description: 'demo' }
await new Promise(() => {})
`,
		{ signal: controller.signal },
	);

	setTimeout(() => controller.abort(), 5);

	await assert.rejects(
		() => rejectIfStillPending(run, 100),
		/Workflow was aborted/,
	);
});

test("runWorkflow rejects when timeoutMs expires during an async script that never resolves", async () => {
	const run = runWorkflow(
		`export const meta = { name: 'timeout_never_resolves', description: 'demo' }
await new Promise(() => {})
`,
		{ timeoutMs: 5 },
	);

	await assert.rejects(
		() => rejectIfStillPending(run, 100),
		/Workflow timed out after 5ms/,
	);
});

test("runWorkflow does not replay a failed agent as a cached null result", async () => {
	const journal = createInMemoryWorkflowJournal();
	let calls = 0;
	let fail = true;
	const agent: WorkflowAgentLike = {
		async run(): Promise<string> {
			calls++;
			if (fail) throw new Error("transient failure");
			return "fresh result";
		},
	};
	const script = `export const meta = { name: 'retry_failure', description: 'demo' }
return await agent('inspect')
`;

	await assert.rejects(
		() => runWorkflow(script, { agent, journal }),
		/transient/,
	);
	fail = false;
	const result = await runWorkflow(script, { agent, journal });

	assert.equal(calls, 2);
	assert.equal(result.result, "fresh result");
});

test("runWorkflow rejects forgotten awaits in the returned result", async () => {
	await assert.rejects(
		() =>
			runWorkflow(
				`export const meta = { name: 'forgot_await', description: 'demo' }
const scan = agent('scan')
return { scan }
`,
				{ agent: fakeAgent },
			),
		/did you forget to await/,
	);
});

test("runWorkflow rejects Math.random aliases at runtime", async () => {
	await assert.rejects(
		() =>
			runWorkflow(
				`export const meta = { name: 'random_alias', description: 'demo' }
const { random } = Math
return random()
`,
			),
		/workflow scripts must be deterministic.*Math\.random/s,
	);
});

test("runWorkflow rejects Date.now aliases at runtime", async () => {
	for (const item of [
		{ name: "date_alias", body: "const D = Date\nreturn D.now()" },
		{ name: "global_date", body: "return globalThis.Date.now()" },
	]) {
		await assert.rejects(
			() =>
				runWorkflow(
					`export const meta = { name: '${item.name}', description: 'demo' }\n${item.body}\n`,
				),
			/workflow scripts must be deterministic.*Date\.now/s,
		);
	}
});

test("runWorkflow blocks constructor attempts to access the host process", async () => {
	for (const item of [
		{
			name: "object_constructor_escape",
			body: 'return Object.constructor("return process")().versions.node',
		},
		{
			name: "agent_constructor_escape",
			body: 'return agent.constructor("return process")().versions.node',
		},
	]) {
		await assert.rejects(
			() =>
				runWorkflow(
					`export const meta = { name: '${item.name}', description: 'demo' }\n${item.body}\n`,
				),
			/constructor escape is not allowed|Code generation from strings disallowed|process is not defined/,
		);
	}
});

test("runWorkflow rejects non-JSON-serializable workflow results clearly", async () => {
	const cases = [
		{
			name: "bigint_result",
			body: "return 1n",
		},
		{
			name: "cyclic_result",
			body: "const out = {}; out.self = out; return out",
		},
		{
			name: "function_result",
			body: "return () => {}",
		},
	];

	for (const item of cases) {
		await assert.rejects(
			() =>
				runWorkflow(
					`export const meta = { name: '${item.name}', description: 'demo' }
await agent('inspect')
${item.body}
`,
					{ agent: fakeAgent },
				),
			/workflow result must be JSON-serializable/,
		);
	}
});

test("runWorkflow rejects non-JSON-serializable agent results clearly", async () => {
	const cases: Array<{ name: string; result: unknown }> = [
		{ name: "bigint_agent", result: 1n },
		{
			name: "cyclic_agent",
			result: (() => {
				const out: Record<string, unknown> = {};
				out.self = out;
				return out;
			})(),
		},
		{ name: "function_agent", result: () => {} },
	];

	for (const item of cases) {
		let agentError: Error | undefined;
		const agent: WorkflowAgentLike = {
			async run(): Promise<unknown> {
				return item.result;
			},
		};

		await assert.rejects(
			() =>
				runWorkflow(
					`export const meta = { name: '${item.name}', description: 'demo' }
return await agent('inspect')
`,
					{
						agent,
						onAgentEnd(event) {
							agentError = event.error;
						},
					},
				),
			/agent result must be JSON-serializable/,
		);
		assert.match(
			agentError?.message ?? "",
			/agent result must be JSON-serializable/,
		);
	}
});

test("runWorkflow reports conditional runtime phases only", async () => {
	const result = await runWorkflow(
		`export const meta = {
  name: 'conditional_demo',
  description: 'demo',
  phases: [{ title: 'Skipped' }, { title: 'Inspect API' }, { title: 'Inspect UI' }]
}
phase('Inspect API')
await agent('api')
if (args.includeUi) {
  phase('Inspect UI')
  await agent('ui')
}
return { ok: true }
`,
		{ agent: fakeAgent, args: { includeUi: true } },
	);

	assert.deepEqual(result.phases, ["Inspect API", "Inspect UI"]);
});

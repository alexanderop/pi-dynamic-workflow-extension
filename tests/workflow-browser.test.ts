import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
	WorkflowAgentSnapshot,
	WorkflowSnapshot,
} from "../src/display.js";
import { WorkflowBrowser } from "../src/workflow-browser.js";
import type { WorkflowJob, WorkflowManager } from "../src/workflow-manager.js";

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

function agent(
	overrides: Partial<WorkflowAgentSnapshot>,
): WorkflowAgentSnapshot {
	return {
		id: overrides.id ?? 1,
		label: overrides.label ?? "research_agent",
		phase: overrides.phase ?? "Research",
		prompt:
			overrides.prompt ??
			"Research public information and return a concise summary with evidence.",
		status: overrides.status ?? "done",
		activity: overrides.activity ?? [],
		...overrides,
	};
}

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	const agents = overrides.agents ?? [
		agent({ id: 1, label: "guardrails", phase: "Guardrails" }),
		agent({
			id: 2,
			label: "professional_presence",
			phase: "Research",
			status: "running",
			activity: [
				{ type: "tool", toolName: "read", argsPreview: "README.md" },
				{ type: "text", text: "Found project overview" },
			],
		}),
		agent({ id: 3, label: "technical_projects", phase: "Research" }),
	];
	return {
		name: "portfolio_research",
		description: "Research a portfolio",
		phases: ["Guardrails", "Research", "Synthesis"],
		currentPhase: "Research",
		logs: [],
		agents,
		agentCount: agents.length,
		runningCount: agents.filter((item) => item.status === "running").length,
		doneCount: agents.filter((item) => item.status === "done").length,
		errorCount: agents.filter((item) => item.status === "error").length,
		durationMs: 80_000,
		...overrides,
	};
}

function job(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
	return {
		id: 1,
		runId: "wf_test",
		name: "portfolio_research",
		description: "Research a portfolio",
		status: "running",
		script:
			"export const meta = { name: 'portfolio_research', description: 'x' };\nawait agent('x')",
		snapshot: snapshot(),
		startedAt: 0,
		...overrides,
	};
}

class FakeManager {
	cancelled: number[] = [];
	private listeners = new Set<(job: WorkflowJob) => void>();
	constructor(private jobs: WorkflowJob[]) {}
	getJobs(): WorkflowJob[] {
		return this.jobs;
	}
	onChange(listener: (job: WorkflowJob) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	cancel(id: number): boolean {
		this.cancelled.push(id);
		return true;
	}
}

function browser(manager = new FakeManager([job()])) {
	let renders = 0;
	let done = 0;
	const instance = new WorkflowBrowser(
		manager as unknown as WorkflowManager,
		{ requestRender: () => renders++ },
		theme,
		() => done++,
	);
	return {
		instance,
		manager,
		get renders() {
			return renders;
		},
		get done() {
			return done;
		},
	};
}

test("WorkflowBrowser renders phases, filtered agents, and details in a wide terminal", () => {
	const { instance } = browser();
	const lines = instance.render(124);
	const text = lines.join("\n");

	assert.match(text, /Phases/);
	assert.match(text, /Agents/);
	assert.match(text, /Detail/);
	assert.match(text, /Research 0\/2|Research 1\/2/);
	assert.match(text, /professional_presence/);
	assert.doesNotMatch(text, /guardrails\s+.*Running/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 124, line);

	instance.handleInput("q");
});

test("WorkflowBrowser arrow navigation moves focus then selects phase and agent", () => {
	const { instance } = browser();

	let text = instance.render(124).join("\n");
	assert.match(text, /› .*Research/);
	assert.match(text, /› .*professional_presence/);
	assert.doesNotMatch(text, /› .*guardrails/);

	instance.handleInput("\u001b[C"); // focus agents
	instance.handleInput("\u001b[B"); // select technical_projects within Research
	text = instance.render(124).join("\n");
	assert.match(text, /› .*technical_projects/);
	assert.match(text, /Agent: technical_projects/);

	instance.handleInput("\u001b[A"); // move back to professional_presence
	text = instance.render(124).join("\n");
	assert.match(text, /› .*professional_presence/);

	instance.handleInput("q");
});

test("WorkflowBrowser header keeps selected workflow and switch hint visible", () => {
	const jobs = Array.from({ length: 9 }, (_, index) =>
		job({
			id: index + 1,
			name: `very_long_completed_workflow_name_${index + 1}_with_extra_context`,
			status: index === 8 ? "running" : "done",
			snapshot: snapshot({
				name: `very_long_completed_workflow_name_${index + 1}_with_extra_context`,
			}),
		}),
	);
	const { instance } = browser(new FakeManager(jobs));
	const text = instance.render(96).join("\n");

	assert.match(text, /Runs 9\/9/);
	assert.match(text, /#9 very_long_completed_workflow_name_9/);
	assert.match(text, /p\/n or \[\/\]\/<> switch workflow/);
	for (const line of instance.render(96))
		assert.ok(visibleWidth(line) <= 96, line);

	instance.handleInput("q");
});

test("WorkflowBrowser keeps ANSI resets out of truncated selected workflow chip", () => {
	const jobs = Array.from({ length: 9 }, (_, index) =>
		job({
			id: index + 1,
			name: `very_long_completed_workflow_name_${index + 1}_with_extra_context`,
			status: index === 8 ? "running" : "done",
			snapshot: snapshot({
				name: `very_long_completed_workflow_name_${index + 1}_with_extra_context`,
			}),
		}),
	);
	const instance = new WorkflowBrowser(
		new FakeManager(jobs) as unknown as WorkflowManager,
		{ requestRender() {} },
		{
			fg(_color: string, text: string) {
				return `\u001b[35m${text}\u001b[39m`;
			},
			bold(text: string) {
				return `\u001b[1m${text}\u001b[22m`;
			},
		},
		() => {},
	);

	const strip = instance.render(96)[1] ?? "";
	const ansiEscape = String.fromCharCode(27);
	assert.equal(strip.includes(`${ansiEscape}[0m…${ansiEscape}[0m]`), false);
	assert.match(strip, /very_long_completed_workflow_name_9_with_e…\]/);
	assert.ok(visibleWidth(strip) <= 96, strip);

	instance.handleInput("q");
});

test("WorkflowBrowser renders workflow artifacts in the detail pane", () => {
	const { instance } = browser(
		new FakeManager([
			job({
				snapshot: snapshot({
					artifacts: [
						{
							name: "review.md",
							type: "markdown",
							description: "Human report",
							value: "# Review",
						},
					],
				}),
			}),
		]),
	);

	const text = instance.render(124).join("\n");
	assert.match(text, /Artifacts/);
	assert.match(text, /review\.md/);
	assert.match(text, /markdown/);
	assert.match(text, /Human report/);

	instance.handleInput("q");
});

test("WorkflowBrowser supports p and n workflow navigation", () => {
	const first = job({ id: 1, name: "first_workflow", status: "done" });
	const second = job({ id: 2, name: "second_workflow", status: "running" });
	const { instance } = browser(new FakeManager([first, second]));

	let text = instance.render(124).join("\n");
	assert.match(text, /Runs 2\/2/);
	assert.match(text, /Workflow: second_workflow|#2 second_workflow/);

	instance.handleInput("p");
	text = instance.render(124).join("\n");
	assert.match(text, /Runs 1\/2/);
	assert.match(text, /Workflow: first_workflow|#1 first_workflow/);

	instance.handleInput("n");
	text = instance.render(124).join("\n");
	assert.match(text, /Runs 2\/2/);
	assert.match(text, /Workflow: second_workflow|#2 second_workflow/);

	instance.handleInput("q");
});

test("WorkflowBrowser supports prompt expansion and detail scrolling", () => {
	const longPrompt = Array.from(
		{ length: 12 },
		(_, index) => `line ${index + 1}`,
	).join("\n");
	const { instance } = browser(
		new FakeManager([
			job({
				snapshot: snapshot({
					phases: ["Research"],
					agents: [
						agent({
							id: 1,
							phase: "Research",
							label: "long_prompt",
							prompt: longPrompt,
							activity: Array.from({ length: 14 }, (_, index) => ({
								type: "log" as const,
								text: `activity ${index + 1}`,
							})),
						}),
					],
				}),
			}),
		]),
	);

	let text = instance.render(124).join("\n");
	assert.match(text, /Prompt/);
	assert.match(text, /line 1/);
	assert.doesNotMatch(text, /line 8/);

	instance.handleInput("\r");
	text = instance.render(124).join("\n");
	assert.match(text, /line 8/);

	instance.handleInput("j");
	instance.handleInput("j");
	text = instance.render(124).join("\n");
	assert.match(text, /of \d+ ↓|of \d+ ↕|of \d+ ↑/);

	instance.handleInput("q");
});

test("WorkflowBrowser keeps narrow fallback within width", () => {
	const { instance } = browser();
	const lines = instance.render(48);
	assert.ok(lines.some((line) => line.includes("Phases")));
	for (const line of lines) assert.ok(visibleWidth(line) <= 48, line);
	instance.handleInput("q");
});

test("WorkflowBrowser dashboard shortcuts call selected workflow actions", () => {
	const selected = job({ id: 42, name: "selected_workflow" });
	const manager = new FakeManager([selected]);
	const calls: string[] = [];
	const { instance } = browser(manager);
	const actionable = new WorkflowBrowser(
		manager as unknown as WorkflowManager,
		{ requestRender: () => {} },
		theme,
		() => {},
		{
			save: (job) => calls.push(`save:${job.id}`),
			rerun: (job) => calls.push(`rerun:${job.id}`),
			resume: (job) => calls.push(`resume:${job.id}`),
		},
	);

	instance.handleInput("q");
	actionable.handleInput("s");
	actionable.handleInput("r");
	actionable.handleInput("R");
	actionable.handleInput("q");

	assert.deepEqual(calls, ["save:42", "rerun:42", "resume:42"]);
});

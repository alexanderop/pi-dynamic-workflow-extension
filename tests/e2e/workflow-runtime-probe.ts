import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowExtension } from "../../src/extension/register-workflow-extension.js";
import { formatWorkflowCompletion } from "../../src/extension/workflow-extension-format.js";
import { WorkflowBrowser } from "../../src/workflow-browser.js";
import { createFileWorkflowLibrary } from "../../src/workflow-library.js";
import { createFileWorkflowStore, createWorkflowManager } from "../../src/workflow-manager.js";
import { createWorkflowTool } from "../../src/workflow-tool.js";
import type { WorkflowAgentLike, WorkflowAgentRunOptions } from "../../src/workflow.js";

const SCRIPT = `export const meta = { name: 'e2e_runtime', description: 'Runtime end-to-end workflow' }
phase('Run')
log('started')
artifact('report.md', '# E2E OK', { type: 'markdown', description: 'E2E report' })
const answer = await agent('inspect ' + args.subject, { label: 'worker', phase: 'Run' })
return { ok: true, answer, subject: args.subject }
`;

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function waitForDone(predicate: () => boolean, describe: () => string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for workflow runtime e2e; ${describe()}`);
}

export default function workflowRuntimeProbe(pi: ExtensionAPI) {
	const agentCalls: Array<{ prompt: string; options?: WorkflowAgentRunOptions }> = [];
	const agent: WorkflowAgentLike = {
		async run(prompt, options) {
			agentCalls.push({ prompt, options });
			return "agent-ok";
		},
	};

	const manager = createWorkflowManager();
	const workflowTool = createWorkflowTool({ manager, agent });

	registerWorkflowExtension(pi, {
		manager,
		workflowTool,
		globalWorkflowLibrary: createFileWorkflowLibrary(requireEnv("PI_E2E_GLOBAL_WORKFLOWS")),
		createWorkflowStore(cwd) {
			return createFileWorkflowStore(join(cwd, ".pi", "workflows"));
		},
		createBrowser(browserManager, tui, theme, done, actions) {
			return new WorkflowBrowser(browserManager, tui, theme, done, actions);
		},
		formatCompletion: formatWorkflowCompletion,
		startOptions: { agent },
	});

	pi.registerCommand("e2e-run-workflow", {
		description: "Run a deterministic workflow through the real extension runtime",
		handler: async (_args, ctx) => {
			const outputPath = requireEnv("PI_E2E_OUT");
			await mkdir(dirname(outputPath), { recursive: true });

			const result = await workflowTool.execute(
				"e2e-call",
				{ script: SCRIPT, args: { subject: "tmp-project" } },
				undefined,
				undefined,
				ctx,
			);

			await waitForDone(
				() => manager.getJobs()[0]?.status !== "running",
				() => JSON.stringify(manager.getJobs().map((job) => ({ status: job.status, error: job.error }))),
			);

			const job = manager.getJobs()[0];
			if (!job) throw new Error("workflow job was not created");

			const manifestPath = join(ctx.cwd, ".pi", "workflows", job.runId, "manifest.json");
			const journalPath = join(ctx.cwd, ".pi", "workflows", job.runId, "journal.jsonl");
			const scriptPath = job.scriptPath;

			await writeFile(
				outputPath,
				`${JSON.stringify(
					{
						toolResultText: result.content?.[0]?.type === "text" ? result.content[0].text : undefined,
						job,
						agentCalls,
						persistence: {
							manifestPath,
							manifestExists: existsSync(manifestPath),
							manifestJobStatus: existsSync(manifestPath)
								? JSON.parse(readFileSync(manifestPath, "utf8")).status
								: undefined,
							journalPath,
							journalExists: existsSync(journalPath),
							scriptPath,
							scriptExists: scriptPath ? existsSync(scriptPath) : false,
						},
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
		},
	});
}

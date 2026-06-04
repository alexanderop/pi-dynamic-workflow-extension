import type { WorkflowAgentLike, WorkflowAgentRunOptions } from "../../src/workflow.js";

export interface FauxWorkflowAgent extends WorkflowAgentLike {
	calls: Array<{ prompt: string; options?: WorkflowAgentRunOptions }>;
	resolveAll(value?: unknown): void;
	rejectAll(error: Error): void;
}

export function createResolvingWorkflowAgent(result: unknown = "ok"): FauxWorkflowAgent {
	const calls: Array<{ prompt: string; options?: WorkflowAgentRunOptions }> = [];
	return {
		calls,
		async run(prompt, options) {
			calls.push({ prompt, options });
			return result;
		},
		resolveAll() {},
		rejectAll() {},
	};
}

export function createDeferredWorkflowAgent(): FauxWorkflowAgent {
	const calls: Array<{ prompt: string; options?: WorkflowAgentRunOptions }> = [];
	const pending = new Set<{
		resolve(value: unknown): void;
		reject(error: Error): void;
	}>();
	return {
		calls,
		run(prompt, options) {
			calls.push({ prompt, options });
			return new Promise((resolve, reject) => {
				const entry = { resolve, reject };
				pending.add(entry);
				const cleanup = () => pending.delete(entry);
				if (options?.signal?.aborted) {
					cleanup();
					reject(new Error("aborted"));
					return;
				}
				options?.signal?.addEventListener(
					"abort",
					() => {
						cleanup();
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		},
		resolveAll(value: unknown = "ok") {
			for (const entry of Array.from(pending)) {
				pending.delete(entry);
				entry.resolve(value);
			}
		},
		rejectAll(error: Error) {
			for (const entry of Array.from(pending)) {
				pending.delete(entry);
				entry.reject(error);
			}
		},
	};
}

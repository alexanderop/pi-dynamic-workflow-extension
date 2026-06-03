declare global {
	interface WorkflowAgentOptions {
		label?: string;
		phase?: string;
		agentType?: string;
		model?: string;
		isolation?: "worktree" | string;
		instructions?: string;
		schema?: unknown;
	}

	interface WorkflowBudget {
		readonly spent: number;
		readonly max: number;
		readonly remaining: number;
	}

	interface ArtifactOptions {
		type?: "markdown" | "json" | "text";
		description?: string;
	}

	interface WorkflowArtifact {
		name: string;
		type: "markdown" | "json" | "text";
		description?: string;
		value: unknown;
	}

	const args: unknown;
	const cwd: string;
	const budget: WorkflowBudget;

	function phase(title: string): void;
	function log(message: unknown): void;
	function artifact(
		name: string,
		value: unknown,
		options?: ArtifactOptions,
	): void;
	function agent<T = unknown>(
		prompt: string,
		options?: WorkflowAgentOptions,
	): Promise<T>;
	function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
	function pipeline<T, R>(
		items: T[],
		...stages: Array<
			(value: unknown, item: T, index: number) => Promise<unknown> | unknown
		>
	): Promise<R[]>;
}

export {};

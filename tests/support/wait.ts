export interface WaitForConditionOptions {
	timeoutMs?: number;
	intervalMs?: number;
	describe?: () => string;
}

export async function waitForCondition(
	predicate: () => boolean,
	message: string,
	options: WaitForConditionOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 1000;
	const intervalMs = options.intervalMs ?? 5;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	const details = options.describe?.();
	throw new Error(details ? `${message}; ${details}` : message);
}

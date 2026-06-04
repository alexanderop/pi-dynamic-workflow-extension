import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTempDir(prefix = "pi-workflow-test-") {
	const path = await mkdtemp(join(tmpdir(), prefix));
	return {
		path,
		async cleanup() {
			await rm(path, { recursive: true, force: true });
		},
	};
}

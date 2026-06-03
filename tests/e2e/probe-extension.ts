import { writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probeExtension(pi: ExtensionAPI) {
	pi.registerCommand("e2e-inspect", {
		description: "Write loaded Pi extension state for end-to-end tests",
		handler: async () => {
			const outputPath = process.env.PI_E2E_OUT;
			if (!outputPath) throw new Error("PI_E2E_OUT is required");

			await writeFile(
				outputPath,
				JSON.stringify({
					tools: pi
						.getAllTools()
						.map((tool) => tool.name)
						.sort(),
					commands: pi
						.getCommands()
						.map((command) => command.name)
						.sort(),
				}),
			);
		},
	});
}

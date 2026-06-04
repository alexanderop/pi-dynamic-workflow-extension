// Lint + format config for Vite+ (oxlint + oxfmt), translating biome.json.
// No `vite-plus` import so the config loads without installing the package.
// Build stays on `tsc`; tests stay on Vitest.
export default {
	lint: {
		ignorePatterns: ["dist/**", "node_modules/**", ".pi/**"],
		options: {
			typeAware: true,
		},
	},
	fmt: {
		// Match biome.json: indentStyle "tab", indentWidth 3, lineWidth 120
		useTabs: true,
		tabWidth: 3,
		printWidth: 120,
		// Keep oxfmt off markdown (docs + LLM-facing prompts) — code only.
		ignorePatterns: ["**/*.md"],
	},
};

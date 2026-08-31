import * as fs from "node:fs/promises";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			name: "md-text-loader",
			enforce: "pre" as const,
			async load(id) {
				if (id.endsWith(".md") || id.endsWith(".txt") || id.includes(".md?") || id.includes(".txt?")) {
					const filePath = id.split("?")[0];
					const content = await fs.readFile(filePath, "utf-8");
					return `export default ${JSON.stringify(content)};`;
				}
			},
		},
	],
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		pool: "forks",
		maxWorkers: 2,
		testTimeout: 10_000,
	},
});

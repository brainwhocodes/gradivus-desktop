import path from "node:path";
import { defineConfig } from "@playwright/test";

const e2ePort = process.env.GRADIVUS_E2E_PORT ?? "5173";
export default defineConfig({
	testDir: "e2e",
	testMatch: /(desktop|omp-selection)\.spec\.ts/,
	workers: 1,
	timeout: 45_000,
	trace: "retain-on-failure",
	screenshot: "only-on-failure",
	expect: { timeout: 8_000 },
	webServer: {
		command: `bunx vite --config vite.e2e.config.ts --host 0.0.0.0 --port ${e2ePort}`,
		cwd: path.resolve("."),
		url: `http://127.0.0.1:${e2ePort}/`,
		timeout: 30_000,
		env: {
			VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
		},
	},
	reporter: [["list"]],
});

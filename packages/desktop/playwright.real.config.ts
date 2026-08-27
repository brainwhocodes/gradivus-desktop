import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: /real\.spec\.ts/,
	fullyParallel: false,
	workers: 1,
	timeout: 180_000,
	expect: { timeout: 45_000 },
});

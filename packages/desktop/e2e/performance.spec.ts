import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { electronExecutablePath } from "./electron-path";
import { teardownElectronTest } from "./electron-teardown";

const desktopRoot = path.resolve(".");
const mainBundle = path.join(desktopRoot, ".vite", "build", "main.js");
const electronBinary = electronExecutablePath();
const rpcFixture = path.join(desktopRoot, "e2e", "rpc-fixture.ts");

async function seedSession(userData: string, workspace: string): Promise<void> {
	await fs.mkdir(workspace, { recursive: true });
	const now = new Date().toISOString();
	await fs.writeFile(path.join(userData, "sessions-v1.json"), JSON.stringify({ version: 1, sessions: [{ id: "performance-chat", kind: "work", cwd: workspace, ompSessionId: "", sessionFile: "", title: null, createdAt: now, lastOpenedAt: now }], activeByKind: { work: "performance-chat", code: null } }));
}

test("renders the compiled OMP Chat performance timeline without long tasks", async () => {
	const realTmp = await fs.realpath(os.tmpdir());
	const userData = await fs.mkdtemp(path.join(realTmp, "omp-performance-"));
	let app: ElectronApplication | undefined;
	try {
		const workspace = path.join(userData, "workspace");
		await fs.mkdir(path.join(userData, "home", ".config"), { recursive: true });
		const tempRoot = path.join(userData, "t");
		await fs.mkdir(tempRoot, { recursive: true });
		await seedSession(userData, workspace);
		app = await electron.launch({ executablePath: electronBinary, args: [`--user-data-dir=${userData}`, mainBundle], env: { ...process.env, GRADIVUS_RPC_FIXTURE: rpcFixture, GRADIVUS_PERF_FIXTURE: "1", GRADIVUS_WORKSPACE: workspace, GRADIVUS_NODE: "bun", PATH: `${path.resolve(desktopRoot, "../coding-agent/dist")}${path.delimiter}${process.env.PATH ?? ""}`, HOME: path.join(userData, "home"), USERPROFILE: path.join(userData, "home"), XDG_CONFIG_HOME: path.join(userData, "home", ".config"), TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot, PI_CODING_AGENT_DIR: path.join(userData, "omp-agent"), GRADIVUS_AUTH_FILE: path.join(userData, "auth-state"), ELECTRON_ENABLE_SECURITY_WARNINGS: "1", GRADIVUS_RUNTIME_DIR: path.join(userData, "runtime") } });
		const page = await app!.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.evaluate(() => {
			(window as unknown as { __maxLongTask: number }).__maxLongTask = 0;
			new PerformanceObserver(list => {
				for (const entry of list.getEntries()) {
					const state = window as unknown as { __maxLongTask: number };
					state.__maxLongTask = Math.max(state.__maxLongTask, entry.duration);
				}
			}).observe({ entryTypes: ["longtask"] });
		});
		await expect(page.getByLabel("Message OMP")).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(".timeline-scroll")).toContainText("Performance timeline entry 9999", { timeout: 30_000 });
		const maxLongTask = await page.evaluate(() => (window as unknown as { __maxLongTask: number }).__maxLongTask);
		expect(maxLongTask).toBeLessThan(500);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

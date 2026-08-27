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

async function seedSession(userData: string, workspace: string): Promise<void> {
	const now = new Date().toISOString();
	await fs.mkdir(workspace, { recursive: true });
	await fs.writeFile(path.join(userData, "sessions-v1.json"), JSON.stringify({ version: 1, sessions: [{ id: "real-omp-chat", kind: "work", cwd: workspace, ompSessionId: "", sessionFile: "", title: null, createdAt: now, lastOpenedAt: now }], activeByKind: { work: "real-omp-chat", code: null } }));
}

test("runs /context through the compiled OMP Chat runtime", async () => {
	test.skip(process.env.GRADIVUS_REAL_OMP !== "1", "set GRADIVUS_REAL_OMP=1 to run compiled OMP");
	const realTmp = await fs.realpath(os.tmpdir());
	const userData = await fs.mkdtemp(path.join(realTmp, "omp-real-chat-"));
	let app: ElectronApplication | undefined;
	try {
		const workspace = path.join(userData, "workspace");
		const home = path.join(userData, "home");
		const tempRoot = path.join(userData, "t");
		await fs.mkdir(path.join(home, ".config"), { recursive: true });
		await fs.mkdir(tempRoot, { recursive: true });
		await seedSession(userData, workspace);
		app = await electron.launch({ executablePath: electronBinary, args: [`--user-data-dir=${userData}`, mainBundle], env: { ...process.env, GRADIVUS_WORKSPACE: workspace, OPENAI_API_KEY: "sk-mock-key-for-real-e2e", HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot, PI_CODING_AGENT_DIR: path.join(userData, "omp-agent"), GRADIVUS_RUNTIME_DIR: path.join(userData, "runtime"), ELECTRON_ENABLE_SECURITY_WARNINGS: "1" } });
		const page = await app!.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 30_000 });
		await composer.fill("/context");
		await composer.press("Enter");
		await expect(page.locator(".timeline-scroll")).toContainText(/context window|token/i, { timeout: 30_000 });

		if (process.env.GRADIVUS_REAL_MODEL === "1") {
			await composer.fill("Reply with the single word READY.");
			await composer.press("Enter");
			await expect(page.locator(".timeline-scroll")).toContainText("READY", { timeout: 120_000 });
		}
	} finally {
		await teardownElectronTest(app, userData);
	}
});

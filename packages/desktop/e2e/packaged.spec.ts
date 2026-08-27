import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { teardownElectronTest } from "./electron-teardown";

const desktopRoot = path.resolve(__dirname, "..");
const DEVTOOLS_TIMEOUT_MS = 15_000;
const APP_STOP_TIMEOUT_MS = 5_000;

function findPackagedBinary(): string | undefined {
	const packageRoot = path.join(desktopRoot, "out", `Gradivus-${process.platform}-${process.arch}`);
	const candidates =
		process.platform === "darwin"
			? [path.join(packageRoot, "Gradivus.app", "Contents", "MacOS", "Gradivus")]
			: process.platform === "win32"
				? [path.join(packageRoot, "Gradivus.exe")]
				: [path.join(packageRoot, "Gradivus"), path.join(packageRoot, "gradivus")];
	return candidates.find(candidate => existsSync(candidate));
}

function waitForDevTools(child: ChildProcess): Promise<string> {
	const stderr = child.stderr;
	if (!stderr) return Promise.reject(new Error("Packaged Gradivus stderr was not piped"));

	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let settled = false;
	let output = "";
	const cleanup = (): void => {
		clearTimeout(timer);
		stderr.off("data", onData);
		child.off("error", onError);
		child.off("exit", onExit);
	};
	const succeed = (endpoint: string): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(endpoint);
	};
	const fail = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onData = (chunk: Buffer): void => {
		output += chunk.toString("utf8");
		const endpoint = output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
		if (endpoint) succeed(endpoint);
	};
	const onError = (error: Error): void => fail(error);
	const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		fail(new Error(`Packaged Gradivus exited before DevTools became available (code=${code}, signal=${signal})`));
	};
	const timer = setTimeout(
		() => fail(new Error(`Timed out waiting for packaged Gradivus DevTools endpoint: ${output}`)),
		DEVTOOLS_TIMEOUT_MS,
	);

	stderr.on("data", onData);
	child.once("error", onError);
	child.once("exit", onExit);
	return promise;
}

async function stopPackagedApp(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	if (child.exitCode !== null || child.signalCode !== null) return;

	const { promise, resolve } = Promise.withResolvers<void>();
	const onExit = (): void => resolve();
	const timer = setTimeout(() => {
		child.off("exit", onExit);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		resolve();
	}, APP_STOP_TIMEOUT_MS);
	child.once("exit", onExit);
	await promise;
	clearTimeout(timer);
}

function packagedRuntimePath(packagedBinary: string): string {
	if (process.platform === "darwin") return path.join(path.dirname(packagedBinary), "..", "Resources", "omp");
	return path.join(path.dirname(packagedBinary), "resources", "omp.exe");
}

test("loads the contained Gradivus app and bundles the OMP runtime", async () => {
	const packagedBinary = findPackagedBinary();
	if (!packagedBinary) {
		throw new Error(`Packaged Gradivus binary not found under ${path.join(desktopRoot, "out")}`);
	}
	expect(existsSync(packagedRuntimePath(packagedBinary))).toBe(true);

	const realTmp = await fs.realpath(os.tmpdir());
	const userData = await fs.mkdtemp(path.join(realTmp, "gradivus-packaged-"));
	let child: ChildProcess | undefined;
	let browser: Browser | undefined;
	try {
		const testWorkspace = path.join(userData, "workspace");
		const home = path.join(userData, "home");
		const tempRoot = path.join(userData, "t");
		await fs.mkdir(path.join(home, ".config"), { recursive: true });
		await fs.mkdir(tempRoot, { recursive: true });
		child = spawn(packagedBinary, ["--remote-debugging-port=0", `--user-data-dir=${userData}`], {
			env: {
				...process.env,
				GRADIVUS_WORKSPACE: testWorkspace,
				GRADIVUS_RUNTIME_DIR: path.join(userData, "runtime"),
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				TMPDIR: tempRoot,
				TMP: tempRoot,
				TEMP: tempRoot,
				PI_CODING_AGENT_DIR: path.join(userData, "omp-agent"),
				ELECTRON_ENABLE_SECURITY_WARNINGS: "0",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		const endpoint = await waitForDevTools(child);
		browser = await chromium.connectOverCDP(endpoint);
		await expect
			.poll(() => browser?.contexts().flatMap(context => context.pages()).length ?? 0, { timeout: DEVTOOLS_TIMEOUT_MS })
			.toBeGreaterThan(0);
		const page: Page | undefined = browser.contexts().flatMap(context => context.pages())[0];
		if (!page) throw new Error("Packaged Gradivus did not create a renderer window");

		const consoleErrors: string[] = [];
		page.on("console", message => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		page.on("pageerror", error => consoleErrors.push(error.message));
		await page.setViewportSize({ width: 1440, height: 900 });

		await expect.poll(() => page.evaluate(() => document.styleSheets.length), { timeout: DEVTOOLS_TIMEOUT_MS }).toBeGreaterThan(0);
		await expect(page.getByLabel("Gradivus", { exact: true })).toBeVisible();
		await expect(page.getByRole("tab", { name: /OMP Chat/ })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("heading", { name: "Make the next useful thing." })).toBeVisible();
		await expect(page.getByRole("button", { name: /Choose a workspace/ })).toBeVisible();
		await expect(page.getByRole("button", { name: "Open browser tab" })).toBeVisible();
		expect(consoleErrors).toEqual([]);
	} finally {
		await browser?.close().catch(() => {});
		if (child) await stopPackagedApp(child);
		await teardownElectronTest(undefined, userData);
	}
});

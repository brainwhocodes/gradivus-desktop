import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import * as os from "node:os";
import * as path from "node:path";
import type { GradivusSettings } from "../src/shared/contracts";
import { DESKTOP_THEME_PALETTES, type ResolvedTheme } from "../src/shared/theme-palette";
import { expectEnhancedContrast, expectThemeContrast, canonicalizeCssColor } from "./theme-contrast";
import { electronExecutablePath } from "./electron-path";
import { teardownElectronTest } from "./electron-teardown";

type AttachmentCapture = {
	sequence: number;
	route: "prompt" | "steer" | "follow_up";
	requestId: string;
	messageBytes: number;
	baseTextBytes: number;
	envelopes: Array<{ kind: "file" | "prompt" | "image"; name?: string }>;
	references: Array<{ kind: "file" | "prompt"; path: string; absolute: boolean; exists: boolean; bytes: number; sha256: string }>;
	images: Array<{ mimeType: string; bytes: number; sha256: string; base64Valid: boolean }>;
};

const root = path.resolve(".");
const bundle = path.join(root, ".vite", "build", "main.js");
const binary = electronExecutablePath();
const fixture = path.join(root, "e2e", "rpc-fixture.ts");
async function createUserData(prefix: string): Promise<string> { const realTmp = await fs.realpath(os.tmpdir()); return fs.mkdtemp(path.join(realTmp, prefix)); }
async function seed(userData: string, cwd: string, ids = ["fixture-chat-1"], settingsOverride?: GradivusSettings | GradivusSettings["theme"]): Promise<void> { try { await fs.mkdir(cwd, { recursive: true });
	const now = new Date().toISOString();
	await fs.writeFile(path.join(userData, "sessions-v1.json"), JSON.stringify({ version: 1, sessions: ids.map((id, index) => ({ id, kind: "work", cwd, ompSessionId: "", sessionFile: "", title: index ? "Second chat" : null, createdAt: now, lastOpenedAt: now })), activeByKind: { work: ids[0], code: null } }));
	if (settingsOverride) await fs.writeFile(path.join(userData, "settings.json"), JSON.stringify(typeof settingsOverride === "string" ? { theme: settingsOverride } : settingsOverride)); } catch (error) { await teardownElectronTest(undefined, userData).catch(() => {}); throw error; } }
function sha256(bytes: Uint8Array): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function bytesOf(size: number, seed = 0x42): Buffer { const bytes = Buffer.allocUnsafe(size); for (let index = 0; index < size; index += 1) bytes[index] = (seed + index * 31) & 0xff; return bytes; }
function completeSettings(workspace: string, overrides: Partial<GradivusSettings> = {}): GradivusSettings {
	return {
		theme: "dark",
		confirmCloseTab: true,
		ui: { density: "comfortable", reduceMotion: false, showToolDetails: true, ...overrides.ui },
		terminal: { shell: "/bin/zsh", fontSize: 14, fontFamily: "monospace", cursorBlink: true, cursorStyle: "bar", scrollback: 10_000 },
		browser: { defaultUrl: "https://omp.sh", searchEngine: "https://www.google.com/search?q=%s" },
		workspace: { defaultPath: workspace, ...overrides.workspace },
		...overrides,
	};
}
const SMALL_TEXT = Buffer.from("attachment journey exact bytes\n");
const SMALL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function expectComposerReady(page: Page): Promise<void> {
	await expect(page.getByLabel("Message OMP")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByLabel("Message OMP")).toBeEnabled();
	await expect(page.getByLabel("Attach files")).toBeVisible();
	await expect(page.getByLabel("Attach files")).toBeEnabled();
}
function collectRendererErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
	page.on("pageerror", error => errors.push(error.message));
	return errors;
}
async function readAttachmentCaptures(file: string): Promise<AttachmentCapture[]> {
	try {
		const text = await fs.readFile(file, "utf8");
		return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as AttachmentCapture);
	} catch { return []; }
}
async function waitForAttachmentCapture(file: string, predicate: (capture: AttachmentCapture) => boolean): Promise<AttachmentCapture> {
	await expect.poll(async () => (await readAttachmentCaptures(file)).find(predicate), { timeout: 20_000, intervals: [100, 250, 500] }).toBeTruthy();
	return (await readAttachmentCaptures(file)).find(predicate) as AttachmentCapture;
}
async function waitForCapturedPath(file: string, predicate: (capture: AttachmentCapture) => boolean, exists: boolean): Promise<string> {
	let receivedPath = "";
	await expect.poll(async () => {
		const capture = (await readAttachmentCaptures(file)).find(predicate);
		receivedPath = capture?.references.find(reference => reference.kind === "file" || reference.kind === "prompt")?.path ?? "";
		if (!receivedPath) return false;
		try { await fs.access(receivedPath); return exists; } catch { return !exists; }
	}, { timeout: 20_000, intervals: [100, 250, 500] }).toBe(true);
	return receivedPath;
}
async function enumeratePromptStoreFiles(rootPath: string): Promise<string[]> {
	const entries: string[] = [];
	async function visit(current: string): Promise<void> {
		let children: Array<{ name: string; isDirectory(): boolean }> = [];
		try { children = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
		for (const child of children) {
			const childPath = path.join(current, child.name);
			if (child.name.startsWith("gradivus-prompt-")) entries.push(childPath);
			if (child.isDirectory()) await visit(childPath);
		}
	}
	await visit(rootPath);
	return entries;
}
async function dispatchFileDrag(page: Page, target: string, files: Array<{ name: string; mimeType: string; bytes: Uint8Array }>, events: Array<"dragenter" | "dragover" | "dragleave" | "drop" | "dragend"> = ["dragenter", "dragover", "drop", "dragend"]): Promise<void> {
	await page.locator(target).evaluate((element, payload) => {
		const transfer = new DataTransfer();
		for (const input of payload.files) transfer.items.add(new File([Uint8Array.from(input.bytes)], input.name, { type: input.mimeType }));
		for (const type of payload.events) {
			const event = new DragEvent(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", { configurable: true, value: transfer });
			element.dispatchEvent(event);
		}
	}, { files: files.map(file => ({ ...file, bytes: Array.from(file.bytes) })), events });
}
async function dispatchNonFileDrag(page: Page, target: string): Promise<void> {
	await page.locator(target).evaluate(element => {
		const transfer = new DataTransfer();
		transfer.setData("text/plain", "not a file");
		for (const type of ["dragenter", "dragover", "drop", "dragend"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
	});
}
async function dispatchSlowFileDrag(page: Page, target: string, file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<() => Promise<void>> {
	await page.locator(target).evaluate((element, input) => {
		const transfer = new DataTransfer();
		const file = new File([Uint8Array.from(input.bytes)], input.name, { type: input.mimeType });
		Object.defineProperty(file, "arrayBuffer", { configurable: true, value: () => new Promise<ArrayBuffer>(resolve => { (window as Window & { __resolveGradivusSlowFile?: (value: ArrayBuffer) => void }).__resolveGradivusSlowFile = resolve; }) });
		transfer.items.add(file);
		for (const type of ["dragenter", "dragover", "drop", "dragend"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
	}, { ...file, bytes: Array.from(file.bytes) });
	return async () => { await page.evaluate(raw => { const win = window as Window & { __resolveGradivusSlowFile?: (value: ArrayBuffer) => void }; win.__resolveGradivusSlowFile?.(Uint8Array.from(raw).buffer); delete win.__resolveGradivusSlowFile; }, Array.from(file.bytes)); };
}
async function launch(userData: string, workspace: string, fixtureEnv: Record<string, string> = {}) {
	try {
		await fs.mkdir(path.join(userData, "home", ".config"), { recursive: true });
		const tempRoot = path.join(userData, "t");
		await fs.mkdir(tempRoot, { recursive: true });
		const captureFile = fixtureEnv.GRADIVUS_ATTACHMENT_CAPTURE_FILE ?? path.join(userData, "attachment-captures.jsonl");
		return await electron.launch({ executablePath: binary, args: [`--user-data-dir=${userData}`, bundle], env: {
			...process.env,
			PATH: `${path.resolve(root, "../coding-agent/dist")}${path.delimiter}${process.env.PATH ?? ""}`,
			HOME: path.join(userData, "home"),
			USERPROFILE: path.join(userData, "home"),
			XDG_CONFIG_HOME: path.join(userData, "home", ".config"),
			TMPDIR: tempRoot,
			TMP: tempRoot,
			TEMP: tempRoot,
			GRADIVUS_AUTH_FILE: path.join(userData, "auth-state"),
			GRADIVUS_NODE: "bun",
			GRADIVUS_RPC_FIXTURE: fixture,
			GRADIVUS_WORKSPACE: workspace,
			GRADIVUS_ATTACHMENT_CAPTURE_FILE: captureFile,
			PI_CODING_AGENT_DIR: path.join(userData, "omp-agent"),
			OPENAI_API_KEY: "sk-mock-key-for-test",
			ELECTRON_ENABLE_SECURITY_WARNINGS: "false",
			...fixtureEnv,
			GRADIVUS_RUNTIME_DIR: path.join(userData, "runtime"),
		} });
	} catch (error) {
		await teardownElectronTest(undefined, userData).catch(() => {});
		throw error;
	}
}
const COMPOSER_DROPDOWN_BOUNDS_TOLERANCE = 0.5;
async function expectComposerDropdownTriggersContained(page: Page): Promise<void> {
	const wrappers = page.locator(".runtime-picker-panel .model-select-item, .runtime-picker-panel .thinking-select");
	const runtimeTrigger = page.locator(".runtime-picker-trigger");
	await runtimeTrigger.click();
	await expect(runtimeTrigger).toHaveAttribute("aria-expanded", "true");
	const count = await wrappers.count();
	expect(count).toBeGreaterThan(0);
	for (let index = 0; index < count; index += 1) {
		const wrapper = wrappers.nth(index);
		const trigger = wrapper.locator(".custom-dropdown-trigger");
		await expect(trigger).toHaveCount(1);
		const wrapperBox = await wrapper.boundingBox();
		const triggerBox = await trigger.boundingBox();
		if (!wrapperBox || !triggerBox) throw new Error(`Composer dropdown ${index} is not rendered`);
		expect(triggerBox.x).toBeGreaterThanOrEqual(wrapperBox.x - COMPOSER_DROPDOWN_BOUNDS_TOLERANCE);
		expect(triggerBox.y).toBeGreaterThanOrEqual(wrapperBox.y - COMPOSER_DROPDOWN_BOUNDS_TOLERANCE);
		expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(wrapperBox.x + wrapperBox.width + COMPOSER_DROPDOWN_BOUNDS_TOLERANCE);
		expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(wrapperBox.y + wrapperBox.height + COMPOSER_DROPDOWN_BOUNDS_TOLERANCE);
	}
	await page.getByRole("button", { name: "Close runtime settings" }).click();
	await expect(runtimeTrigger).toHaveAttribute("aria-expanded", "false");
}


test("runs current Gradivus chat feedback, recovery, local command, folder creation, settings, and Axe journeys", async () => {
	const userData = await createUserData("gradivus-e2e-chat-"); const workspace = path.join(userData, "workspace"); await seed(userData, workspace); const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
		page.on("pageerror", error => errors.push(error.message));
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.density)).toBe("comfortable");
		await expectComposerDropdownTriggersContained(page);
		await expect(page.getByRole("tab", { name: /Gradivus/ })).toHaveAttribute("aria-selected", "true");
		const runtimeTrigger = page.locator(".runtime-picker-trigger");
		await runtimeTrigger.click();
		const runtimePanel = page.locator("#runtime-picker-panel");
		const providerDropdown = runtimePanel.getByRole("button", { name: "Model provider" });
		await providerDropdown.click();
		await page.getByRole("option", { name: "Alternate", exact: true }).click();
		await expect(runtimePanel.getByRole("button", { name: "Model", exact: true })).toContainText("Compact Fixture");
		await runtimePanel.getByRole("button", { name: "Close runtime settings" }).click();
		await expect(page.locator(".timeline-scroll")).not.toContainText("FIXTURE_HIDDEN_DEVELOPER_REMINDER");
		await expect(page.locator(".timeline-scroll")).not.toContainText("FIXTURE_HIDDEN_CUSTOM_MESSAGE");
		await expect(page.locator(".timeline-scroll")).not.toContainText("FIXTURE_HIDDEN_HOOK_MESSAGE");
		await composer.fill("normal streaming turn"); await composer.press("Enter"); await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/, { timeout: 8_000 }); await expect(page.locator(".timeline-scroll")).toContainText("Fixture completed the requested work.", { timeout: 15_000 });
		await expect(page.locator(".timeline-item.item-user")).toHaveCount(1);
		await expect(page.locator(".timeline-scroll")).not.toContainText("Todo progress updated");
		await composer.fill("delayed error"); await composer.press("Enter"); await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/, { timeout: 8_000 }); await expect(page.locator(".prompt-recovery-card")).toContainText("Fixture provider rejected the request.", { timeout: 12_000 }); await expect(composer).toHaveValue("delayed error");
		await composer.fill("/status"); await composer.press("Enter"); await expect(page.locator(".timeline-scroll")).toContainText("Fixture status: ready", { timeout: 8_000 });
		await page.getByRole("button", { name: "New Chat in workspace" }).click(); await expect(page.getByRole("treeitem")).toHaveCount(2); await expect(composer).toBeVisible();
		await page.getByRole("button", { name: "Open settings" }).click();
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
		await expect(page.getByRole("searchbox", { name: "Search settings" })).toBeFocused();
		const appearanceButtons = page.getByRole("button", { name: "Appearance", exact: true });
		await expect(appearanceButtons).toHaveCount(2);
		await appearanceButtons.nth(1).click();
		await expect(page.locator("#settings-category-title")).toHaveText("Appearance");
		await page.getByRole("button", { name: "Interface density", exact: true }).click();
		await page.getByRole("option", { name: "Compact", exact: true }).click();
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.density)).toBe("compact");
		await page.getByRole("button", { name: "Accounts", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Provider access", exact: true })).toBeVisible();
		await expect(page.getByLabel("Provider access").getByText("ChatGPT Plus/Pro", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
		await expect(composer).toBeVisible();
		await expectComposerDropdownTriggersContained(page);
		const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze(); expect(axe.violations.filter(v => v.impact === "critical" || v.impact === "serious")).toEqual([]); expect(errors).toEqual([]);
	} finally { await teardownElectronTest(app, userData); }
});
test("deletes a chat after confirmation, discloses transcript retention, and falls back to a remaining chat", async () => {
	const userData = await createUserData("gradivus-e2e-del-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace);
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole("treeitem")).toHaveCount(1);

		await page.getByRole("button", { name: "New Chat in workspace" }).click();
		await expect(page.getByRole("treeitem")).toHaveCount(2);
		const createdRow = page.locator(".session-tree-row.selected");
		await expect(createdRow).toHaveCount(1);
		await expect(createdRow).not.toContainText("Second chat");

		let confirmMessage = "";
		page.on("dialog", dialog => { confirmMessage = dialog.message(); void dialog.accept(); });
		await createdRow.getByRole("button", { name: /Delete chat / }).click();

		await expect.poll(() => confirmMessage).toContain("permanently removes the chat from Gradivus");
		expect(confirmMessage).toContain("The OMP transcript file remains on disk.");
		await expect(page.getByRole("treeitem")).toHaveCount(1);
		await expect(page.locator(".session-tree-row.selected")).toHaveCount(1);
		await expect(composer).toBeEnabled();

		const saved = JSON.parse(await fs.readFile(path.join(userData, "sessions-v1.json"), "utf8")) as {
			sessions: Array<{ id: string }>;
			activeByKind: { work: string | null };
		};
		expect(saved.sessions.map(session => session.id)).toEqual(["fixture-chat-1"]);
		expect(saved.activeByKind.work).toBe("fixture-chat-1");
	} finally { await teardownElectronTest(app, userData); }
});
test("keeps the runtime summary and disclosure usable at both densities", async () => {
	const userData = await createUserData("gradivus-runtime-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-runtime-picker"], completeSettings(workspace));
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expectComposerReady(page);

		const assertRuntimePicker = async (expectedThinking: string, selectProvider: boolean): Promise<void> => {
			const picker = page.locator(".runtime-picker");
			await expect(picker).toBeVisible();
			const trigger = picker.getByRole("button").first();
			await expect(trigger).toBeVisible();
			await expect(trigger).toContainText(/.+/);
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
			const controlsId = await trigger.getAttribute("aria-controls");
			expect(controlsId).toBeTruthy();
			const disclosure = page.locator(`#${controlsId}`);
			await expect(disclosure).toBeHidden();

			await trigger.click();
			await expect(trigger).toHaveAttribute("aria-expanded", "true");
			await expect(disclosure).toBeVisible();
			const provider = disclosure.getByRole("button", { name: "Model provider", exact: true });
			const model = disclosure.getByRole("button", { name: "Model", exact: true });
			const thinking = disclosure.getByRole("button", { name: "Thinking level", exact: true });
			await expect(provider).toBeVisible();
			await expect(model).toBeVisible();
			await expect(thinking).toBeVisible();

			if (selectProvider) {
				await provider.click();
				await page.getByRole("option", { name: "Alternate", exact: true }).click();
				await expect(model).toContainText("Compact Fixture");
				await expect(trigger).toContainText("Alternate");
				await expect(trigger).toContainText("Compact Fixture");
			}

			await thinking.click();
			await page.getByRole("option", { name: expectedThinking, exact: true }).click();
			await expect(trigger).toContainText(expectedThinking);
			await page.keyboard.press("Escape");
			await expect(trigger).toHaveAttribute("aria-expanded", "false");
			await expect(trigger).toBeFocused();
			await expect(trigger).toContainText(expectedThinking);
			if (selectProvider) {
				await expect(trigger).toContainText("Alternate");
				await expect(trigger).toContainText("Compact Fixture");
			}
		};

		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.density)).toBe("comfortable");
		await assertRuntimePicker("high", true);

		await page.getByRole("button", { name: "Open settings" }).click();
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Appearance", exact: true }).last().click();
		await page.getByRole("button", { name: "Interface density", exact: true }).click();
		await page.getByRole("option", { name: "Compact", exact: true }).click();
		await expect.poll(() => page.evaluate(() => document.documentElement.dataset.density)).toBe("compact");
		await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
		await expectComposerReady(page);
		await assertRuntimePicker("medium", false);
		const contextTrigger = page.getByRole("button", { name: /Context window:/ });
		const contextPanelId = await contextTrigger.getAttribute("aria-controls");
		expect(contextPanelId).toBeTruthy();
		await contextTrigger.click();
		await expect(contextTrigger).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator(`#${contextPanelId}`)).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(contextTrigger).toHaveAttribute("aria-expanded", "false");
		await expect(contextTrigger).toBeFocused();
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("verifies repaired chat computed-style contracts across themes and narrow rails", async () => {
	const userData = await createUserData("gradivus-style-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-chat-style"]);
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expectComposerReady(page);
		await page.getByLabel("Choose files to attach").setInputFiles({
			name: "style-check.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("style check"),
		});
		await expect(page.locator(".attachment-chip")).toBeVisible();
		const runtimeTrigger = page.locator(".runtime-picker-trigger");
		await runtimeTrigger.click();
		await expect(runtimeTrigger).toHaveAttribute("aria-expanded", "true");

		const styles = await page.evaluate(() => {
			const root = getComputedStyle(document.documentElement);
			const resolveColor = (token: string, property: "backgroundColor" | "color"): string => {
				const probe = document.createElement("span");
				probe.style[property] = `var(${token})`;
				document.body.append(probe);
				const value = getComputedStyle(probe)[property];
				probe.remove();
				return value;
			};
			const resolveBorder = (token: string): string => {
				const probe = document.createElement("span");
				probe.style.borderTopColor = `var(${token})`;
				document.body.append(probe);
				const value = getComputedStyle(probe).borderTopColor;
				probe.remove();
				return value;
			};
			const composer = document.querySelector<HTMLElement>(".composer");
			const attachmentChip = document.querySelector<HTMLElement>(".attachment-chip");
			const thinking = document.querySelector<HTMLElement>(".thinking-select .custom-dropdown-trigger");
			const composerWrap = document.querySelector<HTMLElement>(".composer-wrap");
			const jump = document.createElement("button");
			jump.className = "jump-to-latest-pill";
			jump.textContent = "Jump to latest";
			composerWrap?.append(jump);
			const jumpStyle = getComputedStyle(jump);
			const values = {
				composerBackground: composer ? getComputedStyle(composer).backgroundColor : "",
				shellRaised: resolveColor("--shell-raised", "backgroundColor"),
				attachmentChipBorder: attachmentChip ? getComputedStyle(attachmentChip).borderTopColor : "",
				accentBoundary: resolveBorder("--accent-boundary"),
				thinkingHeight: thinking ? getComputedStyle(thinking).height : "",
				thinkingMinHeight: thinking ? getComputedStyle(thinking).minHeight : "",
				thinkingBorderColor: thinking ? getComputedStyle(thinking).borderTopColor : "",
				thinkingBackground: thinking ? getComputedStyle(thinking).backgroundColor : "",
				jumpWidth: jumpStyle.width,
				jumpParent: jump.parentElement?.className ?? "",
				terminalCanvasMinHeight: document.querySelector<HTMLElement>(".chat-terminal-canvas")
					? getComputedStyle(document.querySelector<HTMLElement>(".chat-terminal-canvas")!).minHeight
					: "",
			};
			jump.remove();
			return values;
		});
		expect(styles.composerBackground).toBe(styles.shellRaised);
		expect(styles.attachmentChipBorder).toBe(styles.accentBoundary);
		expect(styles.thinkingHeight).toBe("24px");
		expect(styles.thinkingMinHeight).toBe("24px");
		expect(styles.thinkingBorderColor).toBe("rgba(0, 0, 0, 0)");
		expect(styles.thinkingBackground).toBe("rgba(0, 0, 0, 0)");
		expect(styles.jumpWidth).not.toBe("100%");
		expect(styles.jumpParent).toContain("composer-wrap");
		expect(styles.terminalCanvasMinHeight).toBe("0px");
		await page.getByRole("button", { name: "Close runtime settings" }).click();
		await expect(page).toHaveTitle(/ · Gradivus$/);

		await page.getByLabel("About Gradivus").click();
		await expect(page.locator("dialog.about-dialog")).toBeVisible();
		await expect(page.locator("dialog.about-dialog #about-title")).toHaveText("Gradivus");
		await expect(page.locator("dialog.about-dialog .eyebrow")).toHaveText("Gradivus Labs");
		const eyebrowStyles = await page.locator("dialog.about-dialog .eyebrow").evaluate(element => {
			const style = getComputedStyle(element);
			return { color: style.color, font: style.font, letterSpacing: style.letterSpacing, transform: style.textTransform };
		});
		expect(eyebrowStyles.font).toContain("9px");
		expect(Number.parseFloat(eyebrowStyles.letterSpacing)).toBeCloseTo(0.54, 2);
		expect(eyebrowStyles.transform).toBe("uppercase");
		await page.locator("dialog.about-dialog").getByRole("button", { name: "Close" }).click();
		await expect(page.locator("dialog.about-dialog")).toBeHidden();

		for (const width of [920, 760] as const) {
			await page.setViewportSize({ width, height: 820 });
			const railWidth = await page.evaluate(() => {
				const grid = document.querySelector<HTMLElement>(".workspace-grid");
				if (!grid) return "";
				const inspector = document.createElement("aside");
				inspector.className = "inspector";
				grid.append(inspector);
				const firstColumn = getComputedStyle(grid).gridTemplateColumns.split(" ")[0] ?? "";
				inspector.remove();
				return firstColumn;
			});
			expect(railWidth).toBe(width === 920 ? "196px" : "178px");
		}

		for (const theme of ["dark", "light"] as const) {
			const toastStyles = await page.evaluate(themeName => {
				document.documentElement.dataset.theme = themeName;
				const toast = document.createElement("div");
				toast.className = "error-toast";
				const strong = document.createElement("strong");
				strong.textContent = "Action failed";
				toast.append(strong);
				document.body.append(toast);
				const style = getComputedStyle(toast);
				const strongStyle = getComputedStyle(strong);
				const resolveBackground = (token: string): string => {
					const probe = document.createElement("span");
					probe.style.backgroundColor = `var(${token})`;
					document.body.append(probe);
					const value = getComputedStyle(probe).backgroundColor;
					probe.remove();
					return value;
				};
				const resolveForeground = (token: string): string => {
					const probe = document.createElement("span");
					probe.style.color = `var(${token})`;
					document.body.append(probe);
					const value = getComputedStyle(probe).color;
					probe.remove();
					return value;
				};
				const values = {
					background: style.backgroundColor,
					backgroundToken: resolveBackground("--danger-surface"),
					border: style.borderTopColor,
					borderToken: (() => {
						const probe = document.createElement("span");
						probe.style.borderTopColor = "var(--danger-boundary)";
						document.body.append(probe);
						const value = getComputedStyle(probe).borderTopColor;
						probe.remove();
						return value;
					})(),
					color: style.color,
					colorToken: resolveForeground("--foreground"),
					strongColor: strongStyle.color,
					strongColorToken: resolveForeground("--foreground-strong"),
				};
				toast.remove();
				return values;
			}, theme);
			expect(toastStyles.background).toBe(toastStyles.backgroundToken);
			expect(toastStyles.border).toBe(toastStyles.borderToken);
			expect(toastStyles.color).toBe(toastStyles.colorToken);
			expect(toastStyles.strongColor).toBe(toastStyles.strongColorToken);
		}
	} finally {
		await teardownElectronTest(app, userData);
	}
});
test("keeps the Command Deck composer as one usable surface at both densities", async () => {
	const userData = await createUserData("gradivus-cg-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-composer-geometry"]);
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await expectComposerReady(page);

		for (const density of ["comfortable", "compact"] as const) {
			const currentDensity = await page.evaluate(() => document.documentElement.dataset.density);
			if (currentDensity !== density) {
				await page.getByRole("button", { name: "Open settings" }).click();
				await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
				await page.getByRole("button", { name: "Appearance", exact: true }).last().click();
				await page.getByRole("button", { name: "Interface density", exact: true }).click();
				await page.getByRole("option", { name: density === "compact" ? "Compact" : "Comfortable", exact: true }).click();
				await expect.poll(() => page.evaluate(() => document.documentElement.dataset.density)).toBe(density);
				await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
				await expectComposerReady(page);
			}
			const narrowWidths = [920, 760, 720] as const;
			for (const width of narrowWidths) {
				await page.setViewportSize({ width, height: 820 });
				await expectComposerReady(page);
				const narrowGeometry = await page.evaluate(() => {
					const surface = document.querySelector<HTMLElement>(".composer");
					const inputContainer = surface?.querySelector<HTMLElement>(":scope > .composer-input-container") ?? null;
					const textarea = surface?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
					const footer = surface?.querySelector<HTMLElement>(".composer-actions") ?? null;
					const attachment = footer?.querySelector<HTMLElement>(".composer-attachment-bar") ?? null;
					const tools = footer?.querySelector<HTMLElement>(".composer-tools") ?? null;
					const actionRail = footer?.querySelector<HTMLElement>(".composer-action-rail") ?? null;
					const attach = attachment?.querySelector<HTMLElement>(".attachment-add-button") ?? null;
					const runtime = tools?.querySelector<HTMLElement>('.runtime-picker > button[aria-controls="runtime-picker-panel"]') ?? null;
					const context = tools?.querySelector<HTMLElement>('button.context-donut-btn[aria-label^="Context window:"]') ?? null;
					const primary = actionRail?.querySelector<HTMLElement>(".send-turn-btn") ?? null;
					const footerChildren = [attachment, tools, actionRail].filter((element): element is HTMLElement => Boolean(element));
					const controls = [attach, runtime, context, primary].filter((element): element is HTMLElement => Boolean(element));
					type GeometryRect = { x: number; y: number; right: number; bottom: number; width: number; height: number };
					const rect = (element: HTMLElement | null): GeometryRect | null => {
						if (!element) return null;
						const box = element.getBoundingClientRect();
						return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
					};
					const within = (child: GeometryRect | null, parent: GeometryRect | null): boolean => Boolean(
						child && parent
						&& child.x >= parent.x - 1
						&& child.right <= parent.right + 1
						&& child.y >= parent.y - 1
						&& child.bottom <= parent.bottom + 1,
					);
					const reachable = (element: HTMLElement | null): boolean => {
						if (!element) return false;
						const box = element.getBoundingClientRect();
						if (box.width <= 0 || box.height <= 0) return false;
						const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
						return hit === element || Boolean(hit && element.contains(hit));
					};
					const overlaps = (left: GeometryRect | null, right: GeometryRect | null): boolean => Boolean(
						left && right
						&& Math.min(left.right, right.right) - Math.max(left.x, right.x) > 1
						&& Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y) > 1,
					);
					const surfaceRect = rect(surface);
					const inputRect = rect(inputContainer);
					const textareaRect = rect(textarea);
					const footerRect = rect(footer);
					const attachmentRect = rect(attachment);
					const toolsRect = rect(tools);
					const actionRailRect = rect(actionRail);
					const runtimeRect = rect(runtime);
					const contextRect = rect(context);
					const primaryRect = rect(primary);
					const childRects = footerChildren.map(rect);
					const footerStyle = footer ? getComputedStyle(footer) : null;
					const textareaStyle = textarea ? getComputedStyle(textarea) : null;
					const documentWidth = document.documentElement;
					const body = document.body;
					return {
						viewportWidth: window.innerWidth,
						surfaceRect,
						inputRect,
						textareaRect,
						footerRect,
						attachmentRect,
						toolsRect,
						actionRailRect,
						footerDisplay: footerStyle?.display ?? "",
						primaryLabel: primary?.getAttribute("aria-label") ?? "",
						primaryRect,
						runtimeRect,
						contextRect,
						textareaMinHeight: textareaStyle ? Number.parseFloat(textareaStyle.minHeight) : Number.NaN,
						textareaMaxHeight: textareaStyle ? Number.parseFloat(textareaStyle.maxHeight) : Number.NaN,
						textareaWidthRatio: inputRect && textareaRect ? textareaRect.width / inputRect.width : 0,
						inputWidthRatio: surfaceRect && inputRect ? inputRect.width / surfaceRect.width : 0,
						footerFlexWrap: footerStyle?.flexWrap ?? "",
						footerRowCount: attachmentRect && toolsRect && actionRailRect
							? (attachmentRect.bottom <= Math.min(toolsRect.y, actionRailRect.y) + 1 ? 2 : 1)
							: 0,
						footerChildrenContained: Boolean(footerRect) && childRects.every(child => within(child, footerRect)),
						textareaContained: within(textareaRect, inputRect),
						runtimeContained: within(runtimeRect, surfaceRect),
						contextContained: within(contextRect, surfaceRect),
						primaryContained: within(primaryRect, surfaceRect),
						surfaceWithinViewport: Boolean(
							surfaceRect
							&& surfaceRect.x >= -1
							&& surfaceRect.right <= window.innerWidth + 1,
						),
						footerContained: within(footerRect, surfaceRect),
						allControlsReachable: controls.length === 4 && controls.every(reachable),
						textareaReachable: reachable(textarea),
						widgetsDoNotOverlap: !overlaps(runtimeRect, contextRect)
							&& !overlaps(contextRect, primaryRect)
							&& !overlaps(runtimeRect, primaryRect),
						wideFooterOrdered: Boolean(
							attachmentRect && runtimeRect && contextRect && primaryRect
							&& attachmentRect.right <= runtimeRect.x + 1
							&& runtimeRect.right <= contextRect.x + 1
							&& contextRect.right <= primaryRect.x + 1,
						),
						wideFooterGapsCompact: Boolean(
							attachmentRect && runtimeRect && contextRect && primaryRect
							&& runtimeRect.x - attachmentRect.right <= 16
							&& contextRect.x - runtimeRect.right <= 16
							&& primaryRect.x - contextRect.right <= 16,
						),
						controlGapsCompact: Boolean(
							runtimeRect && contextRect
							&& contextRect.x - runtimeRect.right >= -1
							&& contextRect.x - runtimeRect.right <= 16,
						),
						narrowShelfAboveTools: Boolean(
							attachmentRect && toolsRect && actionRailRect
							&& attachmentRect.bottom <= Math.min(toolsRect.y, actionRailRect.y) + 1,
						),
						narrowToolsAndActionAligned: Boolean(
							toolsRect && actionRailRect
							&& Math.min(toolsRect.bottom, actionRailRect.bottom) - Math.max(toolsRect.y, actionRailRect.y) > 1,
						),
						narrowControlsOnSecondRow: Boolean(
							attachmentRect && runtimeRect && contextRect && primaryRect
							&& attachmentRect.bottom <= Math.min(runtimeRect.y, contextRect.y, primaryRect.y) + 1
							&& Math.min(runtimeRect.bottom, primaryRect.bottom) - Math.max(runtimeRect.y, primaryRect.y) > 1
							&& Math.min(contextRect.bottom, primaryRect.bottom) - Math.max(contextRect.y, primaryRect.y) > 1,
						),
						primaryAnchoredLowerRight: Boolean(
							footerRect && primaryRect
							&& Math.abs(footerRect.right - primaryRect.right) <= 1
							&& Math.abs(footerRect.bottom - primaryRect.bottom) <= 1,
						),
						documentOverflowing: documentWidth.scrollWidth > documentWidth.clientWidth + 1
							|| body.scrollWidth > documentWidth.clientWidth + 1,
						surfaceOverflowing: Boolean(surface && surface.scrollWidth > surface.clientWidth + 1),
						footerOverflowing: Boolean(footer && footer.scrollWidth > footer.clientWidth + 1),
					};
				});

				expect(narrowGeometry.viewportWidth).toBe(width);
				expect(narrowGeometry.surfaceRect).not.toBeNull();
				expect(narrowGeometry.inputRect).not.toBeNull();
				expect(narrowGeometry.textareaRect).not.toBeNull();
				expect(narrowGeometry.footerRect).not.toBeNull();
				expect(narrowGeometry.attachmentRect).not.toBeNull();
				expect(narrowGeometry.toolsRect).not.toBeNull();
				expect(narrowGeometry.actionRailRect).not.toBeNull();
				expect(narrowGeometry.primaryRect).not.toBeNull();
				expect(narrowGeometry.runtimeRect).not.toBeNull();
				expect(narrowGeometry.contextRect).not.toBeNull();
				const surfaceWidth = narrowGeometry.surfaceRect?.width ?? 0;
				expect(surfaceWidth).toBeGreaterThan(0);
				expect(surfaceWidth).toBeLessThan(width);
				expect(narrowGeometry.primaryLabel).toMatch(/^(Send message|Steer current turn)$/);
				if (surfaceWidth <= 680) {
					expect(narrowGeometry.footerDisplay).toBe("grid");
					expect(narrowGeometry.footerRowCount).toBe(2);
					expect(narrowGeometry.narrowShelfAboveTools).toBe(true);
					expect(narrowGeometry.narrowToolsAndActionAligned).toBe(true);
					expect(narrowGeometry.narrowControlsOnSecondRow).toBe(true);
					expect(narrowGeometry.primaryAnchoredLowerRight).toBe(true);
				} else {
					expect(narrowGeometry.footerDisplay).toBe("flex");
					expect(narrowGeometry.footerFlexWrap).toBe("nowrap");
					expect(narrowGeometry.footerRowCount).toBe(1);
					expect(narrowGeometry.wideFooterOrdered).toBe(true);
					expect(narrowGeometry.wideFooterGapsCompact).toBe(true);
				}
				expect(narrowGeometry.documentOverflowing).toBe(false);
				expect(narrowGeometry.surfaceOverflowing).toBe(false);
				expect(narrowGeometry.surfaceWithinViewport).toBe(true);
				expect(narrowGeometry.footerContained).toBe(true);
				expect(narrowGeometry.footerOverflowing).toBe(false);
				expect(narrowGeometry.textareaContained).toBe(true);
				expect(narrowGeometry.footerChildrenContained).toBe(true);
				expect(narrowGeometry.primaryContained).toBe(true);
				expect(narrowGeometry.runtimeContained).toBe(true);
				expect(narrowGeometry.contextContained).toBe(true);
				expect(narrowGeometry.allControlsReachable).toBe(true);
				expect(narrowGeometry.textareaReachable).toBe(true);
				expect(narrowGeometry.widgetsDoNotOverlap).toBe(true);
				expect(narrowGeometry.controlGapsCompact).toBe(true);
				expect(narrowGeometry.footerRowCount).toBeGreaterThanOrEqual(1);
				expect(narrowGeometry.footerRowCount).toBeLessThanOrEqual(2);
				expect(narrowGeometry.inputWidthRatio).toBeGreaterThan(0.9);
				expect(narrowGeometry.textareaWidthRatio).toBeGreaterThan(0.95);
				expect(narrowGeometry.textareaMaxHeight).toBe(density === "compact" ? 144 : 160);
				expect(narrowGeometry.textareaMinHeight).toBe(density === "compact" ? 36 : 42);
				await page.setViewportSize({ width: 1440, height: 900 });
				await expectComposerReady(page);
			}


			const geometry = await page.evaluate(() => {
				const surfaces = Array.from(document.querySelectorAll<HTMLElement>(".composer"));
				const surface = surfaces[0] ?? null;
				const topBar = surface?.querySelector<HTMLElement>(":scope > .composer-top-bar") ?? null;
				const inputContainer = surface?.querySelector<HTMLElement>(":scope > .composer-input-container") ?? null;
				const textarea = inputContainer?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
				const actions = surface?.querySelector<HTMLElement>(".composer-actions") ?? null;
				const tools = actions?.querySelector<HTMLElement>(".composer-tools") ?? null;
				const actionRail = actions?.querySelector<HTMLElement>(".composer-action-rail") ?? null;
				const attachmentBar = surface?.querySelector<HTMLElement>(".composer-attachment-bar") ?? null;
				const attachButton = attachmentBar?.querySelector<HTMLElement>(".attachment-add-button") ?? null;
				const runtime = tools?.querySelector<HTMLElement>('.runtime-picker > button[aria-controls="runtime-picker-panel"]') ?? null;
				const context = tools?.querySelector<HTMLElement>('button.context-donut-btn[aria-label^="Context window:"]') ?? null;
				const primary = actionRail?.querySelector<HTMLElement>(".send-turn-btn") ?? null;
				const rect = (element: HTMLElement | null) => {
					if (!element) return null;
					const box = element.getBoundingClientRect();
					return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
				};
				const reachable = (element: HTMLElement | null) => {
					if (!element) return false;
					const box = element.getBoundingClientRect();
					if (box.width <= 0 || box.height <= 0) return false;
					const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
					return hit === element || Boolean(hit && element.contains(hit));
				};
				const surfaceRect = rect(surface);
				const topBarRect = rect(topBar);
				const inputRect = rect(inputContainer);
				const textareaRect = rect(textarea);
				const actionsRect = rect(actions);
				const toolsRect = rect(tools);
				const actionRailRect = rect(actionRail);
				const attachmentRect = rect(attachmentBar);
				const attachRect = rect(attachButton);
				const runtimeRect = rect(runtime);
				const contextRect = rect(context);
				const primaryRect = rect(primary);
				const inputActionVerticalOverlap = inputRect && actionsRect
					? Math.min(inputRect.bottom, actionsRect.bottom) - Math.max(inputRect.y, actionsRect.y)
					: 0;
				const attachmentUtilityVerticalOverlap = Boolean(attachmentRect && [toolsRect, actionRailRect].some(peer => (
					peer && Math.min(attachmentRect.bottom, peer.bottom) - Math.max(attachmentRect.y, peer.y) > 0
				)));
				const attachmentReachable = attachButton && attachRect
					? (() => {
						const hit = document.elementFromPoint(attachRect.x + attachRect.width / 2, attachRect.y + attachRect.height / 2);
						return hit === attachButton || Boolean(hit && attachButton.contains(hit));
					})()
					: false;
				const documentWidth = document.documentElement;
				return {
					surfaceCount: surfaces.length,
					surfaceRect,
					surfaceDisplay: surface ? getComputedStyle(surface).display : "",
					topBarParentIsSurface: topBar?.parentElement === surface,
					topBarRect,
					inputRect,
					textareaRect,
					actionsRect,
					toolsRect,
					actionRailRect,
					attachmentRect,
					attachRect,
					runtimeRect,
					contextRect,
					primaryRect,
					attachmentParentIsActions: attachmentBar?.parentElement === actions,
					attachmentFullWidth: Boolean(attachmentRect && surfaceRect && attachmentRect.width >= surfaceRect.width - 2),
					attachmentUtilityVerticalOverlap,
					attachmentHasChips: Boolean(attachmentBar?.querySelector(".attachment-chip-list")),
					attachmentHasStatus: Boolean(attachmentBar?.querySelector(".attachment-status")),
					inputWidthRatio: surfaceRect && inputRect ? inputRect.width / surfaceRect.width : 0,
					textareaWidthRatio: inputRect && textareaRect ? textareaRect.width / inputRect.width : 0,
					inputActionGap: inputRect && actionsRect ? actionsRect.x - inputRect.right : Number.NEGATIVE_INFINITY,
					inputActionVerticalOverlap,
					attachmentReachable,
					runtimeReachable: reachable(runtime),
					contextReachable: reachable(context),
					footerGapsCompact: Boolean(
						attachmentRect && runtimeRect && contextRect && primaryRect
						&& runtimeRect.x - attachmentRect.right <= 16
						&& contextRect.x - runtimeRect.right <= 16
						&& primaryRect.x - contextRect.right <= 16,
					),
					primaryReachable: reachable(primary),
					textareaReachable: reachable(textarea),
					footerOrdered: Boolean(
						attachmentRect && runtimeRect && contextRect && primaryRect
						&& attachmentRect.right <= runtimeRect.x + 1
						&& runtimeRect.right <= contextRect.x + 1
						&& contextRect.right <= primaryRect.x + 1,
					),
					primaryAnchoredLowerRight: Boolean(
						actionsRect && primaryRect
						&& Math.abs(actionsRect.right - primaryRect.right) <= 1
						&& Math.abs(actionsRect.bottom - primaryRect.bottom) <= 1,
					),
					surfaceOverflowing: Boolean(surface && surface.scrollWidth > surface.clientWidth + 1),
					footerOverflowing: Boolean(actions && actions.scrollWidth > actions.clientWidth + 1),
					documentOverflowing: documentWidth.scrollWidth > documentWidth.clientWidth || document.body.scrollWidth > documentWidth.clientWidth,
				};
			});

			expect(geometry.surfaceCount).toBe(1);
			expect(geometry.surfaceDisplay).toBe("grid");
			expect(geometry.topBarParentIsSurface).toBe(true);
			expect(geometry.topBarRect).not.toBeNull();
			expect(geometry.inputRect).not.toBeNull();
			expect(geometry.actionsRect).not.toBeNull();
			expect(geometry.textareaRect).not.toBeNull();
			expect(geometry.attachmentRect).not.toBeNull();
			expect(geometry.attachRect).not.toBeNull();
			expect(geometry.runtimeRect).not.toBeNull();
			expect(geometry.contextRect).not.toBeNull();
			expect(geometry.primaryRect).not.toBeNull();
			expect(geometry.attachmentParentIsActions).toBe(true);
			expect(geometry.attachmentFullWidth).toBe(false);
			expect(geometry.attachmentUtilityVerticalOverlap).toBe(true);
			expect(geometry.attachmentHasChips).toBe(false);
			expect(geometry.attachmentHasStatus).toBe(false);
			expect(geometry.inputWidthRatio).toBeGreaterThan(0.9);
			expect(geometry.textareaWidthRatio).toBeGreaterThan(0.95);
			expect(geometry.attachmentReachable).toBe(true);
			expect(geometry.runtimeReachable).toBe(true);
			expect(geometry.contextReachable).toBe(true);
			expect(geometry.footerGapsCompact).toBe(true);
			expect(geometry.primaryReachable).toBe(true);
			expect(geometry.textareaReachable).toBe(true);
			expect(geometry.footerOrdered).toBe(true);
			expect(geometry.primaryAnchoredLowerRight).toBe(true);
			expect(geometry.surfaceOverflowing).toBe(false);
			expect(geometry.footerOverflowing).toBe(false);
			expect(geometry.documentOverflowing).toBe(false);

			const surface = geometry.surfaceRect;
			const topBar = geometry.topBarRect;
			const actions = geometry.actionsRect;
			const attachment = geometry.attachmentRect;
			const attach = geometry.attachRect;
			if (!surface || !topBar || !actions || !attachment || !attach) throw new Error("Composer geometry is not rendered");
			expect(topBar.x).toBeGreaterThanOrEqual(surface.x - 1);
			expect(topBar.right).toBeLessThanOrEqual(surface.right + 1);
			expect(actions.x).toBeGreaterThanOrEqual(surface.x - 1);
			expect(actions.right).toBeLessThanOrEqual(surface.right + 1);
			expect(attachment.x).toBeGreaterThanOrEqual(surface.x - 1);
			expect(attachment.right).toBeLessThanOrEqual(surface.right + 1);
			expect(attachment.y).toBeGreaterThanOrEqual(actions.y - 1);
			expect(attachment.bottom).toBeLessThanOrEqual(actions.bottom + 1);
			expect(attach.x).toBeGreaterThanOrEqual(surface.x - 1);
			expect(attach.right).toBeLessThanOrEqual(surface.right + 1);

			const stagedName = `geometry-${density}.txt`;
			await page.getByLabel("Choose files to attach").setInputFiles({
				name: stagedName,
				mimeType: "text/plain",
				buffer: Buffer.from(`staged ${density}`),
			});
			await expect(page.getByRole("button", { name: `Remove ${stagedName}` })).toBeVisible();
			const attachmentStatus = page.locator(".attachment-status");
			await expect(attachmentStatus).toHaveAttribute("role", "status");
			await expect(attachmentStatus).toHaveAttribute("aria-live", "polite");
			await expect(attachmentStatus).toContainText(/ready/i);
			const stagedGeometry = await page.evaluate(() => {
				const surface = document.querySelector<HTMLElement>(".composer");
				const shelf = document.querySelector<HTMLElement>(".composer-attachment-bar");
				const surfaceBox = surface?.getBoundingClientRect();
				const shelfBox = shelf?.getBoundingClientRect();
				const chips = Array.from(document.querySelectorAll<HTMLElement>(".attachment-chip"));
				return {
					shelf: shelfBox ? { x: shelfBox.x, y: shelfBox.y, right: shelfBox.right, bottom: shelfBox.bottom } : null,
					surface: surfaceBox ? { x: surfaceBox.x, y: surfaceBox.y, right: surfaceBox.right, bottom: surfaceBox.bottom } : null,
					chips: chips.map(chip => {
						const box = chip.getBoundingClientRect();
						return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
					}),
				};
			});
			expect(stagedGeometry.chips).toHaveLength(1);
			if (!stagedGeometry.surface || !stagedGeometry.shelf) throw new Error("Staged attachment shelf is not rendered");
			for (const chip of stagedGeometry.chips) {
				expect(chip.x).toBeGreaterThanOrEqual(stagedGeometry.shelf.x - 1);
				expect(chip.right).toBeLessThanOrEqual(stagedGeometry.shelf.right + 1);
				expect(chip.y).toBeGreaterThanOrEqual(stagedGeometry.shelf.y - 1);
				expect(chip.bottom).toBeLessThanOrEqual(stagedGeometry.shelf.bottom + 1);
				expect(chip.x).toBeGreaterThanOrEqual(stagedGeometry.surface.x - 1);
				expect(chip.right).toBeLessThanOrEqual(stagedGeometry.surface.right + 1);
				expect(chip.y).toBeGreaterThanOrEqual(stagedGeometry.surface.y - 1);
				expect(chip.bottom).toBeLessThanOrEqual(stagedGeometry.surface.bottom + 1);
			}
			await page.getByRole("button", { name: `Remove ${stagedName}` }).click();
			await expect(page.getByRole("button", { name: `Remove ${stagedName}` })).toHaveCount(0);
			await expect(attachmentStatus).toHaveCount(0);

			const composerInput = page.getByRole("combobox", { name: "Message OMP" });
			const readTextareaMetrics = () => composerInput.evaluate(element => {
				const textarea = element as HTMLTextAreaElement;
				const style = getComputedStyle(textarea);
				const rect = textarea.getBoundingClientRect();
				return {
					height: rect.height,
					clientHeight: textarea.clientHeight,
					scrollHeight: textarea.scrollHeight,
					maxHeight: Number.parseFloat(style.maxHeight),
					overflowY: style.overflowY,
				};
			});

			await composerInput.fill("");
			const idle = await readTextareaMetrics();
			expect(idle.height).toBeGreaterThan(0);
			expect(idle.height).toBeLessThan(idle.maxHeight);
			await composerInput.fill("single line");
			const oneLine = await readTextareaMetrics();
			expect(oneLine.height).toBeGreaterThan(0);
			expect(oneLine.height).toBeLessThan(oneLine.maxHeight);
			await composerInput.fill("line one\nline two\nline three\nline four");
			await expect.poll(async () => (await readTextareaMetrics()).height).toBeGreaterThan(oneLine.height);
			const multiline = await readTextareaMetrics();
			expect(multiline.height).toBeGreaterThan(oneLine.height);
			expect(multiline.height).toBeLessThan(multiline.maxHeight);
			expect(multiline.scrollHeight).toBeLessThanOrEqual(multiline.clientHeight + 1);

			const longDraft = ["ultrathink", ...Array.from({ length: 100 }, (_, index) => `draft line ${index} keeps the editor occupied`)].join("\n");
			await composerInput.fill(longDraft);
			await expect.poll(async () => {
				const metrics = await readTextareaMetrics();
				return metrics.scrollHeight > metrics.clientHeight;
			}).toBe(true);
			const capped = await readTextareaMetrics();
			expect(capped.height).toBeGreaterThanOrEqual(multiline.height);
			expect(capped.height).toBeLessThanOrEqual(capped.maxHeight + 1);
			expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight);
			expect(["auto", "scroll"]).toContain(capped.overflowY);

			const backdrop = page.locator(".composer-backdrop");
			await expect(backdrop).toBeVisible();
			await composerInput.evaluate(element => {
				const textarea = element as HTMLTextAreaElement;
				textarea.scrollTop = textarea.scrollHeight;
				textarea.dispatchEvent(new Event("scroll", { bubbles: true }));
			});
			await expect.poll(() => composerInput.evaluate(element => (element as HTMLTextAreaElement).scrollTop)).toBeGreaterThan(0);
			await expect.poll(() => page.evaluate(() => {
				const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea");
				const backdrop = document.querySelector<HTMLElement>(".composer-backdrop");
				return Boolean(textarea && backdrop && backdrop.scrollTop === textarea.scrollTop);
			})).toBe(true);
			const alignment = await page.evaluate(() => {
				const textarea = document.querySelector<HTMLTextAreaElement>(".composer textarea");
				const backdrop = document.querySelector<HTMLElement>(".composer-backdrop");
				if (!textarea || !backdrop) return null;
				const inputRect = textarea.getBoundingClientRect();
				const backdropRect = backdrop.getBoundingClientRect();
				return {
					rectDelta: Math.max(
						Math.abs(inputRect.x - backdropRect.x),
						Math.abs(inputRect.y - backdropRect.y),
						Math.abs(inputRect.width - backdropRect.width),
						Math.abs(inputRect.height - backdropRect.height),
					),
					inputScrollTop: textarea.scrollTop,
					backdropScrollTop: backdrop.scrollTop,
				};
			});
			if (!alignment) throw new Error("Composer magic backdrop is not rendered");
			expect(alignment.rectDelta).toBeLessThanOrEqual(1);
			expect(alignment.backdropScrollTop).toBe(alignment.inputScrollTop);

			await composerInput.fill("/");
			const commandMenu = page.locator("#slash-command-menu");
			const commandList = commandMenu.getByRole("listbox", { name: "Slash commands" });
			await expect(commandMenu).toBeVisible();
			await expect(commandList).toBeVisible();
			await expect(composerInput).toHaveAttribute("aria-expanded", "true");
			await expect(composerInput).toHaveAttribute("aria-controls", "slash-command-menu");
			await expect(composerInput).toHaveAttribute("aria-activedescendant", /^slash-command-option-\d+$/);
			await composerInput.press("Escape");
			await expect(commandMenu).toBeHidden();
			await expect(composerInput).toHaveAttribute("aria-expanded", "false");
			await expect(composerInput).toHaveValue("/");
			await expect(composerInput).toBeFocused();
			await expect(composerInput).toHaveAttribute("role", "combobox");
			await expect(composerInput).toHaveAttribute("aria-autocomplete", "list");
			await expect(composerInput).toHaveAttribute("aria-haspopup", "listbox");
			await expect(composerInput).toHaveAttribute("aria-expanded", "false");
			await expect(composerInput).not.toHaveAttribute("aria-controls");
			await expect(composerInput).not.toHaveAttribute("aria-activedescendant");
		}
	} finally {
		await teardownElectronTest(app, userData);
	}
});
test.describe("composer attachments", () => {
	test("stages picker files with exact native transport and supports attachment-only send", async () => {
		const userData = await createUserData("gradivus-a1-");
		const workspace = path.join(userData, "workspace");
		await seed(userData, workspace, ["fixture-attachments-picker"]);
		const app = await launch(userData, workspace);
		const errors = await app.firstWindow().then(page => collectRendererErrors(page));
		try {
			const page = await app.firstWindow();
			await page.setViewportSize({ width: 1280, height: 820 });
			await expectComposerReady(page);
			const composer = page.getByLabel("Message OMP");
			const chooserPromise = page.waitForEvent("filechooser");
			await page.getByLabel("Attach files").click();
			const chooser = await chooserPromise;
			await chooser.setFiles([
				{ name: "notes with spaces.md", mimeType: "text/plain", buffer: SMALL_TEXT },
				{ name: "screen.dat", mimeType: "text/plain", buffer: SMALL_PNG },
			]);
			await expect(page.getByLabel("Attached files")).toContainText("notes with spaces.md");
			await expect(page.getByLabel("Attached files")).toContainText("screen.dat");
			await expect(page.getByLabel("Attached files")).toContainText("FILE");
			await expect(page.getByLabel("Attached files")).toContainText("IMG");
			await page.getByRole("button", { name: "Remove notes with spaces.md" }).click();
			await expect(page.getByRole("button", { name: "Remove notes with spaces.md" })).toHaveCount(0);
			const reselectPromise = page.waitForEvent("filechooser");
			await page.getByLabel("Attach files").click();
			await (await reselectPromise).setFiles({ name: "notes with spaces.md", mimeType: "text/plain", buffer: SMALL_TEXT });
			await expect(page.getByRole("button", { name: "Remove notes with spaces.md" })).toBeVisible();
			await composer.press("Enter");
			const captureFile = path.join(userData, "attachment-captures.jsonl");
			const capture = await waitForAttachmentCapture(captureFile, value => value.route === "prompt");
			await expect(page.locator(".timeline-scroll")).toContainText("Attachment report: route=prompt; files=1; prompts=0; images=1; readable=true");
			expect(capture.baseTextBytes).toBe(0);
			expect(capture.envelopes.map(value => value.kind)).toEqual(["image", "file"]);
			expect(capture.references).toHaveLength(1);
			expect(capture.references[0]).toMatchObject({ kind: "file", bytes: SMALL_TEXT.byteLength, sha256: sha256(SMALL_TEXT), absolute: true, exists: true });
			expect(capture.images).toEqual([{ mimeType: "image/png", bytes: SMALL_PNG.byteLength, sha256: sha256(SMALL_PNG), base64Valid: true }]);
			await expect(page.getByRole("button", { name: "Remove notes with spaces.md" })).toHaveCount(0);
			await expect(page.getByRole("button", { name: "Remove screen.dat" })).toHaveCount(0);
			await waitForCapturedPath(captureFile, value => value.sequence === capture.sequence, false);
			expect(errors).toEqual([]);
		} finally {
			await teardownElectronTest(app, userData);
		}
	});

	test("keeps file drag overlay accessible and overflow-safe at narrow reduced-motion settings", async () => {
		const userData = await createUserData("gradivus-a2-");
		const workspace = path.join(userData, "workspace");
		await seed(userData, workspace, ["fixture-attachments-drag"], completeSettings(workspace, { ui: { density: "compact", reduceMotion: true, showToolDetails: true } }));
		const app = await launch(userData, workspace);
		const errors = await app.firstWindow().then(page => collectRendererErrors(page));
		try {
			const page = await app.firstWindow();
			await page.setViewportSize({ width: 760, height: 620 });
			await expectComposerReady(page);
			const composer = page.getByLabel("Message OMP");
			await composer.fill("preserve this draft");
			await dispatchNonFileDrag(page, ".composer");
			await expect(page.locator(".composer-drop-overlay")).toHaveCount(0);
			await dispatchFileDrag(page, ".composer", [{ name: "dragged.txt", mimeType: "text/plain", bytes: SMALL_TEXT }], ["dragenter"]);
			await expect(page.locator(".composer-drop-overlay")).toBeVisible();
			await dispatchFileDrag(page, ".composer", [{ name: "dragged.txt", mimeType: "text/plain", bytes: SMALL_TEXT }], ["dragleave"]);
			await expect(page.locator(".composer-drop-overlay")).toHaveCount(0);
			await dispatchFileDrag(page, ".composer", [{ name: "dragged.txt", mimeType: "text/plain", bytes: SMALL_TEXT }], ["dragenter", "dragover", "drop", "dragend"]);
			await expect(page.getByRole("button", { name: "Remove dragged.txt" })).toBeVisible();
			await expect(composer).toHaveValue("preserve this draft");
			const longFiles = Array.from({ length: 6 }, (_, index) => ({ name: `long-${index}-${"x".repeat(80)}.txt`, mimeType: "text/plain", buffer: SMALL_TEXT }));
			await page.getByLabel("Choose files to attach").setInputFiles(longFiles);
			await expect.poll(() => page.locator(".attachment-chip").count()).toBe(7);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
			await page.getByRole("button", { name: /Remove long-0-/ }).focus();
			await page.keyboard.press("Enter");
			await expect(page.getByRole("button", { name: /Remove long-0-/ })).toHaveCount(0);
			const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
			expect(axe.violations.filter(value => value.impact === "critical" || value.impact === "serious")).toEqual([]);
			expect(await page.locator(".composer-wrap *").evaluateAll(elements => elements.some(element => getComputedStyle(element).animationName !== "none"))).toBe(false);
			expect(errors).toEqual([]);
		} finally {
			await teardownElectronTest(app, userData);
		}
	});

	test("spills oversized pasted and programmatic text without embedding it", async () => {
		const userData = await createUserData("gradivus-a3-");
		const workspace = path.join(userData, "workspace");
		await seed(userData, workspace, ["fixture-attachments-spill"]);
		const app = await launch(userData, workspace);
		const errors = await app.firstWindow().then(page => collectRendererErrors(page));
		try {
			const page = await app.firstWindow();
			await expectComposerReady(page);
			const composer = page.getByLabel("Message OMP");
			await composer.fill("ordinary paste");
			await expect(composer).toHaveValue("ordinary paste");
			await expect(page.getByRole("button", { name: "Remove Pasted prompt" })).toHaveCount(0);
			await page.getByLabel("Choose files to attach").setInputFiles({ name: "paste-image.bin", mimeType: "text/plain", buffer: SMALL_PNG });
			const prefix = "prefix:";
			const suffix = ":suffix";
			const composed = `${prefix}${"p".repeat(512 * 1024 - prefix.length - suffix.length + 1)}${suffix}`;
			await composer.fill(`${prefix}${suffix}`);
			await composer.evaluate((element, prefixValue) => { const input = element as HTMLTextAreaElement; input.setSelectionRange(prefixValue.length, prefixValue.length); }, prefix);
			await page.evaluate(value => {
				const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message OMP"]')!;
				const transfer = new DataTransfer();
				transfer.setData("text/plain", value);
				input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
			}, composed.slice(prefix.length, -suffix.length));
			await expect(page.getByText("Pasted prompt is ready as an attachment.", { exact: true })).toBeVisible();
			await expect(page.getByRole("button", { name: "Remove Pasted prompt" })).toBeVisible();
			await composer.press("Enter");
			const captureFile = path.join(userData, "attachment-captures.jsonl");
			const capture = await waitForAttachmentCapture(captureFile, value => value.route === "prompt" && value.envelopes.some(envelope => envelope.kind === "prompt"));
			expect(capture.messageBytes).toBeLessThan(512 * 1024);
			expect(capture.baseTextBytes).toBe(0);
			const promptReference = capture.references.find(reference => reference.kind === "prompt");
			expect(promptReference).toMatchObject({ bytes: Buffer.byteLength(composed), sha256: sha256(Buffer.from(composed)), absolute: true, exists: true });
			await expect(page.getByRole("button", { name: "Remove Pasted prompt" })).toHaveCount(0);
			await waitForCapturedPath(captureFile, value => value.sequence === capture.sequence, false);
			const programmatic = "q".repeat(512 * 1024 + 1);
			await composer.fill(programmatic);
			await expect(page.getByRole("button", { name: "Remove Pasted prompt" })).toBeVisible();
			await page.getByRole("button", { name: "Remove Pasted prompt" }).click();
			await expect(page.getByRole("button", { name: "Remove Pasted prompt" })).toHaveCount(0);
			expect(errors).toEqual([]);
		} finally {
			await teardownElectronTest(app, userData);
		}
	});

	test("rejects attachment count, size, image, cumulative, and spill limits atomically", async () => {
		test.setTimeout(120_000);
		const userData = await createUserData("gradivus-a4-");
		const workspace = path.join(userData, "workspace");
		await seed(userData, workspace, ["fixture-attachments-limits"]);
		const app = await launch(userData, workspace);
		const errors = await app.firstWindow().then(page => collectRendererErrors(page));
		try {
			const page = await app.firstWindow();
			await expectComposerReady(page);
			const input = page.getByLabel("Choose files to attach");
			await input.setInputFiles(Array.from({ length: 13 }, (_, index) => ({ name: `tiny-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from([index]) })));
			await expect(page.getByRole("status")).toContainText("You can attach up to 12 files.");
			await expect(page.locator(".attachment-chip")).toHaveCount(0);
			await input.setInputFiles({ name: "too-large.txt", mimeType: "text/plain", buffer: Buffer.alloc(25 * 1024 * 1024 + 1) });
			await expect(page.getByRole("status")).toContainText("too-large.txt exceeds the 25 MiB attachment limit.");
			await expect(page.locator(".attachment-chip")).toHaveCount(0);
			await input.setInputFiles([{ name: "batch-a.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(17 * 1024 * 1024) }, { name: "batch-b.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(17 * 1024 * 1024) }]);
			await expect(page.getByRole("status")).toContainText("Attachments exceed the 32 MiB batch limit.");
			await expect(page.locator(".attachment-chip")).toHaveCount(0);
			const largePng = Buffer.concat([SMALL_PNG, Buffer.alloc(20 * 1024 * 1024 - SMALL_PNG.length + 1)]);
			await input.setInputFiles({ name: "large-image.bin", mimeType: "text/plain", buffer: largePng });
			await expect(page.getByRole("status")).toContainText("image attachment exceeds 20 MiB");
			await expect(page.locator(".attachment-chip")).toHaveCount(0);
			await input.setInputFiles({ name: "twenty.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(20 * 1024 * 1024) });
			await expect(page.getByRole("button", { name: "Remove twenty.bin" })).toBeVisible();
			await input.setInputFiles({ name: "thirteen.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(13 * 1024 * 1024) });
			await expect(page.getByRole("status")).toContainText("Attachments exceed the 32 MiB batch limit.");
			await expect(page.getByRole("button", { name: "Remove twenty.bin" })).toBeVisible();
			await page.getByRole("button", { name: "Remove twenty.bin" }).click();
			await input.setInputFiles(Array.from({ length: 12 }, (_, index) => ({ name: `count-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from([index]) })));
			await expect.poll(() => page.locator(".attachment-chip").count()).toBe(12);
			const draft = "r".repeat(512 * 1024 + 1);
			await page.getByLabel("Message OMP").fill(draft);
			await expect(page.getByRole("status")).toContainText("You can attach up to 12 files.");
			await expect(page.locator(".attachment-chip")).toHaveCount(12);
			await expect(page.getByLabel("Message OMP")).toHaveValue(draft);
			expect(errors).toEqual([]);
		} finally {
			await teardownElectronTest(app, userData);
		}
	});

	test("restores and retries an attachment-only prompt after immediate failure", async () => {
		const userData = await createUserData("gradivus-a5-");
		const workspace = path.join(userData, "workspace");
		await seed(userData, workspace, ["fixture-attachments-immediate"]);
		const app = await launch(userData, workspace, { GRADIVUS_REJECT_NEXT_PROMPT: "immediate" });
		const errors = await app.firstWindow().then(page => collectRendererErrors(page));
		try {
			const page = await app.firstWindow();
			await expectComposerReady(page);
			await page.getByLabel("Choose files to attach").setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: SMALL_TEXT });
			await page.getByLabel("Message OMP").press("Enter");
			await expect(page.locator(".prompt-recovery-card")).toContainText("Fixture prompt delivery failed.");
			await expect(page.getByRole("button", { name: "Remove retry.txt" })).toBeVisible();
			await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
			const captureFile = path.join(userData, "attachment-captures.jsonl");
			const first = await waitForAttachmentCapture(captureFile, value => value.sequence === 1);
			await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			const second = await waitForAttachmentCapture(captureFile, value => value.sequence === 2);
			expect(second.references[0]).toMatchObject({ path: first.references[0]?.path, sha256: sha256(SMALL_TEXT), exists: true });
			await expect(page.getByRole("button", { name: "Remove retry.txt" })).toHaveCount(0);
			await waitForCapturedPath(captureFile, value => value.sequence === 2, false);
			expect(errors).toEqual([]);
		} finally {
			await teardownElectronTest(app, userData);
		}
	});
test("preserves newer draft and newly staged files across delayed prompt failure", async () => {
	const userData = await createUserData("gradivus-a6-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-attachments-delayed"]);
	const app = await launch(userData, workspace, { GRADIVUS_REJECT_NEXT_PROMPT: "delayed" });
	const errors = await app.firstWindow().then(page => collectRendererErrors(page));
	try {
		const page = await app.firstWindow();
		await expectComposerReady(page);
		const composer = page.getByLabel("Message OMP");
		const input = page.getByLabel("Choose files to attach");
		await input.setInputFiles({ name: "original.md", mimeType: "text/markdown", buffer: Buffer.from("original attachment") });
		await composer.fill("original request");
		await composer.press("Enter");
		await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/);
		await composer.fill("newer draft");
		await input.setInputFiles({ name: "new.md", mimeType: "text/markdown", buffer: Buffer.from("new attachment") });
		await expect(page.locator(".prompt-recovery-card")).toContainText("Fixture prompt delivery failed.", { timeout: 15_000 });
		await expect(composer).toHaveValue("original request\n\nnewer draft");
		await expect.poll(() => page.locator(".attachment-chip-name").allTextContents()).toEqual(["original.md", "new.md"]);
		const captureFile = path.join(userData, "attachment-captures.jsonl");
		const first = await waitForAttachmentCapture(captureFile, value => value.sequence === 1);
		expect(first.references[0]?.exists).toBe(true);
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		const second = await waitForAttachmentCapture(captureFile, value => value.sequence === 2);
		expect(second.references.map(reference => reference.bytes)).toEqual([Buffer.byteLength("original attachment"), Buffer.byteLength("new attachment")]);
		await expect(page.getByRole("button", { name: "Remove original.md" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Remove new.md" })).toHaveCount(0);
		await expect.poll(async () => Promise.all(second.references.map(async reference => { try { await fs.access(reference.path); return true; } catch { return false; } }))).toEqual([false, false]);
		expect(errors).toEqual([]);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("retains local-command attachments and isolates session switching", async () => {
	const userData = await createUserData("gradivus-a7-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-local-a", "fixture-local-b"]);
	const app = await launch(userData, workspace);
	const errors = await app.firstWindow().then(page => collectRendererErrors(page));
	try {
		const page = await app.firstWindow();
		await expectComposerReady(page);
		const composer = page.getByLabel("Message OMP");
		await page.getByLabel("Choose files to attach").setInputFiles({ name: "local.md", mimeType: "text/markdown", buffer: SMALL_TEXT });
		await composer.fill("/status");
		await composer.press("Enter");
		await expect(page.locator(".timeline-scroll")).toContainText("Fixture status: ready");
		await expect(page.getByRole("button", { name: "Remove local.md" })).toBeVisible();
		const captureFile = path.join(userData, "attachment-captures.jsonl");
		const capture = await waitForAttachmentCapture(captureFile, value => value.route === "prompt");
		expect(capture.baseTextBytes).toBe(Buffer.byteLength("/status"));
		await page.getByRole("button", { name: "Remove local.md" }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("button", { name: "Remove local.md" })).toHaveCount(0);
		await waitForCapturedPath(captureFile, value => value.sequence === capture.sequence, false);
		await page.getByLabel("Choose files to attach").setInputFiles({ name: "session-a.md", mimeType: "text/markdown", buffer: SMALL_TEXT });
		const sessions = page.getByRole("treeitem");
		await expect(sessions).toHaveCount(2);
		await sessions.nth(1).click();
		await expect(page.getByRole("button", { name: "Remove session-a.md" })).toHaveCount(0);
		await sessions.nth(0).click();
		await expect(page.getByRole("button", { name: "Remove session-a.md" })).toHaveCount(0);
		await expect.poll(async () => (await enumeratePromptStoreFiles(userData)).length).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("releases a slow staging result at a session boundary", async () => {
	const userData = await createUserData("gradivus-a8-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-race-a", "fixture-race-b"]);
	const app = await launch(userData, workspace);
	const errors = await app.firstWindow().then(page => collectRendererErrors(page));
	try {
		const page = await app.firstWindow();
		await expectComposerReady(page);
		const resolveSlowFile = await dispatchSlowFileDrag(page, ".composer-wrap", { name: "slow.md", mimeType: "text/markdown", bytes: SMALL_TEXT });
		await expect(page.getByRole("status")).toContainText("Staging 1 attachment");
		await page.getByRole("treeitem").nth(1).click();
		await resolveSlowFile();
		await expect(page.getByLabel("Attach files")).toBeEnabled();
		await expect(page.getByRole("button", { name: "Remove slow.md" })).toHaveCount(0);
		await expect.poll(async () => (await enumeratePromptStoreFiles(userData)).length).toBe(0);
		await page.getByRole("treeitem").nth(0).click();
		await expect(page.getByRole("button", { name: "Remove slow.md" })).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("steers with exact attachments, rolls back once, and releases admitted files", async () => {
	const userData = await createUserData("gradivus-a9-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-attachments-steer"]);
	const app = await launch(userData, workspace, { GRADIVUS_REJECT_NEXT_STEER: "1" });
	const errors = await app.firstWindow().then(page => collectRendererErrors(page));
	try {
		const page = await app.firstWindow();
		await expectComposerReady(page);
		const composer = page.getByLabel("Message OMP");
		await composer.fill("hold current turn");
		await composer.press("Enter");
		await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/);
		await page.getByLabel("Choose files to attach").setInputFiles([{ name: "steer.md", mimeType: "text/markdown", buffer: SMALL_TEXT }, { name: "steer.png", mimeType: "image/png", buffer: SMALL_PNG }]);
		await composer.fill("steer with files");
		await composer.press("Enter");
		await expect(page.getByRole("button", { name: "Remove steer.md" })).toBeVisible();
		await expect(composer).toHaveValue("steer with files");
		const captureFile = path.join(userData, "attachment-captures.jsonl");
		const first = await waitForAttachmentCapture(captureFile, value => value.route === "steer");
		await expect.poll(async () => { try { await fs.access(first.references[0]!.path); return true; } catch { return false; } }).toBe(true);
		await composer.press("Enter");
		const second = await waitForAttachmentCapture(captureFile, value => value.route === "steer" && value.sequence > first.sequence);
		expect(second.images).toEqual([{ mimeType: "image/png", bytes: SMALL_PNG.byteLength, sha256: sha256(SMALL_PNG), base64Valid: true }]);
		await expect(page.getByRole("button", { name: "Remove steer.md" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Remove steer.png" })).toHaveCount(0);
		await expect.poll(async () => { try { await fs.access(second.references[0]!.path); return true; } catch { return false; } }).toBe(false);
		await expect(page.locator(".timeline-scroll")).toContainText("Held turn completed after steering.");
		expect(errors).toEqual([]);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("queues exact follow-up attachments, releases them at admission, and leaves nothing at teardown", async () => {
	const userData = await createUserData("gradivus-a10-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-attachments-follow-up"]);
	const app = await launch(userData, workspace, { GRADIVUS_REJECT_NEXT_FOLLOW_UP: "1" });
	const errors = await app.firstWindow().then(page => collectRendererErrors(page));
	try {
		const page = await app.firstWindow();
		await expectComposerReady(page);
		const composer = page.getByLabel("Message OMP");
		await composer.fill("hold current turn");
		await composer.press("Enter");
		await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/);
		await page.getByLabel("Choose files to attach").setInputFiles([{ name: "queue.md", mimeType: "text/markdown", buffer: SMALL_TEXT }, { name: "queue.png", mimeType: "image/png", buffer: SMALL_PNG }]);
		await composer.fill("queue with files");
		await page.locator("summary.action-menu-trigger").click();
		await page.getByRole("button", { name: "Queue for the next turn", exact: true }).click();
		await expect(page.getByRole("button", { name: "Remove queue.md" })).toBeVisible();
		const captureFile = path.join(userData, "attachment-captures.jsonl");
		const first = await waitForAttachmentCapture(captureFile, value => value.route === "follow_up");
		await expect(page.locator(".error-toast")).toContainText("Fixture follow-up delivery failed.");
		await expect.poll(async () => { try { await fs.access(first.references[0]!.path); return true; } catch { return false; } }).toBe(true);
		await expect(page.getByRole("button", { name: "Remove queue.md" })).toBeVisible();
		await page.locator(".error-toast").getByRole("button", { name: "Dismiss error" }).click();
		await page.locator("summary.action-menu-trigger").click();
		await expect(page.getByRole("button", { name: "Queue for the next turn" })).toBeEnabled();
		await page.locator("button.queue-follow-up-button").evaluate(button => (button as HTMLButtonElement).click());
		const second = await waitForAttachmentCapture(captureFile, value => value.route === "follow_up" && value.sequence > first.sequence);
		expect(second.images).toEqual([{ mimeType: "image/png", bytes: SMALL_PNG.byteLength, sha256: sha256(SMALL_PNG), base64Valid: true }]);
		await expect(page.getByRole("button", { name: "Remove queue.md" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Remove queue.png" })).toHaveCount(0);
		await expect.poll(async () => { try { await fs.access(second.references[0]!.path); return true; } catch { return false; } }).toBe(false);
		await expect(page.locator(".timeline-scroll")).toContainText("Follow-up completed after the active turn.");
		const admittedPaths = second.references.map(reference => reference.path);
		await app.close();
		await expect.poll(async () => Promise.all(admittedPaths.map(async admittedPath => { try { await fs.access(admittedPath); return true; } catch { return false; } }))).toEqual([false]);
		await expect.poll(async () => (await enumeratePromptStoreFiles(userData)).length).toBe(0);
		expect(errors).toEqual([]);
	} finally {
		await teardownElectronTest(app, userData);
	}
});
test("isolates attachments across successful workspace creation", async () => {
	const userData = await createUserData("gradivus-a11-");
	const workspaceA = path.join(userData, "workspace-a");
	const workspaceB = path.join(userData, "workspace-b");
	await seed(userData, workspaceA, ["fixture-session-a"]);
	await fs.mkdir(workspaceB, { recursive: true });
	const app = await launch(userData, workspaceA);
	try {
		const page = await app.firstWindow();
		await expectComposerReady(page);
		await page.getByLabel("Choose files to attach").setInputFiles({
			name: "session-a.md",
			mimeType: "text/markdown",
			buffer: SMALL_TEXT,
		});
		await expect(page.getByRole("button", { name: "Remove session-a.md" })).toBeVisible();
		const setChooserResult = async (canceled: boolean, selectedPath: string): Promise<void> => {
			await app.evaluate(({ dialog }, result: { canceled: boolean; selectedPath: string }) => {
				dialog.showOpenDialog = async () => ({
					canceled: result.canceled,
					filePaths: result.canceled ? [] : [result.selectedPath],
				});
			}, { canceled, selectedPath });
		};
		await setChooserResult(true, workspaceB);
		await page.getByRole("button", { name: "Create new workspace" }).click();
		await expect(page.getByRole("button", { name: "Remove session-a.md" })).toBeVisible();
		await setChooserResult(false, workspaceB);
		await page.getByRole("button", { name: "Create new workspace" }).click();
		await expect(page.getByRole("button", { name: "Remove session-a.md" })).toHaveCount(0);
		const captureFile = path.join(userData, "attachment-captures.jsonl");
		await page.getByLabel("Message OMP").fill("new workspace prompt");
		await page.getByLabel("Message OMP").press("Enter");
		const capture = await waitForAttachmentCapture(captureFile, value => value.route === "prompt");
		expect(capture.references).toEqual([]);
		await expect.poll(async () => (await enumeratePromptStoreFiles(userData)).length).toBe(0);
	} finally {
		await teardownElectronTest(app, userData);
	}
});
});
test("reopens settings after a delayed refresh closes", async () => {
	const userData = await createUserData("gradivus-e2e-set-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-settings-refresh"]);
	const app = await launch(userData, workspace, { GRADIVUS_SETTINGS_RESPONSE_DELAY: "250" });
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1280, height: 820 });
		await expect(page.getByLabel("Message OMP")).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Open settings" }).click();
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
		const refreshButton = page.locator(".settings-shell-actions button").first();
		if (await refreshButton.isEnabled()) await refreshButton.click();
		await expect(refreshButton).toBeDisabled();
		await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
		await expect(page.getByLabel("Message OMP")).toBeVisible();
		await page.getByRole("button", { name: "Open settings" }).click();
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
		await expect(page.locator(".settings-shell-actions button").first()).toBeDisabled();
		await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled({ timeout: 2_000 });
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("detaches the active browser view while routed settings are open", async () => {
	test.setTimeout(60_000);
	const userData = await createUserData("gradivus-browser-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-settings-refresh"]);
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1280, height: 820 });
		await expect(page.getByLabel("Message OMP")).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Open browser tab" }).click();
		const browserTab = page.getByRole("tab", { name: /Browser/ });
		await browserTab.click();
		const pane = page.getByRole("group", { name: "Browser pane" });
		const address = pane.getByRole("textbox", { name: "Address" });
		await address.fill("http://127.0.0.1:5173/browser-fixture.html");
		await address.press("Enter");
		const readFixtureView = async (): Promise<{ id: number; url: string } | undefined> =>
			app.evaluate(({ BrowserWindow }) => {
				const win = BrowserWindow.getAllWindows()[0];
				const view = win?.contentView.children.find(candidate => {
					if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
					const webContents = (candidate.webContents as WebContents | undefined) ?? undefined;
					return Boolean(webContents && !webContents.isDestroyed() && webContents.getURL().includes("browser-fixture.html"));
				}) as { webContents: WebContents } | undefined;
				if (!view) return undefined;
				return { id: view.webContents.id, url: view.webContents.getURL() };
			});
		await expect.poll(() => readFixtureView(), { timeout: 15_000 }).toBeTruthy();
		const before = await readFixtureView();
		if (!before) throw new Error("Fixture browser view did not attach");
		await expect(browserTab).toHaveAttribute("aria-selected", "true");

		await page.getByRole("button", { name: "Open application settings", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
		await expect.poll(() => readFixtureView(), { timeout: 10_000 }).toBeUndefined();
		await expect(browserTab).toHaveAttribute("aria-selected", "true");

		await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);
		await expect.poll(() => readFixtureView(), { timeout: 10_000 }).toBeTruthy();
		const after = await readFixtureView();
		expect(after).toEqual(before);
		await expect(browserTab).toHaveAttribute("aria-selected", "true");
	} finally {
		await teardownElectronTest(app, userData);
	}
});


test("keeps timeline activity paused while reading history and renders bounded file summaries", async () => {
	const userData = await createUserData("gradivus-e2e-wave-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-wave-chat"]);
	const app = await launch(userData, workspace, { GRADIVUS_TIMELINE_FIXTURE: "1" });
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1280, height: 820 });
		const composer = page.getByLabel("Message OMP");
		const timeline = page.locator(".timeline-scroll");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		await expect(timeline).toContainText("Deterministic history entry 260", { timeout: 15_000 });

		const olderEntries = page.getByRole("button", { name: /Load 100 older entries/ });
		await expect(olderEntries).toBeVisible();
		await olderEntries.click();
		await expect(timeline).toContainText("Deterministic history entry 1");

		await timeline.evaluate(element => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		const jump = page.getByRole("button", { name: /Jump to latest messages/ });
		await expect(jump).toBeVisible();

		await composer.fill("timeline wave");
		await composer.press("Enter");
		await timeline.evaluate(element => {
			element.scrollTop = 0;
			element.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		const pausedScrollTop = await timeline.evaluate(element => element.scrollTop);
		await expect(timeline.getByText("read", { exact: true })).toBeVisible({ timeout: 8_000 });
		await expect(timeline).toContainText("Wave assistant complete 1.", { timeout: 12_000 });
		await expect(jump).toBeVisible();
		const scrollTopAfter = await timeline.evaluate(element => element.scrollTop);
		expect(scrollTopAfter).toBeLessThanOrEqual(pausedScrollTop + 8);

		await expect(timeline.getByLabel("Read activity")).toContainText("notes.txt");
		await expect(timeline.getByLabel("Wrote activity")).toContainText("activity.txt");
		await expect(timeline.getByLabel("Edited activity")).toContainText("notes.txt");
		await expect(timeline.locator(".tool-activity-preview").first()).toContainText("alpha");
		await jump.click();
		await expect(jump).toBeHidden();
		await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(8);
		await composer.fill("timeline wave following");
		await composer.press("Enter");
		await expect(timeline).toContainText("Wave assistant complete 2.", { timeout: 12_000 });
		await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(8);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("opens Agent Hub and Files inspectors with fixture lifecycle and activity controls", async () => {
	const userData = await createUserData("gradivus-inspect-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-inspector-chat"]);
	const app = await launch(userData, workspace, { GRADIVUS_TIMELINE_FIXTURE: "1" });
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		const timeline = page.locator(".timeline-scroll");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		await composer.fill("activity wave");
		await composer.press("Enter");
		await expect(timeline).toContainText("Wave assistant complete 1.", { timeout: 12_000 });
		await composer.fill("normal streaming turn");
		await composer.press("Enter");
		await expect(timeline).toContainText("Fixture completed the requested work.", { timeout: 12_000 });

		const runInspector = page.locator("#run-inspector");
		const inspectorHeader = page.locator(".transcript-actions");
		const agentHubHeaderControl = inspectorHeader.locator('button[aria-controls="run-inspector"]').filter({ hasText: "Agent Hub" });
		const filesHeaderControl = inspectorHeader.locator('button[aria-controls="run-inspector"]').filter({ hasText: "Files" });
		await expect(agentHubHeaderControl).toHaveAttribute("aria-label", /Open Agent Hub/);
		await agentHubHeaderControl.click();
		await expect(runInspector).toBeVisible();
		await expect(agentHubHeaderControl).toHaveAttribute("aria-label", /Close Agent Hub/);
		await agentHubHeaderControl.click();
		await expect(runInspector).toBeHidden();
		await agentHubHeaderControl.click();
		await expect(runInspector).toBeVisible();
		await expect(page.getByRole("heading", { name: "Agent Hub", exact: true })).toBeVisible();

		await expect(page.getByRole("tab", { name: "Agent Hub", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Agent Hub", exact: true })).toBeVisible();
		const verifier = page.getByRole("button", { name: /Fixture Verifier/ });
		const advisor = page.getByRole("button", { name: /Fixture Advisor/ });
		await expect(verifier).toBeVisible();
		await expect(advisor).toBeVisible();
		await verifier.click();
		await expect(page.locator(".agent-hub-window")).toBeVisible();
		await expect(page.getByRole("log", { name: "Fixture Verifier transcript" })).toContainText("Fixture collaborator transcript.");
		const agentHubWindow = page.locator(".agent-hub-window");
		const modalAxe = await new AxeBuilder({ page }).include(".agent-hub-window").setLegacyMode(true).analyze();
		expect(modalAxe.violations.filter(v => v.impact === "critical" || v.impact === "serious")).toEqual([]);
		await expect(agentHubWindow.getByRole("button", { name: "Close Agent Hub session", exact: true })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(agentHubWindow).toBeHidden();
		await expect(verifier).toBeFocused();
		await verifier.click();
		await expect(agentHubWindow).toBeVisible();
		await expect(page.getByRole("button", { name: "Revive agent", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Revive agent", exact: true }).click();
		await expect(verifier).toHaveAttribute("aria-label", /idle/);

		const agentMessage = page.locator(".agent-hub-window").getByLabel("Message Fixture Verifier", { exact: true });
		await expect(agentMessage).toBeVisible();
		await agentMessage.fill("Check the activity summary.");
		await page.locator(".agent-hub-window").getByRole("button", { name: "Send message", exact: true }).click();
		await expect(verifier).toContainText("Received: Check the activity summary.");

		page.once("dialog", dialog => void dialog.accept());
		await page.getByRole("button", { name: "Kill agent", exact: true }).click();
		await expect(verifier).toHaveAttribute("aria-label", /aborted/);
		await page.getByRole("button", { name: "Close Agent Hub session", exact: true }).click();
		await advisor.click();
		await expect(page.locator(".agent-hub-window")).toBeVisible();
		await expect(page.getByRole("note")).toContainText("read only");
		await expect(page.getByLabel("Message Fixture Advisor", { exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Close Agent Hub session", exact: true }).click();

		await page.getByRole("tab", { name: /^Files/ }).click();
		await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
		await expect(filesHeaderControl).toHaveAttribute("aria-label", /Close Files/);
		await filesHeaderControl.click();
		await expect(runInspector).toBeHidden();
		await filesHeaderControl.click();
		await expect(runInspector).toBeVisible();
		await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
		await expect(page.getByRole("list", { name: "Recent file and Agent Hub activity" })).toContainText("activity.txt");
		const recentActivity = page.getByRole("list", { name: "Recent file and Agent Hub activity" });
		await expect(recentActivity).toContainText("result.txt");
		await recentActivity.getByRole("button", { name: "Focus read activity in the chat timeline", exact: true }).click();
		await expect(page.getByRole("button", { name: /Jump to latest messages/ })).toBeHidden();
		await composer.fill("normal streaming turn");
		await composer.press("Enter");
		await expect(timeline).toContainText("Fixture completed the requested work.", { timeout: 12_000 });
		await expect.poll(() => timeline.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(8);
		await page.getByRole("button", { name: "Review the current diff for result.txt", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Git diff for result.txt" })).toContainText("Fixture result");
		await page.getByRole("button", { name: "Close git diff", exact: true }).click();
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("opens the current chat terminal drawer without changing chat state", async () => {
	// The runtime control socket is a Unix-domain path; keep this fixture prefix short enough for macOS's 104-byte limit.
	const userData = await createUserData("gradivus-term-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-terminal-chat"]);
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1568, height: 470 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		const timeline = page.locator(".timeline-scroll");
		const timelineBefore = await timeline.innerText();
		const terminalToggle = page.locator('button[aria-controls="chat-terminal-drawer"]');
		const terminalPanel = page.locator(".chat-terminal-drawer");
		await expect(terminalToggle).toHaveAttribute("aria-label", "Show terminal");
		const headerBox = await page.locator(".transcript-header").boundingBox();
		const toggleBox = await terminalToggle.boundingBox();
		expect(headerBox).not.toBeNull();
		expect(toggleBox).not.toBeNull();
		expect(toggleBox!.x).toBeGreaterThan(headerBox!.x + headerBox!.width / 2);
		expect(toggleBox!.y).toBeGreaterThanOrEqual(headerBox!.y);
		expect(toggleBox!.y + toggleBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
		await page.setViewportSize({ width: 1280, height: 820 });
		await expect(terminalToggle).toHaveAttribute("aria-expanded", "false");
		await expect(terminalPanel).toBeHidden();

		await terminalToggle.click();
		await expect(terminalToggle).toHaveAttribute("aria-label", "Hide terminal");
		await expect(terminalToggle).toHaveAttribute("aria-expanded", "true");
		await expect(terminalPanel).toBeVisible();
		const canvas = terminalPanel.locator(".chat-terminal-canvas");
		const panelFrame = page.locator(".chat-terminal-panel");
		const composerBox = await page.locator(".composer-wrap").boundingBox();
		const panelBox = await panelFrame.boundingBox();
		expect(composerBox).not.toBeNull();
		expect(panelBox).not.toBeNull();
		expect(panelBox!.y).toBeGreaterThanOrEqual(composerBox!.y + composerBox!.height);
		const panelWidth = await panelFrame.evaluate(element => element.getBoundingClientRect().width);
		const paneWidth = await page.locator(".transcript-pane").evaluate(element => element.getBoundingClientRect().width);
		expect(panelWidth).toBeCloseTo(paneWidth, 0);
		await expect(canvas).toBeVisible();
		await expect(page.getByRole("button", { name: "Agent activity", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Shell", exact: true })).toHaveCount(0);
		const visual = await page.evaluate(() => {
			const panel = document.querySelector(".chat-terminal-drawer");
			const canvasHost = document.querySelector(".chat-terminal-canvas");
			return {
				background: panel ? getComputedStyle(panel).backgroundColor : "",
				fontFamily: canvasHost ? getComputedStyle(canvasHost).fontFamily : "",
			};
		});
		expect(canonicalizeCssColor(visual.background)).toBe(canonicalizeCssColor(DESKTOP_THEME_PALETTES.dark.terminal.background));
		expect(visual.fontFamily).toContain("monospace");

		const shell = page.locator(".chat-terminal-shell");
		await expect.poll(async () => Number(await shell.getAttribute("data-rendered-offset")), { timeout: 5_000 }).toBeGreaterThan(0);
		const renderedBefore = Number(await shell.getAttribute("data-rendered-offset"));
		await canvas.locator("canvas").first().click();
		await page.keyboard.type("printf 'gradivus-terminal-ok'");
		await page.keyboard.press("Enter");
		await expect.poll(async () => Number(await shell.getAttribute("data-rendered-offset")), { timeout: 5_000 }).toBeGreaterThan(renderedBefore);
		await canvas.locator("canvas").first().click();
		await page.keyboard.type("exit");
		await page.keyboard.press("Enter");
		const restartButton = page.getByRole("button", { name: "Restart shell", exact: true });
		await expect(restartButton).toBeVisible({ timeout: 5_000 });
		await restartButton.click();
		await expect(restartButton).toHaveCount(0);
		const restartedShell = page.locator(".chat-terminal-shell");
		const restartedBefore = Number(await restartedShell.getAttribute("data-rendered-offset"));
		await restartedShell.locator(".chat-terminal-canvas canvas").first().click();
		await page.keyboard.type("printf 'gradivus-terminal-restart-ok'");
		await page.keyboard.press("Enter");
		await expect.poll(async () => Number(await restartedShell.getAttribute("data-rendered-offset")), { timeout: 5_000 }).toBeGreaterThan(restartedBefore);
		const offsetBeforeHide = Number(await restartedShell.getAttribute("data-rendered-offset"));

		await terminalToggle.click();
		await expect(terminalToggle).toHaveAttribute("aria-expanded", "false");
		await expect(terminalPanel).toBeHidden();
		expect(await timeline.innerText()).toBe(timelineBefore);

		await terminalToggle.click();
		await expect(terminalToggle).toHaveAttribute("aria-expanded", "true");
		await expect(terminalPanel).toBeVisible();
		const reopenedCanvas = terminalPanel.locator(".chat-terminal-canvas");
		await expect(reopenedCanvas).toBeVisible();
		const reopenedShell = page.locator(".chat-terminal-shell");
		const reopenedBefore = Number(await reopenedShell.getAttribute("data-rendered-offset"));
		expect(reopenedBefore).toBeGreaterThanOrEqual(offsetBeforeHide);
		await reopenedCanvas.locator("canvas").first().click();
		await page.keyboard.type("printf 'gradivus-terminal-reopened'");
		await page.keyboard.press("Enter");
		await expect.poll(async () => Number(await reopenedShell.getAttribute("data-rendered-offset")), { timeout: 5_000 }).toBeGreaterThan(reopenedBefore);
		expect(await timeline.innerText()).toBe(timelineBefore);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("keeps drafts scoped to their chat across session switches and relaunch", async () => {
	const userData = await createUserData("gradivus-drafts-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-chat-a", "fixture-chat-b"]);
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		const sessions = page.getByRole("treeitem");
		await expect(sessions).toHaveCount(2);

		// Draft in chat A, then leave before sending.
		await composer.fill("Draft alpha for the first chat");
		const secondChat = sessions.filter({ hasText: "Second chat" });
		await secondChat.click();
		await expect(secondChat).toHaveAttribute("aria-selected", "true");

		// The draft does not follow the user across the boundary.
		await expect(composer).toHaveValue("");

		// Draft in chat B too.
		await composer.fill("Draft beta for the second chat");
		const firstChat = sessions.filter({ hasNotText: "Second chat" });
		await firstChat.click();
		await expect(firstChat).toHaveAttribute("aria-selected", "true");
		await expect(composer).toHaveValue("Draft alpha for the first chat");

		await secondChat.click();
		await expect(composer).toHaveValue("Draft beta for the second chat");
	} finally {
		// Drafts are an in-memory convenience: they never reach the persisted registry.
		const registryText = await fs.readFile(path.join(userData, "sessions-v1.json"), "utf8");
		expect(registryText).not.toContain("Draft alpha");
		expect(registryText).not.toContain("Draft beta");
		await teardownElectronTest(app, userData);
	}
});

test("keeps background completion attached to its originating chat", async () => {
	const userData = await createUserData("gradivus-bgchat-"); const workspace = path.join(userData, "workspace"); await seed(userData, workspace, ["fixture-chat-a", "fixture-chat-b"]); const app = await launch(userData, workspace);
	try { const page = await app.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 }); const composer = page.getByLabel("Message OMP"); await expect(composer).toBeVisible({ timeout: 20_000 }); const sessions = page.getByRole("treeitem"); await expect(sessions).toHaveCount(2); await composer.fill("background delayed"); await composer.press("Enter"); await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/, { timeout: 8_000 }); const secondChat = sessions.filter({ hasText: "Second chat" }); await secondChat.click(); await expect(secondChat).toHaveAttribute("aria-selected", "true"); await composer.fill("second chat normal"); await composer.press("Enter"); await expect(page.locator(".timeline-scroll")).toContainText("Fixture completed the requested work.", { timeout: 12_000 }); const firstChat = page.getByRole("treeitem").filter({ hasNotText: "Second chat" }).first(); await firstChat.click(); await expect(firstChat).toHaveAttribute("aria-selected", "true"); await expect(page.locator(".timeline-scroll")).toContainText("Background session completed.", { timeout: 12_000 }); } finally { await teardownElectronTest(app, userData); }
});

test("replays a backgrounded extension request when returning to its chat", async () => {
	const userData = await createUserData("gradivus-extreplay-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-chat-a", "fixture-chat-b"]);
	const app = await launch(userData, workspace, { GRADIVUS_EXTENSION_DELAY_MS: "3000" });
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		const sessions = page.getByRole("treeitem");
		await expect(sessions).toHaveCount(2);
		const dialog = page.locator(".extension-dialog");
		await expect(dialog).toHaveCount(0);

		// Start a turn in chat A whose extension request arrives only after a delay.
		await composer.fill("delayed select");
		await composer.press("Enter");
		await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/, { timeout: 8_000 });

		// Leave chat A before the delayed request arrives.
		const secondChat = sessions.filter({ hasText: "Second chat" });
		await secondChat.click();
		await expect(secondChat).toHaveAttribute("aria-selected", "true");
		await expect(dialog).toHaveCount(0);

		// Wait out the delay while chat B is active, then return to A.
		await page.waitForTimeout(4_000);
		await expect(dialog).toHaveCount(0);

		// The originating chat replays the outstanding request exactly once.
		const firstChat = sessions.filter({ hasNotText: "Second chat" });
		await firstChat.click();
		await expect(page.locator("#extension-title")).toHaveText("Delayed fixture choice");
		await expect(dialog.getByRole("button", { name: "Continue turn" })).toBeVisible();
		await expect(page.locator(".extension-dialog")).toHaveCount(1);
		await dialog.getByRole("button", { name: "Continue turn" }).click();

		// The originating turn continues; no duplicate dialog and no stranded request.
		await expect(page.locator(".timeline-scroll")).toContainText(
			"Fixture continued after the replayed choice: Continue turn.",
			{ timeout: 15_000 },
		);
		await expect(dialog).toHaveCount(0);
		await page.waitForTimeout(1_000);
		await expect(page.locator(".extension-dialog")).toHaveCount(0);
		await expect(page.getByText("Action failed")).toHaveCount(0);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("routes Enter to steering while a turn is active", async () => {
	const userData = await createUserData("gradivus-e2e-steer-"); const workspace = path.join(userData, "workspace"); await seed(userData, workspace, ["fixture-steer-chat"]); const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });
		const composerShell = page.locator(".composer");
		const idleSend = composerShell.getByRole("button", { name: "Send message", exact: true });
		await expect(idleSend).toHaveCount(1);
		await expect(idleSend).toBeDisabled();
		await expect(composerShell.getByRole("button", { name: "Stop generation", exact: true })).toHaveCount(0);

		await composer.fill("hold current turn");
		await composer.press("Enter");
		await expect(page.getByRole("status")).toContainText(/Turn in progress|Generating response|Reasoning/, { timeout: 8_000 });
		await expect(composerShell.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
		const steer = composerShell.getByRole("button", { name: "Steer current turn", exact: true });
		await expect(steer).toHaveCount(1);
		await expect(steer).toBeDisabled();
		const moreActions = composerShell.locator("summary.action-menu-trigger");
		await expect(moreActions).toHaveCount(1);
		await expect(moreActions).toBeEnabled();
		const stop = page.locator(".active-turn-status .turn-stop-btn");
		await expect(stop).toHaveCount(1);
		await expect(page.locator(".turn-stop-btn")).toHaveCount(1);
		await expect(stop).toHaveAccessibleName("Stop generation");
		await expect(stop).toBeEnabled();
		await expect(composerShell.getByRole("button", { name: "Queue for the next turn", exact: true })).toBeHidden();

		await composer.fill("steer the current turn");
		await expect(steer).toBeEnabled();
		await moreActions.click();
		const queue = composerShell.getByRole("button", { name: "Queue for the next turn", exact: true });
		await expect(queue).toBeVisible();
		await expect(queue).toBeEnabled();
		await composer.press("Enter");
		await expect(page.locator(".timeline-scroll")).toContainText("Held turn completed after steering.", { timeout: 15_000 });
	} finally { await teardownElectronTest(app, userData); }
});

test("renders semantic transcript messages", async () => {
	const userData = await createUserData("gradivus-special-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-special-chat"]);
	const app = await launch(userData, workspace, { GRADIVUS_SPECIAL_MESSAGES: "1" });
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
		page.on("pageerror", error => errors.push(error.message));
		const timeline = page.locator(".timeline-scroll");
		const composer = page.getByLabel("Message OMP");
		await page.setViewportSize({ width: 1440, height: 900 });
		await expect(composer).toBeVisible({ timeout: 20_000 });
		await expect(page.getByLabel("System update")).toBeVisible();
		await expect(page.getByLabel("IRC ← Mira message")).toBeVisible();
		await expect(page.getByLabel("IRC → Mira message")).toBeVisible();
		await expect(page.getByLabel("IRC Mira → Noah message")).toBeVisible();
		const collaboration = page.getByLabel("Collaboration prompt from Riley");
		await expect(collaboration).toBeVisible();
		const collaborationText = (await collaboration.textContent()) ?? "";
		const collaborationBody = "Please inspect the fixture's accessibility boundary and return a concise report.";
		expect(collaborationText.split(collaborationBody).length - 1).toBe(1);
		const advisor = page.getByLabel("Advisor notes, 1 blockers");
		await expect(advisor).toContainText("blocker");
		const fourthAdvisorNote = advisor.getByText("The fourth note is intentionally behind the details disclosure.", { exact: true });
		await expect(fourthAdvisorNote).not.toBeVisible();
		await advisor.getByText("Show remaining advisor notes", { exact: true }).click();
		await expect(fourthAdvisorNote).toBeVisible();
		await expect(page.getByLabel("Background job completed activity")).toContainText("Lint workspace");
		await expect(page.getByLabel("Late diagnostics activity")).toContainText("src/auth.ts");
		await expect(page.getByLabel("bash execution, truncated")).toContainText("excluded from context");
		await expect(page.getByLabel("Provider error")).toBeVisible();
		await expect(timeline).not.toContainText("<system-notice>");
		await expect(timeline).not.toContainText("LIVE_MODEL_IRC_INSTRUCTION_SENTINEL");
		await expect(timeline).not.toContainText("FIXTURE_UNKNOWN_DETAILS_MUST_NOT_RENDER");
		await expect(timeline).not.toContainText("Unrecognized event");
		await composer.fill("/fixture-special");
		await composer.press("Enter");
		await expect(page.getByLabel("IRC ← Avery message")).toHaveCount(1, { timeout: 10_000 });
		await expect(timeline).toContainText("A semantic transcript warning is visible", { timeout: 10_000 });
		const summary = page.getByText("Show full compaction summary", { exact: true });
		await expect(summary).toBeVisible();
		await summary.focus();
		await page.keyboard.press("Enter");
		await expect(summary).toBeFocused();
		await expect(timeline).toContainText("Compacted context line 12", { timeout: 5_000 });
		const warningToast = page.getByRole("alert").filter({ hasText: "Dismiss this warning toast" });
		await expect(warningToast).toBeVisible({ timeout: 10_000 });
		await warningToast.getByRole("button", { name: "Dismiss notification" }).click();
		await expect(warningToast).toBeHidden();
		await composer.focus();
		await expect(composer).toBeFocused();
		await composer.fill("composer remains usable");
		await expect(composer).toHaveValue("composer remains usable");
		const wideOverflow = await page.evaluate(() => {
			const timelineElement = document.querySelector(".timeline-scroll");
			return { document: document.documentElement.scrollWidth === document.documentElement.clientWidth, timeline: timelineElement ? timelineElement.scrollWidth === timelineElement.clientWidth : true };
		});
		expect(wideOverflow.document).toBe(true);
		expect(wideOverflow.timeline).toBe(true);
		await page.setViewportSize({ width: 760, height: 620 });
		const narrowOverflow = await page.evaluate(() => {
			const timelineElement = document.querySelector(".timeline-scroll");
			return { document: document.documentElement.scrollWidth === document.documentElement.clientWidth, timeline: timelineElement ? timelineElement.scrollWidth === timelineElement.clientWidth : true };
		});
		expect(narrowOverflow.document).toBe(true);
		expect(narrowOverflow.timeline).toBe(true);
		const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
		expect(axe.violations.filter(violation => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await teardownElectronTest(app, userData);
	}
});
test("applies AAA neutral palettes in dark and light modes", async () => {
	test.setTimeout(120_000);
	const userData = await createUserData("gradivus-e2e-theme-");
	const workspace = path.join(userData, "workspace");
	await seed(userData, workspace, ["fixture-theme-chat"], "dark");
	const app = await launch(userData, workspace, { GRADIVUS_SPECIAL_MESSAGES: "1" });

	try {
		const page: Page = await app.firstWindow();
		const nativeWindowBackground = async (): Promise<string> =>
			canonicalizeCssColor(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? ""));
		const cssColorFor = async (color: string): Promise<string> =>
			canonicalizeCssColor(
				await page.evaluate(value => {
					const probe = document.createElement("span");
					probe.style.backgroundColor = value;
					document.body.append(probe);
					const computed = getComputedStyle(probe).backgroundColor;
					probe.remove();
					return computed;
				}, color),
			);
		const assertNeutralThemeSurfaces = async (theme: ResolvedTheme): Promise<void> => {
			const palette = DESKTOP_THEME_PALETTES[theme];
			const colors = await page.evaluate(() => {
				const root = getComputedStyle(document.documentElement);
				const body = getComputedStyle(document.body);
				const appShell = document.querySelector<HTMLElement>(".app-shell");
				const terminal = document.querySelector<HTMLElement>(".chat-terminal-drawer");
				return {
					rootBackground: root.backgroundColor,
					bodyBackground: body.backgroundColor,
					bodyForeground: body.color,
					chatBackground: appShell ? getComputedStyle(appShell).backgroundColor : "",
					shell: root.getPropertyValue("--shell").trim(),
					shellRaised: root.getPropertyValue("--shell-raised").trim(),
					shellHover: root.getPropertyValue("--shell-hover").trim(),
					chatCanvas: root.getPropertyValue("--chat-canvas").trim(),
					codeSurface: root.getPropertyValue("--code-surface").trim(),
					line: root.getPropertyValue("--line").trim(),
					terminalBackground: root.getPropertyValue("--terminal-background").trim(),
					terminalForeground: root.getPropertyValue("--terminal-foreground").trim(),
					terminalPanel: terminal ? getComputedStyle(terminal).backgroundColor : "",
					terminalBorder: terminal ? getComputedStyle(terminal).borderBottomColor : "",
				};
			});
			const expectedWindow = theme === "dark" ? "#0d0d0d" : "#ffffff";
			const expectedShell = theme === "dark" ? "#141414" : "#fafafa";
			const expectedChat = theme === "dark" ? "#101010" : "#ffffff";
			const expectedCode = theme === "dark" ? "#181818" : "#f5f5f5";
			const expectedRaised = theme === "dark" ? "#1c1c1c" : "#ffffff";
			const expectedHover = theme === "dark" ? "#292929" : "#f2f2f2";
			const expectedLine = theme === "dark" ? "#747474" : "#858585";
			expect(canonicalizeCssColor(colors.rootBackground)).toBe(expectedWindow);
			expect(canonicalizeCssColor(colors.bodyBackground)).toBe(expectedShell);
			expect(canonicalizeCssColor(colors.chatBackground)).toBe(expectedChat);
			expect(canonicalizeCssColor(colors.codeSurface)).toBe(expectedCode);
			expect(canonicalizeCssColor(colors.shellRaised)).toBe(expectedRaised);
			expect(canonicalizeCssColor(colors.shellHover)).toBe(expectedHover);
			expect(canonicalizeCssColor(colors.line)).toBe(expectedLine);
			expect(canonicalizeCssColor(colors.line)).toBe(await cssColorFor(palette.line));
			if (colors.terminalBorder) {
				expect(canonicalizeCssColor(colors.terminalBorder)).toBe(expectedLine);
				expect(canonicalizeCssColor(colors.terminalBorder)).toBe(await cssColorFor(palette.line));
			}
			expect(await nativeWindowBackground()).toBe(expectedWindow);
			expect(canonicalizeCssColor(colors.rootBackground)).toBe(await cssColorFor(palette.windowBackground));
			expect(canonicalizeCssColor(colors.bodyBackground)).toBe(await cssColorFor(palette.shell));
			expect(canonicalizeCssColor(colors.bodyForeground)).toBe(await cssColorFor(palette.foreground));
			expect(canonicalizeCssColor(colors.chatBackground)).toBe(await cssColorFor(palette.chatCanvas));
			expect(canonicalizeCssColor(colors.shell)).toBe(await cssColorFor(palette.shell));
			expect(canonicalizeCssColor(colors.shellRaised)).toBe(await cssColorFor(palette.shellRaised));
			expect(canonicalizeCssColor(colors.shellHover)).toBe(await cssColorFor(palette.shellHover));
			expect(canonicalizeCssColor(colors.chatCanvas)).toBe(await cssColorFor(palette.chatCanvas));
			expect(canonicalizeCssColor(colors.codeSurface)).toBe(await cssColorFor(palette.codeSurface));
			expect(canonicalizeCssColor(colors.terminalBackground)).toBe(await cssColorFor(palette.terminal.background));
			expect(canonicalizeCssColor(colors.terminalForeground)).toBe(await cssColorFor(palette.terminal.foreground));
			if (colors.terminalPanel) expect(canonicalizeCssColor(colors.terminalPanel)).toBe(await cssColorFor(palette.terminal.background));
			expect(await nativeWindowBackground()).toBe(await cssColorFor(palette.windowBackground));
		};
		await page.setViewportSize({ width: 1440, height: 900 });
		const composer = page.getByLabel("Message OMP");
		await expect(composer).toBeVisible({ timeout: 20_000 });

		const semanticStates = [
			{ label: "System update", gutter: "EXT" },
			{ label: "Background job completed activity", gutter: "JOB" },
			{ label: "Advisor notes, 1 blockers", gutter: "ADV" },
			{ label: "Provider error", gutter: "OMP" },
		];
		for (const state of semanticStates) {
			const presentation = page.getByLabel(state.label, { exact: true });
			await expect(presentation).toBeVisible();
			const article = presentation.locator("xpath=ancestor::article[1]");
			await expect(article.locator(".timeline-gutter")).toContainText(state.gutter);
			await expect(presentation.locator(".timeline-presentation-header, .timeline-status-row").first()).toBeVisible();
		}

		const focusOutline = async (control: Locator, outlineTarget?: Locator): Promise<{ outlineColor: string; boxShadow: string }> => {
			await control.evaluate(element => (element as HTMLElement).focus({ focusVisible: true }));
			await expect(control).toBeFocused();
			const target = outlineTarget ?? control;
			await expect
				.poll(
					async () => canonicalizeCssColor(await target.evaluate(element => getComputedStyle(element).outlineColor)),
					{ timeout: 2_000 },
				)
				.toBe("#ffffff");
			const outline = await target.evaluate(element => {
				const style = getComputedStyle(element);
				return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle, outlineColor: style.outlineColor, boxShadow: style.boxShadow };
			});
			expect(outline.width).toBeGreaterThanOrEqual(2);
			expect(outline.style).not.toBe("none");
			return outline;
		};

		const readTerminalReplay = async (): Promise<{
			offset: number;
			canvasWidth: number;
			canvasHeight: number;
			nonBackgroundPixels: number;
		}> =>
			page.evaluate(() => {
				const shell = document.querySelector<HTMLElement>(".chat-terminal-shell");
				const canvas = document.querySelector<HTMLCanvasElement>(".chat-terminal-canvas canvas");
				const context = canvas?.getContext("2d");
				const image = canvas && context ? context.getImageData(0, 0, canvas.width, canvas.height) : undefined;
				let nonBackgroundPixels = 0;
				if (image && image.data.length >= 4) {
					const background = image.data.slice(0, 4);
					for (let index = 4; index < image.data.length; index += 4) {
						if (
							image.data[index] !== background[0] ||
							image.data[index + 1] !== background[1] ||
							image.data[index + 2] !== background[2] ||
							image.data[index + 3] !== background[3]
						) {
							nonBackgroundPixels++;
						}
					}
				}
				return {
					offset: Number(shell?.dataset.renderedOffset ?? 0),
					canvasWidth: canvas?.width ?? 0,
					canvasHeight: canvas?.height ?? 0,
					nonBackgroundPixels,
				};
			});
		let replayOffset = 0;
		let replayCanvasWidth = 0;
		let replayCanvasHeight = 0;
		const assertTerminal = async (theme: ResolvedTheme): Promise<void> => {
			const palette = DESKTOP_THEME_PALETTES[theme];
			const terminalToggle = page.locator('button[aria-controls="chat-terminal-drawer"]');
			const terminalPanel = page.locator(".chat-terminal-drawer");
			if ((await terminalToggle.getAttribute("aria-expanded")) !== "true") await terminalToggle.click();
			await expect(terminalPanel).toBeVisible();
			const shell = page.locator(".chat-terminal-shell");
			await expect
				.poll(async () => Number((await shell.getAttribute("data-rendered-offset")) ?? 0), { timeout: 15_000 })
				.toBeGreaterThan(0);
			const replay = await readTerminalReplay();
			expect(replay.canvasWidth).toBeGreaterThan(0);
			expect(replay.canvasHeight).toBeGreaterThan(0);
			expect(replay.nonBackgroundPixels).toBeGreaterThan(0);
			if (replayCanvasWidth === 0) {
				replayCanvasWidth = replay.canvasWidth;
				replayCanvasHeight = replay.canvasHeight;
				replayOffset = replay.offset;
			} else {
				expect(replay.canvasWidth).toBe(replayCanvasWidth);
				expect(replay.canvasHeight).toBe(replayCanvasHeight);
				expect(replay.offset).toBeGreaterThanOrEqual(replayOffset);
			}
			const terminal = await page.evaluate(() => {
				const panel = document.querySelector<HTMLElement>(".chat-terminal-drawer");
				const rootStyle = getComputedStyle(document.documentElement);
				return {
					background: panel ? getComputedStyle(panel).backgroundColor : "",
					borderColor: panel ? getComputedStyle(panel).borderBottomColor : "",
					foreground: panel ? getComputedStyle(panel).color : "",
					backgroundToken: rootStyle.getPropertyValue("--terminal-background").trim(),
					foregroundToken: rootStyle.getPropertyValue("--terminal-foreground").trim(),
					codeSurface: rootStyle.getPropertyValue("--code-surface").trim(),
				};
			});
			expect(canonicalizeCssColor(terminal.background)).toBe(await cssColorFor(palette.terminal.background));
			expect(canonicalizeCssColor(terminal.foreground)).toBe(await cssColorFor(palette.terminal.foreground));
			expect(canonicalizeCssColor(terminal.borderColor)).toBe(await cssColorFor(palette.line));
			expect(await cssColorFor(terminal.backgroundToken)).toBe(await cssColorFor(palette.terminal.background));
			expect(await cssColorFor(terminal.foregroundToken)).toBe(await cssColorFor(palette.terminal.foreground));
			expect(canonicalizeCssColor(terminal.codeSurface)).toBe(await cssColorFor(palette.codeSurface));
			expect(replay.offset).toBeGreaterThan(0);
			expect(await nativeWindowBackground()).toBe(await cssColorFor(palette.windowBackground));
		};

		const assertTheme = async (theme: ResolvedTheme): Promise<void> => {
			const palette = DESKTOP_THEME_PALETTES[theme];
			await expectThemeContrast(page, theme);
			await expectEnhancedContrast(page);
			await assertNeutralThemeSurfaces(theme);
			await composer.fill("focus test");
			for (const [control, target] of [
				[page.getByRole("button", { name: "Send message", exact: true }), undefined],
				[composer, page.locator(".composer")],
				[page.getByRole("tab", { name: /Gradivus/ }), undefined],
				[page.getByText("Show full compaction summary", { exact: true }), undefined],
			] as const) {
				const focus = await focusOutline(control, target);
				const focusTarget =
					(await control.getAttribute("aria-label")) ??
					(await control.getAttribute("title")) ??
					(await control.getAttribute("class")) ??
					"unknown control";
				expect(canonicalizeCssColor(palette.focusInner)).toBe("#ffffff");
				expect(canonicalizeCssColor(palette.focusOuter)).toBe("#000000");
				expect(canonicalizeCssColor(focus.outlineColor), `focus ${focusTarget}`).toBe("#ffffff");
				expect(focus.boxShadow).toMatch(/(?:#000000|rgb\(0,\s*0,\s*0\)|rgba\(0,\s*0,\s*0,\s*(?:0?\.\d+|1)\))/);
			}
			await assertTerminal(theme);
		};

		await assertTheme("dark");

		const setThemeInApplicationSettings = async (theme: GradivusSettings["theme"]): Promise<void> => {
			const settingsButton = page.getByRole("button", { name: "Open application settings", exact: true });
			await settingsButton.click();
			await expect(page.getByRole("heading", { name: "Application settings", exact: true })).toBeVisible();
			const themeField = page.locator("label.settings-field").filter({ hasText: /^Theme/ });
			await themeField.getByRole("button", { name: "Theme", exact: true }).click();
			const optionLabel = theme[0].toUpperCase() + theme.slice(1);
			await page.getByRole("option", { name: optionLabel, exact: true }).click();
			await expect(page.locator(".settings-feedback")).toHaveText("Theme updated.");
			await expect.poll(async () => JSON.parse(await fs.readFile(path.join(userData, "settings.json"), "utf8")).theme).toBe(theme);
			await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
			await expect(composer).toBeVisible();
		};

		await setThemeInApplicationSettings("light");
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
		await assertTheme("light");

		await page.setViewportSize({ width: 760, height: 620 });
		for (const theme of ["light", "dark"] as const) {
			if (theme !== "light") {
				await setThemeInApplicationSettings(theme);
				await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			}
			await expectThemeContrast(page, theme);
			const overflow = await page.evaluate(() => {
				const timelineElement = document.querySelector<HTMLElement>(".timeline-scroll");
				return {
					document: document.documentElement.scrollWidth === document.documentElement.clientWidth,
					timeline: timelineElement ? timelineElement.scrollWidth === timelineElement.clientWidth : true,
				};
			});
			expect(overflow.document).toBe(true);
			expect(overflow.timeline).toBe(true);
		}

		await page.setViewportSize({ width: 1440, height: 900 });
		const setSystemColorScheme = async (theme: ResolvedTheme): Promise<void> => {
			if (theme === "dark") {
				await app.evaluate(({ nativeTheme }) => {
					nativeTheme.themeSource = "dark";
				});
			} else {
				await app.evaluate(({ nativeTheme }) => {
					nativeTheme.themeSource = "light";
				});
			}
			await page.emulateMedia({ colorScheme: theme });
		};
		await setThemeInApplicationSettings("system");
		const terminalToggle = page.locator('button[aria-controls="chat-terminal-drawer"]');
		if ((await terminalToggle.getAttribute("aria-expanded")) !== "true") await terminalToggle.click();
		await expect(page.locator(".chat-terminal-shell")).toBeVisible();
		await setSystemColorScheme("dark");
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
		await expect.poll(async () => (await readTerminalReplay()).offset, { timeout: 15_000 }).toBeGreaterThan(0);
		await assertNeutralThemeSurfaces("dark");
		const darkReplay = await readTerminalReplay();
		expect(darkReplay.canvasWidth).toBe(replayCanvasWidth);
		expect(darkReplay.canvasHeight).toBe(replayCanvasHeight);
		expect(darkReplay.nonBackgroundPixels).toBeGreaterThan(0);
		expect(darkReplay.offset).toBeGreaterThanOrEqual(replayOffset);
		await expect
			.poll(async () => canonicalizeCssColor(await page.locator(".chat-terminal-drawer").evaluate(element => getComputedStyle(element).backgroundColor)))
			.toBe(await cssColorFor(DESKTOP_THEME_PALETTES.dark.terminal.background));
		await setSystemColorScheme("light");
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
		await expect.poll(async () => (await readTerminalReplay()).offset, { timeout: 15_000 }).toBeGreaterThan(0);
		await assertNeutralThemeSurfaces("light");
		const lightReplay = await readTerminalReplay();
		expect(lightReplay.canvasWidth).toBe(replayCanvasWidth);
		expect(lightReplay.canvasHeight).toBe(replayCanvasHeight);
		expect(lightReplay.nonBackgroundPixels).toBeGreaterThan(0);
		expect(lightReplay.offset).toBeGreaterThanOrEqual(darkReplay.offset);
		await expect
			.poll(async () => canonicalizeCssColor(await page.locator(".chat-terminal-drawer").evaluate(element => getComputedStyle(element).backgroundColor)))
			.toBe(await cssColorFor(DESKTOP_THEME_PALETTES.light.terminal.background));
		await expect(page.getByLabel("Background job completed activity", { exact: true })).toBeVisible();
	} finally {
		await teardownElectronTest(app, userData);
	}
});

import AxeBuilder from "@axe-core/playwright";
import * as net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import type { GradivusSettings } from "../src/shared/contracts";
import { DESKTOP_THEME_PALETTES } from "../src/shared/theme-palette";
import type { WebContents } from "electron";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { electronExecutablePath } from "./electron-path";
import { teardownElectronTest } from "./electron-teardown";
import { canonicalizeCssColor, expectEnhancedContrast } from "./theme-contrast";

const root = path.resolve(".");
const bundle = path.join(root, ".vite", "build", "main.js");
const binary = electronExecutablePath();
const fixture = path.join(root, "e2e", "rpc-fixture.ts");
const browserUrl = "http://127.0.0.1:5173/browser-fixture.html";

type LaunchOptions = {
	promptFailure?: boolean;
	captureFile?: string;
};

async function createUserData(prefix: string): Promise<string> {
	const realTmp = await fs.realpath(os.tmpdir());
	return fs.mkdtemp(path.join(realTmp, prefix));
}

async function prepare(userData: string, workspace: string, sessionId: string, theme?: GradivusSettings["theme"]): Promise<void> {
	try {
		await fs.mkdir(path.join(userData, "home", ".config"), { recursive: true });
		await fs.mkdir(workspace, { recursive: true });
		const now = new Date().toISOString();
		await fs.writeFile(
			path.join(userData, "sessions-v1.json"),
			JSON.stringify({
				version: 1,
				sessions: [{ id: sessionId, kind: "work", cwd: workspace, ompSessionId: "", sessionFile: "", title: null, createdAt: now, lastOpenedAt: now }],
				activeByKind: { work: sessionId, code: null },
			}),
		);
		await fs.mkdir(path.join(userData, "runtime"), { recursive: true });
		const runtimeDocument = {
			version: 1,
			revision: 0,
			activeWorkspaceId: "workspace-default",
			workspaces: [{ id: "workspace-default", name: "Workspace", locationId: "location-default", generation: 1 }],
			locations: [
				{
					id: "location-default",
					name: "Local",
					address: { kind: "local", path: workspace },
					lifecycle: { status: "active", generation: 1, updatedAt: Date.now() },
				},
			],
			tabs: [],
			panes: [],
			terminals: [],
			browsers: [],
			previews: [],
			agentProfiles: [{ id: "profile-fixture", name: "Fixture Agent", config: {}, capabilityIds: [] }],
			agents: [{ id: "fixture-agent", profileId: "profile-fixture", sessionId, status: "running" }],
			capabilities: [],
			sessions: [
				{
					id: sessionId,
					locationId: "location-default",
					actorId: "fixture-agent",
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: Date.now(),
					lastSeenAt: Date.now(),
				},
			],
			sessionEvents: [],
			deliveryReceipts: [],
			services: [],
			worktrees: [],
			elementEdits: [],
			notifications: [],
			pendingCleanup: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		await fs.writeFile(
			path.join(userData, "runtime", "workspace-state.jsonl"),
			`${JSON.stringify({ type: "snapshot", document: runtimeDocument, seenCommandIds: [], nextEventSequence: 1 })}\n`,
		);
		if (theme) await fs.writeFile(path.join(userData, "settings.json"), JSON.stringify({ theme }));
	} catch (error) {
		await teardownElectronTest(undefined, userData).catch(() => {});
		throw error;
	}
}
type RuntimeDocumentFixture = {
	revision: number;
	activeWorkspaceId?: string | null;
	workspaces: Array<{ id: string }>;
	agentProfiles: Array<{ id: string }>;
	agents: Array<{ id: string }>;
};

async function provisionSelectionAgent(userData: string): Promise<void> {
	const runtimeRoot = path.join(userData, "runtime");
	let controlToken = "";
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			controlToken = await fs.readFile(path.join(runtimeRoot, "control.token"), "utf8");
			await fs.stat(path.join(runtimeRoot, "control.sock"));
			break;
		} catch {
			await sleep(100);
		}
	}
	if (!controlToken) throw new Error("Selection E2E runtime control token did not become available");
	const sessionConfig = JSON.parse(await fs.readFile(path.join(userData, "sessions-v1.json"), "utf8")) as {
		sessions?: Array<{ id?: string }>;
	};
	const sessionId = sessionConfig.sessions?.[0]?.id;
	if (!sessionId) throw new Error("Selection E2E agent bootstrap has no session id");

	await new Promise<void>((resolve, reject) => {
		const socket = net.createConnection(path.join(runtimeRoot, "control.sock"));
		let buffer = "";
		let authenticated = false;
		let settled = false;
		let document: RuntimeDocumentFixture | undefined;
		let activeRequestId: string | undefined;
		let step = 0;

		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		const finish = (): void => {
			if (settled) return;
			settled = true;
			socket.end();
			resolve();
		};
		const issue = (type: "profile.create" | "agent.start", payload: Record<string, unknown>): void => {
			if (!document || activeRequestId) return;
			const workspaceId = document.activeWorkspaceId ?? document.workspaces[0]?.id;
			if (!workspaceId) {
				fail("Selection E2E agent bootstrap has no workspace");
				return;
			}
			step += 1;
			activeRequestId = `e2e-selection-agent-${step}`;
			socket.write(
				`${JSON.stringify({
					type: "command",
					requestId: activeRequestId,
					command: {
						version: 1,
						commandId: `e2e-selection-${type}-${sessionId}`,
						workspaceId,
						expectedRevision: document.revision,
						issuedAt: Date.now(),
						type,
						payload,
					},
				})}\n`,
			);
		};
		const advance = (): void => {
			if (!document || activeRequestId) return;
			if (!document.agentProfiles.some(profile => profile.id === "profile-fixture")) {
				issue("profile.create", {
					id: "profile-fixture",
					name: "Fixture Agent",
					protocol: "omp",
					config: {},
					capabilityIds: [],
				});
				return;
			}
			if (!document.agents.some(agent => agent.id === "fixture-agent")) {
				issue("agent.start", { id: "fixture-agent", profileId: "profile-fixture", sessionId });
				return;
			}
			finish();
		};
		socket.setTimeout(10_000, () => fail("Selection E2E agent bootstrap timed out"));
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ type: "auth", token: controlToken })}\n`);
		});
		socket.on("data", chunk => {
			buffer += chunk.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(line) as Record<string, unknown>;
				} catch (error) {
					fail(error);
					return;
				}
				if (!authenticated && message.type === "auth.ok") {
					authenticated = true;
					document = message.document as RuntimeDocumentFixture;
					socket.write(`${JSON.stringify({ type: "subscribe" })}\n`);
					advance();
					continue;
				}
				if (typeof message.requestId !== "string" || message.requestId !== activeRequestId) continue;
				const result = message.result as { status?: string; document?: RuntimeDocumentFixture; error?: { message?: string } };
				if (
					(result.status !== "accepted" && result.status !== "duplicate") ||
					!result.document
				) {
					fail(result.error?.message ?? "Selection E2E agent bootstrap command failed");
					return;
				}
				document = result.document;
				activeRequestId = undefined;
				advance();
			}
		});
		socket.on("error", fail);
		socket.on("close", () => {
			if (!settled) fail("Selection E2E agent bootstrap connection closed");
		});
	});
}


async function launch(userData: string, workspace: string, options: LaunchOptions = {}): Promise<ElectronApplication> {
	try {
		const tempRoot = path.join(userData, "t");
		await fs.mkdir(path.join(userData, "home", ".config"), { recursive: true });
		await fs.mkdir(tempRoot, { recursive: true });
		const app = await electron.launch({
			executablePath: binary,
			args: [`--user-data-dir=${userData}`, bundle],
			env: {
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
				PI_CODING_AGENT_DIR: path.join(userData, "omp-agent"),
				OPENAI_API_KEY: "sk-mock-key-for-test",
				ELECTRON_ENABLE_SECURITY_WARNINGS: "false",
				GRADIVUS_RUNTIME_DIR: path.join(userData, "runtime"),
				...(options.promptFailure ? { GRADIVUS_REJECT_NEXT_PROMPT: "immediate" } : {}),
				...(options.captureFile ? { GRADIVUS_ATTACHMENT_CAPTURE_FILE: options.captureFile } : {}),
			},
		});
		await provisionSelectionAgent(userData);
		return app;
	} catch (error) {
		await teardownElectronTest(undefined, userData).catch(() => {});
		throw error;
	}
}

type FixtureClickMode = "normal" | "stale-html";
type BrowserViewInfo = { id: number; url: string; bounds: { x: number; y: number; width: number; height: number } };
type CardState = {
	visible: boolean;
	role: string;
	label: string;
	target: string;
	instruction: string;
	agent: string;
	capture: string;
	action: string;
	status: string;
	background: string;
	color: string;
	text: string;
	queue: string;
	pinned: number;
	states: string[];
};
type InspectorColorSample = {
	background: string;
	color: string;
	border: string;
};

type InspectorThemeSnapshot = {
	card: InspectorColorSample;
	textarea: InspectorColorSample;
	action: InspectorColorSample;
	mode: InspectorColorSample;
	menu: InspectorColorSample;
};

function expectedInspectorTheme(theme: "dark" | "light"): InspectorThemeSnapshot {
	const palette = DESKTOP_THEME_PALETTES[theme];
	return {
		card: { background: palette.shellRaised, color: palette.foreground, border: palette.line },
		textarea: { background: palette.codeSurface, color: palette.foreground, border: palette.line },
		action: { background: palette.accent, color: palette.accentForeground, border: palette.accentBoundary },
		mode: { background: palette.selectionSurface, color: palette.selectionForeground, border: palette.accentBoundary },
		menu: { background: palette.codeSurface, color: palette.foreground, border: palette.line },
	};
}

function canonicalizeInspectorTheme(snapshot: InspectorThemeSnapshot): InspectorThemeSnapshot {
	const canonicalize = (sample: InspectorColorSample): InspectorColorSample => ({
		background: canonicalizeCssColor(sample.background),
		color: canonicalizeCssColor(sample.color),
		border: canonicalizeCssColor(sample.border),
	});
	return {
		card: canonicalize(snapshot.card),
		textarea: canonicalize(snapshot.textarea),
		action: canonicalize(snapshot.action),
		mode: canonicalize(snapshot.mode),
		menu: canonicalize(snapshot.menu),
	};
}


async function inspectShadow<T>(app: ElectronApplication, paneIndex: number, selector: string, callback: string, args: unknown[] = []): Promise<T | undefined> {
	try {
		return await app.evaluate(
			async ({ BrowserWindow }, payload: { paneIndex: number; selector: string; callback: string; args: unknown[] }) => {
				const win = BrowserWindow.getAllWindows()[0];
				const views = win?.contentView.children.filter(candidate => {
					if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
					const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
					return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
				});
				const view = views?.[payload.paneIndex] as { webContents: WebContents } | undefined;
				if (!view || view.webContents.isDestroyed()) return undefined;
				const debuggerInstance = view.webContents.debugger;
				if (!debuggerInstance.isAttached()) debuggerInstance.attach("1.3");
				const documentResult = (await debuggerInstance.sendCommand("DOM.getDocument", { depth: -1, pierce: true })) as { root?: { nodeId?: number } };
				const documentNodeId = documentResult.root?.nodeId;
				if (!documentNodeId) return undefined;
				const hostResult = (await debuggerInstance.sendCommand("DOM.querySelector", { nodeId: documentNodeId, selector: "#__gradivus_inspector_root__" })) as { nodeId?: number };
				if (!hostResult.nodeId) return undefined;
				const described = (await debuggerInstance.sendCommand("DOM.describeNode", { nodeId: hostResult.nodeId, depth: 1, pierce: true })) as { node?: { shadowRoots?: Array<{ nodeId?: number }> } };
				const shadowNodeId = described.node?.shadowRoots?.[0]?.nodeId;
				if (!shadowNodeId) return undefined;
				const targetResult = (await debuggerInstance.sendCommand("DOM.querySelector", { nodeId: shadowNodeId, selector: payload.selector })) as { nodeId?: number };
				if (!targetResult.nodeId) return undefined;
				const resolved = (await debuggerInstance.sendCommand("DOM.resolveNode", { nodeId: targetResult.nodeId })) as { object?: { objectId?: string } };
				const objectId = resolved.object?.objectId;
				if (!objectId) return undefined;
				const called = (await debuggerInstance.sendCommand("Runtime.callFunctionOn", {
					objectId,
					functionDeclaration: `function(...values) { return (${payload.callback})(this, ...values); }`,
					arguments: payload.args.map(value => ({ value })),
					returnByValue: true,
				})) as { result?: { value?: unknown } };
				return called.result?.value;
			},
			{ paneIndex, selector, callback, args },
		);
	} catch {
		return undefined;
	}
}
async function inspectorThemeColors(app: ElectronApplication, paneIndex = 0): Promise<InspectorThemeSnapshot | undefined> {
	return inspectShadow<InspectorThemeSnapshot>(
		app,
		paneIndex,
		".inspector-card",
		`function(card) {
			const pick = node => {
				if (!node) return { background: "", color: "", border: "" };
				const style = getComputedStyle(node);
				return { background: style.backgroundColor, color: style.color, border: style.borderTopColor };
			};
			return {
				card: pick(card),
				textarea: pick(card.querySelector(".card-textarea")),
				action: pick(card.querySelector(".split-action-btn-group")),
				mode: pick(card.querySelector(".mode-toggle.active")),
				menu: pick(card.querySelector(".split-action-menu")),
			};
		}`,
	);
}


async function cardState(app: ElectronApplication, paneIndex = 0): Promise<CardState | undefined> {
	const values = await inspectShadow<unknown[]>(
		app,
		paneIndex,
		".inspector-card",
		`function(card) {
			const style = getComputedStyle(card);
			const target = card.querySelector(".target-name");
			const selector = card.querySelector(".target-selector");
			const textarea = card.querySelector("textarea");
			const activeMode = card.querySelector(".mode-toggle.active") || card.querySelector("[aria-pressed='true']");
			const submit = card.querySelector(".btn-submit-main");
			const root = card.getRootNode();
			const pinned = root.querySelectorAll(".pinned-queue-badge");
			return [
				style.display !== "none" && style.visibility !== "hidden",
				card.getAttribute("role") || "",
				target?.textContent?.trim() || "",
				selector?.textContent || "",
				textarea?.value || "",
				card.querySelector(".agent-select")?.value || "",
				activeMode?.getAttribute("data-mode") || activeMode?.textContent?.trim() || "",
				submit?.querySelector(".submit-label")?.textContent?.trim() || "",
				card.querySelector(".card-status")?.textContent?.trim() || "",
				card.querySelector(".inline-response-body")?.textContent?.trim() || "",
				style.backgroundColor || "",
				style.color || "",
				card.textContent?.trim() || "",
				root.querySelector(".mini-queue-pill")?.textContent?.trim() || "",
				pinned.length,
				Array.from(pinned).map(badge => badge.parentElement?.className || ""),
			];
		}`,
	);
	if (!values) return undefined;
	const [visible, role, target, selector, instruction, agent, capture, action, status, response, background, color, text, queue, pinned, states] = values;
	return { visible: Boolean(visible), role: String(role), label: String(target), target: String(target), selector: String(selector), instruction: String(instruction), agent: String(agent), capture: String(capture), action: String(action), status: String(status), response: String(response), background: String(background), color: String(color), text: String(text), queue: String(queue), pinned: Number(pinned), states: Array.isArray(states) ? states.map(String) : [] };
}

async function cardRootExists(app: ElectronApplication, paneIndex = 0): Promise<boolean> {
	const root = await inspectShadow(app, paneIndex, "#does-not-exist", "function() { return true; }");
	if (root !== undefined) return true;
	return app.evaluate(
		async ({ BrowserWindow }, index: number) => {
			const views = BrowserWindow.getAllWindows()[0]?.contentView.children.filter(candidate => {
				if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
				const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
				return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
			});
			const view = views?.[index] as { webContents: WebContents } | undefined;
			if (!view || view.webContents.isDestroyed()) return false;
			const debuggerInstance = view.webContents.debugger;
			if (!debuggerInstance.isAttached()) debuggerInstance.attach("1.3");
			const result = (await debuggerInstance.sendCommand("Runtime.evaluate", { expression: "Boolean(document.querySelector('#__gradivus_inspector_root__'))", returnByValue: true })) as { result?: { value?: boolean } };
			return result.result?.value === true;
		},
		paneIndex,
	);
}
async function inspectorRootCount(app: ElectronApplication): Promise<number> {
	return app.evaluate(async ({ BrowserWindow }) => {
		const views = BrowserWindow.getAllWindows()[0]?.contentView.children.filter(candidate => {
			if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
			const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
			return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
		}) as Array<{ webContents: WebContents }> | undefined;
		let count = 0;
		for (const view of views ?? []) {
			const debuggerInstance = view.webContents.debugger;
			if (!debuggerInstance.isAttached()) debuggerInstance.attach("1.3");
			const result = (await debuggerInstance.sendCommand("Runtime.evaluate", {
				expression: "Boolean(document.querySelector('#__gradivus_inspector_root__'))",
				returnByValue: true,
			})) as { result?: { value?: unknown } };
			if (result.result?.value === true) count += 1;
		}
		return count;
	});
}

async function clickCard(app: ElectronApplication, selector: string, paneIndex = 0): Promise<void> {
		await expect.poll(() => inspectShadow(app, paneIndex, selector, "function(button) { button.click(); return true; }"), { timeout: 10_000 }).toBe(true);
}

async function fillCard(app: ElectronApplication, value: string, paneIndex = 0): Promise<void> {
	await expect.poll(() => inspectShadow(app, paneIndex, "textarea", "function(textarea, value) { textarea.value = value; textarea.dispatchEvent(new Event('input', { bubbles: true })); return textarea.value; }", [value]), { timeout: 10_000 }).toBe(value);
}

async function chooseRole(app: ElectronApplication, role: string, paneIndex = 0): Promise<void> {
	await expect.poll(() => inspectShadow(app, paneIndex, ".agent-select", "function(select, value) { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value; }", [role]), { timeout: 10_000 }).toBe(role);
}

async function chooseCapture(app: ElectronApplication, mode: "dom" | "screenshot", paneIndex = 0): Promise<void> {
	await clickCard(app, `.mode-toggle[data-mode="${mode}"]`, paneIndex);
}

async function chooseAction(app: ElectronApplication, action: "inline" | "chat" | "queue", paneIndex = 0): Promise<void> {
	await clickCard(app, ".btn-action-dropdown", paneIndex);
	await clickCard(app, `.split-action-item[data-action="${action}"]`, paneIndex);
}

async function clickFixture(app: ElectronApplication, target = "#fixture-action", mode: FixtureClickMode = "normal", paneIndex = 0): Promise<void> {
	await expect.poll(() => app.evaluate(async ({ BrowserWindow }, payload: { target: string; mode: FixtureClickMode; paneIndex: number }) => {
		const views = BrowserWindow.getAllWindows()[0]?.contentView.children.filter(candidate => {
			if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
			const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
			return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
		});
		const view = views?.[payload.paneIndex] as { webContents: WebContents } | undefined;
		if (!view || view.webContents.isLoading()) return false;
		const debuggerInstance = view.webContents.debugger;
		if (!debuggerInstance.isAttached()) debuggerInstance.attach("1.3");
		const documentResult = (await debuggerInstance.sendCommand("DOM.getDocument", { depth: -1, pierce: true })) as { root?: { nodeId?: number } };
		if (!documentResult.root?.nodeId) return false;
		const nodeResult = (await debuggerInstance.sendCommand("DOM.querySelector", { nodeId: documentResult.root.nodeId, selector: payload.target })) as { nodeId?: number };
		if (!nodeResult.nodeId) return false;
		const boxResult = (await debuggerInstance.sendCommand("DOM.getBoxModel", { nodeId: nodeResult.nodeId })) as { model?: { border?: number[] } };
		const border = boxResult.model?.border;
		if (!border || border.length < 8) return false;
		const x = Math.round((border[0] + border[2]) / 2);
		const y = Math.round((border[1] + border[5]) / 2);
		if (payload.mode === "stale-html") {
			await debuggerInstance.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
			await debuggerInstance.sendCommand("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => resolve()))", awaitPromise: true });
		} else await debuggerInstance.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await debuggerInstance.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await debuggerInstance.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
		return true;
	}, { target, mode, paneIndex }), { timeout: 10_000 }).toBe(true);
}

async function openFixture(page: Page, app: ElectronApplication, paneIndex = 0, targetUrl = browserUrl, openBrowserTab = true): Promise<void> {
	if (openBrowserTab) {
		await page.getByRole("button", { name: "Open browser tab" }).click();
		await page.getByRole("tab", { name: /Browser/ }).click();
	}
	const pane = page.getByRole("group", { name: "Browser pane" }).nth(paneIndex);
	const address = pane.getByRole("textbox", { name: "Address" });
	await address.fill(targetUrl);
	await address.press("Enter");
	await expect.poll(
		() =>
			app.evaluate(
				({ BrowserWindow }, payload: { paneIndex: number; targetUrl: string }) => {
					const views = BrowserWindow.getAllWindows()[0]?.contentView.children.filter(candidate => {
						if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
						const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
						return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
					});
					const view = views?.[payload.paneIndex] as { webContents: WebContents } | undefined;
					return Boolean(view && !view.webContents.isLoading() && view.webContents.getURL() === payload.targetUrl);
				},
				{ paneIndex, targetUrl },
			),
		{ timeout: 15_000 },
	).toBe(true);
}

async function appViewReady(page: Page, paneIndex: number): Promise<boolean> {
	return page.evaluate(index => Boolean(document.querySelectorAll('[aria-label="Browser pane"]')[index]), paneIndex);
}

async function selectElement(page: Page, app: ElectronApplication, target = "#fixture-action", paneIndex = 0, openBrowserTab = true, mode: FixtureClickMode = "normal"): Promise<void> {
	await openFixture(page, app, paneIndex, browserUrl, openBrowserTab);
	const pane = page.getByRole("group", { name: "Browser pane" }).nth(paneIndex);
	const selectorButton = pane.getByRole("button", { name: "Select page element for agent" });
	await expect(selectorButton).toBeEnabled({ timeout: 15_000 });
	await selectorButton.click();
	await clickFixture(app, target, mode, paneIndex);
	await expect.poll(() => cardRootExists(app, paneIndex), { timeout: 10_000 }).toBe(true);
	await expect.poll(() => cardState(app, paneIndex), { timeout: 15_000 }).toMatchObject({ visible: true });
}

async function waitForSelectionTerminal(page: Page, paneIndex = 0): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(async index => {
					const document = await window.gradivus.getWorkspaceDocument();
					const paneId = document?.panes
						.filter(pane => pane?.kind === "browser")[index]?.id;
					if (!paneId) return "idle";
					return (await window.gradivus.getSelectionState(paneId))?.phase ?? "idle";
				}, paneIndex),
			{ timeout: 20_000 },
		)
		.toMatch(/ready|error/);
}
async function nativeView(app: ElectronApplication, paneIndex = 0): Promise<BrowserViewInfo | undefined> {
	return app.evaluate(({ BrowserWindow }, index: number) => {
		const views = BrowserWindow.getAllWindows()[0]?.contentView.children.filter(candidate => {
			if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
			const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
			return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
		});
		const view = views?.[index] as { webContents: WebContents; getBounds: () => BrowserViewInfo["bounds"] } | undefined;
		if (!view || view.webContents.isDestroyed()) return undefined;
		return { id: view.webContents.id, url: view.webContents.getURL(), bounds: view.getBounds() };
	}, paneIndex);
}

async function fixtureOutput(app: ElectronApplication, paneIndex = 0): Promise<string> {
	return app.evaluate(async ({ BrowserWindow }, index: number) => {
		const views = BrowserWindow.getAllWindows()[0]?.contentView.children.filter(candidate => {
			if (!candidate || typeof candidate !== "object" || !("webContents" in candidate)) return false;
			const contents = (candidate.webContents as WebContents | undefined) ?? undefined;
			return Boolean(contents && !contents.isDestroyed() && contents.getURL().includes("browser-fixture.html"));
		});
		const view = views?.[index] as { webContents: WebContents } | undefined;
		if (!view || view.webContents.isDestroyed()) return "";
		const debuggerInstance = view.webContents.debugger;
		if (!debuggerInstance.isAttached()) debuggerInstance.attach("1.3");
		const result = (await debuggerInstance.sendCommand("Runtime.evaluate", { expression: "document.querySelector('#fixture-output')?.textContent || ''", returnByValue: true })) as { result?: { value?: unknown } };
		return String(result.result?.value ?? "");
	}, paneIndex);
}

async function readCapture(file: string): Promise<Array<{ images?: Array<{ mimeType?: string; bytes?: number; base64Valid?: boolean }> }>> {
	try {
		const text = await fs.readFile(file, "utf8");
		return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as { images?: Array<{ mimeType?: string; bytes?: number; base64Valid?: boolean }> });
	} catch {
		return [];
	}
}

test("opens a fresh BrowserView card with independent defaults and stable native surface", async () => {
	const userData = await createUserData("gradivus-e2e-card-");
	const workspace = path.join(userData, "workspace");
	await prepare(userData, workspace, "fixture-selection-card");
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await selectElement(page, app);
		await expect.poll(() => page.evaluate(() => Boolean(window.gradivus)), { timeout: 10_000 }).toBe(true);
		expect(await page.evaluate(() => location.origin)).toBe("gradivus://app");
		const before = await nativeView(app);
		if (!before) throw new Error("Fixture browser view did not attach");
		expect(before.url).toContain("browser-fixture.html");
		expect(before.bounds.width).toBeGreaterThan(0);
		expect(before.bounds.height).toBeGreaterThan(0);
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({ visible: true, role: "dialog", target: "<button>", instruction: "", agent: "task", capture: "dom", action: /Ask OMP|Inline/i, selector: "#fixture-action", background: /./, color: /./ });
		const card = await cardState(app);
		expect(card?.label).not.toBe("");
		await expectEnhancedContrast(page, "body");
		const axe = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
		expect(axe.violations.filter(violation => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
		await clickCard(app, ".btn-action-dropdown");
		expect(await nativeView(app)).toEqual(before);
		await clickCard(app, ".btn-action-dropdown");
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("starting a second pane cancels the first card and leaves one active card", async () => {
	const userData = await createUserData("gradivus-xpane-");
	const workspace = path.join(userData, "workspace");
	await prepare(userData, workspace, "fixture-selection-cross-pane");
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await selectElement(page, app);
		const panes = page.getByRole("group", { name: "Browser pane" });
		await panes.nth(0).getByRole("button", { name: "Split browser right" }).click();
		await expect(panes).toHaveCount(2);
		await selectElement(page, app, "#fixture-secondary", 1, false);
		await expect.poll(() => inspectorRootCount(app), { timeout: 10_000 }).toBe(1);
		await expect.poll(() => cardState(app, 1), { timeout: 10_000 }).toMatchObject({ visible: true, selector: "#fixture-secondary" });
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("repeated queued picks retain role, capture, selector, URL and report statuses", async () => {
	const userData = await createUserData("gradivus-queue-");
	const workspace = path.join(userData, "workspace");
	await prepare(userData, workspace, "fixture-selection-card-queue");
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await selectElement(page, app, "#fixture-action");
		await fillCard(app, "Update primary target");
		await chooseRole(app, "designer");
		await chooseCapture(app, "screenshot");
		await chooseAction(app, "queue");
		const beforeDock = await nativeView(app);
		await clickCard(app, ".btn-submit-main");
		await expect.poll(
			() =>
				page.evaluate(async () => {
					const document = await window.gradivus.getWorkspaceDocument();
					const pane = document?.panes.find(candidate => candidate.kind === "browser");
					return pane ? (await window.gradivus.getSelectionState(pane.id)).queuedTasks?.length ?? 0 : 0;
				}),
			{ timeout: 15_000 },
		).toBe(1);
		const queue = page.getByRole("complementary", { name: "Selection queue and output" });
		await expect(queue).toBeVisible();
		await expect(queue.locator(".selection-queue-row")).toHaveCount(1);
		await expect(queue.locator(".selection-queue-row")).toContainText("#1");
		await expect(queue.locator(".selection-queue-row")).toContainText("#fixture-action");
		if (!beforeDock) throw new Error("Fixture browser view did not attach before queue docking");
		await expect.poll(() => nativeView(app).then(view => view?.bounds.height ?? 0), { timeout: 10_000 }).toBe(beforeDock.bounds.height);
		await expect.poll(() => nativeView(app).then(view => view?.bounds.width ?? 0), { timeout: 10_000 }).toBeLessThan(beforeDock.bounds.width);

		await clickFixture(app, "#fixture-secondary");
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({
			visible: true,
			instruction: "",
			agent: "designer",
			capture: "screenshot",
			action: /Add to Queue|Queue/i,
			selector: "#fixture-secondary",
		});
		await fillCard(app, "Update secondary target");
		await chooseRole(app, "reviewer");
		await chooseAction(app, "queue");
		await clickCard(app, ".btn-submit-main");
		await expect(queue.locator(".selection-queue-row")).toHaveCount(2);
		await expect(queue.locator(".selection-queue-row").nth(1)).toContainText("#2");
		await expect(queue.locator(".selection-queue-row").nth(1)).toContainText("#fixture-secondary");

		await queue.getByRole("button", { name: "Run All" }).click();
		await expect.poll(
			() => queue.locator(".selection-queue-status").allTextContents(),
			{ timeout: 30_000 },
		).toEqual([expect.stringMatching(/completed|error/), expect.stringMatching(/completed|error/)]);
		const rows = queue.locator(".selection-queue-row");
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toContainText(/Output|error|failed/i);
		await expect.poll(() => nativeView(app).then(view => view?.bounds.height ?? 0), { timeout: 10_000 }).toBe(beforeDock!.bounds.height);
		await expect.poll(() => nativeView(app).then(view => view?.bounds.width ?? 0), { timeout: 10_000 }).toBeLessThan(beforeDock!.bounds.width);

		await queue.getByRole("button", { name: "Clear" }).click();
		await expect(queue).not.toBeVisible();
		await expect.poll(() => nativeView(app).then(view => view?.bounds.width ?? 0), { timeout: 10_000 }).toBe(beforeDock!.bounds.width);
		await expect.poll(() => nativeView(app).then(view => view?.bounds.height ?? 0), { timeout: 10_000 }).toBe(beforeDock!.bounds.height);
		await expect.poll(() => cardState(app)?.pinned ?? 0, { timeout: 10_000 }).toBe(0);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("Send to Chat reports only after fixture acceptance and closes cleanly", async () => {
	const userData = await createUserData("gradivus-cardchat-");
	const workspace = path.join(userData, "workspace");
	await prepare(userData, workspace, "fixture-selection-card-chat");
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await selectElement(page, app);
		await fillCard(app, "Explain this target");
		await chooseAction(app, "chat");
		await clickCard(app, ".btn-submit-main");
		await expect(page.locator(".timeline-scroll")).toContainText("Fixture completed the requested work.", { timeout: 15_000 });
		await page.getByRole("tab", { name: /Browser/ }).click();
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({ status: /Delivered|Sent|complete/i, response: /OMP Chat|Sent|Fixture/i });
		await clickCard(app, ".btn-close-response");
		await expect.poll(() => cardRootExists(app), { timeout: 10_000 }).toBe(false);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("inline result and delivery error stay in the card until Close", async () => {
	for (const [promptFailure, expected] of [[false, /Fixture completed|complete/i], [true, /failed|error|rejected/i]] as const) {
		const userData = await createUserData(promptFailure ? "gradivus-carderr-" : "gradivus-inline-");
		const workspace = path.join(userData, "workspace");
		await prepare(userData, workspace, promptFailure ? "fixture-selection-card-error" : "fixture-selection-card-inline");
		const app = await launch(userData, workspace, { promptFailure });
		try {
			const page = await app.firstWindow();
			await page.setViewportSize({ width: 1440, height: 900 });
			await selectElement(page, app);
			await fillCard(app, promptFailure ? "fail this prompt" : "Describe this target");
			await clickCard(app, ".btn-submit-main");
			await waitForSelectionTerminal(page);
			const state = await cardState(app);
			if (promptFailure) {
				expect(state).toMatchObject({ visible: true, status: /error|failed|rejected/i });
			} else {
				expect(state).toMatchObject({ visible: true, status: /complete/i, response: expected });
			}
			await clickCard(app, ".btn-close-response");
			await expect.poll(() => cardRootExists(app), { timeout: 10_000 }).toBe(false);
		} finally {
			await teardownElectronTest(app, userData);
		}
	}
});

test("cancel, restart, navigate and close leave no stale inspector root", async () => {
	const userData = await createUserData("gradivus-e2e-life-");
	const workspace = path.join(userData, "workspace");
	await prepare(userData, workspace, "fixture-selection-card-lifecycle");
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await selectElement(page, app, "#fixture-action", 0, true, "stale-html");
		const pane = page.getByRole("group", { name: "Browser pane" }).nth(0);
		await pane.getByRole("button", { name: "Cancel element selection" }).click();
		await expect.poll(() => cardRootExists(app), { timeout: 10_000 }).toBe(false);
		await pane.getByRole("button", { name: "Select page element for agent" }).click();
		await clickFixture(app, "#fixture-secondary");
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({ selector: "#fixture-secondary" });
		await clickCard(app, ".btn-cancel");
		await expect.poll(() => cardRootExists(app), { timeout: 10_000 }).toBe(false);
		await clickFixture(app, "#fixture-secondary");
		await expect.poll(() => fixtureOutput(app), { timeout: 10_000 }).toBe("Secondary connected");
		await pane.getByRole("button", { name: "Select page element for agent" }).click();
		await clickFixture(app, "#fixture-action");
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({ selector: "#fixture-action" });
		const address = pane.getByRole("textbox", { name: "Address" });
		await address.fill(`${browserUrl}?navigation=1`);
		await address.press("Enter");
		await expect.poll(() => cardRootExists(app), { timeout: 10_000 }).toBe(false);
		await pane.getByRole("button", { name: "Split browser right" }).click();
		await expect(page.getByRole("group", { name: "Browser pane" })).toHaveCount(2);
		await page.getByRole("group", { name: "Browser pane" }).nth(0).getByRole("button", { name: "Close browser pane" }).click();
		await expect(page.getByRole("group", { name: "Browser pane" })).toHaveCount(1);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("theme changes preserve target and queued pins", async () => {
	const userData = await createUserData("gradivus-theme-");
	const workspace = path.join(userData, "workspace");
	await prepare(userData, workspace, "fixture-selection-card-theme", "dark");
	const app = await launch(userData, workspace);
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await selectElement(page, app);
		await fillCard(app, "Queue themed target");
		await chooseAction(app, "queue");
		await clickCard(app, ".btn-submit-main");
		await clickFixture(app, "#fixture-secondary");
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({ selector: "#fixture-secondary", pinned: 1 });
		await expect(page.getByRole("complementary", { name: "Selection queue and output" })).toBeVisible();
		await expect.poll(() => nativeView(app).then(view => view?.bounds.width ?? 0), { timeout: 10_000 }).toBeLessThan(1440);
		const before = await nativeView(app);
		if (!before) throw new Error("Fixture browser view did not attach");
		await expect
			.poll(async () => {
				const colors = await inspectorThemeColors(app);
				return colors ? canonicalizeInspectorTheme(colors) : undefined;
			}, { timeout: 10_000 })
			.toEqual(expectedInspectorTheme("dark"));
		await page.evaluate(async () => window.gradivus.updateAppSettings({ theme: "light" }));
		await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(candidate => Boolean(candidate && typeof candidate === "object" && "webContents" in candidate && (candidate.webContents as WebContents | undefined)?.getURL().includes("browser-fixture.html"))) as { webContents: WebContents } | undefined;
			if (!view) return "";
			const debuggerInstance = view.webContents.debugger;
			if (!debuggerInstance.isAttached()) debuggerInstance.attach("1.3");
			const result = (await debuggerInstance.sendCommand("Runtime.evaluate", { expression: "document.querySelector('#__gradivus_inspector_root__')?.dataset.theme || ''", returnByValue: true })) as { result?: { value?: unknown } };
			return String(result.result?.value ?? "");
		}), { timeout: 10_000 }).toBe("light");
		await expect
			.poll(async () => {
				const colors = await inspectorThemeColors(app);
				return colors ? canonicalizeInspectorTheme(colors) : undefined;
			}, { timeout: 10_000 })
			.toEqual(expectedInspectorTheme("light"));
		await expect.poll(() => nativeView(app).then(view => view?.bounds.width ?? 0), { timeout: 10_000 }).toBe(before.bounds.width);
		await expect.poll(() => nativeView(app).then(view => view?.bounds.height ?? 0), { timeout: 10_000 }).toBe(before.bounds.height);
		await expect.poll(() => cardState(app), { timeout: 10_000 }).toMatchObject({ selector: "#fixture-secondary", pinned: 1 });
	} finally {
		await teardownElectronTest(app, userData);
	}
});

test("screenshot mode sends one valid JPEG while BrowserView identity and bounds stay fixed", async () => {
	const userData = await createUserData("gradivus-image-");
	const workspace = path.join(userData, "workspace");
	const captureFile = path.join(userData, "attachments.jsonl");
	await prepare(userData, workspace, "fixture-selection-card-image");
	const app = await launch(userData, workspace, { captureFile });
	try {
		const page = await app.firstWindow();
		await page.setViewportSize({ width: 1440, height: 900 });
		await selectElement(page, app);
		const before = await nativeView(app);
		if (!before) throw new Error("Fixture browser view did not attach");
		await app.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(candidate => Boolean(candidate && typeof candidate === "object" && "webContents" in candidate && (candidate.webContents as WebContents | undefined)?.getURL().includes("browser-fixture.html"))) as { webContents: WebContents } | undefined;
			if (view && !view.webContents.isDestroyed()) await view.webContents.setZoomFactor(1.25);
		});
		await fillCard(app, "Inspect this high contrast target");
		await chooseCapture(app, "screenshot");
		await clickCard(app, ".btn-submit-main");
		await expect.poll(() => cardState(app), { timeout: 20_000 }).toMatchObject({ visible: true, status: /complete|success|ready/i });
		await expect.poll(() => readCapture(captureFile), { timeout: 10_000 }).toHaveLength(1);
		const captured = await readCapture(captureFile);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.images).toHaveLength(1);
		expect(captured[0]?.images?.[0]).toMatchObject({ mimeType: "image/jpeg", base64Valid: true });
		expect(captured[0]?.images?.[0]?.bytes).toBeGreaterThan(0);
		expect(await nativeView(app)).toEqual(before);
	} finally {
		await teardownElectronTest(app, userData);
	}
});

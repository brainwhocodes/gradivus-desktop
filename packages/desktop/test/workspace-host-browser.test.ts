import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { nativeTheme } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHost } from "../src/main/desktop-host";
import { WorkspaceHost } from "../src/main/workspace-host";
import { getAgentSwatch } from "../src/shared/agent-swatch";

const mockSetBounds = vi.fn();
const mockSetWindowBackgroundColor = vi.fn();
const mockSetBackgroundColor = vi.fn();
const mockExecuteJavaScript = vi.fn().mockResolvedValue({ canceled: true });
const mockCapturePage = vi.fn();
const mockViewInstances: Array<{
	webContents: { capturePage: typeof mockCapturePage };
	setBounds: typeof mockSetBounds;
}> = [];
let nativeThemeUpdatedCallback: (() => void) | undefined;

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/tmp/userData") },
	nativeTheme: {
		shouldUseDarkColors: true,
		on: vi.fn((_event: string, listener: () => void) => {
			nativeThemeUpdatedCallback = listener;
		}),
	},
	Menu: {
		buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
	},
	WebContentsView: class {
		webContents = {
			navigationHistory: {
				canGoBack: () => false,
				canGoForward: () => false,
			},
			loadURL: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			setWindowOpenHandler: vi.fn(),
			executeJavaScript: mockExecuteJavaScript,
			capturePage: mockCapturePage,
			isDestroyed: () => false,
		};
		setBounds = mockSetBounds;
		setBackgroundColor = mockSetBackgroundColor;
		constructor() {
			mockViewInstances.push(this);
		}
	},
}));

describe("WorkspaceHost position-aware browser bounds", () => {
	afterEach(() => {
		mockSetBounds.mockClear();
		mockSetBackgroundColor.mockClear();
		mockSetWindowBackgroundColor.mockClear();
		mockExecuteJavaScript.mockReset();
		mockExecuteJavaScript.mockResolvedValue({ canceled: true });
		vi.clearAllMocks();
		nativeThemeUpdatedCallback = undefined;
		nativeTheme.shouldUseDarkColors = true;
		mockCapturePage.mockReset();
		mockViewInstances.length = 0;
	});

	function createHost(zoomFactor = 1) {
		const send = vi.fn();
		const addChildView = vi.fn();
		const removeChildView = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send,
				getZoomFactor: () => zoomFactor,
			},
			contentView: {
				addChildView,
				removeChildView,
			},
		};
		const host = new WorkspaceHost(window as never);
		return { host, send, addChildView, removeChildView, window };
	}

	function createMockDocument(): WorkspaceDocumentV1 {
		return {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_1", label: "Main", locationId: "loc_1" }],
			locations: [{ id: "loc_1", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab_browser",
					workspaceId: "ws_1",
					locationId: "loc_1",
					generation: 1,
					name: "Browser Tab",
					paneKind: "browser",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-browser-1"],
					activePaneId: "pane-browser-1",
				},
			],
			panes: [{ id: "pane-browser-1", tabId: "tab_browser", generation: 1, kind: "browser", entityId: "browser-1" }],
			terminals: [],
			browsers: [
				{
					id: "browser-1",
					locationId: "loc_1",
					paneId: "pane-browser-1",
					generation: 1,
					url: "https://omp.sh",
					status: "ready",
				},
			],
			previews: [],
			agents: [],
			sessions: [],
			agentProfiles: [],
			pendingCleanup: [],
		};
	}

	it("converts CSS pixels to DIPs with window zoom factor when applying bounds", () => {
		const { host } = createHost(1.25);
		const doc = createMockDocument();
		host.syncWithDocument(doc);
		host.setVisibleBrowsers(["pane-browser-1"]);

		host.setBrowserBounds("pane-browser-1", { x: 100, y: 50, width: 800, height: 600 });

		expect(mockSetBounds).toHaveBeenCalledWith({
			x: 125, // 100 * 1.25
			y: 63, // 50 * 1.25 rounded
			width: 1000, // 800 * 1.25
			height: 750, // 600 * 1.25
		});
	});

	it("re-applies cached bounds immediately upon view reattachment", () => {
		const { host } = createHost(1);
		const doc = createMockDocument();
		host.syncWithDocument(doc);
		host.setVisibleBrowsers(["pane-browser-1"]);

		host.setBrowserBounds("pane-browser-1", { x: 10, y: 20, width: 500, height: 400 });
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 500, height: 400 });

		// Detach by hiding
		host.setVisibleBrowsers([]);
		// Reattach by making visible again
		host.setVisibleBrowsers(["pane-browser-1"]);
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 500, height: 400 });
	});

	it("sets exact palette backgrounds on the window and every browser view", () => {
		const store = {
			settings: {
				theme: "dark" as const,
				confirmCloseTab: true,
				terminal: { shell: "" },
				browser: {},
				workspace: { defaultPath: "/tmp" },
			},
		};
		const window = {
			isDestroyed: () => false,
			setBackgroundColor: mockSetWindowBackgroundColor,
			webContents: { isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => 1 },
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		};
		const host = new WorkspaceHost(window as never, store as never);
		const doc = createMockDocument();
		doc.panes.push({ ...doc.panes[0], id: "pane-browser-2", entityId: "browser-2" });
		doc.browsers.push({ ...doc.browsers[0], id: "browser-2", paneId: "pane-browser-2" });
		host.syncWithDocument(doc);
		host.updateTheme();

		expect(mockSetWindowBackgroundColor).toHaveBeenLastCalledWith("#111111");
		expect(mockSetBackgroundColor.mock.calls.slice(-2)).toEqual([["#111111"], ["#111111"]]);
		store.settings.theme = "light";
		host.updateTheme();
		expect(mockSetWindowBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
		expect(mockSetBackgroundColor.mock.calls.slice(-2)).toEqual([["#ffffff"], ["#ffffff"]]);
		expect(host.getBrowserBackgroundColor()).toBe("#ffffff");
	});
	it("resolves system theme through the native preference while explicit settings take precedence", () => {
		const store = {
			settings: {
				theme: "system" as const,
				confirmCloseTab: true,
				terminal: { shell: "" },
				browser: {},
				workspace: { defaultPath: "/tmp" },
			},
		};
		const host = new WorkspaceHost({} as never, store as never);
		expect(host.resolveTheme()).toBe("dark");
		nativeTheme.shouldUseDarkColors = false;
		expect(host.resolveTheme()).toBe("light");
		store.settings.theme = "light";
		expect(host.resolveTheme()).toBe("light");
		store.settings.theme = "dark";
		expect(host.resolveTheme()).toBe("dark");
		nativeTheme.shouldUseDarkColors = true;
	});
	it("keeps the native BrowserView identity and bounds stable while the in-page selector is active", async () => {
		const store = {
			settings: {
				theme: "system" as const,
				confirmCloseTab: true,
				terminal: { shell: "" },
				browser: {},
				workspace: { defaultPath: "/tmp" },
			},
		};
		const hostWindow = {
			isDestroyed: () => false,
			setBackgroundColor: mockSetWindowBackgroundColor,
			webContents: { isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => 1 },
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		};
		const host = new WorkspaceHost(hostWindow as never, store as never);
		host.syncWithDocument(createMockDocument());
		host.setVisibleBrowsers(["pane-browser-1"]);
		host.setBrowserBounds("pane-browser-1", { x: 24, y: 18, width: 800, height: 600 });
		const view = mockViewInstances[0];
		expect(view).toBeDefined();
		const cardCommand = new Promise<never>(() => {});
		mockExecuteJavaScript.mockImplementation(async script => {
			if (typeof script === "string" && script.includes("__gradivus_inspector_set_theme__")) return true;
			return cardCommand;
		});
		const scope = {
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId: "pane-browser-1",
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
			agentId: "agent",
			sessionId: "session",
		} as const;

		await expect(host.startSelection(scope)).resolves.toMatchObject({ phase: "picking", paneId: scope.paneId });
		expect(mockViewInstances[0]).toBe(view);
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 24, y: 18, width: 800, height: 600 });

		nativeTheme.shouldUseDarkColors = false;
		nativeThemeUpdatedCallback?.();
		store.settings.theme = "dark";
		nativeThemeUpdatedCallback?.();
		expect(mockViewInstances[0]).toBe(view);
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 24, y: 18, width: 800, height: 600 });
		expect(
			mockExecuteJavaScript.mock.calls.filter(
				([script]) => typeof script === "string" && script.includes("__gradivus_inspector_set_theme__?.("),
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("uses the current-target bridge and restores the inspector around a native JPEG capture", async () => {
		const events: string[] = [];
		const bounds = { x: 100, y: 50, width: 40, height: 20, top: 50, left: 100, right: 140, bottom: 70 };
		const nativeImage = {
			getSize: () => ({ width: 40, height: 20 }),
			toJPEG: vi.fn(() => Buffer.from("jpeg-bytes")),
		};
		mockCapturePage.mockImplementation(async () => {
			events.push("capture");
			return nativeImage;
		});
		let initialAction = true;
		mockExecuteJavaScript.mockImplementation(async script => {
			if (typeof script !== "string") return { canceled: true };
			if (script.includes("__gradivus_inspector_get_current_target_bounds__")) {
				events.push("bounds");
				return bounds;
			}
			if (script.includes("__gradivus_inspector_set_capture_hidden__")) {
				events.push(script.includes("(true)") ? "hide" : "restore");
				return true;
			}
			if (script.includes("__gradivus_inspector_finish__") || script.includes("__gradivus_inspector_cleanup__"))
				return true;
			if (initialAction) {
				initialAction = false;
				return {
					selector: "#target",
					tagName: "button",
					text: "Target",
					outerHTML: '<button id="target">SERIALIZED_NODE_SHOULD_NOT_LEAVE_PAGE</button>',
					instruction: "Inspect this target",
					action: "chat",
					captureMode: "screenshot",
					bounds,
				};
			}
			return { canceled: true };
		});
		const hostWindow = {
			isDestroyed: () => false,
			webContents: { isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => 1.5 },
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		};
		const host = new WorkspaceHost(hostWindow as never);
		host.syncWithDocument(createMockDocument());
		host.setVisibleBrowsers(["pane-browser-1"]);
		const view = mockViewInstances[0];
		expect(view).toBeDefined();
		host.setBrowserBounds("pane-browser-1", { x: 40, y: 30, width: 800, height: 600 });
		const deliverElementPrompt = vi.fn(
			async (_promptText: string, _sessionId: string, _deliveryOptions: unknown) => undefined,
		);
		host.setDesktopHost({
			setPaneBroker: vi.fn(),
			refreshPaneBroker: vi.fn(),
			resolveChatSessionForBrowserAgent: vi.fn((sessionId: string) => sessionId),
			deliverElementPrompt,
		} as never);
		await host.startSelection({
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId: "pane-browser-1",
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
			agentId: "agent",
			sessionId: "session",
		});
		await vi.waitFor(() => expect(mockCapturePage).toHaveBeenCalled());
		await vi.waitFor(() => expect(deliverElementPrompt).toHaveBeenCalled());
		expect(
			mockExecuteJavaScript.mock.calls.some(
				([script]) =>
					typeof script === "string" && script.includes("__gradivus_inspector_get_current_target_bounds__"),
			),
		).toBe(true);
		expect(mockCapturePage).toHaveBeenCalledWith({ x: 138, y: 63, width: 84, height: 54 });
		expect(nativeImage.toJPEG).toHaveBeenCalledWith(80);
		expect(mockViewInstances[0]).toBe(view);
		expect(mockSetBounds).toHaveBeenLastCalledWith({ x: 60, y: 45, width: 1200, height: 900 });
		expect(events.indexOf("hide")).toBeLessThan(events.indexOf("capture"));
		expect(events.indexOf("capture")).toBeLessThan(events.indexOf("restore"));
		const [promptText, , deliveryOptions] = deliverElementPrompt.mock.calls[0]!;
		expect(promptText).toContain("https://omp.sh");
		expect(promptText).toContain("#target");
		expect(promptText).not.toContain("SERIALIZED_NODE_SHOULD_NOT_LEAVE_PAGE");
		expect(deliveryOptions).toMatchObject({
			selector: "#target",
			captureMode: "screenshot",
			screenshot: {
				base64: Buffer.from("jpeg-bytes").toString("base64"),
				mimeType: "image/jpeg",
				width: 40,
				height: 20,
			},
		});
	});

	it("notifies an active inspector overlay without canceling it", () => {
		const store = {
			settings: {
				theme: "dark" as const,
				confirmCloseTab: true,
				terminal: { shell: "" },
				browser: {},
				workspace: { defaultPath: "/tmp" },
			},
		};
		const hostWindow = {
			isDestroyed: () => false,
			webContents: { isDestroyed: () => false, send: vi.fn(), getZoomFactor: () => 1 },
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		};
		const host = new WorkspaceHost(hostWindow as never, store as never);
		host.syncWithDocument(createMockDocument());
		const scope = {
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId: "pane-browser-1",
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
			agentId: "agent",
			sessionId: "session",
		} as const;
		void host.startSelection(scope);
		store.settings.theme = "light";
		host.updateTheme();
		expect(mockExecuteJavaScript).toHaveBeenCalledWith(expect.stringContaining("__gradivus_inspector_set_theme__"));
	});
	it("owns immediate multi-agent queue records and runs pending tasks by target session", async () => {
		const { host } = createHost();
		const paneId = "pane-browser-1";
		host.syncWithDocument(createMockDocument());
		host.setVisibleBrowsers([paneId]);
		const baseScope = {
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId,
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
		};
		const targetA = { id: "agent-a", name: "Agent A", swatch: getAgentSwatch("agent-a") };
		const targetB = { id: "agent-b", name: "Agent B", swatch: getAgentSwatch("agent-b") };
		const resolveSelectionTarget = vi.fn((_: string, targetAgentId: string | undefined, documentEpoch: number) => ({
			scope: {
				...baseScope,
				documentEpoch,
				agentId: targetAgentId ?? "agent-a",
				sessionId: `session-${targetAgentId ?? "agent-a"}`,
			},
			target: targetAgentId === targetB.id ? targetB : targetA,
		}));
		const executeInlinePrompt = vi.fn(async (_promptText: string, sessionId: string) => {
			if (sessionId === "session-agent-b") throw new Error("Agent B failed");
			return "Agent A response";
		});
		host.setDesktopHost({
			setPaneBroker: vi.fn(),
			refreshPaneBroker: vi.fn(),
			resolveSelectionTarget,
			executeInlinePrompt,
		} as never);

		const actions = [
			{
				enqueue: true,
				targetAgentId: targetA.id,
				selector: "#first",
				tagName: "button",
				attributes: { id: "first" },
				outerHTML: '<button id="first">First</button>',
				instruction: "Inspect first",
				agentType: "designer",
				captureMode: "dom",
				bounds: { x: 10, y: 20, width: 80, height: 30 },
			},
			{
				enqueue: true,
				targetAgentId: targetB.id,
				selector: "#second",
				tagName: "main",
				attributes: { id: "second" },
				outerHTML: '<main id="second">Second</main>',
				instruction: "Inspect second",
				agentType: "reviewer",
				captureMode: "dom",
				bounds: { x: 12, y: 24, width: 100, height: 40 },
			},
		];
		let initialCount = 0;
		mockExecuteJavaScript.mockImplementation(async script => {
			if (typeof script !== "string") return { canceled: true };
			if (script.startsWith("Boolean(document.getElementById")) return false;
			if (
				script.startsWith("window.__gradivus_inspector_finish__") ||
				script.startsWith("window.__gradivus_inspector_cleanup__") ||
				script.startsWith("window.__gradivus_inspector_clear_queue__")
			) {
				return true;
			}
			if (script.startsWith("window.__gradivus_inspector_wait_for_action__")) return { canceled: true };
			initialCount += 1;
			return actions[initialCount - 1] ?? { canceled: true };
		});

		const scopeA = { ...baseScope, agentId: targetA.id, sessionId: "session-agent-a" };
		const scopeB = { ...baseScope, agentId: targetB.id, sessionId: "session-agent-b" };
		expect(host.getBrowserDocumentEpoch(paneId)).toBe(1);
		await host.startSelection(scopeA, { target: targetA });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(1));
		await host.startSelection(scopeB, { target: targetB });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(2));

		const snapshot = host.getSelectionState(paneId);
		snapshot.queuedTasks![0]!.targetAgentName = "mutated";
		expect(snapshot.queuedTasks?.[0]).not.toHaveProperty("domHtml");
		expect(snapshot.queuedTasks?.[0]).not.toHaveProperty("domSnapshot");
		expect(snapshot.queuedTasks?.[0]).not.toHaveProperty("summary");
		const unchanged = host.getSelectionState(paneId);
		expect(unchanged.queuedTasks?.[0]?.targetAgentName).toBe(targetA.name);

		const completed = await host.runQueuedTasks(paneId);
		expect(completed.queuedTasks?.map(task => task.status)).toEqual(["completed", "error"]);
		expect(completed.queuedTasks?.[0]?.response).toBe("Agent A response");
		expect(completed.queuedTasks?.[1]?.error).toBe("Agent B failed");
		expect(executeInlinePrompt.mock.calls.map(([, sessionId]) => sessionId)).toEqual([
			"session-agent-a",
			"session-agent-b",
		]);
		const [firstPrompt] = executeInlinePrompt.mock.calls[0]!;
		expect(firstPrompt).toContain("https://omp.sh");
		expect(firstPrompt).toContain("#first");
		expect(firstPrompt).not.toContain('<button id="first">First</button>');
		expect(firstPrompt).not.toContain("Element DOM snippet");

		const cleared = await host.clearQueuedTasks(paneId);
		expect(cleared.queuedTasks).toEqual([]);
		expect(cleared.queueRunning).toBe(false);
	});
	it("routes authenticated queued targets to distinct session ids", async () => {
		const { host } = createHost();
		const paneId = "pane-browser-1";
		const baseDocument = createMockDocument();
		host.syncWithDocument(baseDocument);
		host.setVisibleBrowsers([paneId]);
		const targetA = { id: "agent-a", name: "Agent Alpha", swatch: getAgentSwatch("agent-a") };
		const targetB = { id: "agent-b", name: "Agent Beta", swatch: getAgentSwatch("agent-b") };
		const now = Date.now();
		const authorityDocument = {
			...baseDocument,
			workspaces: [{ id: "ws_1", name: "Main", locationId: "loc_1", generation: 1 }],
			locations: [
				{
					id: "loc_1",
					name: "Local",
					address: { kind: "local", path: "/tmp" },
					lifecycle: { status: "active", generation: 1, updatedAt: now },
				},
			],
			browsers: [{ ...baseDocument.browsers[0], status: "open" }],
			agentProfiles: [
				{ id: "profile-a", name: targetA.name, config: {}, capabilityIds: [] },
				{ id: "profile-b", name: targetB.name, config: {}, capabilityIds: [] },
			],
			agents: [
				{ id: targetA.id, profileId: "profile-a", sessionId: "session-a", status: "running" },
				{ id: targetB.id, profileId: "profile-b", sessionId: "session-b", status: "running" },
			],
			sessions: [
				{
					id: "session-a",
					locationId: "loc_1",
					actorId: targetA.id,
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: now,
					lastSeenAt: now,
				},
				{
					id: "session-b",
					locationId: "loc_1",
					actorId: targetB.id,
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: now,
					lastSeenAt: now,
				},
			],
		} as unknown as WorkspaceDocumentV1;
		const desktopHost = new DesktopHost("/tmp/gradivus-selection-auth");
		desktopHost.setWorkspaceAuthority({ kind: "user", id: "principal" }, authorityDocument);
		const inlineSpy = vi.spyOn(desktopHost, "executeInlinePrompt").mockImplementation(async (_prompt, sessionId) => {
			if (sessionId === "session-b") throw new Error("Agent Beta failed");
			return "Agent Alpha output";
		});
		host.setDesktopHost(desktopHost);

		const actions = [
			{
				enqueue: true,
				targetAgentId: targetA.id,
				selector: "#first",
				tagName: "button",
				attributes: { id: "first" },
				outerHTML: '<button id="first">First</button>',
				instruction: "Inspect first",
				agentType: "designer",
				captureMode: "dom",
				bounds: { x: 10, y: 20, width: 80, height: 30 },
			},
			{
				enqueue: true,
				targetAgentId: targetB.id,
				selector: "#second",
				tagName: "main",
				attributes: { id: "second" },
				outerHTML: '<main id="second">Second</main>',
				instruction: "Inspect second",
				agentType: "reviewer",
				captureMode: "dom",
				bounds: { x: 12, y: 24, width: 100, height: 40 },
			},
		];
		let initialCount = 0;
		mockExecuteJavaScript.mockImplementation(async script => {
			if (typeof script !== "string") return { canceled: true };
			if (script.startsWith("Boolean(document.getElementById")) return false;
			if (
				script.startsWith("window.__gradivus_inspector_finish__") ||
				script.startsWith("window.__gradivus_inspector_cleanup__")
			) {
				return true;
			}
			if (script.startsWith("window.__gradivus_inspector_wait_for_action__")) return { canceled: true };
			initialCount += 1;
			return actions[initialCount - 1] ?? { canceled: true };
		});
		const scope = {
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId,
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
		};
		await host.startSelection({ ...scope, agentId: targetA.id, sessionId: "session-a" }, { target: targetA });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(1));
		await host.startSelection({ ...scope, agentId: targetB.id, sessionId: "session-b" }, { target: targetB });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(2));
		expect(host.getSelectionState(paneId).queuedTasks?.map(task => task.status)).toEqual(["pending", "pending"]);

		const result = await host.runQueuedTasks(paneId);
		expect(result.queuedTasks?.map(task => task.status)).toEqual(["completed", "error"]);
		expect(result.queuedTasks?.[0]?.response).toBe("Agent Alpha output");
		expect(result.queuedTasks?.[1]?.error).toBe("Agent Beta failed");
		expect(inlineSpy.mock.calls.map(([, sessionId]) => sessionId)).toEqual(["session-a", "session-b"]);
		await desktopHost.close();
	});
	it("caps each pane queue and resets its monotonic task index on Clear", async () => {
		const { host } = createHost();
		const paneId = "pane-browser-1";
		host.syncWithDocument(createMockDocument());
		host.setVisibleBrowsers([paneId]);
		const target = { id: "agent", name: "Agent", swatch: getAgentSwatch("agent") };
		const scope = {
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId,
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
			agentId: target.id,
			sessionId: "session-agent",
		};
		const resolveSelectionTarget = vi.fn((_: string, __: string | undefined, documentEpoch: number) => ({
			scope: { ...scope, documentEpoch },
			target,
		}));
		host.setDesktopHost({
			setPaneBroker: vi.fn(),
			refreshPaneBroker: vi.fn(),
			resolveSelectionTarget,
			executeInlinePrompt: vi.fn(),
		} as never);
		let nextTask = 0;
		const makeAction = () => {
			nextTask += 1;
			return {
				enqueue: true,
				targetAgentId: target.id,
				selector: `#queued-${nextTask}`,
				tagName: "button",
				attributes: { id: `queued-${nextTask}` },
				outerHTML: `<button id="queued-${nextTask}">Queued</button>`,
				instruction: `Inspect queued ${nextTask}`,
				captureMode: "dom",
				bounds: { x: 1, y: 2, width: 20, height: 12 },
			};
		};
		mockExecuteJavaScript.mockImplementation(async script => {
			if (typeof script !== "string") return { canceled: true };
			if (script.startsWith("Boolean(document.getElementById")) return false;
			if (
				script.startsWith("window.__gradivus_inspector_finish__") ||
				script.startsWith("window.__gradivus_inspector_cleanup__") ||
				script.startsWith("window.__gradivus_inspector_clear_queue__")
			) {
				return true;
			}
			if (script.startsWith("window.__gradivus_inspector_wait_for_action__")) {
				return nextTask < 129 ? makeAction() : { canceled: true };
			}
			return makeAction();
		});

		await host.startSelection(scope, { target });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(128));
		expect(host.getSelectionState(paneId).queuedTasks?.[127]?.taskIndex).toBe(128);
		await host.clearQueuedTasks(paneId);
		expect(host.getSelectionState(paneId).queuedTasks).toEqual([]);

		await host.startSelection(scope, { target });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(1));
		expect(host.getSelectionState(paneId).queuedTasks?.[0]?.taskIndex).toBe(1);
	});
	it("enforces single-flight runs and drops late completions after pane destruction", async () => {
		const { host } = createHost();
		const paneId = "pane-browser-1";
		host.syncWithDocument(createMockDocument());
		host.setVisibleBrowsers([paneId]);
		const target = { id: "agent", name: "Agent", swatch: getAgentSwatch("agent") };
		const scope = {
			principalId: "principal",
			workspaceId: "ws_1",
			tabId: "tab_browser",
			paneId,
			documentEpoch: 1,
			locationGeneration: 1,
			locationId: "loc_1",
			agentId: target.id,
			sessionId: "session-agent",
		};
		const response = Promise.withResolvers<string>();
		const resolveSelectionTarget = vi.fn((_: string, __: string | undefined, documentEpoch: number) => ({
			scope: { ...scope, documentEpoch },
			target,
		}));
		const executeInlinePrompt = vi.fn(() => response.promise);
		host.setDesktopHost({
			setPaneBroker: vi.fn(),
			refreshPaneBroker: vi.fn(),
			resolveSelectionTarget,
			executeInlinePrompt,
		} as never);
		let initial = true;
		mockExecuteJavaScript.mockImplementation(async script => {
			if (typeof script !== "string") return { canceled: true };
			if (script.startsWith("Boolean(document.getElementById")) return false;
			if (
				script.startsWith("window.__gradivus_inspector_finish__") ||
				script.startsWith("window.__gradivus_inspector_cleanup__")
			) {
				return true;
			}
			if (initial) {
				initial = false;
				return {
					enqueue: true,
					targetAgentId: target.id,
					selector: "#late",
					tagName: "button",
					attributes: { id: "late" },
					outerHTML: '<button id="late">Late</button>',
					instruction: "Inspect late",
					captureMode: "dom",
					bounds: { x: 1, y: 2, width: 20, height: 12 },
				};
			}
			return { canceled: true };
		});
		await host.startSelection(scope, { target });
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queuedTasks).toHaveLength(1));

		const running = host.runQueuedTasks(paneId);
		await vi.waitFor(() => expect(host.getSelectionState(paneId).queueRunning).toBe(true));
		await expect(host.runQueuedTasks(paneId)).rejects.toThrow("Selection queue is already running");
		host.destroyBrowserView(paneId);
		response.resolve("Late response");
		await running;
		expect(host.getSelectionState(paneId).queuedTasks).toEqual([]);
		expect(executeInlinePrompt).toHaveBeenCalledTimes(1);
	});
});

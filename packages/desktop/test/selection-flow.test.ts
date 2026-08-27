import { mkdtemp, realpath, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceClient, WorkspaceServer } from "@oh-my-pi/pi-workspace-runtime";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopHost } from "../src/main/desktop-host";
import { WorkspaceHost } from "../src/main/workspace-host";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const electronMocks = vi.hoisted(() => ({
	executeJavaScript: vi.fn().mockResolvedValue(null),
	capturePage: vi.fn(async () => ({
		toJPEG: () => Buffer.from("fake-jpeg-bytes"),
		getSize: () => ({ width: 800, height: 600 }),
	})),
}));

vi.mock("electron", () => {
	class MockWebContents {
		debugger = {
			isAttached: () => true,
			attach: vi.fn(),
			sendCommand: vi.fn(async (method: string) => {
				if (method === "DOM.describeNode") {
					return {
						node: {
							localName: "button",
							attributes: [
								"id",
								"submit-order",
								"class",
								"btn-primary",
								"role",
								"button",
								"aria-label",
								"Submit",
							],
						},
					};
				}
				if (method === "DOM.getBoxModel") {
					return {
						model: {
							border: [10, 20, 110, 20, 110, 60, 10, 60],
							width: 100,
							height: 40,
						},
					};
				}
				return {};
			}),
			on: vi.fn(),
			removeAllListeners: vi.fn(),
		};
		isDestroyed = () => false;
		loadURL = vi.fn(async () => {});
		on = vi.fn();
		setWindowOpenHandler = vi.fn();
		executeJavaScript = electronMocks.executeJavaScript;
		capturePage = electronMocks.capturePage;
	}

	class MockWebContentsView {
		webContents = new MockWebContents();
		setBackgroundColor = vi.fn();
		setBounds = vi.fn();
	}

	return {
		app: { getPath: () => "/tmp/gradivus-test-user-data" },
		BrowserWindow: class {
			isDestroyed = () => false;
			webContents = {
				isDestroyed: () => false,
				send: vi.fn(),
			};
			contentView = {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			};
		},
		WebContentsView: MockWebContentsView,
		Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
		dialog: { showOpenDialog: vi.fn() },
		shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
	};
});

describe("Element Selection End-to-End Workflow with Authenticated Runtime", () => {
	let testDir: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;
	let desktopHost: DesktopHost;
	let workspaceHost: WorkspaceHost;

	beforeEach(async () => {
		electronMocks.executeJavaScript.mockReset().mockResolvedValue(null);
		electronMocks.capturePage.mockReset().mockResolvedValue({
			toJPEG: () => Buffer.from("fake-jpeg-bytes"),
			getSize: () => ({ width: 800, height: 600 }),
		});
		const rawDir = await mkdtemp(path.join(os.tmpdir(), "gradivus-auth-test-"));
		testDir = await realpath(rawDir);
		server = new WorkspaceServer({ runtimeRoot: testDir });
		await server.start();

		client = new WorkspaceClient({ runtimeRoot: testDir });
		await client.connect();

		// 1. Create workspace with location
		const createWsCmd = {
			version: 1 as const,
			commandId: "cmd-ws-create-1",
			workspaceId: "ws_alpha",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create" as const,
			payload: {
				name: "Alpha Workspace",
				locationId: "loc_alpha",
				locationName: "Local Location",
				address: { kind: "local", path: testDir },
			},
		};
		const res1 = await client.executeCommand(createWsCmd);
		expect(res1.status).toBe("accepted");

		// 2. Create agent profile and start agent
		const createProfCmd = {
			version: 1 as const,
			commandId: "cmd-prof-create-1",
			workspaceId: "ws_alpha",
			expectedRevision: 1,
			issuedAt: Date.now(),
			type: "profile.create" as const,
			payload: {
				id: "prof_main",
				name: "Main Profile",
				config: {},
			},
		};
		const res2 = await client.executeCommand(createProfCmd);
		expect(res2.status).toBe("accepted");

		const startAgentCmd = {
			version: 1 as const,
			commandId: "cmd-agent-start-1",
			workspaceId: "ws_alpha",
			expectedRevision: 2,
			issuedAt: Date.now(),
			type: "agent.start" as const,
			payload: {
				id: "agent_alpha",
				profileId: "prof_main",
				sessionId: "session_alpha",
			},
		};
		const res3 = await client.executeCommand(startAgentCmd);
		expect(res3.status).toBe("accepted");

		// 3. Open browser pane
		const openBrowserCmd = {
			version: 1 as const,
			commandId: "cmd-browser-open-1",
			workspaceId: "ws_alpha",
			expectedRevision: 3,
			issuedAt: Date.now(),
			type: "browser.open" as const,
			payload: {
				id: "browser_1",
				paneId: "pane-browser-1",
				tabId: "tab_alpha",
				url: "https://omp.sh",
			},
		};
		const res4 = await client.executeCommand(openBrowserCmd);
		expect(res4.status).toBe("accepted");

		desktopHost = new DesktopHost(testDir);
		await desktopHost.load();
		expect(client.principal).toBeDefined();
		desktopHost.setWorkspaceAuthority(client.principal!, res4.document);
		const mockWindow = new (await import("electron")).BrowserWindow();

		workspaceHost = new WorkspaceHost(mockWindow as unknown as BrowserWindow);
		workspaceHost.setClient(client);
		workspaceHost.syncWithDocument(res4.document);
	});

	afterEach(async () => {
		await client.close();
		if (server.isListening) {
			await server.stop();
		}
		await workspaceHost.stop();
		await desktopHost.close();
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("resolves authenticated scope and leaves the BrowserView card lifecycle host-owned", async () => {
		const doc = client.document!;
		const defaultAgent = doc.agents[0]!;
		const epoch = workspaceHost.getBrowserDocumentEpoch("pane-browser-1");
		const { scope } = desktopHost.resolveSelectionTarget("pane-browser-1", defaultAgent.id, epoch);

		expect(() => desktopHost.resolveSelectionTarget("pane-browser-1", "unknown_agent", epoch)).toThrow(
			"No deliverable workspace agent is available for selection",
		);
		expect(() => desktopHost.resolveSelectionTarget("pane-browser-1", defaultAgent.id, 0)).toThrow(
			"Valid positive documentEpoch is required",
		);

		const pageAction = deferred<null>();
		electronMocks.executeJavaScript.mockImplementationOnce(() => pageAction.promise);
		const pickingState = await workspaceHost.startSelection(scope);

		expect(pickingState.phase).toBe("picking");
		expect(pickingState.paneId).toBe("pane-browser-1");
		expect(pickingState.selectionId).toBeTypeOf("string");
		expect(workspaceHost.getSelectionState("pane-browser-1").phase).toBe("picking");

		pageAction.resolve(null);
		await Promise.resolve();
	});

	it("keeps inline delivery active until the BrowserView card is explicitly canceled", async () => {
		const doc = client.document!;
		const defaultAgent = doc.agents[0]!;
		const { scope } = desktopHost.resolveSelectionTarget(
			"pane-browser-1",
			defaultAgent.id,
			workspaceHost.getBrowserDocumentEpoch("pane-browser-1"),
		);
		const pageAction = deferred<{
			selector: string;
			tagName: string;
			instruction: string;
			action: "inline";
			agentType: "designer";
			captureMode: "dom";
			bounds: { x: number; y: number; width: number; height: number };
		}>();
		const delivery = deferred<string>();
		electronMocks.executeJavaScript.mockImplementation((script: string) => {
			const trimmed = script.trim();
			if (trimmed === "window.__gradivus_inspector_wait_for_action__?.()") return Promise.resolve(null);
			if (
				trimmed.startsWith("window.__gradivus_inspector_finish__?.(") ||
				trimmed.startsWith("window.__gradivus_inspector_cleanup__?.(")
			) {
				return Promise.resolve(true);
			}
			return pageAction.promise;
		});
		workspaceHost.setDesktopHost(desktopHost);
		const inlineSpy = vi.spyOn(desktopHost, "executeInlinePrompt").mockReturnValue(delivery.promise);
		await workspaceHost.startSelection(scope);
		pageAction.resolve({
			selector: "#submit-order",
			tagName: "button",
			instruction: "Explain this control",
			action: "inline",
			agentType: "designer",
			captureMode: "dom",
			bounds: { x: 10, y: 20, width: 100, height: 40 },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(inlineSpy).toHaveBeenCalledWith(
			expect.any(String),
			scope.sessionId,
			expect.objectContaining({
				selector: "#submit-order",
				instruction: "Explain this control",
				agentType: "designer",
				captureMode: "dom",
			}),
		);
		expect(workspaceHost.getSelectionState("pane-browser-1").phase).toBe("analyzing");

		const cancel = workspaceHost.cancelSelection("pane-browser-1", "test cancellation");
		expect(workspaceHost.getSelectionState("pane-browser-1").phase).toBe("idle");
		delivery.resolve("Inline response");
		await cancel;
	});
	it("keeps chat delivery active until explicit cancellation and passes selection metadata", async () => {
		const defaultAgent = client.document!.agents[0]!;
		const { scope } = desktopHost.resolveSelectionTarget(
			"pane-browser-1",
			defaultAgent.id,
			workspaceHost.getBrowserDocumentEpoch("pane-browser-1"),
		);
		client.document!.agents = [];
		const pageAction = deferred<{
			selector: string;
			tagName: string;
			instruction: string;
			action: "chat";
			agentType: "reviewer";
			captureMode: "dom";
			bounds: { x: number; y: number; width: number; height: number };
		}>();
		const delivery = deferred<void>();
		electronMocks.executeJavaScript.mockImplementation((script: string) => {
			const trimmed = script.trim();
			if (trimmed === "window.__gradivus_inspector_wait_for_action__?.()") return Promise.resolve(null);
			if (
				trimmed.startsWith("window.__gradivus_inspector_finish__?.(") ||
				trimmed.startsWith("window.__gradivus_inspector_cleanup__?.(")
			) {
				return Promise.resolve(true);
			}
			return pageAction.promise;
		});
		workspaceHost.setDesktopHost(desktopHost);
		const chatSpy = vi.spyOn(desktopHost, "deliverElementPrompt").mockReturnValue(delivery.promise);
		await workspaceHost.startSelection(scope);
		pageAction.resolve({
			selector: "main > h1",
			tagName: "h1",
			instruction: "Rewrite this heading",
			action: "chat",
			agentType: "reviewer",
			captureMode: "dom",
			bounds: { x: 12, y: 24, width: 180, height: 48 },
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(chatSpy).toHaveBeenCalledWith(
			expect.any(String),
			scope.sessionId,
			expect.objectContaining({
				selector: "main > h1",
				instruction: "Rewrite this heading",
				agentType: "reviewer",
				captureMode: "dom",
			}),
		);
		expect(workspaceHost.getSelectionState("pane-browser-1").phase).toBe("working");
		const cancel = workspaceHost.cancelSelection("pane-browser-1", "test cancellation");
		expect(workspaceHost.getSelectionState("pane-browser-1").phase).toBe("idle");
		delivery.resolve();
		await cancel;
	});
});

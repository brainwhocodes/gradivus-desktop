import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function createDocument(): WorkspaceDocumentV1 {
	return {
		version: 1,
		revision: 1,
		workspaces: [{ id: "ws", label: "Workspace", locationId: "loc" }],
		locations: [{ id: "loc", kind: "local", path: "/tmp/workspace", lifecycle: { generation: 1 } }],
		tabs: [
			{
				id: "tab",
				workspaceId: "ws",
				locationId: "loc",
				generation: 1,
				name: "Browser",
				paneKind: "browser",
				layout: "columns",
				ratio: 50,
				paneIds: ["pane-0001"],
				activePaneId: "pane-0001",
			},
		],
		panes: [{ id: "pane-0001", tabId: "tab", generation: 1, kind: "browser", entityId: "browser" }],
		terminals: [],
		browsers: [
			{
				id: "browser",
				locationId: "loc",
				paneId: "pane-0001",
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

function createScope() {
	return {
		principalId: "principal",
		workspaceId: "ws",
		tabId: "tab",
		paneId: "pane-0001",
		locationId: "loc",
		agentId: "agent",
		sessionId: "session",
		documentEpoch: 1,
		locationGeneration: 1,
	};
}

const electronMocks = vi.hoisted(() => ({
	executeJavaScript: vi.fn().mockResolvedValue(null),
	capturePage: vi.fn().mockResolvedValue({
		toJPEG: () => Buffer.from("jpeg"),
		getSize: () => ({ width: 20, height: 20 }),
	}),
}));

vi.mock("electron", () => {
	class MockWebContents {
		debugger = {
			isAttached: () => false,
			sendCommand: vi.fn().mockResolvedValue({}),
		};
		navigationHistory = {
			canGoBack: () => false,
			canGoForward: () => false,
			goBack: vi.fn(),
			goForward: vi.fn(),
			reload: vi.fn(),
			stop: vi.fn(),
		};
		isDestroyed = () => false;
		getURL = () => "https://omp.sh";
		getTitle = () => "";
		loadURL = vi.fn().mockResolvedValue(undefined);
		on = vi.fn();
		setWindowOpenHandler = vi.fn();
		focus = vi.fn();
		executeJavaScript = electronMocks.executeJavaScript;
		capturePage = electronMocks.capturePage;
		close = vi.fn();
	}
	class MockWebContentsView {
		webContents = new MockWebContents();
		setBounds = vi.fn();
		setBackgroundColor = vi.fn();
	}
	return {
		app: { isPackaged: false, getPath: () => "/tmp/userData" },
		Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
		WebContentsView: MockWebContentsView,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	electronMocks.executeJavaScript.mockReset().mockResolvedValue(null);
	electronMocks.capturePage.mockReset().mockResolvedValue({
		toJPEG: () => Buffer.from("jpeg"),
		getSize: () => ({ width: 20, height: 20 }),
	});
});

describe("WorkspaceHost generation-safe selection lifecycle", () => {
	function createHost() {
		const sentStates: unknown[] = [];
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send: vi.fn((_channel: string, state: unknown) => sentStates.push(state)),
			},
			contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
		};
		const host = new WorkspaceHost(window as never, "http://127.0.0.1:9222");
		const document = createDocument();
		host.syncWithDocument(document);
		host.setVisibleBrowsers(["pane-0001"]);
		return { host, document, sentStates };
	}

	it("returns picking while the BrowserView inspector command remains pending", async () => {
		const { host } = createHost();
		const inspectorCommand = deferred<null>();
		electronMocks.executeJavaScript.mockImplementationOnce(() => inspectorCommand.promise);

		const picking = await host.startSelection(createScope());

		expect(picking.phase).toBe("picking");
		expect(picking.selectionId).toBeTypeOf("string");
		expect(host.getSelectionState("pane-0001").phase).toBe("picking");

		inspectorCommand.resolve(null);
		await Promise.resolve();
	});

	it("emits idle before deferred inspector cleanup settles", async () => {
		const { host, sentStates } = createHost();
		const inspector = deferred<null>();
		const cleanup = deferred<void>();
		electronMocks.executeJavaScript
			.mockImplementationOnce(() => inspector.promise)
			.mockImplementationOnce(() => cleanup.promise);
		await host.startSelection(createScope());

		const cancel = host.cancelSelection("pane-0001", "test");
		expect(host.getSelectionState("pane-0001").phase).toBe("idle");
		expect(
			sentStates.some(
				state => typeof state === "object" && state !== null && "phase" in state && state.phase === "idle",
			),
		).toBe(true);

		inspector.resolve(null);
		cleanup.resolve();
		await cancel;
	});

	it("ignores a stale inspector callback after cancellation and replacement", async () => {
		const { host } = createHost();
		const inspectorA = deferred<{
			tagName: string;
			selector: string;
			instruction: string;
			action: "inline";
		}>();
		electronMocks.executeJavaScript.mockImplementationOnce(() => inspectorA.promise);
		const scope = createScope();
		const first = await host.startSelection(scope);
		await host.cancelSelection("pane-0001", "restart");

		const inspectorB = deferred<null>();
		electronMocks.executeJavaScript.mockImplementationOnce(() => inspectorB.promise);
		const second = await host.startSelection(scope);
		expect(second.phase).toBe("picking");
		expect(second.selectionId).not.toBe(first.selectionId);

		inspectorA.resolve({
			tagName: "button",
			selector: "#stale",
			instruction: "Stale action",
			action: "inline",
		});
		await Promise.resolve();
		expect(host.getSelectionState("pane-0001").selectionId).toBe(second.selectionId);

		inspectorB.resolve(null);
		await Promise.resolve();
	});

	it("delivers runtime Page Agent targets as live selector references without serialized DOM", async () => {
		const { host, document } = createHost();
		document.agents = [{ id: "agent", profileId: "profile", sessionId: "session", status: "running" }];
		const deliveredCommands: unknown[] = [];
		const executeCommandWithRetry = vi.fn(
			async (createCommand: (currentDocument: WorkspaceDocumentV1) => unknown) => {
				deliveredCommands.push(createCommand(document));
				return { status: "accepted", document };
			},
		);
		host.setClient({ isConnected: true, document, executeCommandWithRetry } as never);
		let pendingAction = true;
		electronMocks.executeJavaScript.mockImplementation(async script => {
			if (typeof script !== "string") return null;
			if (
				script.startsWith("window.__gradivus_inspector_finish__") ||
				script.startsWith("window.__gradivus_inspector_cleanup__")
			) {
				return true;
			}
			if (script.startsWith("window.__gradivus_inspector_wait_for_action__")) return { closed: true };
			if (!pendingAction) return null;
			pendingAction = false;
			return {
				selector: "#runtime-target",
				tagName: "button",
				outerHTML: '<button id="runtime-target">SERIALIZED_RUNTIME_NODE_SHOULD_NOT_LEAVE_PAGE</button>',
				instruction: "Inspect the live target",
				action: "chat",
				captureMode: "dom",
				bounds: { x: 10, y: 20, width: 100, height: 40 },
			};
		});

		await host.startSelection(createScope());
		await vi.waitFor(() => expect(executeCommandWithRetry).toHaveBeenCalled());

		const delivered = deliveredCommands[0];
		expect(delivered).toMatchObject({
			type: "agent.message",
			payload: {
				selector: "#runtime-target",
				url: expect.stringContaining("https://omp.sh"),
			},
		});
		expect(delivered).not.toHaveProperty("payload.domSnapshot");
		expect(delivered).toHaveProperty("payload.message", expect.stringContaining("#runtime-target"));
		expect(delivered).not.toHaveProperty("payload.domHtml");
		expect(delivered).not.toHaveProperty("payload.outerHTML");
		expect(delivered).not.toHaveProperty(
			"payload.message",
			expect.stringContaining("SERIALIZED_RUNTIME_NODE_SHOULD_NOT_LEAVE_PAGE"),
		);
	});

	it("preserves selection on rejected close and ends it after an accepted retry", async () => {
		const { host, document } = createHost();
		const rejectedClient = {
			isConnected: true,
			document,
			executeCommandWithRetry: vi.fn().mockResolvedValue({
				status: "rejected",
				error: { message: "Permission denied" },
			}),
		};
		host.setClient(rejectedClient as never);
		const inspector = deferred<null>();
		electronMocks.executeJavaScript.mockImplementationOnce(() => inspector.promise);
		await host.startSelection(createScope());
		await expect(host.closeBrowser("pane-0001")).rejects.toThrow("Permission denied");
		expect(host.getSelectionState("pane-0001").phase).toBe("picking");
		const closedDocument: WorkspaceDocumentV1 = { ...document, revision: 2, browsers: [], panes: [], tabs: [] };
		let acceptedDocument: WorkspaceDocumentV1 = document;
		const acceptedClient = {
			isConnected: true,
			get document() {
				return acceptedDocument;
			},
			executeCommandWithRetry: vi.fn().mockImplementation(async () => {
				acceptedDocument = closedDocument;
				return { status: "accepted", document: closedDocument };
			}),
		};
		host.setClient(acceptedClient as never);
		await host.closeBrowser("pane-0001");
		expect(host.getSelectionState("pane-0001").phase).toBe("idle");
	});
});

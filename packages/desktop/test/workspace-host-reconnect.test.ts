import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHost } from "../src/main/workspace-host";

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/tmp/userData") },
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
			close: vi.fn(),
			isDestroyed: () => false,
		};
		setBounds = vi.fn();
		setBackgroundColor = vi.fn();
	},
}));

describe("WorkspaceHost reconnect and client replacement", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	function createHost() {
		const send = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: {
				isDestroyed: () => false,
				send,
			},
			contentView: {
				addChildView: vi.fn(),
				removeChildView: vi.fn(),
			},
		};
		const host = new WorkspaceHost(window as never);
		return { host, send };
	}

	function createMockDocument(): WorkspaceDocumentV1 {
		return {
			version: 1,
			revision: 1,
			workspaces: [{ id: "ws_1", label: "Main", locationId: "loc_1" }],
			locations: [
				{
					id: "loc_1",
					kind: "local",
					path: "/test",
					address: { kind: "local", path: "/test" },
					lifecycle: { generation: 1 },
				},
			],
			tabs: [
				{
					id: "tab_terminal",
					workspaceId: "ws_1",
					locationId: "loc_1",
					generation: 1,
					name: "Terminal Tab",
					paneKind: "terminal",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-term-1"],
					activePaneId: "pane-term-1",
				},
			],
			panes: [{ id: "pane-term-1", tabId: "tab_terminal", generation: 1, kind: "terminal", entityId: "term-1" }],
			terminals: [
				{
					id: "term-1",
					locationId: "loc_1",
					paneId: "pane-term-1",
					generation: 1,
					label: "Terminal",
					status: "running",
				},
			],
			browsers: [],
			previews: [],
			agents: [],
			sessions: [],
			agentProfiles: [],
			pendingCleanup: [],
		};
	}

	it("retains terminal byte offset across replaceClient and resubscribes from that offset", async () => {
		const { host } = createHost();
		const doc = createMockDocument();

		let outputCallback1: ((frame: { offset: number; data: string }) => void) | undefined;
		const unsubscribe1 = vi.fn();

		const client1 = {
			isConnected: true,
			document: doc,
			onTerminalOutput: vi.fn((_id: string, cb: (frame: { offset: number; data: string }) => void) => {
				outputCallback1 = cb;
				return unsubscribe1;
			}),
			subscribeTerminal: vi.fn().mockResolvedValue({ status: "running" }),
		};

		host.setClient(client1 as never);
		host.syncWithDocument(doc);

		// Initially subscribe terminal at offset 0
		await (
			host as unknown as {
				createTerminal: (input: Record<string, unknown>) => Promise<unknown>;
			}
		).createTerminal({
			id: "pane-term-1",
			tabId: "tab_terminal",
			workspaceId: "ws_1",
			name: "Terminal",
			cols: 80,
			rows: 24,
		});

		expect(client1.subscribeTerminal).toHaveBeenCalledWith("term-1", 0);

		// Simulate receiving output bytes 0..100
		outputCallback1?.({ offset: 0, data: "x".repeat(100) });

		// Now simulate client replacement (reconnect)
		const unsubscribe2 = vi.fn();
		const client2 = {
			isConnected: true,
			document: doc,
			onTerminalOutput: vi.fn(() => unsubscribe2),
			subscribeTerminal: vi.fn().mockResolvedValue({ status: "running" }),
		};

		await host.replaceClient(client2 as never);

		// Previous listener should have been unsubscribed
		expect(unsubscribe1).toHaveBeenCalled();

		// New client should have subscribed with retained offset 100!
		expect(client2.subscribeTerminal).toHaveBeenCalledWith("term-1", 100);
	});
	it("collects replay chunks with offsets and deduplicates overlap", async () => {
		const { host } = createHost();
		const doc = createMockDocument();
		const listeners = new Set<(frame: { offset: number; data: string }) => void>();
		const client = {
			isConnected: true,
			document: doc,
			onTerminalOutput: vi.fn((_id: string, listener: (frame: { offset: number; data: string }) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}),
			subscribeTerminal: vi.fn(async () => {
				for (const listener of listeners) {
					listener({ offset: 100, data: "abc" });
					listener({ offset: 102, data: "cde" });
				}
				return {
					status: "running" as const,
					cwd: "/test",
					firstAvailableOffset: 100,
					totalBytesProduced: 105,
				};
			}),
		};
		host.setClient(client as never);
		host.syncWithDocument(doc);

		await expect(host.attachTerminal("pane-term-1", 0)).resolves.toEqual({
			id: "pane-term-1",
			status: "running",
			cwd: "/test",
			chunks: [
				{ offset: 100, data: "abc" },
				{ offset: 103, data: "de" },
			],
			firstAvailableOffset: 100,
			totalBytesProduced: 105,
		});
	});
});

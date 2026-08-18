import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { projectWorkspaceTabs } from "../src/renderer/workspace-projection";
import { isLocalUrl } from "../src/renderer/workspace-types";

describe("Workspace projection of durable terminal/browser status", () => {
	function createDocWithFailedEntities(): WorkspaceDocumentV1 {
		return {
			version: 1,
			revision: 1,
			activeWorkspaceId: "ws-1",
			workspaces: [{ id: "ws-1", name: "Main Workspace", locationId: "loc-1", generation: 1 }],
			locations: [{ id: "loc-1", kind: "local", path: "/test", lifecycle: { generation: 1 } }],
			tabs: [
				{
					id: "tab-term",
					workspaceId: "ws-1",
					locationId: "loc-1",
					generation: 1,
					name: "Terminal Tab",
					paneKind: "terminal",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-term-failed"],
					activePaneId: "pane-term-failed",
				},
				{
					id: "tab-browser",
					workspaceId: "ws-1",
					locationId: "loc-1",
					generation: 1,
					name: "Browser Tab",
					paneKind: "browser",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-browser-failed"],
					activePaneId: "pane-browser-failed",
				},
			],
			panes: [
				{ id: "pane-term-failed", tabId: "tab-term", generation: 1, kind: "terminal", entityId: "term-failed" },
				{
					id: "pane-browser-failed",
					tabId: "tab-browser",
					generation: 1,
					kind: "browser",
					entityId: "browser-failed",
				},
			],
			terminals: [
				{
					id: "term-failed",
					locationId: "loc-1",
					paneId: "pane-term-failed",
					generation: 1,
					label: "Terminal",
					status: "failed",
					error: "Failed to spawn shell /bin/nonexistent",
				},
			],
			browsers: [
				{
					id: "browser-failed",
					locationId: "loc-1",
					paneId: "pane-browser-failed",
					generation: 1,
					url: "https://omp.sh",
					status: "failed",
					error: "ERR_CONNECTION_REFUSED",
				},
			],
			previews: [],
			agents: [],
			sessions: [],
			agentProfiles: [],
			capabilities: [],
			sessionEvents: [],
			deliveryReceipts: [],
			services: [],
			worktrees: [],
			elementEdits: [],
			notifications: [],
			pendingCleanup: [],
			createdAt: 0,
			updatedAt: 0,
		};
	}

	it("projects terminal failed status directly to pane error with exact error message", () => {
		const doc = createDocWithFailedEntities();
		const projected = projectWorkspaceTabs(doc, "ws-1");

		const termTab = projected.tabs.find(t => t.id === "tab-term");
		expect(termTab).toBeDefined();
		const termPane = termTab?.panes[0];
		expect(termPane?.status).toBe("error");
		expect(termPane?.error).toBe("Failed to spawn shell /bin/nonexistent");

		const browserTab = projected.tabs.find(t => t.id === "tab-browser");
		expect(browserTab).toBeDefined();
		const browserPane = browserTab?.panes[0];
		expect(browserPane?.status).toBe("error");
		expect(browserPane?.error).toBe("ERR_CONNECTION_REFUSED");
	});
});

describe("isLocalUrl local hostname and subdomain detector", () => {
	it("identifies localhost and loopback addresses", () => {
		expect(isLocalUrl("http://localhost:5173")).toBe(true);
		expect(isLocalUrl("http://localhost:3000/app")).toBe(true);
		expect(isLocalUrl("http://127.0.0.1:8080")).toBe(true);
		expect(isLocalUrl("http://0.0.0.0:4000")).toBe(true);
		expect(isLocalUrl("http://[::1]:3000")).toBe(true);
	});

	it("identifies local subdomains and TLDs", () => {
		expect(isLocalUrl("http://app.local:3000")).toBe(true);
		expect(isLocalUrl("http://dashboard.local")).toBe(true);
		expect(isLocalUrl("http://local.dev:8000")).toBe(true);
		expect(isLocalUrl("http://local.myapp.com:3000")).toBe(true);
		expect(isLocalUrl("http://api.local.test")).toBe(true);
		expect(isLocalUrl("http://tenant.localhost:5173")).toBe(true);
		expect(isLocalUrl("http://service.internal")).toBe(true);
		expect(isLocalUrl("http://staging.test")).toBe(true);
		expect(isLocalUrl("http://example.local")).toBe(true);
	});

	it("rejects public and non-local URLs", () => {
		expect(isLocalUrl("https://omp.sh")).toBe(false);
		expect(isLocalUrl("https://github.com/can1357/oh-my-pi")).toBe(false);
		expect(isLocalUrl("https://localhost.com")).toBe(false);
		expect(isLocalUrl("https://notlocal.org")).toBe(false);
		expect(isLocalUrl("invalid-url")).toBe(false);
		expect(isLocalUrl(undefined)).toBe(false);
	});
});

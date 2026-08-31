import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsInventory,
	releaseTab,
	subscribeBrowserTabInventory,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

function kind(name: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-rpc-inventory-${name}.sock`, surface: `surface-${name}` };
}

async function drainTabs(): Promise<void> {
	for (const tab of getTabsInventory()) await releaseTab(tab.name, { kill: false }).catch(() => undefined);
}

describe("RPC browser inventory", () => {
	afterEach(async () => {
		await drainTabs();
		vi.restoreAllMocks();
	});

	it("publishes initial and coalesced updates and closes only the named tab", async () => {
		await drainTabs();
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let opened = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: `surface-${++opened}`, url: "about:blank" };
				if (method === "browser.url.get") return { url: "about:blank" };
				return {};
			},
		);
		const snapshots: string[][] = [];
		const unsubscribe = subscribeBrowserTabInventory(inventory => {
			snapshots.push(inventory.map(tab => tab.name));
		});
		try {
			expect(snapshots).toEqual([[]]);
			const browserA = await acquireBrowser(kind("a"), { cwd: process.cwd() });
			const browserB = await acquireBrowser(kind("b"), { cwd: process.cwd() });
			await acquireTab("rpc-inventory-a", browserA, {
				timeoutMs: 1_000,
				ownerSessionId: "session-a",
				ownerAgentLabel: "agent-a",
			});
			await acquireTab("rpc-inventory-b", browserB, {
				timeoutMs: 1_000,
				ownerSessionId: "session-b",
				ownerAgentLabel: "agent-b",
			});
			await Bun.sleep(0);
			expect(snapshots.at(-1)).toEqual(["rpc-inventory-a", "rpc-inventory-b"]);
			expect(getTabsInventory()).toEqual([
				expect.objectContaining({
					name: "rpc-inventory-a",
					owners: ["agent-a"],
					activeRunCount: 0,
					queuedRunCount: 0,
				}),
				expect.objectContaining({
					name: "rpc-inventory-b",
					owners: ["agent-b"],
					activeRunCount: 0,
					queuedRunCount: 0,
				}),
			]);

			await releaseTab("rpc-inventory-a", { kill: false });
			await Bun.sleep(0);
			expect(snapshots.at(-1)).toEqual(["rpc-inventory-b"]);
			expect(getTabsInventory().map(tab => tab.name)).toEqual(["rpc-inventory-b"]);
		} finally {
			unsubscribe();
		}
	});
});

/**
 * Regression tests for issue #3963: the browser tool leaks Chromium/Puppeteer
 * resources at two termination boundaries.
 *
 * 1. An aborted `open` observes abort only in its `untilAborted` wrapper — the
 *    inner launch resolves in the background and `acquireBrowser` publishes
 *    the handle unconditionally, leaving a live browser at refCount:0 with no
 *    tab holding it. `releaseAllTabs` walks tabs, not browsers, so nothing
 *    ever reaps it.
 * 2. Browser + tab state lives in module-global maps. `AgentSession.dispose()`
 *    walks jobs, eval kernels, provider sessions, and MCP, but has no browser
 *    teardown hook, so any tabs the session opened outlive the session.
 *
 * The tests below cover both by driving `acquireBrowser` / `acquireTab` /
 * `releaseTabsForOwner` directly, with `CmuxSocketClient` prototype methods
 * spied so no real cmux socket / puppeteer process is needed.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTab,
	getTabsInventory,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";

function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/omp-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

function makeSession(sessionId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => sessionId,
		getAgentId: () => sessionId,
		settings: { get: () => undefined },
	} as unknown as ToolSession;
}

async function drainAllTabs(): Promise<void> {
	for (const { name } of getTabsInventory()) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

function stubCmuxReady(): void {
	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
	spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (method: string): Promise<Record<string, unknown>> => {
			switch (method) {
				case "browser.open_split":
					return { surface_id: "surface-transient", url: "about:blank" };
				case "browser.url.get":
					return { url: "about:blank" };
				case "browser.snapshot":
					return { page: { html: "" } };
				case "browser.eval":
					return { value: "" };
				default:
					return {};
			}
		},
	);
}

describe("browser lifecycle — aborted open must not leak a browser handle", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("disposes a cmux browser whose launch resolved after the caller aborted", async () => {
		const gate = Promise.withResolvers<void>();
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await gate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		try {
			const kind = makeKind("abort-orphan");
			const controller = new AbortController();
			const pending = acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal });
			// The reporter's scenario: abort fires while the launch is in flight.
			controller.abort();
			// The launch resolves *after* the abort has been observed by the caller.
			gate.resolve();

			await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			// The freshly-launched browser MUST be torn down before publication so it
			// does not sit at refCount:0 in the global map, leaking a live cmux socket
			// (or, for headless, a live Chromium process) that no `releaseAllTabs`
			// / `dropHeadlessTabs` walk would ever reap.
			expect(closeSpy).toHaveBeenCalledTimes(1);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("does not launch at all when the signal was already aborted", async () => {
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		try {
			const kind = makeKind("preaborted");
			const controller = new AbortController();
			controller.abort();
			await expect(acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			// Not called: pre-abort short-circuit fires before openBrowserHandle.
			expect(connectSpy).not.toHaveBeenCalled();
			expect(closeSpy).not.toHaveBeenCalled();
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — session-scoped teardown reaps owned tabs", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("releaseTabsForOwner tears down only the released session's tabs", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let openCount = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					openCount++;
					return { surface_id: `surface-${openCount}`, url: "about:blank" };
				}
				return {};
			},
		);

		const kindA = makeKind("owner-a");
		const kindB = makeKind("owner-b");
		const browserA = await acquireBrowser(kindA, { cwd: "/tmp" });
		const browserB = await acquireBrowser(kindB, { cwd: "/tmp" });

		await acquireTab("tab-a", browserA, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		await acquireTab("tab-b", browserB, { timeoutMs: 1_000, ownerSessionId: "session-B" });
		expect(
			getTabsInventory()
				.map(tab => tab.name)
				.sort(),
		).toEqual(["tab-a", "tab-b"]);

		const released = await releaseTabsForOwner("session-A", { kill: false });
		expect(released).toBe(1);
		expect(getTabsInventory().map(tab => tab.name)).toEqual(["tab-b"]);

		await releaseTabsForOwner("session-B", { kill: false });
		expect(getTabsInventory()).toHaveLength(0);
	});

	it("reusing an existing tab retains each session's lease", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-reuse", url: "about:blank" };
				return {};
			},
		);

		const browser = await acquireBrowser(makeKind("reuse"), { cwd: "/tmp" });
		const first = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const second = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" });
		expect(first.tab).toBe(second.tab);
		expect(second.created).toBe(false);

		const releasedB = await releaseTabsForOwner("session-B", { kill: false });
		expect(releasedB).toBe(0);
		expect(getTab("reuse-tab")).toBe(first.tab);

		const releasedA = await releaseTabsForOwner("session-A", { kill: false });
		expect(releasedA).toBe(1);
		expect(getTab("reuse-tab")).toBeUndefined();
	});
});

async function waitForTabCounts(name: string, activeRunCount: number, queuedRunCount: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const tab = getTabsInventory().find(item => item.name === name);
		if (tab?.activeRunCount === activeRunCount && tab.queuedRunCount === queuedRunCount) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${name} to reach active=${activeRunCount}, queued=${queuedRunCount}`);
}

async function waitForTabGone(name: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (getTab(name) === undefined) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting for ${name} to be released`);
}

describe("browser lifecycle — transient users and shared FIFO tabs", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("disposes a transient user's active and queued runs with the tab", async () => {
		stubCmuxReady();
		const browser = await acquireBrowser(makeKind("transient-user"), { cwd: "/tmp" });
		await acquireTab("transient-tab", browser, { timeoutMs: 1_000 });
		const session = makeSession("transient-session");
		const active = runInTab("transient-tab", {
			code: "await wait(60_000); return 'active';",
			timeoutMs: 1_000,
			session,
		});
		await waitForTabCounts("transient-tab", 1, 0);
		const queued = runInTab("transient-tab", {
			code: "return 'queued';",
			timeoutMs: 1_000,
			session,
		});
		await waitForTabCounts("transient-tab", 1, 1);

		expect(await releaseTabsForOwner("transient-session", { kill: false })).toBe(0);
		await expect(active).rejects.toBeInstanceOf(ToolAbortError);
		await expect(queued).rejects.toBeInstanceOf(ToolAbortError);
		await waitForTabGone("transient-tab");
	});

	it("cancels a transient queued user without dropping a retained shared owner", async () => {
		stubCmuxReady();
		const browser = await acquireBrowser(makeKind("shared-transient"), { cwd: "/tmp" });
		await acquireTab("shared-tab", browser, { timeoutMs: 1_000, ownerSessionId: "retained-owner" });
		const active = runInTab("shared-tab", {
			code: "await wait(60_000); return 'active';",
			timeoutMs: 1_000,
			session: makeSession("retained-owner"),
		});
		await waitForTabCounts("shared-tab", 1, 0);
		const queued = runInTab("shared-tab", {
			code: "return 'queued';",
			timeoutMs: 1_000,
			session: makeSession("transient-owner"),
		});
		await waitForTabCounts("shared-tab", 1, 1);

		expect(await releaseTabsForOwner("transient-owner", { kill: false })).toBe(0);
		await expect(queued).rejects.toBeInstanceOf(ToolAbortError);
		expect(getTab("shared-tab")).toBeDefined();
		expect(getTabsInventory().find(item => item.name === "shared-tab")).toMatchObject({
			activeRunCount: 1,
			queuedRunCount: 0,
		});

		expect(await releaseTabsForOwner("retained-owner", { kill: false })).toBe(0);
		await expect(active).rejects.toBeInstanceOf(ToolAbortError);
		await waitForTabGone("shared-tab");
	});

	it("preserves FIFO completion order for transient runs on one tab", async () => {
		stubCmuxReady();
		const browser = await acquireBrowser(makeKind("transient-fifo"), { cwd: "/tmp" });
		await acquireTab("fifo-tab", browser, { timeoutMs: 1_000 });
		const order: string[] = [];
		const first = runInTab("fifo-tab", {
			code: "await wait(25); return 'first';",
			timeoutMs: 1_000,
			session: makeSession("fifo-first"),
		});
		await waitForTabCounts("fifo-tab", 1, 0);
		const second = runInTab("fifo-tab", {
			code: "return 'second';",
			timeoutMs: 1_000,
			session: makeSession("fifo-second"),
		});
		await waitForTabCounts("fifo-tab", 1, 1);
		const firstDone = first.then(() => order.push("first"));
		const secondDone = second.then(() => order.push("second"));
		await Promise.all([firstDone, secondDone]);
		expect(order).toEqual(["first", "second"]);
	});

	it("holds a provisional owner while reused-tab navigation is in flight", async () => {
		const navigationStarted = Promise.withResolvers<void>();
		const navigationGate = Promise.withResolvers<Record<string, unknown>>();
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				switch (method) {
					case "browser.open_split":
						return { surface_id: "surface-reuse-race", url: "about:blank" };
					case "browser.url.get":
						return { url: "about:blank" };
					case "browser.navigate":
						navigationStarted.resolve();
						return navigationGate.promise;
					case "browser.snapshot":
						return { page: { html: "" } };
					case "browser.eval":
						return { value: "" };
					default:
						return {};
				}
			},
		);

		const kind = makeKind("reuse-race");
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });
		await acquireTab("reuse-race", browser, {
			timeoutMs: 1_000,
			ownerSessionId: "owner-A",
			ownerAgentLabel: "agent-a",
		});
		const opening = acquireTab("reuse-race", browser, {
			timeoutMs: 1_000,
			url: "https://example.test",
			ownerSessionId: "owner-B",
			ownerAgentLabel: "agent-b",
		});
		await navigationStarted.promise;
		expect(await releaseTabsForOwner("owner-A", { kill: false })).toBe(0);
		expect(getTabsInventory().find(tab => tab.name === "reuse-race")?.owners).toEqual(["agent-b"]);

		navigationGate.resolve({});
		const result = await opening;
		expect(result.created).toBe(false);
		expect(result.tab.state).toBe("alive");
		expect(await releaseTabsForOwner("owner-B", { kill: false })).toBe(1);
	});

	it("settles a pre-aborted run queued behind an active run", async () => {
		stubCmuxReady();
		const browser = await acquireBrowser(makeKind("pre-aborted-active"), { cwd: "/tmp" });
		await acquireTab("pre-aborted-tab", browser, { timeoutMs: 1_000 });
		const active = runInTab("pre-aborted-tab", {
			code: "await wait(60_000); return 'active';",
			timeoutMs: 1_000,
			session: makeSession("active-run"),
		});
		await waitForTabCounts("pre-aborted-tab", 1, 0);

		const controller = new AbortController();
		controller.abort();
		const queued = runInTab("pre-aborted-tab", {
			code: "return 'queued';",
			timeoutMs: 1_000,
			session: makeSession("queued-run"),
			signal: controller.signal,
		});
		const outcome = await Promise.race([
			queued.then(
				() => "resolved",
				error => error,
			),
			Bun.sleep(100).then(() => new Error("pre-aborted queued run did not settle")),
		]);
		expect(outcome).toBeInstanceOf(ToolAbortError);
		expect(getTabsInventory().find(tab => tab.name === "pre-aborted-tab")).toMatchObject({
			activeRunCount: 1,
			queuedRunCount: 0,
		});

		expect(await releaseTabsForOwner("active-run", { kill: false })).toBe(0);
		await expect(active).rejects.toBeInstanceOf(ToolAbortError);
		await waitForTabGone("pre-aborted-tab");
	});

	it("does not execute queued code after its deadline expires before dequeue", async () => {
		stubCmuxReady();
		const browser = await acquireBrowser(makeKind("expired-queued"), { cwd: "/tmp" });
		await acquireTab("expired-queued-tab", browser, { timeoutMs: 1_000 });
		const baseNow = Date.now();
		const nowSpy = spyOn(Date, "now").mockReturnValue(baseNow);
		try {
			const active = runInTab("expired-queued-tab", {
				code: "await wait(25); return 'active';",
				timeoutMs: 1_000,
				session: makeSession("expired-active"),
			});
			await waitForTabCounts("expired-queued-tab", 1, 0);
			const queued = runInTab("expired-queued-tab", {
				code: "throw new Error('expired queued code evaluated');",
				timeoutMs: 1_000,
				session: makeSession("expired-queued"),
			});
			void queued.catch(() => undefined);
			await waitForTabCounts("expired-queued-tab", 1, 1);

			nowSpy.mockReturnValue(baseNow + 2_000);
			await expect(active).resolves.toMatchObject({ returnValue: "active" });
			await expect(queued).rejects.toThrow("Browser code execution timed out after 1000ms");
		} finally {
			nowSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — close deadlines", () => {
	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await drainAllTabs();
	});

	it("rejects a stuck close with the backend, tab, and pending resource", async () => {
		vi.useFakeTimers();
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const stuck = Promise.withResolvers<Record<string, unknown>>();
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async method => {
			if (method === "browser.open_split") return { surface_id: "probe-surface", url: "about:blank" };
			if (method === "surface.close") return await stuck.promise;
			return {};
		});

		const kind: CmuxKind = { kind: "cmux", socketPath: "/tmp/omp-close-deadline.sock" };
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });
		await acquireTab("probe", browser, { timeoutMs: 1_000 });

		const close = releaseTab("probe", { timeoutMs: 100 });
		vi.advanceTimersByTime(100);

		await expect(close).rejects.toThrow(
			'Timed out after 100ms closing cmux browser tab "probe"; pending resource: cmux surface "probe-surface" (surface.close)',
		);
		expect(getTab("probe")).toBeUndefined();
	});
});

import * as path from "node:path";
import { isCompiledBinary, logger, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { Browser } from "playwright-core";
import { ToolAbortError } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { findFreeCdpPort, findReusableCdp, gracefulKillTreeOnce, resolveSpawnArgs, waitForCdp } from "./attach";
import type { CmuxKind } from "./cmux/rpc";
import { CmuxSocketClient } from "./cmux/socket-client";
import {
	BROWSER_PROTOCOL_TIMEOUT_MS,
	DEFAULT_VIEWPORT,
	launchHeadlessBrowser,
	loadPlaywright,
	removeUserDataDir,
} from "./launch";
import { protectDialogOwnership } from "./dialogs";
import { reapOrphanSharedTargets } from "./orphan-registry";
import { ensureRelayDaemon, isLoopbackRelayUrl } from "./relay/daemon";
import type { RelayKind } from "./relay/kind";
import { waitForRelayExtension } from "./relay/probe";
import { ensureSharedBrowser } from "./shared-daemon";

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type CdpBrowserKind =
	| {
			kind: "headless";
			headless: boolean;
			/** Process-local launch flag; shared browsers use the tab-scoped CDP override instead. */
			ignoreHttpsErrors?: boolean;
			/** Process-local file access launch flag, unsupported by an already-running shared browser. */
			allowFileAccess?: boolean;
	  }
	| { kind: "spawned"; path: string; args?: string[] }
	| { kind: "connected"; cdpUrl: string }
	| RelayKind;
export type BrowserKind = CdpBrowserKind | CmuxKind;
export type BrowserKindTag = BrowserKind["kind"];

/**
 * Upper bound for closing the Playwright CDP connection to an OMP-owned
 * headless browser before terminating the owned process tree.
 */
const HEADLESS_CLOSE_TIMEOUT_MS = 5_000;

interface BrowserHandleCommon {
	key: string;
	kind: BrowserKind;
	refCount: number;
}

/** Playwright CDP connection plus its process/profile ownership record, when locally launched. */
export interface CdpBrowserHandle extends BrowserHandleCommon {
	kind: CdpBrowserKind;
	browser: Browser;
	cdpEndpoint: string;
	pid?: number;
	subprocess?: Subprocess;
	ownedProcess?: Subprocess;
	/** OMP-owned temporary profile, removed only after the matching owned process is stopped. */
	userDataDir?: string;
	ownsUserDataDir?: boolean;
	/** Broker owner for shared headless Chromium; this process must never terminate it. */
	sharedDaemon?: { name: string; projectDir: string };
}

export interface CmuxBrowserHandle extends BrowserHandleCommon {
	kind: CmuxKind;
	client: CmuxSocketClient;
	surface?: string;
}

export type BrowserHandle = CdpBrowserHandle | CmuxBrowserHandle;

export interface ReleaseBrowserOptions {
	kill: boolean;
	timeoutMs?: number;
	resource?: string;
}

const browsers = new Map<string, BrowserHandle>();
const pendingOpens = new Map<string, Promise<BrowserHandle>>();

export function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}:${kind.ignoreHttpsErrors ? "tls" : ""}:${kind.allowFileAccess ? "file" : ""}`;
		case "spawned":
			return `spawned:${JSON.stringify([kind.path, kind.args ?? []])}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
		case "relay":
			return `relay:${kind.cdpUrl}`;
		case "cmux":
			return `cmux:${kind.socketPath}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	signal?: AbortSignal;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "spawned") kind = { ...kind, args: resolveSpawnArgs(kind.path, kind.args, opts.cwd) };
	const key = browserKey(kind);
	for (;;) {
		const existing = browsers.get(key);
		if (existing) {
			if ("client" in existing || existing.browser.isConnected()) return existing;
			browsers.delete(key);
			await disposeBrowserHandle(existing, {
				kill: existing.ownedProcess !== undefined,
			});
			continue;
		}
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		const pending = pendingOpens.get(key);
		if (pending) {
			await pending.catch(() => undefined);
			continue;
		}
		const open = openBrowserHandle(kind, opts).finally(() => pendingOpens.delete(key));
		pendingOpens.set(key, open);
		const handle = await open;
		if (opts.signal?.aborted) {
			await disposeBrowserHandle(handle, { kill: kind.kind === "spawned" }).catch(error => {
				logger.debug("Failed to dispose orphan browser after abort", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			throw new ToolAbortError("Browser open aborted");
		}
		if ("browser" in handle) protectDialogOwnership(handle.browser);
		browsers.set(key, handle);
		return handle;
	}
}

export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
	const cdpEndpoint = rawCdpUrl.replace(/\/+$/, "");
	if (/^wss?:\/\//i.test(cdpEndpoint)) {
		throw new ToolError(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
	}
	return cdpEndpoint;
}

async function connectBrowser(cdpEndpoint: string): Promise<Browser> {
	const playwright = await loadPlaywright();
	return await playwright.chromium.connectOverCDP(cdpEndpoint, {
		noDefaults: true,
		timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
	});
}
async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "cmux") {
		const client = new CmuxSocketClient({ socketPath: kind.socketPath, password: kind.password });
		await client.connect();
		return { key: browserKey(kind), kind, client, surface: kind.surface, refCount: 0 };
	}
	if (kind.kind === "headless") {
		const { browser, cdpEndpoint, subprocess, userDataDir } = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
			signal: opts.signal,
			ignoreHttpsErrors: kind.ignoreHttpsErrors,
			allowFileAccess: kind.allowFileAccess,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpEndpoint,
			pid: subprocess.pid,
			subprocess,
			ownedProcess: subprocess,
			userDataDir,
			ownsUserDataDir: userDataDir !== undefined,
			refCount: 0,
		};
	}
	if (kind.kind === "connected") {
		const cdpEndpoint = normalizeConnectedCdpUrl(kind.cdpUrl);
		await waitForCdp(cdpEndpoint, 5_000, opts.signal);
		return {
			key: browserKey(kind),
			kind,
			browser: await connectBrowser(cdpEndpoint),
			cdpEndpoint,
			refCount: 0,
		};
	}
	if (kind.kind === "relay") {
		const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
		// Loopback relays are owned by a machine-global broker and auto-started
		// on demand (the extension dials in on its own). Hosts without a CLI
		// worker entry (bun test, SDK embedding) never spawn brokers. Remote
		// relay URLs must already be serving.
		if (isLoopbackRelayUrl(cdpUrl) && (isCompiledBinary() || workerHostEntry() !== null)) {
			await ensureRelayDaemon({ cdpUrl, signal: opts.signal });
		}
		// The relay answers /json/version with 503 until its extension dials in;
		// the wait fails fast when nothing serves the port or the server has
		// already outlived the window an installed extension needs to connect.
		const outcome = await waitForRelayExtension(cdpUrl, opts.signal);
		if (outcome === "unreachable") {
			throw new ToolError(
				`omp browser relay is not reachable at ${cdpUrl}. Start it with \`omp browser-relay\` (or check the endpoint), and make sure the OMP Browser Relay extension is loaded in Chrome.`,
			);
		}
		if (outcome === "no-extension") {
			throw new ToolError(
				`omp browser relay is serving at ${cdpUrl} but its extension never connected. Install it with \`omp browser-relay install\` and check the toolbar badge shows "on".`,
			);
		}
		return {
			key: browserKey(kind),
			kind,
			browser: await connectBrowser(cdpUrl),
			cdpEndpoint: cdpUrl,
			refCount: 0,
		};
	}

	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const appArgs = kind.args ?? [];
	const reused = await findReusableCdp(exe, { signal: opts.signal, appArgs });
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const port = await findFreeCdpPort();
		const launchArgs = [...appArgs, `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			cwd: opts.cwd,
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${formatError(err)}`);
		}
	}

	let browser: Browser;
	try {
		browser = await connectBrowser(cdpUrl);
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but Playwright connectOverCDP failed: ${formatError(err)}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpEndpoint: cdpUrl,
		pid,
		subprocess,
		ownedProcess: subprocess,
		refCount: 0,
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount !== 0) return;
	if (browsers.get(handle.key) === handle) browsers.delete(handle.key);
	await disposeBrowserHandle(handle, opts);
}

async function terminateOwnedProcess(handle: CdpBrowserHandle, timeoutMs: number): Promise<void> {
	if (!handle.ownedProcess) return;
	const pid = handle.ownedProcess.pid;
	try {
		await withTimeout(gracefulKillTreeOnce(pid), timeoutMs, `Timed out stopping owned browser process ${pid}`);
	} catch (error) {
		logger.debug("Failed to stop owned browser process", {
			pid,
			error: error instanceof Error ? error.message : String(error),
		});
		await withTimeout(
			gracefulKillTreeOnce(pid, 0),
			1_000,
			`Timed out force-stopping owned browser process ${pid}`,
		).catch(() => undefined);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: ReleaseBrowserOptions): Promise<void> {
	if ("client" in handle) {
		handle.client.close();
		return;
	}
	if (handle.kind.kind === "headless") {
		if (handle.sharedDaemon) {
			// Playwright close drops this CDP connection only; the shared daemon
			// remains owned by its broker and other sessions.
			if (handle.browser.isConnected()) {
				try {
					await withTimeout(
						handle.browser.close(),
						opts.timeoutMs ?? HEADLESS_CLOSE_TIMEOUT_MS,
						"Timed out disconnecting from shared browser",
					);
				} catch (err) {
					logger.debug("Failed to disconnect from shared browser", { error: formatError(err) });
				}
			}
			return;
		}
		if (handle.browser.isConnected()) {
			try {
				await withTimeout(
					handle.browser.close(),
					HEADLESS_CLOSE_TIMEOUT_MS,
					"Timed out closing headless browser connection",
				);
			} catch (err) {
				logger.debug("Failed to close headless browser connection", { error: formatError(err) });
			}
		}
		// This launch owns the process tree, so close the Playwright connection
		// first, then stop Chromium before removing its temporary profile.
		await terminateOwnedProcess(handle, opts.timeoutMs ?? HEADLESS_CLOSE_TIMEOUT_MS);
		if (handle.userDataDir) await removeUserDataDir(handle.userDataDir);
		return;
	}
	// Connected and relay browsers belong to the user: drop our CDP link, never kill.
	if (handle.kind.kind === "connected" || handle.kind.kind === "relay") {
		if (handle.browser.isConnected()) {
			try {
				await withTimeout(
					handle.browser.close(),
					opts.timeoutMs ?? HEADLESS_CLOSE_TIMEOUT_MS,
					"Timed out disconnecting from remote browser",
				);
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: formatError(err) });
			}
		}
		return;
	}
	if (handle.browser.isConnected()) {
		try {
			await withTimeout(
				handle.browser.close(),
				opts.timeoutMs ?? HEADLESS_CLOSE_TIMEOUT_MS,
				"Timed out disconnecting from spawned browser",
			);
		} catch (err) {
			logger.debug("Failed to disconnect from spawned browser", { error: formatError(err) });
		}
	}
	// A discovered CDP PID is borrowed, not ours to kill on close or abort.
	if (opts.kill && handle.subprocess && handle.subprocess.exitCode === null) {
		await gracefulKillTreeOnce(handle.subprocess.pid);
	}
}

async function openSharedHeadlessHandle(
	kind: Extract<CdpBrowserKind, { kind: "headless" }>,
	opts: AcquireBrowserOptions,
): Promise<CdpBrowserHandle> {
	if (kind.allowFileAccess) {
		throw new ToolError(
			"browser.open({ allow_file_access:true }) requires a process-local Chromium launch and cannot be applied to the project-shared browser. Use app.path to launch a dedicated browser.",
		);
	}
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	try {
		const shared = await ensureSharedBrowser({
			projectDir: opts.cwd,
			headless: kind.headless,
			viewport: vp,
			signal: opts.signal,
		});
		if (!shared) {
			throw new ToolError(
				"Shared browser daemon unavailable (broker start or Chromium launch failed); check `omp ps` for omp.browser.* daemons and ~/.omp/logs for details",
			);
		}
		const endpoint = new URL(shared.wsEndpoint);
		endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
		endpoint.pathname = "";
		endpoint.search = "";
		endpoint.hash = "";
		const cdpEndpoint = endpoint.toString().replace(/\/$/, "");
		const playwright = await loadPlaywright();
		const browser = await playwright.chromium.connectOverCDP(cdpEndpoint, {
			noDefaults: true,
			timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		// Attaching to the shared daemon is the natural point to sweep targets
		// left behind by omp processes that died without teardown — bounds
		// accumulation without a background timer. Best-effort and detached so a
		// slow reap never delays the open (issue #10022).
		void reapOrphanSharedTargets(browser, { projectDir: shared.projectDir, daemonName: shared.daemonName });
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpEndpoint,
			sharedDaemon: { name: shared.daemonName, projectDir: shared.projectDir },
			refCount: 0,
		};
	} catch (error) {
		if (error instanceof ToolAbortError || error instanceof ToolError) throw error;
		if (opts.signal?.aborted) throw new ToolAbortError("Browser open aborted");
		throw new ToolError(`Shared browser attach failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

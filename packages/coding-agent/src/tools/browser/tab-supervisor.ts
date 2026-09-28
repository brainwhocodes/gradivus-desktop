import { getProjectDir, logger, postmortem, Snowflake, withTimeout, workerHostEntry } from "@oh-my-pi/pi-utils";
import type { CDPSession, Page } from "playwright-core";
import { callSessionTool } from "../../eval/js/tool-bridge";
import { webpExclusionForModel } from "@oh-my-pi/pi-tui/chat/image-loading";
import type { ToolSession } from "../index";
import { expandPath } from "../path-utils";
import { ToolAbortError } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	gracefulKillTreeOnce,
	pickElectronTarget,
	shouldPreserveConnectedBrowserFocus,
	targetIdForPage,
} from "./attach";
import { CmuxTab, runCmuxCode } from "./cmux/cmux-tab";
import { mapWaitUntil } from "./cmux/rpc";
import { assertNoBrowserTabRecursion, resolveBrowserSessionKey } from "./ownership";
import { DEFAULT_VIEWPORT, getPageCDPSession } from "./launch";
import { closeCdpTarget, forgetSharedTarget, recordSharedTarget, type SharedTargetScope } from "./orphan-registry";
import {
	type BrowserHandle,
	type BrowserKindTag,
	type CdpBrowserHandle,
	type CmuxBrowserHandle,
	holdBrowser,
	releaseBrowser,
} from "./registry";
import type {
	ReadyInfo,
	RunErrorPayload,
	RunResultOk,
	SessionSnapshot,
	Transferable,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "./tab-protocol";

import { cfgBrowserScreenshotDir } from "./settings";

// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so compiled/npm builds only need one JavaScript entry.

interface WorkerHandle {
	send(msg: WorkerInbound, transferList?: Transferable[]): void;
	onMessage(handler: (msg: WorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
	readonly mode: "worker";
}

export type DialogPolicy = "accept" | "dismiss";

interface QueuedRun {
	id: string;
	pending: PendingRun;
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession };
	snapshot: SessionSnapshot;
	deadline: number;
	promise: Promise<RunResultOk>;
	leaseToken?: string;
	timer?: NodeJS.Timeout;
	abort?: () => void;
	started: boolean;
}

export interface PendingRun {
	resolve(result: RunResultOk): void;
	reject(error: unknown): void;
	session: ToolSession;
	sessionKey?: string;
	signal?: AbortSignal;
	toolCalls: Map<string, AbortController>;
	closeAc?: AbortController;
}

interface TabSessionBase<TBrowser extends BrowserHandle = BrowserHandle> {
	name: string;
	browser: TBrowser;
	kindTag: BrowserKindTag;
	targetId: string;
	state: "alive" | "dead";
	info: ReadyInfo;
	pending: Map<string, PendingRun>;
	queue: QueuedRun[];
	running: boolean;
	dialogPolicy?: DialogPolicy;
	retainedLeases: Map<string, string>;
	useTokens: Map<string, string | undefined>;
	cleanupRequested: boolean;
	/** Hostname patterns enforced by the worker across navigations and subresources. */
	allowedDomains?: string[];
	/**
	 * Session id of the caller that CREATED the tab. Preserved across reuse so
	 * that dispose of the creating session can reap browser resources without
	 * yanking the tab out from under a subagent that only reused it.
	 * Undefined when the acquirer did not identify itself.
	 */
	ownerSessionId?: string;
	/**
	 * Opt out of settle-freeze and idle-close reaping. Recorded on the tab
	 * when created (never on reuse), mirroring `ownerSessionId`: keeping a
	 * tab live across turns is the creator's explicit decision.
	 */
	persist?: boolean;
	/** Wall-clock (`Date.now()`) last use: create, reuse, or run start. Drives idle-close. */
	lastActivityAt: number;
	/**
	 * True after a successful settle-freeze (`Page.setWebLifecycleState`
	 * frozen). Cleared on unfreeze/create. Freeze pauses rAF/timers so an
	 * idle animated page stops burning CPU/GPU; the renderer, worker, and
	 * DOM state stay alive for millisecond resume.
	 */
	frozen: boolean;
}

export interface WorkerTabSession extends TabSessionBase<CdpBrowserHandle> {
	backend: "worker";
	worker: WorkerHandle;
	activateForScreenshot: boolean;
}

export interface CmuxTabSession extends TabSessionBase<CmuxBrowserHandle> {
	backend: "cmux";
	cmuxTab: CmuxTab;
	cmuxOwnsSurface: boolean;
	cmuxAttachedSurface?: string;
}

export type TabSession = WorkerTabSession | CmuxTabSession;

export interface BrowserTabInventory {
	name: string;
	state: TabSession["state"];
	browser: BrowserKindTag;
	url: string;
	title: string;
	owners: readonly string[];
	activeRunCount: number;
	queuedRunCount: number;
}

export interface AcquireTabOptions {
	url?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	target?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	dialogs?: DialogPolicy;
	/** Hostname patterns allowed for every tab request. */
	allowedDomains?: string[];
	/** Document-start JavaScript sources registered before initial navigation. */
	initScripts?: string[];
	/** Absolute directory used for downloads. */
	downloadsPath?: string;
	/** Explicit tab user agent override. */
	userAgent?: string;
	/** Ignore invalid HTTPS certificates for this page. */
	ignoreHttpsErrors?: boolean;
	cmuxSurface?: string;
	ownerSessionId?: string;
	ownerAgentLabel?: string;
	deadlineStartMs?: number;
	/**
	 * Keep the tab live across turn settle and idle close. Recorded on the
	 * tab when created (never on reuse) so a later caller cannot silently
	 * extend another session's tab lifetime.
	 */
	persist?: boolean;
}

export interface AcquireTabResult {
	tab: TabSession;
	created: boolean;
}

export interface RunInTabOptions {
	code: string;
	timeoutMs: number;
	signal?: AbortSignal;
	session: ToolSession;
}

export interface ReleaseTabOptions {
	kill?: boolean;
	timeoutMs?: number;
}

const tabs = new Map<string, TabSession>();
// Per-name acquisition chain: serializes concurrent `acquireTab` calls for the
// same tab name so the existence check and `tabs.set` (separated by several
// awaits) cannot interleave and leak a worker + browser refCount.
const acquireChains = new Map<string, Promise<void>>();
const GRACE_MS = 750;
const WORKER_INIT_TIMEOUT_MS = 15_000;
const SETUP_BUDGET_CAP_MS = 10_000;
const SETUP_BUDGET_FLOOR_MS = 2_000;
const READY_BUDGET_FLOOR_MS = 500;
// Names of tabs the supervisor force-killed (timeout past grace, failed recycle),
// mapped to the kill reason. Lets the next `run` on that name explain WHY the tab
// vanished instead of a bare "not alive". Cleared when the name is opened again.
const killedTabs = new Map<string, string>();
const DEFAULT_TAB_CLOSE_TIMEOUT_MS = 5_000;
const inventoryListeners = new Set<(inventory: readonly BrowserTabInventory[]) => void>();
let inventoryNotificationScheduled = false;

function emitBrowserTabInventory(): void {
	if (inventoryNotificationScheduled) return;
	inventoryNotificationScheduled = true;
	queueMicrotask(() => {
		inventoryNotificationScheduled = false;
		const inventory = getTabsInventory();
		for (const listener of inventoryListeners) listener(inventory);
	});
}

export function subscribeBrowserTabInventory(
	listener: (inventory: readonly BrowserTabInventory[]) => void,
): () => void {
	inventoryListeners.add(listener);
	listener(getTabsInventory());
	return () => inventoryListeners.delete(listener);
}
class RecoverableWorkerError extends ToolError {}

async function waitForTabCleanup<T>(
	tab: TabSession,
	timeoutMs: number,
	pendingResource: string,
	promise: Promise<T>,
): Promise<T> {
	const message = `Timed out after ${timeoutMs}ms closing ${tab.kindTag} browser tab ${JSON.stringify(tab.name)}; pending resource: ${pendingResource}`;
	try {
		return await withTimeout(promise, timeoutMs, message);
	} catch (error) {
		if (error instanceof Error && error.message === message) throw new ToolError(message);
		throw error;
	}
}

export function getTab(name: string): TabSession | undefined {
	return tabs.get(name);
}
export function getTabsInventory(limit = 100): readonly BrowserTabInventory[] {
	return [...tabs.values()]
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, Math.max(0, limit))
		.map(tab => ({
			name: tab.name,
			state: tab.state,
			browser: tab.kindTag,
			url: tab.info.url,
			title: tab.info.title ?? "",
			owners: [...tab.retainedLeases.values()].sort(),
			activeRunCount: tab.pending.size,
			queuedRunCount: tab.queue.length,
		}));
}

function retainLease(tab: TabSession, opts: AcquireTabOptions): void {
	if (!opts.ownerSessionId) return;
	tab.retainedLeases.set(opts.ownerSessionId, opts.ownerAgentLabel ?? "anonymous");
	tab.cleanupRequested = false;
	emitBrowserTabInventory();
}

function settleUseToken(tab: TabSession, token: string | undefined): void {
	if (token) tab.useTokens.delete(token);
}

function maybeReleaseUnownedTab(tab: TabSession, opts: ReleaseTabOptions = {}): Promise<boolean> {
	if (
		!tab.cleanupRequested ||
		tab.state !== "alive" ||
		tab.retainedLeases.size > 0 ||
		tab.pending.size > 0 ||
		tab.queue.length > 0 ||
		tab.useTokens.size > 0
	) {
		return Promise.resolve(false);
	}
	return releaseTab(tab.name, opts).then(
		() => true,
		error => {
			logger.warn("Failed to release unowned browser tab", {
				name: tab.name,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		},
	);
}
/** JSON-safe metadata for one managed browser tab. */
export interface ManagedTabInfo {
	/** Managed tab name. */
	name: string;
	/** Last reported page URL. */
	url: string;
	/** Last reported page title. */
	title: string;
	/** Browser target or cmux surface identifier. */
	targetId: string;
	/** Browser backend kind. */
	kind: BrowserKindTag;
	/** Whether settle and idle-close management are disabled. */
	persist: boolean;
}

/** List the currently alive tabs in the managed-tab registry. */
export function listTabs(): ManagedTabInfo[] {
	return [...tabs.values()]
		.filter(tab => tab.state === "alive")
		.map(tab => ({
			name: tab.name,
			url: tab.info.url,
			title: tab.info.title ?? "",
			targetId: tab.targetId,
			kind: tab.kindTag,
			persist: tab.persist ?? false,
		}));
}

function settleQueuedRun(tab: TabSession, node: QueuedRun, error: unknown): boolean {
	const index = tab.queue.indexOf(node);
	if (index < 0) return false;
	tab.queue.splice(index, 1);
	emitBrowserTabInventory();
	clearTimeout(node.timer);
	node.opts.signal?.removeEventListener("abort", node.abort as EventListener);
	settleUseToken(tab, node.leaseToken);
	node.pending.reject(error);
	return true;
}
function settleDequeuedRun(tab: TabSession, node: QueuedRun, error: unknown): void {
	clearTimeout(node.timer);
	node.opts.signal?.removeEventListener("abort", node.abort as EventListener);
	settleUseToken(tab, node.leaseToken);
	emitBrowserTabInventory();
	node.pending.reject(error);
}

export function acquireTab(name: string, browser: BrowserHandle, opts: AcquireTabOptions): Promise<AcquireTabResult> {
	holdBrowser(browser);
	const prior = acquireChains.get(name) ?? Promise.resolve();
	const acquisition = prior.then(() => acquireTabImpl(name, browser, opts));
	const tail = acquisition.then(
		() => undefined,
		() => undefined,
	);
	acquireChains.set(name, tail);
	void tail.then(() => {
		if (acquireChains.get(name) === tail) acquireChains.delete(name);
	});
	return acquisition.finally(async () => {
		await releaseBrowser(browser, { kill: false }).catch(() => undefined);
	});
}

async function acquireTabImpl(
	name: string,
	browser: BrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	// Serialized opens can sit behind a slow predecessor in the per-name
	// chain; honor an abort at dequeue instead of spawning a worker and
	// browser hold nobody is waiting for.
	if (opts.signal?.aborted) {
		throw new ToolAbortError("Browser tab open aborted");
	}
	killedTabs.delete(name);
	// Temporary refCount hold so releasing an existing tab on the SAME browser
	// below cannot drop it to refCount 0 and dispose the instance we are about
	// to reuse (e.g. reopening the sole tab with a different dialogs policy).
	let tempHold = false;
	const existing = tabs.get(name);
	if (existing) {
		if (existing.browser === browser && existing.state === "alive") {
			const requestedCmuxSurface = "client" in browser ? (opts.cmuxSurface ?? browser.surface) : undefined;
			if (existing.backend === "cmux" && existing.cmuxAttachedSurface !== requestedCmuxSurface) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (opts.dialogs !== undefined && opts.dialogs !== existing.dialogPolicy) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else if (
				opts.allowedDomains !== undefined &&
				!sameAllowedDomains(opts.allowedDomains, existing.allowedDomains)
			) {
				holdBrowser(browser);
				tempHold = true;
				await releaseTab(name, { kill: false });
			} else {
				const ownerId = opts.ownerSessionId;
				const hadOwnerLease = ownerId !== undefined && existing.retainedLeases.has(ownerId);
				const cleanupRequestedBefore = existing.cleanupRequested;
				if (ownerId !== undefined && !hadOwnerLease) retainLease(existing, opts);
				try {
					// Reuse counts as use: refresh the idle clock and resume a settle-frozen page before driving it again.
					existing.lastActivityAt = Date.now();
					if (!(await unfreezeTabSession(existing))) {
						throw new ToolError(
							`Tab ${JSON.stringify(name)} is frozen and could not be resumed. Close and reopen it.`,
						);
					}
					if (opts.persist !== undefined && existing.ownerSessionId === opts.ownerSessionId)
						existing.persist = opts.persist;
					const reuseSteps: string[] = [];
					if (opts.viewport && browser.kind.kind !== "cmux") {
						const dsf = opts.viewport.deviceScaleFactor;
						reuseSteps.push(
							`await page.setViewport({ width: ${opts.viewport.width}, height: ${opts.viewport.height}, deviceScaleFactor: ${dsf === undefined ? "undefined" : String(dsf)} });`,
						);
					}
					if (opts.url)
						reuseSteps.push(
							`await tab.goto(${JSON.stringify(opts.url)}, { waitUntil: ${JSON.stringify(opts.waitUntil ?? "load")} });`,
						);
					if (reuseSteps.length) {
						await runInTabWithSnapshot(
							name,
							{ code: reuseSteps.join("\n"), timeoutMs: opts.timeoutMs, signal: opts.signal },
							{ cwd: process.cwd() },
						);
					}
					const tab = tabs.get(name);
					if (tab?.state !== "alive") throw new ToolError(`Browser tab ${JSON.stringify(name)} was closed`);
					return { tab, created: false };
				} catch (error) {
					if (ownerId !== undefined && !hadOwnerLease && tabs.get(name) === existing) {
						existing.retainedLeases.delete(ownerId);
						existing.cleanupRequested ||= cleanupRequestedBefore;
						await maybeReleaseUnownedTab(existing);
					}
					throw error;
				}
			}
		} else {
			if (existing.browser === browser) {
				holdBrowser(browser);
				tempHold = true;
			}
			await releaseTab(name, { kill: false });
		}
	}

	if ("client" in browser) {
		try {
			const result = await acquireCmuxTab(name, browser, opts);
			if (tempHold) await releaseBrowser(browser, { kill: false });
			return result;
		} catch (error) {
			if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
			throw error;
		}
	}
	let initPayload: WorkerInitPayload;
	let worker: WorkerHandle;
	try {
		initPayload = await buildInitPayload(browser, opts);
		worker = await spawnTabWorker();
	} catch (error) {
		// Failing before the worker took its own hold must release the
		// temporary one, or the browser's refCount never reaches 0 again.
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	let info: ReadyInfo;
	try {
		const workerInitTimeoutMs =
			opts.deadlineStartMs === undefined
				? Math.max(WORKER_INIT_TIMEOUT_MS, opts.timeoutMs + GRACE_MS)
				: opts.timeoutMs;
		info = await initializeTabWorker(worker, initPayload, workerInitTimeoutMs, opts.deadlineStartMs);
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false });
		throw error;
	}
	// If the caller aborted while we were spawning/initializing the worker, tear
	// the freshly-built worker down before publishing the tab so the browser
	// refCount (which `holdBrowser` below would take) never grows for a tab
	// nobody is waiting for. Mirror the error paths' `refCount === 0` release so
	// a fresh browser held by nothing but this aborted open is not orphaned in
	// the registry; a browser still leased/held elsewhere (refCount > 0) is left
	// for its owner to release.
	if (opts.signal?.aborted) {
		await worker.terminate().catch(() => undefined);
		if (tempHold || browser.refCount === 0) await releaseBrowser(browser, { kill: false }).catch(() => undefined);
		throw new ToolAbortError("Browser tab open aborted");
	}

	holdBrowser(browser);
	if (tempHold) await releaseBrowser(browser, { kill: false });
	const tab: WorkerTabSession = {
		name,
		browser,
		targetId: info.targetId,
		backend: "worker",
		worker,
		state: "alive",
		info,
		pending: new Map(),
		queue: [],
		running: false,
		retainedLeases: new Map(),
		useTokens: new Map(),
		cleanupRequested: false,
		dialogPolicy: opts.dialogs,
		allowedDomains: opts.allowedDomains ? [...opts.allowedDomains] : undefined,
		kindTag: browser.kind.kind,
		activateForScreenshot: initPayload.mode === "headless" || initPayload.activateForScreenshot !== false,
		ownerSessionId: opts.ownerSessionId,
		persist: opts.persist ?? false,
		lastActivityAt: Date.now(),
		frozen: false,
	};
	worker.onMessage(msg => handleTabMessage(tab, msg));
	tabs.set(name, tab);
	retainLease(tab, opts);
	emitBrowserTabInventory();
	// Durably record ownership so another live omp process can reap this page if
	// this process dies abnormally before its own teardown closes the tab.
	const scope = sharedScopeOf(browser);
	if (scope) void recordSharedTarget(scope, info.targetId);
	return { tab, created: true };
}

async function acquireCmuxTab(
	name: string,
	browser: CmuxBrowserHandle,
	opts: AcquireTabOptions,
): Promise<AcquireTabResult> {
	if (opts.allowedDomains?.length) {
		throw new ToolError("browser.open allowed_domains is not supported on the cmux backend");
	}
	const attachedSurface = opts.cmuxSurface ?? browser.surface;
	if (attachedSurface?.startsWith("surface:")) {
		throw new ToolError(
			"app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split",
		);
	}

	let surfaceId = attachedSurface;
	let initialUrl = opts.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: opts.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await browser.client.request("browser.open_split", params, { timeoutMs: opts.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) {
				throw new ToolError("cmux browser.open_split did not return a surface_id");
			}
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (opts.url) {
				await browser.client.request(
					"browser.wait",
					{
						surface_id: surfaceId,
						load_state: mapWaitUntil(opts.waitUntil ?? "load"),
						timeout_ms: opts.timeoutMs,
					},
					{ timeoutMs: opts.timeoutMs },
				);
			}
		}

		const cmuxTab = new CmuxTab({ client: browser.client, surfaceId, url: initialUrl });
		if (attachedSurface && opts.url) {
			await cmuxTab.goto(opts.url, { waitUntil: opts.waitUntil ?? "load", timeoutMs: opts.timeoutMs });
		}
		const info = await cmuxTab.readyInfo(opts.viewport ?? DEFAULT_VIEWPORT);
		// If the caller aborted while we were opening the cmux surface, close the
		// surface (if we own it) instead of taking a browser hold on it.
		if (opts.signal?.aborted) {
			throw new ToolAbortError("Browser tab open aborted");
		}
		holdBrowser(browser);
		const tab: CmuxTabSession = {
			name,
			browser,
			targetId: surfaceId,
			backend: "cmux",
			cmuxTab,
			cmuxOwnsSurface: ownsSurface,
			state: "alive",
			info,
			pending: new Map(),
			queue: [],
			running: false,
			retainedLeases: new Map(),
			useTokens: new Map(),
			cleanupRequested: false,
			dialogPolicy: opts.dialogs,
			kindTag: browser.kind.kind,
			cmuxAttachedSurface: attachedSurface,
			ownerSessionId: opts.ownerSessionId,
			persist: opts.persist ?? false,
			lastActivityAt: Date.now(),
			frozen: false,
		};
		tabs.set(name, tab);
		retainLease(tab, opts);
		emitBrowserTabInventory();
		return { tab, created: true };
	} catch (error) {
		if (ownsSurface && surfaceId) {
			await browser.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		}
		throw error;
	}
}

export async function runInTab(name: string, opts: RunInTabOptions): Promise<RunResultOk> {
	return await runInTabWithSnapshot(
		name,
		{ code: opts.code, timeoutMs: opts.timeoutMs, signal: opts.signal, session: opts.session },
		{
			cwd: opts.session.cwd,
			browserScreenshotDir: expandBrowserScreenshotDir(opts.session),
			excludeWebP: webpExclusionForModel(opts.session.getActiveModel?.()),
		},
	);
}

async function runInTabWithSnapshot(
	name: string,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<RunResultOk> {
	const tab = tabs.get(name);
	if (!tab || tab.state === "dead") {
		const killed = killedTabs.get(name);
		throw new ToolError(
			killed
				? `Tab ${JSON.stringify(name)} was killed: ${killed}. Reopen it.`
				: `Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".`,
		);
	}
	if (opts.signal?.aborted) throw new ToolAbortError();
	tab.lastActivityAt = Date.now();
	const id = Snowflake.next();
	const { promise, resolve, reject } = Promise.withResolvers<RunResultOk>();
	const pending: PendingRun = {
		resolve,
		reject,
		session: opts.session ?? ({} as ToolSession),
		sessionKey: resolveBrowserSessionKey(opts.session),
		signal: opts.signal,
		toolCalls: new Map(),
		closeAc: new AbortController(),
	};
	promise.catch(() => undefined);
	tab.useTokens.set(id, pending.sessionKey);

	if (tab.running) {
		const node: QueuedRun = {
			id,
			pending,
			opts,
			snapshot,
			deadline: Date.now() + opts.timeoutMs,
			leaseToken: id,
			promise,
			started: false,
		};
		tab.queue.push(node);
		node.abort = () => {
			if (settleQueuedRun(tab, node, new ToolAbortError())) void maybeReleaseUnownedTab(tab);
		};
		node.timer = setTimeout(() => {
			if (settleQueuedRun(tab, node, new ToolError(`Browser code execution timed out after ${opts.timeoutMs}ms`))) {
				void maybeReleaseUnownedTab(tab);
			}
		}, opts.timeoutMs);
		if (opts.signal?.aborted) node.abort();
		else opts.signal?.addEventListener("abort", node.abort, { once: true });
		emitBrowserTabInventory();
		return promise;
	}

	void startTabRun(tab, id, pending, promise, opts, snapshot);
	return promise;
}

function startNextQueuedRun(tab: TabSession): void {
	if (tab.running || tab.state !== "alive") return;
	while (tab.queue.length > 0) {
		const node = tab.queue.shift()!;
		clearTimeout(node.timer);
		node.opts.signal?.removeEventListener("abort", node.abort as EventListener);
		emitBrowserTabInventory();
		if (node.opts.signal?.aborted) {
			settleDequeuedRun(tab, node, new ToolAbortError());
			continue;
		}
		if (Date.now() >= node.deadline) {
			settleDequeuedRun(tab, node, new ToolError(`Browser code execution timed out after ${node.opts.timeoutMs}ms`));
			continue;
		}
		node.started = true;
		void startTabRun(tab, node.id, node.pending, node.promise, node.opts, node.snapshot);
		return;
	}
	void maybeReleaseUnownedTab(tab);
}

async function startTabRun(
	tab: TabSession,
	id: string,
	pending: PendingRun,
	promise: Promise<RunResultOk>,
	opts: { code: string; timeoutMs: number; signal?: AbortSignal; session?: ToolSession },
	snapshot: SessionSnapshot,
): Promise<void> {
	tab.running = true;
	tab.pending.set(id, pending);
	emitBrowserTabInventory();
	try {
		const ready = await Promise.race([
			unfreezeTabSession(tab).then(resumed => ({ kind: "resumed" as const, resumed })),
			promise.then(
				() => ({ kind: "settled" as const }),
				error => ({ kind: "rejected" as const, error }),
			),
		]);
		if (ready.kind !== "resumed") return;
		if (!ready.resumed) {
			throw new ToolError(
				`Tab ${JSON.stringify(tab.name)} is frozen and could not be resumed. Close and reopen it.`,
			);
		}
		if (opts.signal?.aborted) throw new ToolAbortError();
		if (tabs.get(tab.name) !== tab || tab.state === "dead") {
			throw new ToolError(`Tab ${JSON.stringify(tab.name)} is not alive. Open it first with action:"open".`);
		}
		if (tab.backend === "cmux") {
			const runSignal = opts.signal
				? AbortSignal.any([opts.signal, pending.closeAc!.signal])
				: pending.closeAc!.signal;
			const result = await runCmuxCode(tab.cmuxTab, {
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				signal: runSignal,
				session: pending.session,
				snapshot,
				activeTabName: tab.name,
			});
			pending.resolve(result);
			return;
		}

		let runSent = false;
		let abortRequested = false;
		const abort = (): void => {
			abortRequested = true;
			if (!runSent) return;
			safeSend(tab, { type: "abort", id });
			for (const ctrl of pending.toolCalls.values()) ctrl.abort(opts.signal?.reason);
		};
		opts.signal?.addEventListener("abort", abort, { once: true });
		try {
			tab.worker.send({
				type: "run",
				id,
				name: tab.name,
				code: opts.code,
				timeoutMs: opts.timeoutMs,
				session: snapshot,
			});
			runSent = true;
			if (abortRequested || opts.signal?.aborted) abort();
			try {
				await raceWithTimeout(
					promise,
					opts.timeoutMs + GRACE_MS,
					"Browser code execution hung past grace; tab killed",
					async reason => await forceKillTab(tab.name, reason),
				);
			} catch (error) {
				const runTimedOut =
					error instanceof ToolError && error.message.startsWith("Browser code execution timed out after ");
				if (runTimedOut || error instanceof RecoverableWorkerError) {
					try {
						await recycleTimedOutWorkerTab(tab, opts.timeoutMs + GRACE_MS);
					} catch (recycleError) {
						logger.warn("Failed to recycle browser tab worker; killing tab", {
							error: recycleError instanceof Error ? recycleError.message : String(recycleError),
						});
						await forceKillTab(tab.name, "Browser tab worker recovery failed; tab killed");
					}
				}
				throw error;
			}
		} finally {
			opts.signal?.removeEventListener("abort", abort);
		}
	} catch (error) {
		pending.reject(error);
	} finally {
		tab.pending.delete(id);
		settleUseToken(tab, id);
		tab.running = false;
		tab.lastActivityAt = Date.now();
		emitBrowserTabInventory();
		startNextQueuedRun(tab);
	}
}

/**
 * In-flight releases by tab object. A second `releaseTab` for a tab already
 * being torn down joins the first instead of redoubling teardown: without
 * this, a same-name acquire racing a sweep's release would publish a
 * replacement that the first release's unconditional delete then removes
 * (and the shared browser hold would release twice). Joiners share the
 * first release's outcome.
 */
const releaseInflight = new WeakMap<TabSession, { promise: Promise<boolean>; opts: ReleaseTabOptions }>();

export async function releaseTab(name: string, opts: ReleaseTabOptions = {}): Promise<boolean> {
	const tab = tabs.get(name);
	if (!tab) {
		logger.debug("releaseTab: unknown tab", { name });
		return false;
	}
	const ongoing = releaseInflight.get(tab);
	if (ongoing) {
		// Coalesce cleanup strength: a joining disposal must not lose its
		// kill request to an earlier non-killing close — `releaseBrowser`
		// reads `opts.kill` at teardown time, so the upgrade lands as long
		// as the first release has not finished. (Not directly testable
		// in-process: observing it needs a real spawned application.)
		ongoing.opts.kill = ongoing.opts.kill || opts.kill;
		const joined = await ongoing.promise;
		// The upgrade above lands too late when the first release already
		// passed `releaseBrowser`: verify a still-running spawned app is
		// terminated rather than trusting the joined outcome.
		if (opts.kill) await ensureSpawnedKilled(tab.browser);
		return joined;
	}
	const entry = { promise: releaseTabInner(tab, name, opts), opts };
	releaseInflight.set(tab, entry);
	try {
		return await entry.promise;
	} finally {
		releaseInflight.delete(tab);
	}
}

/**
 * Best-effort termination of a spawned app that outlived a joined teardown.
 * Fires only behind a live subprocess handle (kernel-tracked, so no
 * pid-reuse hazard): anything else already died or was never ours to kill.
 */
async function ensureSpawnedKilled(browser: BrowserHandle): Promise<void> {
	if (browser.kind.kind !== "spawned" || !("subprocess" in browser)) return;
	const { pid, subprocess } = browser;
	if (pid === undefined || !subprocess || subprocess.exitCode !== null) return;
	await gracefulKillTreeOnce(pid).catch(() => undefined);
}

/** Test hook for the kill guards without a live application. */
export function ensureSpawnedKilledForTest(browser: BrowserHandle): Promise<void> {
	return ensureSpawnedKilled(browser);
}

async function releaseTabInner(tab: TabSession, name: string, opts: ReleaseTabOptions): Promise<boolean> {
	const wasAlive = tab.state === "alive";
	tab.state = "dead";
	emitBrowserTabInventory();
	const closeError = postmortem.markExpectedCleanupError(new ToolError(`Tab ${JSON.stringify(name)} was closed`));
	for (const node of tab.queue.splice(0)) {
		clearTimeout(node.timer as ReturnType<typeof setTimeout>);
		node.opts.signal?.removeEventListener("abort", node.abort as EventListener);
		settleUseToken(tab, node.leaseToken);
		node.pending.reject(closeError);
	}
	tab.running = false;
	for (const [id, pending] of tab.pending) {
		if (tab.backend === "worker") {
			try {
				tab.worker.send({ type: "abort", id, expectedCleanup: true });
			} catch {}
		}
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(closeError);
		// Propagate the closure into the cmux run's abort signal so
		// `wait(...)`, in-flight cmux socket calls, and the facade proxies
		// unwind promptly. Firing this BEFORE `pending.reject` means
		// `runCmuxCode` finishes with `ToolAbortError` and its `.then(reject)`
		// is a no-op — `promise` still settles with the tab-close error via
		// the `reject` call below. Without it, a run that isn't currently
		// making a socket request (e.g. `await wait(60_000)`) would keep
		// `runCmuxCode` blocked until timeout even after `pending.reject`
		// unblocked the caller (issue #4499 review feedback).
		pending.closeAc?.abort(closeError);
		pending.reject(closeError);
	}
	tab.pending.clear();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TAB_CLOSE_TIMEOUT_MS;
	if (tab.backend === "cmux") {
		let closeError: unknown;
		if (wasAlive && tab.cmuxOwnsSurface) {
			try {
				await waitForTabCleanup(
					tab,
					timeoutMs,
					`cmux surface ${JSON.stringify(tab.targetId)} (surface.close)`,
					tab.browser.client.request("surface.close", { surface_id: tab.targetId }, { timeoutMs }),
				);
			} catch (err) {
				if (isLastSurfaceCloseError(err)) {
					logger.debug("Leaving cmux browser surface open because it is the last surface in the workspace", {
						error: err instanceof Error ? err.message : String(err),
					});
				} else {
					closeError = err;
				}
			}
		}
		try {
			await releaseBrowser(tab.browser, {
				kill: opts.kill ?? false,
				timeoutMs,
				resource: `tab ${JSON.stringify(name)}`,
			});
		} catch (error) {
			closeError ??= error;
		} finally {
			if (tabs.get(name) === tab) tabs.delete(name);
			emitBrowserTabInventory();
		}
		if (closeError) throw closeError;
		return true;
	}
	let cleanupError: unknown;
	let forced = false;
	if (wasAlive) {
		try {
			tab.worker.send({ type: "close" });
			await waitForClosed(tab);
		} catch {
			forced = true;
		}
	}
	await tab.worker.terminate().catch(() => undefined);
	if (forced && tab.kindTag === "headless") {
		try {
			await waitForTabCleanup(
				tab,
				timeoutMs,
				`orphan CDP target ${JSON.stringify(tab.targetId)} (Page.close)`,
				closeOrphanTarget(tab),
			);
		} catch (error) {
			cleanupError = error;
		}
	}
	try {
		await releaseBrowser(tab.browser, {
			kill: opts.kill ?? false,
			timeoutMs,
			resource: `tab ${JSON.stringify(name)}`,
		});
	} catch (error) {
		cleanupError ??= error;
	} finally {
		tabs.delete(name);
		const scope = sharedScopeOf(tab.browser);
		if (scope) void forgetSharedTarget(scope, tab.targetId);
	}
	if (cleanupError) throw cleanupError;
	return true;
}

export async function releaseAllTabs(opts: ReleaseTabOptions = {}): Promise<number> {
	const names = [...tabs.keys()];
	let count = 0;
	for (const name of names) {
		if (await releaseTab(name, opts)) count++;
	}
	return count;
}

export async function dropHeadlessTabs(): Promise<void> {
	const names = [...tabs.values()].filter(tab => tab.kindTag === "headless").map(tab => tab.name);
	for (const name of names) await releaseTab(name);
}
/** Release this session's retained leases and transient queued/active runs. */
export async function releaseTabsForOwner(ownerId: string, opts: ReleaseTabOptions = {}): Promise<number> {
	if (!ownerId) return 0;
	const candidates = [...tabs.values()].filter(
		tab =>
			tab.retainedLeases.has(ownerId) ||
			tab.queue.some(node => node.pending.sessionKey === ownerId) ||
			[...tab.pending.values()].some(pending => pending.sessionKey === ownerId) ||
			[...tab.useTokens.values()].some(sessionKey => sessionKey === ownerId),
	);
	let count = 0;
	for (const tab of candidates) {
		tab.cleanupRequested = true;
		tab.retainedLeases.delete(ownerId);
		emitBrowserTabInventory();
		const disposeError = new ToolAbortError("Browser session disposed");
		for (const node of [...tab.queue]) {
			if (node.pending.sessionKey === ownerId) settleQueuedRun(tab, node, disposeError);
		}
		for (const [id, pending] of tab.pending) {
			if (pending.sessionKey !== ownerId) continue;
			if (tab.backend === "worker") {
				try {
					tab.worker.send({ type: "abort", id, expectedCleanup: true });
				} catch {}
			}
			pending.closeAc?.abort(disposeError);
			pending.reject(disposeError);
		}
		if (!tab.running) {
			for (const [token, sessionKey] of tab.useTokens) {
				if (sessionKey === ownerId) settleUseToken(tab, token);
			}
		}
		if (await maybeReleaseUnownedTab(tab, opts)) count++;
	}
	return count;
}

/**
 * Tabs this settle machinery may ever touch: OMP-launched headless Playwright
 * tabs (`kindTag === "headless"` covers hidden and visible shared-daemon
 * tabs) that are alive and not opted out with `persist`. Connected, relay,
 * and spawned tabs drive the user's own pages/apps, and cmux surfaces are a
 * different backend with no CDP lifecycle — all are never frozen or reaped
 * here. Ownership follows the `releaseTabsForOwner` contract: recorded on
 * creation, never transferred by reuse.
 */
function isSettleManaged(tab: TabSession): boolean {
	return tab.backend === "worker" && tab.kindTag === "headless" && tab.state === "alive" && !tab.persist;
}

/**
 * Find the live Playwright page backing a tab by its exact Chrome target id.
 * Returns undefined when the target is already gone.
 */
async function findTargetForTab(tab: WorkerTabSession): Promise<Page | undefined> {
	const pages = tab.browser.browser.contexts().flatMap(context => context.pages());
	for (const page of pages) {
		if ((await targetIdForPage(page).catch(() => "")) === tab.targetId) return page;
	}
	return undefined;
}

/**
 * Set a tab's web lifecycle state through a supervisor-owned CDP session —
 * no worker-protocol change needed; CDP allows multiple sessions per target.
 * `frozen` pauses rAF/timers (the SwiftShader burn in #8246); `active`
 * resumes. Best-effort in the safe direction: false when the tab is gone or
 * the protocol call fails, leaving `frozen` untouched so the next checkpoint
 * retries and close paths still apply.
 *
 * Race protocol (all flag reads/writes below run atomically between awaits):
 * runs register `pending` before driving the page, so a freeze that starts
 * after a run began stands down at the guard. A freeze already past the
 * guard when a run registers rechecks `pending` after its CDP roundtrip and
 * re-asserts `active` on the same session — a frozen frame already sent
 * cannot be unsent, so the undo guarantees the run never executes on a
 * frozen page. Unfreezing always proceeds: resuming is safe under any
 * pending state.
 */
async function setTabFrozen(tab: TabSession, frozen: boolean): Promise<boolean> {
	if (!isSettleManaged(tab) || tab.backend !== "worker") return false;
	if (tab.frozen === frozen) return false;
	if (frozen && tab.pending.size > 0) return false;
	const page = await findTargetForTab(tab).catch(() => undefined);
	if (!page) return false;
	const session = await getPageCDPSession(page).catch(() => null);
	if (!session) return false;
	try {
		await session.send("Page.enable").catch(() => undefined);
		await session.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
		if (tab.state !== "alive") return false;
		if (frozen) {
			if (tab.frozen) return false;
			if (tab.pending.size > 0 || tab.persist) {
				// A run registered, or the owner opted out with `persist`,
				// while our CDP roundtrip was in flight. Either way the
				// frozen frame may already have landed, so re-assert
				// `active` instead of recording frozen — a persist tab left
				// frozen could never resume (unfreeze is rejected by the
				// same persist eligibility gate).
				if (await sendLifecycleState(session, "active")) return false;
				// One retry for the in-flight run's sake: a brief frozen
				// blip is harmless (rAF just skips frames), but an
				// indefinite freeze stalls it to timeout.
				await Bun.sleep(100);
				if (await sendLifecycleState(session, "active")) return false;
				tab.frozen = true;
				return false;
			}
			tab.frozen = true;
			return true;
		}
		tab.frozen = false;
		return true;
	} catch (error) {
		logger.debug("Browser tab lifecycle transition failed; leaving tab lifecycle state unchanged", {
			name: tab.name,
			frozen,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/** Best-effort lifecycle write on an owned CDP session; false when the call fails. */
async function sendLifecycleState(session: CDPSession, state: "frozen" | "active"): Promise<boolean> {
	try {
		await session.send("Page.setWebLifecycleState", { state });
		return true;
	} catch {
		return false;
	}
}

/** Test hook for the lifecycle transition without a tabs-map entry. */
export function setTabFrozenForTest(tab: TabSession, frozen: boolean): Promise<boolean> {
	return setTabFrozen(tab, frozen);
}

/**
 * Resume a tab before driving it. Returns false only when the page target
 * exists but refuses the `active` transition even after one retry — the
 * page is most likely still paused, so the caller must not dispatch onto
 * it. A vanished target returns true: the run proceeds and surfaces the
 * real page error immediately instead of hanging to timeout.
 */
async function unfreezeTabSession(tab: TabSession): Promise<boolean> {
	if (!tab.frozen) return true;
	if (tab.backend === "worker") {
		const target = await findTargetForTab(tab).catch(() => undefined);
		// Page target gone: let the run proceed and surface the real page
		// error immediately instead of hanging to timeout.
		if (!target) return true;
	}
	if (await setTabFrozen(tab, false).catch(() => false)) return true;
	await Bun.sleep(100);
	return await setTabFrozen(tab, false).catch(() => false);
}

/** Test hook for the pre-run resume without a tabs-map entry. */
export function unfreezeTabSessionForTest(tab: TabSession): Promise<boolean> {
	return unfreezeTabSession(tab);
}

/**
 * Freeze every managed tab owned by `ownerId` (issue #8246). Turn-settle
 * checkpoint: an idle animated page stops burning CPU/GPU while keeping its
 * renderer, worker, and DOM state for millisecond resume on next use. Tabs
 * with in-flight runs are skipped at the guard; a freeze already past the
 * guard when a run registers undoes itself at completion (see
 * `setTabFrozen`), so neither path can stall a run mid-execution.
 */
export async function freezeTabsForOwner(ownerId: string): Promise<number> {
	if (!ownerId) return 0;
	let count = 0;
	for (const tab of tabs.values()) {
		if (tab.ownerSessionId !== ownerId) continue;
		if (await setTabFrozen(tab, true).catch(() => false)) count++;
	}
	return count;
}
/**
 * Idle-close eligibility: owned, settle-managed, no in-flight run, and idle
 * past the deadline. An executing tab is not idle even when its run outlasts
 * the timeout. Exported so the never-touch contract is unit-testable;
 * `releaseIdleTabsForOwner` walks the map with exactly this predicate.
 */
export function isIdleCloseCandidate(tab: TabSession, ownerId: string, nowMs: number, idleMs: number): boolean {
	return (
		tab.ownerSessionId === ownerId &&
		isSettleManaged(tab) &&
		tab.pending.size === 0 &&
		nowMs - tab.lastActivityAt >= idleMs
	);
}
/**
 * Close managed tabs owned by `ownerId` idle longer than `idleMs` — the
 * memory backstop under settle-freeze (frozen tabs still hold their renderer
 * and worker). Never throws: a wedged tab counts as unclosed and the sweep
 * continues, returning the partial count — reapers must not fail callers.
 */
export async function releaseIdleTabsForOwner(
	ownerId: string,
	opts: { idleMs: number } & ReleaseTabOptions = { idleMs: 0 },
): Promise<number> {
	if (!ownerId) return 0;
	const now = Date.now();
	const names = [...tabs.values()]
		.filter(tab => isIdleCloseCandidate(tab, ownerId, now, opts.idleMs))
		.map(tab => tab.name);
	let count = 0;
	// Program-order token: a cancel landing after this increment suppresses
	// the re-arm below, so disabling mid-sweep cannot resurrect the deadline.
	const sweepSeq = ++idleCloseSeq;
	try {
		for (const name of names) {
			// Revalidate immediately before closing: an earlier close in this
			// loop awaits worker cleanup, during which a later candidate may
			// have been reused or started a run.
			const current = tabs.get(name);
			if (!current || !isIdleCloseCandidate(current, ownerId, Date.now(), opts.idleMs)) continue;
			try {
				if (await releaseTab(name, opts)) count++;
			} catch (error) {
				// One tab's wedged cleanup must not abandon the remaining
				// candidates; the tab is already removed from the map, so
				// the next sweep (or close path) retries it.
				logger.debug("Failed to close idle browser tab; continuing sweep", {
					name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} finally {
		// Leave the next deadline armed even when a close threw — unless
		// cancelled mid-sweep. Sweeps only fire on turns, opens, and timer
		// callbacks, so without re-arming the survivors would never close.
		if ((idleCloseCancelSeq.get(ownerId) ?? 0) <= sweepSeq) {
			armIdleCloseForOwner(ownerId, opts.idleMs);
		}
	}
	return count;
}

/** Per-owner one-shot timers arming the idle-close backstop. Always unref'd. */
const idleCloseTimers = new Map<string, NodeJS.Timeout>();

/**
 * Monotonic clock ordering sweeps against cancels: each sweep entry and
 * each cancel takes the next value, so a sweep can tell whether a cancel
 * landed mid-flight.
 */
let idleCloseSeq = 0;
/** Last cancel sequence per owner; sweeps re-arm only when uncancelled. */
const idleCloseCancelSeq = new Map<string, number>();

/** Recheck cadence when a firing sweep skips due-but-busy tabs. Overridable in tests. */
const IDLE_DUE_RETRY_MS = 30_000;

/**
 * Milliseconds until the owner's next managed tab goes idle, `0` when one
 * already is, or undefined when no managed tab is tracked. The sweep
 * checkpoints (turn settle, open) handle the due case synchronously; the
 * timer covers abandonment with no further activity.
 */
export function earliestIdleCloseInMs(ownerId: string, idleMs: number, nowMs: number = Date.now()): number | undefined {
	if (!ownerId || !(idleMs > 0)) return undefined;
	let earliest: number | undefined;
	for (const tab of tabs.values()) {
		if (tab.ownerSessionId !== ownerId || !isSettleManaged(tab)) continue;
		const remaining = idleMs - (nowMs - tab.lastActivityAt);
		if (remaining <= 0) return 0;
		earliest = earliest === undefined ? remaining : Math.min(earliest, remaining);
	}
	return earliest;
}

/** Drop a pending idle-close deadline and invalidate a sweep in flight. */
export function cancelIdleCloseForOwner(ownerId: string): void {
	if (!ownerId) return;
	clearIdleCloseTimer(ownerId);
	idleCloseCancelSeq.set(ownerId, ++idleCloseSeq);
}

/** Test probe: whether the owner currently has an armed deadline. */
export function hasIdleCloseTimerForTest(ownerId: string): boolean {
	return idleCloseTimers.has(ownerId);
}

function clearIdleCloseTimer(ownerId: string): void {
	const existing = idleCloseTimers.get(ownerId);
	if (existing === undefined) return;
	idleCloseTimers.delete(ownerId);
	clearTimeout(existing);
}

/**
 * (Re)arm the owner-scoped one-shot that closes idle tabs when the timeout
 * elapses without further activity. Without this, a tab used in the final
 * turn before an idle session would sit until the next turn, open, or
 * dispose despite the advertised timeout. The timer is unref'd so it never
 * holds the process open (print/RPC exits are unaffected), firing
 * re-enters through `releaseIdleTabsForOwner` — which re-arms while
 * survivors remain — and disposal needs no cleanup since a fired sweep
 * over released tabs is a no-op. Due-but-busy survivors re-arm on a short
 * retry cadence instead of losing their deadline until the next sweep.
 * @param retryMs recheck cadence for due-but-busy survivors; keep well above zero.
 */
export function armIdleCloseForOwner(ownerId: string, idleMs: number, retryMs: number = IDLE_DUE_RETRY_MS): void {
	clearIdleCloseTimer(ownerId);
	const delay = earliestIdleCloseInMs(ownerId, idleMs);
	if (delay === undefined) return;
	const wait = delay <= 0 ? retryMs : Math.min(delay, 2_147_483_647);
	const timer = setTimeout(() => {
		idleCloseTimers.delete(ownerId);
		void releaseIdleTabsForOwner(ownerId, { idleMs })
			.then(() => armIdleCloseForOwner(ownerId, idleMs, retryMs))
			.catch(() => undefined);
	}, wait);
	timer.unref();
	idleCloseTimers.set(ownerId, timer);
}

/** Test-only accessor for the module-global tabs map. */
export function getTabsMapForTest(): Map<string, TabSession> {
	return tabs;
}
function isLastSurfaceCloseError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /last/i.test(message);
}

function sameAllowedDomains(left: readonly string[], right: readonly string[] | undefined): boolean {
	if (!right || left.length !== right.length) return false;
	return left.every((domain, index) => domain === right[index]);
}

async function buildInitPayload(browser: CdpBrowserHandle, opts: AcquireTabOptions): Promise<WorkerInitPayload> {
	const cdpEndpoint = browser.cdpEndpoint;
	if (browser.kind.kind === "headless") {
		return {
			mode: "headless",
			cdpEndpoint,
			// Visible launches still need an OMP-owned page, stealth setup, and
			// independent lifecycle; only their fixed device emulation is disabled.
			emulateViewport: browser.kind.headless,
			viewport: opts.viewport,
			dialogs: opts.dialogs,
			allowedDomains: opts.allowedDomains,
			initScripts: opts.initScripts,
			downloadsPath: opts.downloadsPath,
			userAgent: opts.userAgent,
			ignoreHttpsErrors: opts.ignoreHttpsErrors,
			url: opts.url,
			waitUntil: opts.waitUntil,
			timeoutMs: opts.timeoutMs,
		};
	}
	// Resolve one concrete transport identity before the worker starts. The
	// worker adopts that target id exactly and never substitutes another page.
	const userDriven = browser.kind.kind === "connected" || browser.kind.kind === "relay";
	const activateForScreenshot = !userDriven || !shouldPreserveConnectedBrowserFocus(opts.target);
	const page = await pickElectronTarget(browser.browser, {
		matcher: opts.target,
		preferVisible: !activateForScreenshot,
	});
	const targetId = await targetIdForPage(page);
	return {
		mode: "attach",
		cdpEndpoint,
		targetId,
		dialogs: opts.dialogs,
		allowedDomains: opts.allowedDomains,
		initScripts: opts.initScripts,
		downloadsPath: opts.downloadsPath,
		userAgent: opts.userAgent,
		ignoreHttpsErrors: opts.ignoreHttpsErrors,
		url: opts.url,
		waitUntil: opts.waitUntil,
		timeoutMs: opts.timeoutMs,
		activateForScreenshot,
	};
}

function handleTabMessage(tab: WorkerTabSession, msg: WorkerOutbound): void {
	if (msg.type === "result") {
		const pending = tab.pending.get(msg.id);
		if (!pending) return;
		tab.pending.delete(msg.id);
		emitBrowserTabInventory();
		if (msg.ok) {
			pending.resolve(msg.payload);
			return;
		}
		pending.reject(errorFromPayload(msg.error));
		return;
	}
	if (msg.type === "ready") {
		tab.info = msg.info;
		emitBrowserTabInventory();
		return;
	}
	if (msg.type === "tool-call") {
		void dispatchToolCall(tab, msg);
		return;
	}
	if (msg.type === "log") logWorkerMessage(msg);
}
async function dispatchToolCall(
	tab: WorkerTabSession,
	msg: Extract<WorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = tab.pending.get(msg.runId);
	if (!pending?.session.cwd) {
		safeSend(tab, {
			type: "tool-reply",
			id: msg.id,
			reply: {
				ok: false,
				error: { name: "ToolError", message: "No active run for tool call", isToolError: true, isAbort: false },
			},
		});
		return;
	}
	try {
		assertNoBrowserTabRecursion(tab.name, msg.name, msg.args, pending.session);
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	const onParentAbort = (): void => ctrl.abort(pending.signal?.reason);
	if (pending.signal?.aborted) onParentAbort();
	else pending.signal?.addEventListener("abort", onParentAbort, { once: true });
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.session,
			signal: ctrl.signal,
			emitStatus: () => {
				// Status events from tool calls aren't piped back to user code yet; the worker
				// already pushes its own helper status via the display channel.
			},
		});
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(tab, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
		pending.signal?.removeEventListener("abort", onParentAbort);
	}
}

function safeSend(tab: WorkerTabSession, msg: WorkerInbound): void {
	if (tab.state !== "alive") return;
	try {
		tab.worker.send(msg);
	} catch (err) {
		logger.debug("tab worker send failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

function toErrorPayload(error: unknown): RunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { name: "Error", message: String(error), isAbort: false, isToolError: false };
}

async function recycleTimedOutWorkerTab(tab: WorkerTabSession, timeoutMs: number): Promise<void> {
	const oldWorker = tab.worker;
	await oldWorker.terminate().catch(() => undefined);
	const payload: WorkerInitPayload = {
		mode: "attach",
		cdpEndpoint: tab.browser.cdpEndpoint,
		targetId: tab.targetId,
		dialogs: tab.dialogPolicy,
		allowedDomains: tab.allowedDomains,
		// Unblock a wedged page (open JS dialog, hung navigation) before adopting it —
		// otherwise init stalls, times out, and the tab gets force-killed.
		recover: true,
		emulateFocus: tab.kindTag === "headless",
		timeoutMs,
		activateForScreenshot: tab.activateForScreenshot,
	};
	const worker = await spawnTabWorker();
	try {
		const info = await initializeTabWorker(worker, payload, timeoutMs);
		tab.worker = worker;
		tab.info = info;
		tab.state = "alive";
		emitBrowserTabInventory();
		worker.onMessage(msg => handleTabMessage(tab, msg));
	} catch (error) {
		await worker.terminate().catch(() => undefined);
		throw error;
	}
}

async function forceKillTab(name: string, reason: string): Promise<void> {
	const tab = tabs.get(name);
	if (!tab) return;
	killedTabs.set(name, reason);
	tab.state = "dead";
	emitBrowserTabInventory();
	const error = postmortem.markExpectedCleanupError(new ToolError(reason));
	for (const pending of tab.pending.values()) pending.reject(error);
	tab.pending.clear();
	if (tab.backend === "cmux") {
		await releaseBrowser(tab.browser, { kill: false });
		tabs.delete(name);
		emitBrowserTabInventory();
		return;
	}
	await tab.worker.terminate().catch(() => undefined);
	if (tab.kindTag === "headless") await closeOrphanTarget(tab);
	await releaseBrowser(tab.browser, { kill: false });
	tabs.delete(name);
	const scope = sharedScopeOf(tab.browser);
	if (scope) void forgetSharedTarget(scope, tab.targetId);
}

/**
 * Durable-ownership scope for a browser handle, or undefined when the handle is
 * not the project-shared broker-owned Chromium (the only browser whose targets
 * outlive their creating process and thus need cross-process orphan reaping).
 */
function sharedScopeOf(browser: BrowserHandle): SharedTargetScope | undefined {
	if ("client" in browser) return undefined;
	if (browser.kind.kind !== "headless" || !browser.sharedDaemon) return undefined;
	return { projectDir: browser.sharedDaemon.projectDir, daemonName: browser.sharedDaemon.name };
}

/**
 * Best-effort cleanup for a forced-kill path: close the page the tab's worker
 * reported as created. A run caller is never a browser ref holder, so the
 * browser is still in the registry; the tab's browser is the only place that
 * page can be, so no targetId guesswork across multiple sessions.
 */
async function closeOrphanTarget(tab: WorkerTabSession): Promise<void> {
	await closeCdpTarget(tab.browser.browser, tab.targetId).catch(() => undefined);
}

async function waitForClosed(tab: WorkerTabSession): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = tab.worker.onMessage(msg => {
		if (msg.type === "closed") resolve();
	});
	try {
		await raceWithTimeout(promise, GRACE_MS, "Timed out closing browser tab worker");
	} finally {
		unsubscribe();
	}
}

function expandBrowserScreenshotDir(session: ToolSession): string | undefined {
	const value = cfgBrowserScreenshotDir.get(session.settings);
	return value ? expandPath(value) : undefined;
}

function errorFromPayload(payload: RunErrorPayload): Error {
	const error = payload.recoverTab
		? new RecoverableWorkerError(payload.message)
		: payload.isAbort
			? new ToolAbortError()
			: payload.isToolError
				? new ToolError(payload.message)
				: new Error(payload.message);
	error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function logWorkerMessage(msg: Extract<WorkerOutbound, { type: "log" }>): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}

async function raceWithTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	reason: string,
	onTimeout?: (reason: string) => Promise<void>,
): Promise<T> {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const { promise: timeoutPromise, reject } = Promise.withResolvers<never>();
	const onAbort = (): void => reject(new ToolError(reason));
	timeoutSignal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, timeoutPromise]);
	} catch (error) {
		if (error instanceof ToolError && error.message === reason) await onTimeout?.(reason);
		throw error;
	} finally {
		timeoutSignal.removeEventListener("abort", onAbort);
	}
}

async function spawnTabWorker(): Promise<WorkerHandle> {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_tab"] })
			: new Worker(new URL("./tab-worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (error) {
		throw new ToolError(
			`Failed to spawn browser tab worker: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg, transferList) {
			worker.postMessage(msg, { transfer: transferList ?? [] });
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as WorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`Tab worker message error: ${String(event.data)}`));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
			};
		},
		async terminate() {
			worker.terminate();
		},
	};
}

async function initializeTabWorker(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	const remainingMs = timeoutMs - Math.round(performance.now() - deadlineStart);
	const setupBudgetMs = Math.max(SETUP_BUDGET_FLOOR_MS, Math.min(SETUP_BUDGET_CAP_MS, Math.floor(remainingMs / 3)));
	const setup = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<ReadyInfo>();
	let setupDone = false;
	const failStartup = (error: Error): void => {
		(setupDone ? ready : setup).reject(error);
	};
	const unlisten = worker.onMessage(msg => {
		if (msg.type === "setup") {
			setupDone = true;
			setup.resolve();
		} else if (msg.type === "ready") ready.resolve(msg.info);
		else if (msg.type === "init-failed") failStartup(errorFromPayload(msg.error));
		else if (msg.type === "log") logWorkerMessage(msg);
	});
	const unlistenError = worker.onError(error => {
		failStartup(new ToolError(`Tab worker failed during startup: ${error.message}`));
	});
	try {
		worker.send({ type: "init", payload });
		await raceWithTimeout(setup.promise, setupBudgetMs, "Timed out waiting for tab worker setup");
		const readyBudgetMs = Math.max(READY_BUDGET_FLOOR_MS, timeoutMs - Math.round(performance.now() - deadlineStart));
		return await raceWithTimeout(ready.promise, readyBudgetMs, "Timed out initializing browser tab worker");
	} finally {
		unlisten();
		unlistenError();
	}
}

export function initializeTabWorkerForTest(
	worker: WorkerHandle,
	payload: WorkerInitPayload,
	timeoutMs: number,
	deadlineStart: number = performance.now(),
): Promise<ReadyInfo> {
	return initializeTabWorker(worker, payload, timeoutMs, deadlineStart);
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown tab worker error");
}

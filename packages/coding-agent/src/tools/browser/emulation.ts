import type { Protocol } from "devtools-protocol";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CDPSession, Frame, Page } from "playwright-core";
import { applyViewport, getPageCDPSession } from "./launch";

/** Viewport dimensions accepted by runtime emulation. */
export interface EmulationViewport {
	/** Viewport width in CSS pixels. */
	width: number;
	/** Viewport height in CSS pixels. */
	height: number;
	/** Device scale factor. */
	scale?: number;
}

/** Coordinates accepted by runtime geolocation emulation. */
export interface EmulationGeolocation {
	/** Latitude in decimal degrees. */
	latitude: number;
	/** Longitude in decimal degrees. */
	longitude: number;
	/** Position accuracy in meters. */
	accuracy?: number;
}

/** HTTP basic-auth credentials applied to the page. */
export interface EmulationCredentials {
	/** Basic-auth username. */
	username: string;
	/** Basic-auth password. */
	password: string;
}

/** Custom network throughput in bytes per second plus latency in milliseconds. */
export interface EmulationNetworkConditions {
	/** Download throughput in bytes per second. */
	download: number;
	/** Upload throughput in bytes per second. */
	upload: number;
	/** Request latency in milliseconds. */
	latency: number;
}

/** Independently mergeable device, network, and media overrides for a browser tab. */
export interface BrowserEmulateOptions {
	/** Override viewport dimensions. */
	viewport?: EmulationViewport;
	/** Emulate a Playwright device profile. */
	device?: string;
	/** Override coordinates, or clear the override with `null`. */
	geolocation?: EmulationGeolocation | null;
	/** Toggle offline mode. */
	offline?: boolean;
	/** Override the preferred color scheme. */
	colorScheme?: "dark" | "light" | "no-preference";
	/** Toggle reduced-motion preference. */
	reducedMotion?: boolean;
	/** Set extra HTTP headers, or clear them with `null`. */
	headers?: Record<string, string> | null;
	/** Set HTTP basic-auth credentials, or clear them with `null`. */
	credentials?: EmulationCredentials | null;
	/** Set a user agent, or clear it with `null` while retaining an active device UA. */
	userAgent?: string | null;
	/** Set an ICU timezone, or clear it with `null`. */
	timezone?: string | null;
	/** Set a locale, or clear it with `null`. */
	locale?: string | null;
	/** Set a CPU slowdown factor, or clear it with `null`. */
	cpuThrottling?: number | null;
	/** Set a network preset/custom profile, or clear it with `null`. */
	network?: "slow3g" | "fast3g" | EmulationNetworkConditions | null;
}

/** Result of a clipboard operation, identifying whether Chromium or the worker shim handled it. */
export interface ClipboardActionResult {
	/** Chromium page clipboard or in-worker round-trip shim. */
	source: "page" | "shim";
}

/** Clipboard text plus the source that supplied it. */
export interface ClipboardReadResult extends ClipboardActionResult {
	/** Clipboard plain text. */
	text: string;
}

interface DeviceDescriptor {
	viewport: { width: number; height: number };
	userAgent: string;
	deviceScaleFactor: number;
	isMobile: boolean;
	hasTouch: boolean;
}

interface NetworkProfile {
	download: number;
	upload: number;
	latency: number;
	offline?: boolean;
}

type KnownDeviceMap = Readonly<Record<string, DeviceDescriptor>>;
type KnownNetworkMap = Readonly<Record<string, NetworkProfile>>;
interface PageClipboard {
	readText(): Promise<string>;
	writeText(text: string): Promise<void>;
}

interface PageClipboardNavigator extends Navigator {
	clipboard: PageClipboard;
}

type RuntimePermission = "geolocation" | "clipboard-read" | "clipboard-write";

const hasOwn = <K extends keyof BrowserEmulateOptions>(
	value: BrowserEmulateOptions,
	key: K,
): value is BrowserEmulateOptions & Required<Pick<BrowserEmulateOptions, K>> =>
	Object.prototype.hasOwnProperty.call(value, key);

function copyOptions(options: BrowserEmulateOptions): BrowserEmulateOptions {
	return structuredClone(options);
}

function pageOrigin(page: Page): string | null {
	try {
		const origin = new URL(page.url()).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/** Apply a page-scoped user-agent override that remains active across navigations. */
export async function applyUserAgentOverride(page: Page, userAgent: string): Promise<void> {
	const session = await getPageCDPSession(page);
	await session.send("Network.enable");
	await session.send("Network.setUserAgentOverride", { userAgent });
}

/** Owns persistent runtime emulation and clipboard state for one Playwright page. */
export class BrowserEmulationController {
	readonly #page: Page;
	readonly #devices: KnownDeviceMap;
	readonly #networkConditions: KnownNetworkMap;
	readonly #baseUserAgent: string;
	readonly #state: BrowserEmulateOptions = {};
	readonly #permissionsByOrigin = new Map<string, Set<RuntimePermission>>();
	#clipboardShim: string | undefined;
	#sessionPromise: Promise<CDPSession> | undefined;
	#fetchEnabled = false;
	#credentials: EmulationCredentials | null = null;
	readonly #requestPausedHandler = (event: Protocol.Fetch.RequestPausedEvent): void => {
		void this.#session()
			.then(session => session.send("Fetch.continueRequest", { requestId: event.requestId }))
			.catch(() => undefined);
	};
	readonly #authRequiredHandler = (event: Protocol.Fetch.AuthRequiredEvent): void => {
		const credentials = this.#credentials;
		const authChallengeResponse: Protocol.Fetch.AuthChallengeResponse = credentials
			? {
					response: "ProvideCredentials",
					username: credentials.username,
					password: credentials.password,
				}
			: { response: "Default" };
		void this.#session()
			.then(session => session.send("Fetch.continueWithAuth", { requestId: event.requestId, authChallengeResponse }))
			.catch(() => undefined);
	};
	readonly #navigationHandler: (frame: Frame) => void;

	constructor(page: Page, devices: KnownDeviceMap, networkConditions: KnownNetworkMap, baseUserAgent: string) {
		this.#page = page;
		this.#devices = devices;
		this.#networkConditions = networkConditions;
		this.#baseUserAgent = baseUserAgent;
		this.#navigationHandler = frame => {
			if (frame !== this.#page.mainFrame()) return;
			if (this.#state.geolocation) void this.#grantPermissions(["geolocation"]).catch(() => undefined);
		};
		page.on("framenavigated", this.#navigationHandler);
	}

	/** Return all Playwright device names in stable order. */
	devices(): string[] {
		return Object.keys(this.#devices).sort();
	}

	/** Merge supplied overrides, apply the effective state, and return a detached state snapshot. */
	async emulate(options: BrowserEmulateOptions = {}): Promise<BrowserEmulateOptions> {
		Object.assign(this.#state, copyOptions(options));
		await this.reapply();
		return copyOptions(this.#state);
	}

	/** Re-apply every active override after a browser lifecycle resume. */
	async reapply(): Promise<void> {
		const state = this.#state;
		const device = hasOwn(state, "device") ? this.#devices[state.device] : undefined;
		if (hasOwn(state, "device") && !device) {
			throw new ToolError(`Unknown Playwright device ${JSON.stringify(state.device)}. Use tab.devices().`);
		}
		const viewport = state.viewport ?? device?.viewport;
		if (viewport) {
			await applyViewport(this.#page, {
				width: viewport.width,
				height: viewport.height,
				deviceScaleFactor: state.viewport?.scale ?? device?.deviceScaleFactor,
			});
		}
		if (device) {
			const session = await this.#session();
			await session.send("Emulation.setDeviceMetricsOverride", {
				width: viewport!.width,
				height: viewport!.height,
				deviceScaleFactor: state.viewport?.scale ?? device.deviceScaleFactor,
				mobile: device.isMobile,
				screenWidth: device.viewport.width,
				screenHeight: device.viewport.height,
			});
			await session.send("Emulation.setTouchEmulationEnabled", { enabled: device.hasTouch, maxTouchPoints: 1 });
		}
		if (hasOwn(state, "userAgent") || device) {
			const userAgent = state.userAgent ?? device?.userAgent ?? this.#baseUserAgent;
			const session = await this.#session();
			await session.send("Network.setUserAgentOverride", { userAgent });
		}
		if (hasOwn(state, "geolocation")) {
			if (state.geolocation) {
				await this.#grantPermissions(["geolocation"]);
				await this.#page.context().setGeolocation(state.geolocation);
			} else {
				const session = await this.#session();
				await session.send("Emulation.clearGeolocationOverride");
			}
		}
		if (hasOwn(state, "network") || hasOwn(state, "offline")) {
			const conditions = this.#resolveNetworkConditions(state.network);
			const session = await this.#session();
			await session.send("Network.emulateNetworkConditions", {
				offline: state.offline ?? conditions?.offline ?? false,
				latency: conditions?.latency ?? 0,
				downloadThroughput: conditions?.download ?? -1,
				uploadThroughput: conditions?.upload ?? -1,
			});
		}
		if (hasOwn(state, "colorScheme") || hasOwn(state, "reducedMotion")) {
			const media: {
				colorScheme?: "dark" | "light" | "no-preference" | null;
				reducedMotion?: "reduce" | "no-preference" | null;
			} = {};
			if (hasOwn(state, "colorScheme")) media.colorScheme = state.colorScheme;
			if (hasOwn(state, "reducedMotion")) {
				media.reducedMotion = state.reducedMotion ? "reduce" : "no-preference";
			}
			await this.#page.emulateMedia(media);
		}
		if (hasOwn(state, "headers")) await this.#page.setExtraHTTPHeaders(state.headers ?? {});
		if (hasOwn(state, "credentials")) await this.#applyCredentials(state.credentials);
		if (hasOwn(state, "timezone")) {
			await (await this.#session()).send("Emulation.setTimezoneOverride", { timezoneId: state.timezone ?? "" });
		}
		if (hasOwn(state, "locale")) {
			await (await this.#session()).send("Emulation.setLocaleOverride", { locale: state.locale ?? "" });
		}
		if (hasOwn(state, "cpuThrottling")) {
			await (await this.#session()).send("Emulation.setCPUThrottlingRate", { rate: state.cpuThrottling ?? 1 });
		}
	}

	/** Read text through the page clipboard, falling back only to a prior shim write. */
	async clipboardRead(): Promise<ClipboardReadResult> {
		try {
			await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
			const text = await this.#page.evaluate(async () => {
				const pageNavigator = navigator as PageClipboardNavigator;
				// Chromium exposes this secure-context API in page realms even when the worker DOM lib omits it.
				return await pageNavigator.clipboard.readText();
			});
			if (this.#clipboardShim !== undefined && text !== this.#clipboardShim) {
				return { text: this.#clipboardShim, source: "shim" };
			}
			return { text, source: "page" };
		} catch (error) {
			if (this.#clipboardShim !== undefined) return { text: this.#clipboardShim, source: "shim" };
			throw new ToolError("The page clipboard is unavailable and no shim value has been written", { cause: error });
		}
	}

	/** Write clipboard text through the page, retaining a worker shim only when Chromium blocks it. */
	async clipboardWrite(text: string): Promise<ClipboardActionResult> {
		try {
			await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
			await this.#page.evaluate(async value => {
				const pageNavigator = navigator as PageClipboardNavigator;
				// Chromium exposes this secure-context API in page realms even when the worker DOM lib omits it.
				await pageNavigator.clipboard.writeText(value);
			}, text);
			this.#clipboardShim = text;
			return { source: "page" };
		} catch {
			this.#clipboardShim = text;
			return { source: "shim" };
		}
	}

	/** Copy the page's current selection using the platform keyboard shortcut. */
	async clipboardCopy(): Promise<ClipboardActionResult> {
		this.#clipboardShim = undefined;
		await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await this.#page.keyboard.down(modifier);
		try {
			await this.#page.keyboard.press("c");
		} finally {
			await this.#page.keyboard.up(modifier);
		}
		return { source: "page" };
	}

	/** Paste the page clipboard into the focused control using the platform keyboard shortcut. */
	async clipboardPaste(): Promise<ClipboardActionResult> {
		await this.#grantPermissions(["clipboard-read", "clipboard-write"]);
		const modifier = process.platform === "darwin" ? "Meta" : "Control";
		await this.#page.keyboard.down(modifier);
		try {
			await this.#page.keyboard.press("v");
		} finally {
			await this.#page.keyboard.up(modifier);
		}
		return { source: "page" };
	}

	/** Remove page listeners and release the CDP session owned by this controller. */
	dispose(): void {
		this.#page.off("framenavigated", this.#navigationHandler);
		const sessionPromise = this.#sessionPromise;
		const fetchEnabled = this.#fetchEnabled;
		this.#sessionPromise = undefined;
		this.#fetchEnabled = false;
		void sessionPromise
			?.then(async session => {
				session.off("Fetch.requestPaused", this.#requestPausedHandler);
				session.off("Fetch.authRequired", this.#authRequiredHandler);
				if (fetchEnabled) await session.send("Fetch.disable").catch(() => undefined);
				await session.detach().catch(() => undefined);
			})
			.catch(() => undefined);
	}

	#session(): Promise<CDPSession> {
		return (this.#sessionPromise ??= this.#page.context().newCDPSession(this.#page));
	}

	async #applyCredentials(credentials: EmulationCredentials | null): Promise<void> {
		this.#credentials = credentials;
		if (!credentials && !this.#fetchEnabled) return;
		const session = await this.#session();
		if (credentials && !this.#fetchEnabled) {
			session.on("Fetch.requestPaused", this.#requestPausedHandler);
			session.on("Fetch.authRequired", this.#authRequiredHandler);
			try {
				await session.send("Fetch.enable", {
					handleAuthRequests: true,
					patterns: [{ urlPattern: "*" }],
				});
				this.#fetchEnabled = true;
			} catch (error) {
				session.off("Fetch.requestPaused", this.#requestPausedHandler);
				session.off("Fetch.authRequired", this.#authRequiredHandler);
				throw error;
			}
		} else if (!credentials && this.#fetchEnabled) {
			session.off("Fetch.requestPaused", this.#requestPausedHandler);
			session.off("Fetch.authRequired", this.#authRequiredHandler);
			try {
				await session.send("Fetch.disable");
			} finally {
				this.#fetchEnabled = false;
			}
		}
	}

	#resolveNetworkConditions(value: BrowserEmulateOptions["network"]): NetworkProfile | null {
		if (value === null || value === undefined) return null;
		if (typeof value !== "string") return { ...value, offline: false };
		if (value !== "slow3g" && value !== "fast3g") {
			throw new ToolError(`Unknown network preset ${JSON.stringify(value)}. Expected "slow3g" or "fast3g".`);
		}
		const key = value === "slow3g" ? "Slow 3G" : "Fast 3G";
		const conditions = this.#networkConditions[key];
		if (!conditions) throw new ToolError(`Playwright network preset ${JSON.stringify(key)} is unavailable`);
		return conditions;
	}

	async #grantPermissions(permissions: RuntimePermission[]): Promise<void> {
		const origin = pageOrigin(this.#page);
		if (!origin) return;
		const granted = this.#permissionsByOrigin.get(origin) ?? new Set<RuntimePermission>();
		for (const permission of permissions) granted.add(permission);
		this.#permissionsByOrigin.set(origin, granted);
		await this.#page.context().grantPermissions([...granted], { origin });
	}
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";

import { Snowflake } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Protocol } from "devtools-protocol";
import type { CDPSession, Page } from "playwright-core";
import { resolveToCwd } from "../path-utils";

/** Options for starting a Chromium performance trace. */
export interface BrowserTraceStartOptions {
	/** Include screenshots in the trace. */
	screenshots?: boolean;
	/** Override the Chromium trace category list. */
	categories?: string[];
}

/** Options for saving a completed Chromium performance trace. */
export interface BrowserTraceStopOptions {
	/** Absolute or cwd-relative destination path. */
	path?: string;
}

/** Options for saving a completed Chromium CPU profile. */
export interface BrowserProfileStopOptions {
	/** Absolute or cwd-relative destination path. */
	path?: string;
}

/** Browser page metrics augmented with navigation-relative lifecycle durations. */
export interface BrowserMetrics {
	/** Named Chromium or lifecycle metric. */
	[name: string]: number;
	/** Milliseconds from navigation start through DOMContentLoaded. */
	domContentLoaded: number;
	/** Milliseconds from navigation start through load. */
	load: number;
}

function outputPath(requested: string | undefined, cwd: string, extension: string): string {
	if (requested) return resolveToCwd(requested, cwd);
	return path.join(os.tmpdir(), `omp-browser-${Snowflake.next()}.${extension}`);
}
const DEFAULT_TRACE_CATEGORIES = [
	"devtools.timeline",
	"v8.execute",
	"disabled-by-default-devtools.timeline",
	"disabled-by-default-devtools.timeline.frame",
	"disabled-by-default-devtools.timeline.stack",
];

async function saveTraceStream(session: CDPSession, handle: string, destination: string): Promise<void> {
	const output = fs.createWriteStream(destination);
	const outputError = new Promise<never>((_resolve, reject) => output.once("error", reject));
	void outputError.catch(() => undefined);
	try {
		for (;;) {
			const { data, eof, base64Encoded } = await Promise.race([session.send("IO.read", { handle }), outputError]);
			const chunk = base64Encoded ? Buffer.from(data, "base64") : data;
			if (chunk && !output.write(chunk)) await Promise.race([once(output, "drain"), outputError]);
			if (eof) break;
		}
		output.end();
		await Promise.race([once(output, "finish"), outputError]);
	} catch (error) {
		output.destroy();
		throw error;
	} finally {
		await session.send("IO.close", { handle }).catch(() => undefined);
	}
}

/** Stateful trace and CPU-profile controller for one Playwright page. */
export class BrowserTracingController {
	readonly #page: Page;
	#traceActive = false;
	#traceSession?: CDPSession;
	#profileSession?: CDPSession;

	constructor(page: Page) {
		this.#page = page;
	}

	/** Start Chromium tracing for this page's browser connection. */
	async traceStart(options: BrowserTraceStartOptions = {}): Promise<void> {
		if (this.#traceActive) throw new ToolError("tab.traceStart() cannot start while a trace is already active");
		const session = await this.#page.context().newCDPSession(this.#page);
		const categories = [...(options.categories ?? DEFAULT_TRACE_CATEGORIES)];
		if (options.screenshots && !categories.includes("disabled-by-default-devtools.screenshot")) {
			categories.push("disabled-by-default-devtools.screenshot");
		}
		try {
			await session.send("Tracing.start", {
				categories: categories.join(","),
				transferMode: "ReturnAsStream",
			});
			this.#traceSession = session;
			this.#traceActive = true;
		} catch (error) {
			await session.detach().catch(() => undefined);
			throw error;
		}
	}

	/** Stop Chromium tracing, save its JSON, and return the absolute path. */
	async traceStop(cwd: string, options: BrowserTraceStopOptions = {}): Promise<string> {
		const session = this.#traceSession;
		if (!this.#traceActive || !session) throw new ToolError("tab.traceStop() requires an active trace");
		const destination = outputPath(options.path, cwd, "json");
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		this.#traceActive = false;
		this.#traceSession = undefined;
		try {
			const stream = await this.#endTrace(session);
			if (!stream) throw new ToolError("Chromium tracing stopped without producing trace data");
			await saveTraceStream(session, stream, destination);
			return destination;
		} finally {
			await session.detach().catch(() => undefined);
		}
	}

	/** Start a Chromium DevTools CPU profile for the page. */
	async profileStart(): Promise<void> {
		if (this.#profileSession)
			throw new ToolError("tab.profileStart() cannot start while a profile is already active");
		const session = await this.#page.context().newCDPSession(this.#page);
		try {
			await session.send("Profiler.enable");
			await session.send("Profiler.start");
			this.#profileSession = session;
		} catch (error) {
			await session.detach().catch(() => undefined);
			throw error;
		}
	}

	/** Stop the active CPU profile, save it, and return the absolute path. */
	async profileStop(cwd: string, options: BrowserProfileStopOptions = {}): Promise<string> {
		const session = this.#profileSession;
		if (!session) throw new ToolError("tab.profileStop() requires an active profile");
		this.#profileSession = undefined;
		const destination = outputPath(options.path, cwd, "cpuprofile");
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		try {
			const { profile } = await session.send("Profiler.stop");
			await Bun.write(destination, JSON.stringify(profile));
			return destination;
		} finally {
			await session.send("Profiler.disable").catch(() => undefined);
			await session.detach().catch(() => undefined);
		}
	}

	/** Return Chromium Performance metrics plus navigation-relative lifecycle durations. */
	async metrics(): Promise<BrowserMetrics> {
		const session = await this.#page.context().newCDPSession(this.#page);
		try {
			await session.send("Performance.enable");
			const [{ metrics: pageMetrics }, timing] = await Promise.all([
				session.send("Performance.getMetrics"),
				this.#page.evaluate(() => {
					// The DOM library omits navigation timing fields from the supported entry-type overload.
					const pagePerformance = performance as unknown as {
						getEntriesByType(type: string): Array<{
							domContentLoadedEventEnd: number;
							loadEventEnd: number;
						}>;
					};
					const navigation = pagePerformance.getEntriesByType("navigation")[0];
					return {
						domContentLoadedEventEnd: navigation?.domContentLoadedEventEnd ?? 0,
						loadEventEnd: navigation?.loadEventEnd ?? 0,
					};
				}),
			]);
			const metrics: Record<string, number> = {};
			for (const { name, value } of pageMetrics) metrics[name] = value;
			return {
				...metrics,
				domContentLoaded: timing.domContentLoadedEventEnd,
				load: timing.loadEventEnd,
			};
		} finally {
			await session.send("Performance.disable").catch(() => undefined);
			await session.detach().catch(() => undefined);
		}
	}

	async #endTrace(session: CDPSession): Promise<string | undefined> {
		let resolveComplete: (event: Protocol.Tracing.TracingCompleteEvent) => void = () => {};
		const completed = new Promise<Protocol.Tracing.TracingCompleteEvent>(resolve => {
			resolveComplete = resolve;
		});
		const onComplete = (event: Protocol.Tracing.TracingCompleteEvent): void => resolveComplete(event);
		session.once("Tracing.tracingComplete", onComplete);
		try {
			await session.send("Tracing.end");
			return (await completed).stream;
		} finally {
			session.off("Tracing.tracingComplete", onComplete);
		}
	}

	/** Stop and discard active trace/profile state during tab teardown. */
	async dispose(): Promise<void> {
		const traceSession = this.#traceSession;
		this.#traceSession = undefined;
		this.#traceActive = false;
		if (traceSession) {
			try {
				const stream = await this.#endTrace(traceSession);
				if (stream) await traceSession.send("IO.close", { handle: stream }).catch(() => undefined);
			} catch {
				// The browser may already have closed the target.
			} finally {
				await traceSession.detach().catch(() => undefined);
			}
		}
		const session = this.#profileSession;
		this.#profileSession = undefined;
		if (session) {
			await session.send("Profiler.stop").catch(() => undefined);
			await session.send("Profiler.disable").catch(() => undefined);
			await session.detach().catch(() => undefined);
		}
	}
}

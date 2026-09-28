import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, Download, Page } from "playwright-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Completed download metadata returned by tab download helpers. */
export interface BrowserDownload {
	path: string;
	suggestedFilename: string;
	url: string;
	bytes: number;
}

interface DownloadWaiter {
	resolve(value: BrowserDownload): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** Owns tab-scoped downloads and their completion events. */
export class DownloadManager {
	readonly #page: Page;
	readonly #defaultDirectory: string;
	#directory?: string;
	#downloadHandler?: (download: Download) => void;
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: BrowserDownload[] = [];
	readonly #waiters: DownloadWaiter[] = [];

	constructor(_browser: Browser, page: Page, tabId: string) {
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
	}

	/** Enable downloads into an absolute directory, replacing the previous destination. */
	async enable(directory?: string): Promise<void> {
		const resolved = path.resolve(directory ?? this.#defaultDirectory);
		await fs.mkdir(resolved, { recursive: true });
		if (!this.#downloadHandler) {
			this.#downloadHandler = download => {
				void this.#complete(download).catch(error => {
					const detail = error instanceof Error ? error.message : String(error);
					this.#rejectNext(new ToolError(`Download failed for ${download.url()}: ${detail}`));
				});
			};
			this.#page.on("download", this.#downloadHandler);
		}
		this.#directory = resolved;
	}

	/** Wait for the next unclaimed completed download. */
	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		if (!this.#downloadHandler) await this.enable();
		const ready = this.#unclaimed.shift();
		if (ready) return { ...ready };
		if (signal?.aborted) throw signal.reason;
		const { promise, resolve, reject } = Promise.withResolvers<BrowserDownload>();
		const waiter: DownloadWaiter = { resolve, reject, signal };
		if (signal) {
			waiter.onAbort = () => {
				this.#removeWaiter(waiter);
				reject(signal.reason);
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		}
		this.#waiters.push(waiter);
		return promise;
	}

	/** Return every completed download for this tab. */
	list(): BrowserDownload[] {
		return this.#completed.map(download => ({ ...download }));
	}

	/** Detach event listeners and reject outstanding waits. */
	async close(): Promise<void> {
		if (this.#downloadHandler) this.#page.off("download", this.#downloadHandler);
		this.#downloadHandler = undefined;
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new ToolError("Tab closed while waiting for a download"));
		}
	}

	async #complete(downloadEvent: Download): Promise<void> {
		const suggestedFilename = downloadEvent.suggestedFilename();
		const downloadPath = path.join(this.#directory ?? this.#defaultDirectory, suggestedFilename);
		await downloadEvent.saveAs(downloadPath);
		const failure = await downloadEvent.failure();
		if (failure) throw new ToolError(`Download failed for ${downloadEvent.url()}: ${failure}`);
		const stat = await fs.stat(downloadPath);
		const download: BrowserDownload = {
			path: downloadPath,
			suggestedFilename,
			url: downloadEvent.url(),
			bytes: stat.size,
		};
		this.#completed.push(download);
		const waiter = this.#waiters.shift();
		if (!waiter) {
			this.#unclaimed.push(download);
			return;
		}
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve({ ...download });
	}

	#rejectNext(error: ToolError): void {
		const waiter = this.#waiters.shift();
		if (!waiter) return;
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.reject(error);
	}

	#removeWaiter(waiter: DownloadWaiter): void {
		const index = this.#waiters.indexOf(waiter);
		if (index >= 0) this.#waiters.splice(index, 1);
	}
}

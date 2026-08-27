import * as fsp from "node:fs/promises";
import * as path from "node:path";

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT"
	);
}

import type { GradivusSettings, UpdateGradivusSettingsInput } from "../shared/contracts";
import { defaultWorkspacePath } from "./backend-path";

export function defaultGradivusSettings(defaultPath = defaultWorkspacePath()): GradivusSettings {
	return {
		theme: "dark",
		confirmCloseTab: true,
		ui: {
			density: "comfortable",
			reduceMotion: false,
			showToolDetails: true,
		},
		terminal: {
			shell:
				process.platform === "win32"
					? (process.env.COMSPEC ?? "cmd.exe")
					: process.platform === "darwin"
						? "/bin/zsh"
						: (process.env.SHELL ?? "/bin/bash"),
			fontSize: 14,
			fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
			cursorBlink: true,
			cursorStyle: "bar",
			scrollback: 10000,
		},
		browser: {
			defaultUrl: "https://omp.sh",
			searchEngine: "https://www.google.com/search?q=%s",
		},
		workspace: {
			defaultPath,
		},
	};
}

function mergeGradivusSettings(base: GradivusSettings, updates: UpdateGradivusSettingsInput): GradivusSettings {
	return {
		theme:
			updates.theme === "light" || updates.theme === "system"
				? updates.theme
				: updates.theme === "dark"
					? "dark"
					: base.theme,
		confirmCloseTab: typeof updates.confirmCloseTab === "boolean" ? updates.confirmCloseTab : base.confirmCloseTab,
		ui: {
			...base.ui,
			...(updates.ui?.density === "comfortable" || updates.ui?.density === "compact"
				? { density: updates.ui.density }
				: {}),
			...(typeof updates.ui?.reduceMotion === "boolean" ? { reduceMotion: updates.ui.reduceMotion } : {}),
			...(typeof updates.ui?.showToolDetails === "boolean" ? { showToolDetails: updates.ui.showToolDetails } : {}),
		},
		terminal: {
			...base.terminal,
			...(typeof updates.terminal?.shell === "string" && updates.terminal.shell.trim().length > 0
				? { shell: updates.terminal.shell.trim() }
				: {}),
			...(typeof updates.terminal?.fontSize === "number" && Number.isFinite(updates.terminal.fontSize)
				? { fontSize: Math.max(8, Math.min(48, Math.round(updates.terminal.fontSize))) }
				: {}),
			...(typeof updates.terminal?.fontFamily === "string" && updates.terminal.fontFamily.trim().length > 0
				? { fontFamily: updates.terminal.fontFamily.trim() }
				: {}),
			...(typeof updates.terminal?.cursorBlink === "boolean" ? { cursorBlink: updates.terminal.cursorBlink } : {}),
			...(updates.terminal?.cursorStyle === "block" ||
			updates.terminal?.cursorStyle === "underline" ||
			updates.terminal?.cursorStyle === "bar"
				? { cursorStyle: updates.terminal.cursorStyle }
				: {}),
			...(typeof updates.terminal?.scrollback === "number" && Number.isFinite(updates.terminal.scrollback)
				? { scrollback: Math.max(500, Math.min(100_000, Math.round(updates.terminal.scrollback))) }
				: {}),
		},
		browser: {
			...base.browser,
			...(typeof updates.browser?.defaultUrl === "string" && updates.browser.defaultUrl.trim().length > 0
				? { defaultUrl: updates.browser.defaultUrl.trim() }
				: {}),
			...(typeof updates.browser?.searchEngine === "string" && updates.browser.searchEngine.trim().length > 0
				? { searchEngine: updates.browser.searchEngine.trim() }
				: {}),
		},
		workspace: {
			...base.workspace,
			...(typeof updates.workspace?.defaultPath === "string" && updates.workspace.defaultPath.trim().length > 0
				? { defaultPath: updates.workspace.defaultPath.trim() }
				: {}),
		},
	};
}

/**
 * Read-only view of the persisted settings. Unlike AppSettingsStore.load(),
 * this never repairs or writes the file; unreadable content yields defaults.
 */
export async function loadPersistedGradivusSettings(
	userDataPath: string,
	initialDefaultPath?: string,
): Promise<GradivusSettings> {
	const defaults = defaultGradivusSettings(initialDefaultPath);
	try {
		const content = await fsp.readFile(path.join(userDataPath, "settings.json"), "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			return mergeGradivusSettings(defaults, parsed as UpdateGradivusSettingsInput);
		}
	} catch {
		// Missing or corrupt settings file: fall back to defaults without writing.
	}
	return defaults;
}

export class AppSettingsStore {
	readonly #filePath: string;
	readonly #defaultWorkspacePath: string;
	#settings: GradivusSettings;
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(userDataPath: string, initialDefaultPath?: string) {
		this.#filePath = path.join(userDataPath, "settings.json");
		this.#defaultWorkspacePath = initialDefaultPath ?? defaultWorkspacePath();
		this.#settings = defaultGradivusSettings(this.#defaultWorkspacePath);
	}

	get settings(): GradivusSettings {
		return structuredClone(this.#settings);
	}

	async load(): Promise<GradivusSettings> {
		try {
			const content = await fsp.readFile(this.#filePath, "utf8");
			const parsed = JSON.parse(content) as unknown;
			if (typeof parsed === "object" && parsed !== null) {
				this.#settings = mergeGradivusSettings(this.#settings, parsed as UpdateGradivusSettingsInput);
			}
		} catch (error) {
			if (!isEnoent(error)) {
				// Corrupt/invalid settings file: write clean defaults
				await this.save();
			}
		}
		return this.settings;
	}

	async update(updates: UpdateGradivusSettingsInput): Promise<GradivusSettings> {
		return this.#enqueueWrite(async () => {
			const snapshot = mergeGradivusSettings(this.#settings, updates);
			await this.#writeSnapshot(snapshot);
			this.#settings = snapshot;
			return structuredClone(snapshot);
		});
	}

	async reset(): Promise<GradivusSettings> {
		return this.#enqueueWrite(async () => {
			const snapshot = defaultGradivusSettings(this.#defaultWorkspacePath);
			await this.#writeSnapshot(snapshot);
			this.#settings = snapshot;
			return structuredClone(snapshot);
		});
	}

	async save(): Promise<void> {
		await this.#enqueueWrite(async () => {
			await this.#writeSnapshot(this.#settings);
		});
	}

	#enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.#writeQueue.then(operation);
		this.#writeQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	}

	async #writeSnapshot(snapshot: GradivusSettings): Promise<void> {
		await fsp.mkdir(path.dirname(this.#filePath), { recursive: true });
		const tempFile = `${this.#filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
		await fsp.writeFile(tempFile, JSON.stringify(snapshot, null, 2), "utf8");
		await fsp.rename(tempFile, this.#filePath);
	}
}

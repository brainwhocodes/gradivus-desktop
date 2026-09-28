import type { Disposable, Page } from "playwright-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Serializable description of an init script registered on one tab. */
export interface InitScriptInfo {
	id: string;
	source: string;
}

/** Registers, removes, and lists document-start scripts for one page. */
export class InitScriptManager {
	readonly #page: Page;
	readonly #scripts = new Map<string, { info: InitScriptInfo; disposable: Disposable }>();

	constructor(page: Page) {
		this.#page = page;
	}

	/** Register source for every future document and return its stable identifier. */
	async add(source: string): Promise<{ id: string }> {
		if (typeof source !== "string") throw new ToolError("tab.addInitScript(source) requires a string");
		const disposable = await this.#page.addInitScript({ content: source });
		const id = crypto.randomUUID();
		const info = { id, source };
		this.#scripts.set(id, { info, disposable });
		return { id };
	}

	/** Remove one previously registered script. */
	async remove(id: string): Promise<void> {
		if (typeof id !== "string" || id.length === 0) {
			throw new ToolError("tab.removeInitScript(id) requires a non-empty script id");
		}
		const script = this.#scripts.get(id);
		if (!script) throw new ToolError(`Unknown init script ${JSON.stringify(id)}`);
		await script.disposable.dispose();
		this.#scripts.delete(id);
	}

	/** Return registered scripts in registration order. */
	list(): InitScriptInfo[] {
		return [...this.#scripts.values()].map(({ info }) => ({ ...info }));
	}
}

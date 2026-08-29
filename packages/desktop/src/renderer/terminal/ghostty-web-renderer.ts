import { FitAddon, Ghostty, Terminal } from "ghostty-web";
import ghosttyWasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import type { CreateTerminalRendererOptions, TerminalRenderer, TerminalRendererAppearance } from "./terminal-renderer";

let cachedGhosttyPromise: Promise<Ghostty> | undefined;

export function loadGhosttyWasm(wasmUrl: string = ghosttyWasmUrl): Promise<Ghostty> {
	if (!cachedGhosttyPromise) {
		cachedGhosttyPromise = Ghostty.load(wasmUrl).catch(error => {
			cachedGhosttyPromise = undefined;
			throw error;
		});
	}
	return cachedGhosttyPromise;
}

export function resetGhosttyWasmCacheForTesting(): void {
	cachedGhosttyPromise = undefined;
}

export async function createGhosttyWebRenderer(options: CreateTerminalRendererOptions): Promise<TerminalRenderer> {
	const ghostty = await loadGhosttyWasm(ghosttyWasmUrl);
	const terminal = new Terminal({
		cols: options.cols,
		rows: options.rows,
		fontSize: options.configuration.fontSize,
		fontFamily: options.configuration.fontFamily,
		cursorBlink: options.configuration.cursorBlink,
		cursorStyle: options.configuration.cursorStyle,
		scrollback: options.configuration.scrollback,
		theme: options.configuration.theme,
		ghostty,
	});

	terminal.open(options.element);
	// Ghostty uses the host as its editable keyboard surface and overwrites its
	// ARIA role/name. Keep that behavior while exposing the host as the drawer's
	// shell region; Ghostty's nested textarea remains the input textbox.
	options.element.setAttribute("role", "region");
	options.element.setAttribute("aria-label", "Shell terminal");
	options.element.removeAttribute("aria-multiline");
	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);

	let lastCols = options.cols;
	let lastRows = options.rows;
	let disposed = false;

	const notifyResize = (cols: number, rows: number): void => {
		const nextCols = Math.max(2, Math.min(500, cols));
		const nextRows = Math.max(2, Math.min(500, rows));
		if (nextCols !== lastCols || nextRows !== lastRows) {
			lastCols = nextCols;
			lastRows = nextRows;
			options.onResize(nextCols, nextRows);
		}
	};

	const dataDisposable = terminal.onData(data => {
		options.onData(data);
	});

	const resizeDisposable = terminal.onResize(({ cols, rows }) => {
		notifyResize(cols, rows);
	});

	fitAddon.observeResize();

	return {
		kind: "ghostty-web",
		write(data: string): void {
			if (disposed) return;
			terminal.write(data);
		},
		fit(): void {
			if (disposed) return;
			fitAddon.fit();
			notifyResize(terminal.cols, terminal.rows);
		},
		focus(): void {
			if (disposed) return;
			terminal.focus();
		},
		updateAppearance(appearance: TerminalRendererAppearance): void {
			if (disposed) return;
			terminal.options.theme = appearance.theme;
			terminal.options.cursorBlink = appearance.cursorBlink;
			terminal.options.cursorStyle = appearance.cursorStyle;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			resizeDisposable.dispose();
			dataDisposable.dispose();
			fitAddon.dispose();
			terminal.dispose();
		},
	};
}

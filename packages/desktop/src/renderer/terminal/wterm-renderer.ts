import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
import wtermGhosttyWasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url";
import type { DesktopTerminalTheme } from "../../shared/theme-palette";
import type { CreateTerminalRendererOptions, TerminalRenderer, TerminalRendererAppearance } from "./terminal-renderer";

const WTERM_CSS_VARIABLES: readonly string[] = [
	"--term-fg",
	"--term-bg",
	"--term-cursor",
	"--term-selection-bg",
	"--term-selection-fg",
	"--term-font-family",
	"--term-font-size",
	"--term-line-height",
	"--term-row-height",
	...Array.from({ length: 16 }, (_, index) => `--term-color-${index}`),
];

function applyWtermTheme(element: HTMLElement, theme: DesktopTerminalTheme): void {
	element.style.setProperty("--term-fg", theme.foreground);
	element.style.setProperty("--term-bg", theme.background);
	element.style.setProperty("--term-cursor", theme.cursor);
	element.style.setProperty("--term-selection-bg", theme.selectionBackground);
	element.style.setProperty("--term-selection-fg", theme.selectionForeground);

	element.style.setProperty("--term-color-0", theme.black);
	element.style.setProperty("--term-color-1", theme.red);
	element.style.setProperty("--term-color-2", theme.green);
	element.style.setProperty("--term-color-3", theme.yellow);
	element.style.setProperty("--term-color-4", theme.blue);
	element.style.setProperty("--term-color-5", theme.magenta);
	element.style.setProperty("--term-color-6", theme.cyan);
	element.style.setProperty("--term-color-7", theme.white);
	element.style.setProperty("--term-color-8", theme.brightBlack);
	element.style.setProperty("--term-color-9", theme.brightRed);
	element.style.setProperty("--term-color-10", theme.brightGreen);
	element.style.setProperty("--term-color-11", theme.brightYellow);
	element.style.setProperty("--term-color-12", theme.brightBlue);
	element.style.setProperty("--term-color-13", theme.brightMagenta);
	element.style.setProperty("--term-color-14", theme.brightCyan);
	element.style.setProperty("--term-color-15", theme.brightWhite);
}

function cleanWtermHost(element: HTMLElement): void {
	element.removeAttribute("data-terminal-cursor-style");
	element.classList.remove("cursor-blink", "wterm", "link-modifier-active", "focused");
	for (const prop of WTERM_CSS_VARIABLES) {
		element.style.removeProperty(prop);
	}
}

export async function createWtermRenderer(options: CreateTerminalRendererOptions): Promise<TerminalRenderer> {
	const element = options.element;
	const config = options.configuration;

	element.style.setProperty("--term-font-family", config.fontFamily);
	element.style.setProperty("--term-font-size", `${config.fontSize}px`);
	element.style.setProperty("--term-line-height", "1.2");
	element.style.setProperty("--term-row-height", `${Math.ceil(config.fontSize * 1.2)}px`);
	applyWtermTheme(element, config.theme);
	element.setAttribute("data-terminal-cursor-style", config.cursorStyle);

	const core = await GhosttyCore.load({
		wasmPath: wtermGhosttyWasmUrl,
		scrollbackLimit: config.scrollback,
		foregroundColor: config.theme.foreground,
		backgroundColor: config.theme.background,
	});

	let lastCols = options.cols;
	let lastRows = options.rows;
	let disposed = false;

	const guardedOnResize = (cols: number, rows: number): void => {
		if (disposed) return;
		const nextCols = Math.max(2, Math.min(500, cols));
		const nextRows = Math.max(2, Math.min(500, rows));
		if (nextCols !== lastCols || nextRows !== lastRows) {
			lastCols = nextCols;
			lastRows = nextRows;
			options.onResize(nextCols, nextRows);
		}
	};

	let term: WTerm | undefined = new WTerm(element, {
		core,
		cols: options.cols,
		rows: options.rows,
		autoResize: true,
		cursorBlink: config.cursorBlink,
		onData: options.onData,
		onResize: guardedOnResize,
	});

	await term.init();

	return {
		kind: "wterm-dom",
		write(data: string): void {
			if (disposed || !term) return;
			term.write(data);
		},
		fit(): void {
			// Intentionally a no-op because autoResize: true makes WTerm's ResizeObserver authoritative.
		},
		focus(): void {
			if (disposed || !term) return;
			term.focus();
		},
		updateAppearance(appearance: TerminalRendererAppearance): void {
			if (disposed) return;
			applyWtermTheme(element, appearance.theme);
			element.setAttribute("data-terminal-cursor-style", appearance.cursorStyle);
			if (appearance.cursorBlink) {
				element.classList.add("cursor-blink");
			} else {
				element.classList.remove("cursor-blink");
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			if (term) {
				term.destroy();
				term = undefined;
			}
			cleanWtermHost(element);
		},
	};
}

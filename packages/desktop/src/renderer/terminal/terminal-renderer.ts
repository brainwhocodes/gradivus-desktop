import type { DesktopTerminalTheme } from "../../shared/theme-palette";
import { createGhosttyWebRenderer } from "./ghostty-web-renderer";
import { createWtermRenderer } from "./wterm-renderer";

export type TerminalRendererKind = "ghostty-web" | "wterm-dom";

export interface TerminalRendererConfiguration {
	fontSize: number;
	fontFamily: string;
	cursorBlink: boolean;
	cursorStyle: "block" | "underline" | "bar";
	scrollback: number;
	theme: DesktopTerminalTheme;
}

export type TerminalRendererAppearance = Pick<TerminalRendererConfiguration, "cursorBlink" | "cursorStyle" | "theme">;

export interface CreateTerminalRendererOptions {
	element: HTMLElement;
	cols: number;
	rows: number;
	configuration: TerminalRendererConfiguration;
	onData(data: string): void;
	onResize(cols: number, rows: number): void;
}

export interface TerminalRenderer {
	readonly kind: TerminalRendererKind;
	write(data: string): void;
	fit(): Promise<void> | void;
	focus(): void;
	updateAppearance(appearance: TerminalRendererAppearance): void;
	dispose(): void;
}

export function selectTerminalRenderer(platform: NodeJS.Platform): TerminalRendererKind {
	return platform === "win32" ? "wterm-dom" : "ghostty-web";
}

export async function createTerminalRenderer(
	platform: NodeJS.Platform,
	options: CreateTerminalRendererOptions,
): Promise<TerminalRenderer> {
	const kind = selectTerminalRenderer(platform);
	if (kind === "wterm-dom") {
		return createWtermRenderer(options);
	}
	return createGhosttyWebRenderer(options);
}

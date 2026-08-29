import type { DesktopTerminalTheme } from "../../shared/theme-palette";
import { createGhosttyWebRenderer } from "./ghostty-web-renderer";

export type TerminalRendererKind = "ghostty-web";

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

export function selectTerminalRenderer(_platform: NodeJS.Platform): TerminalRendererKind {
	return "ghostty-web";
}

export async function createTerminalRenderer(
	_platform: NodeJS.Platform,
	options: CreateTerminalRendererOptions,
): Promise<TerminalRenderer> {
	return createGhosttyWebRenderer(options);
}

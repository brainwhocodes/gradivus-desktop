import type { GradivusSettings } from "./contracts";

export type ResolvedTheme = "dark" | "light";

export interface DesktopTerminalTheme {
	background: string;
	foreground: string;
	cursor: string;
	cursorAccent: string;
	selectionBackground: string;
	selectionForeground: string;
	black: string;
	red: string;
	green: string;
	yellow: string;
	blue: string;
	magenta: string;
	cyan: string;
	white: string;
	brightBlack: string;
	brightRed: string;
	brightGreen: string;
	brightYellow: string;
	brightBlue: string;
	brightMagenta: string;
	brightCyan: string;
	brightWhite: string;
}

export interface DesktopNativePalette {
	windowBackground: string;
	browserBackground: string;
	shell: string;
	shellRaised: string;
	shellHover: string;
	chatCanvas: string;
	codeSurface: string;
	foreground: string;
	foregroundStrong: string;
	foregroundMuted: string;
	foregroundDisabled: string;
	line: string;
	lineSoft: string;
	accent: string;
	accentHover: string;
	accentSurface: string;
	accentBoundary: string;
	accentForeground: string;
	danger: string;
	dangerSurface: string;
	dangerBoundary: string;
	dangerForeground: string;
	success: string;
	successSurface: string;
	successBoundary: string;
	successForeground: string;
	warning: string;
	warningSurface: string;
	warningBoundary: string;
	warningForeground: string;
	selectionSurface: string;
	selectionForeground: string;
	focusInner: string;
	focusOuter: string;
	shadowColor: string;
	backdrop: string;
	terminal: DesktopTerminalTheme;
}

function createTerminalTheme(
	palette: Omit<DesktopNativePalette, "terminal">,
	theme: ResolvedTheme,
): DesktopTerminalTheme {
	const dark = theme === "dark";
	return {
		background: palette.windowBackground,
		foreground: palette.foreground,
		cursor: palette.foreground,
		cursorAccent: palette.windowBackground,
		selectionBackground: palette.selectionSurface,
		selectionForeground: palette.selectionForeground,
		black: dark ? "#b6b6b6" : "#000000",
		red: dark ? "#e99191" : "#7f1d1d",
		green: dark ? "#86d49a" : "#14532d",
		yellow: dark ? "#ffd38a" : "#5f3700",
		blue: dark ? "#d1d1d1" : "#333333",
		magenta: dark ? "#e99191" : "#7f1d1d",
		cyan: dark ? "#d1d1d1" : "#333333",
		white: dark ? "#d1d1d1" : "#4f4f4f",
		brightBlack: dark ? "#d1d1d1" : "#4f4f4f",
		brightRed: dark ? "#fff4f4" : "#641414",
		brightGreen: dark ? "#86d49a" : "#14532d",
		brightYellow: dark ? "#ffd38a" : "#5f3700",
		brightBlue: dark ? "#ffffff" : "#000000",
		brightMagenta: dark ? "#fff4f4" : "#641414",
		brightCyan: dark ? "#ffffff" : "#000000",
		brightWhite: dark ? "#ffffff" : "#000000",
	};
}

const DARK_PALETTE: Omit<DesktopNativePalette, "terminal"> = {
	windowBackground: "#0d0d0d",
	browserBackground: "#0d0d0d",
	shell: "#141414",
	shellRaised: "#1c1c1c",
	shellHover: "#292929",
	chatCanvas: "#101010",
	codeSurface: "#181818",
	foreground: "#ffffff",
	foregroundStrong: "#ffffff",
	foregroundMuted: "#d1d1d1",
	foregroundDisabled: "#b6b6b6",
	line: "#747474",
	lineSoft: "#454545",
	accent: "#7f1d1d",
	accentHover: "#991b1b",
	accentSurface: "#240909",
	accentBoundary: "#d16a6a",
	accentForeground: "#ffffff",
	danger: "#7f1d1d",
	dangerSurface: "#240909",
	dangerBoundary: "#d16a6a",
	dangerForeground: "#ffffff",
	success: "#14532d",
	successSurface: "#07140c",
	successBoundary: "#86d49a",
	successForeground: "#ffffff",
	warning: "#5f3700",
	warningSurface: "#171004",
	warningBoundary: "#ffd38a",
	warningForeground: "#ffffff",
	selectionSurface: "#4a0f0f",
	selectionForeground: "#ffffff",
	focusInner: "#ffffff",
	focusOuter: "#000000",
	shadowColor: "rgba(0, 0, 0, 0.72)",
	backdrop: "rgba(0, 0, 0, 0.78)",
};

const LIGHT_PALETTE: Omit<DesktopNativePalette, "terminal"> = {
	windowBackground: "#ffffff",
	browserBackground: "#ffffff",
	shell: "#fafafa",
	shellRaised: "#ffffff",
	shellHover: "#f2f2f2",
	chatCanvas: "#ffffff",
	codeSurface: "#f5f5f5",
	foreground: "#000000",
	foregroundStrong: "#000000",
	foregroundMuted: "#333333",
	foregroundDisabled: "#4b4b4b",
	line: "#858585",
	lineSoft: "#d4d4d4",
	accent: "#7f1d1d",
	accentHover: "#641414",
	accentSurface: "#f4e7e7",
	accentBoundary: "#7f1d1d",
	accentForeground: "#ffffff",
	danger: "#7f1d1d",
	dangerSurface: "#f4e7e7",
	dangerBoundary: "#7f1d1d",
	dangerForeground: "#ffffff",
	success: "#14532d",
	successSurface: "#edf8f0",
	successBoundary: "#14532d",
	successForeground: "#ffffff",
	warning: "#5f3700",
	warningSurface: "#fff5e0",
	warningBoundary: "#5f3700",
	warningForeground: "#ffffff",
	selectionSurface: "#f4e7e7",
	selectionForeground: "#000000",
	focusInner: "#ffffff",
	focusOuter: "#000000",
	shadowColor: "rgba(0, 0, 0, 0.18)",
	backdrop: "rgba(0, 0, 0, 0.46)",
};

export const DESKTOP_THEME_PALETTES: Record<ResolvedTheme, DesktopNativePalette> = {
	dark: { ...DARK_PALETTE, terminal: createTerminalTheme(DARK_PALETTE, "dark") },
	light: { ...LIGHT_PALETTE, terminal: createTerminalTheme(LIGHT_PALETTE, "light") },
};

export function resolveTheme(theme: GradivusSettings["theme"], systemDark: boolean): ResolvedTheme {
	if (theme === "dark" || theme === "light") return theme;
	return systemDark ? "dark" : "light";
}

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
		black: dark ? "#bcbcbc" : "#000000",
		red: dark ? "#e58e90" : "#843a3f",
		green: dark ? "#86d49a" : "#14532d",
		yellow: dark ? "#ffd38a" : "#5f3700",
		blue: dark ? "#d6d6d6" : "#333333",
		magenta: dark ? "#e58e90" : "#843a3f",
		cyan: dark ? "#d6d6d6" : "#333333",
		white: dark ? "#d6d6d6" : "#494949",
		brightBlack: dark ? "#d6d6d6" : "#494949",
		brightRed: dark ? "#ffd1d9" : "#641723",
		brightGreen: dark ? "#86d49a" : "#14532d",
		brightYellow: dark ? "#ffd38a" : "#5f3700",
		brightBlue: dark ? "#ffffff" : "#000000",
		brightMagenta: dark ? "#ffd1d9" : "#641723",
		brightCyan: dark ? "#ffffff" : "#000000",
		brightWhite: dark ? "#ffffff" : "#000000",
	};
}

const DARK_PALETTE: Omit<DesktopNativePalette, "terminal"> = {
	windowBackground: "#111111",
	browserBackground: "#111111",
	shell: "#191919",
	shellRaised: "#202020",
	shellHover: "#2a2a2a",
	chatCanvas: "#141414",
	codeSurface: "#1c1c1c",
	foreground: "#ffffff",
	foregroundStrong: "#ffffff",
	foregroundMuted: "#d6d6d6",
	foregroundDisabled: "#bcbcbc",
	line: "#747474",
	lineSoft: "#454545",
	accent: "#843a3f",
	accentHover: "#8c3f44",
	accentSurface: "#201314",
	accentBoundary: "#e58e90",
	accentForeground: "#ffffff",
	danger: "#843a3f",
	dangerSurface: "#201314",
	dangerBoundary: "#e58e90",
	dangerForeground: "#ffffff",
	success: "#14532d",
	successSurface: "#07140c",
	successBoundary: "#86d49a",
	successForeground: "#ffffff",
	warning: "#5f3700",
	warningSurface: "#171004",
	warningBoundary: "#ffd38a",
	warningForeground: "#ffffff",
	selectionSurface: "#3b2022",
	selectionForeground: "#ffffff",
	focusInner: "#ffffff",
	focusOuter: "#000000",
	shadowColor: "rgba(0, 0, 0, 0.72)",
	backdrop: "rgba(0, 0, 0, 0.78)",
};

const LIGHT_PALETTE: Omit<DesktopNativePalette, "terminal"> = {
	windowBackground: "#ffffff",
	browserBackground: "#ffffff",
	shell: "#f9f9f9",
	shellRaised: "#ffffff",
	shellHover: "#f0f0f0",
	chatCanvas: "#ffffff",
	codeSurface: "#f7f7f7",
	foreground: "#000000",
	foregroundStrong: "#000000",
	foregroundMuted: "#333333",
	foregroundDisabled: "#494949",
	line: "#7f7f7f",
	lineSoft: "#d4d4d4",
	accent: "#843a3f",
	accentHover: "#733136",
	accentSurface: "#feebec",
	accentBoundary: "#843a3f",
	accentForeground: "#ffffff",
	danger: "#843a3f",
	dangerSurface: "#feebec",
	dangerBoundary: "#843a3f",
	dangerForeground: "#ffffff",
	success: "#14532d",
	successSurface: "#edf8f0",
	successBoundary: "#14532d",
	successForeground: "#ffffff",
	warning: "#5f3700",
	warningSurface: "#fff5e0",
	warningBoundary: "#5f3700",
	warningForeground: "#ffffff",
	selectionSurface: "#feebec",
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

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { relativeLuminance } from "@oh-my-pi/pi-utils/color";
import { DESKTOP_THEME_PALETTES, type DesktopTerminalTheme, type ResolvedTheme } from "../src/shared/theme-palette";

const CSS_COLOR_ROLES = [
	"--window-background",
	"--browser",
	"--shell",
	"--shell-raised",
	"--shell-hover",
	"--chat-canvas",
	"--code-surface",
	"--line",
	"--line-soft",
	"--foreground",
	"--foreground-strong",
	"--foreground-muted",
	"--foreground-disabled",
	"--accent",
	"--accent-hover",
	"--accent-surface",
	"--accent-boundary",
	"--accent-foreground",
	"--danger",
	"--danger-surface",
	"--danger-boundary",
	"--danger-foreground",
	"--success",
	"--success-surface",
	"--success-boundary",
	"--success-foreground",
	"--warning",
	"--warning-surface",
	"--warning-boundary",
	"--warning-foreground",
	"--selection-surface",
	"--selection-foreground",
	"--focus-inner",
	"--focus-outer",
	"--focus-ring",
	"--focus-ring-contrast",
	"--placeholder",
	"--terminal-background",
	"--terminal-foreground",
	"--terminal-shadow",
	"--shadow-color",
	"--backdrop",
] as const;

type CssColorRole = (typeof CSS_COLOR_ROLES)[number];

type SampledThemeColors = Record<CssColorRole | "rootBackground" | "rootForeground", string>;

interface ParsedCssColor {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}

function parseCssColor(value: string): ParsedCssColor | undefined {
	const normalized = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]+)$/.exec(normalized)?.[1];
	if (hex && (hex.length === 3 || hex.length === 4 || hex.length === 6 || hex.length === 8)) {
		const digits = hex.length < 5 ? hex.split("").map(digit => `${digit}${digit}`).join("") : hex;
		return {
			red: Number.parseInt(digits.slice(0, 2), 16),
			green: Number.parseInt(digits.slice(2, 4), 16),
			blue: Number.parseInt(digits.slice(4, 6), 16),
			alpha: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
		};
	}

	const functionMatch = /^(rgba?)\((.*)\)$/.exec(normalized);
	if (!functionMatch) return undefined;
	const components = functionMatch[2].split("/");
	const channels = components[0].trim().split(/[\s,]+/);
	const alphaValue = components[1]?.trim() ?? channels[3];
	if (channels.length < 3 || channels.length > 4) return undefined;
	const parseChannel = (channel: string): number | undefined => {
		const percentage = channel.endsWith("%");
		const parsed = Number.parseFloat(percentage ? channel.slice(0, -1) : channel);
		if (!Number.isFinite(parsed)) return undefined;
		return Math.max(0, Math.min(255, Math.round(percentage ? (parsed * 255) / 100 : parsed)));
	};
	const parseAlpha = (alpha: string | undefined): number | undefined => {
		if (alpha === undefined) return 1;
		const percentage = alpha.endsWith("%");
		const parsed = Number.parseFloat(percentage ? alpha.slice(0, -1) : alpha);
		if (!Number.isFinite(parsed)) return undefined;
		return Math.max(0, Math.min(1, percentage ? parsed / 100 : parsed));
	};
	const red = parseChannel(channels[0]);
	const green = parseChannel(channels[1]);
	const blue = parseChannel(channels[2]);
	const alpha = parseAlpha(alphaValue);
	if (red === undefined || green === undefined || blue === undefined || alpha === undefined) return undefined;
	return { red, green, blue, alpha };
}

export function canonicalizeCssColor(value: string): string {
	const parsed = parseCssColor(value);
	if (!parsed) return value.trim().toLowerCase();
	const alphaByte = Math.round(parsed.alpha * 255);
	const channels = [parsed.red, parsed.green, parsed.blue].map(channel => channel.toString(16).padStart(2, "0")).join("");
	if (alphaByte === 255) return `#${channels}`;
	const alpha = (alphaByte / 255).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
	return `rgba(${parsed.red}, ${parsed.green}, ${parsed.blue}, ${alpha})`;
}

function canonicalizeThemeColors(colors: SampledThemeColors): SampledThemeColors {
	return Object.fromEntries(Object.entries(colors).map(([role, color]) => [role, canonicalizeCssColor(color)])) as SampledThemeColors;
}

function canonicalizeTerminalTheme(terminal: DesktopTerminalTheme): DesktopTerminalTheme {
	return Object.fromEntries(Object.entries(terminal).map(([role, color]) => [role, canonicalizeCssColor(color)])) as DesktopTerminalTheme;
}

export function contrastRatio(first: string, second: string): number {
	const firstLuminance = relativeLuminance(first);
	const secondLuminance = relativeLuminance(second);
	if (firstLuminance === undefined || secondLuminance === undefined) {
		throw new Error(`Could not calculate luminance for ${first} and ${second}`);
	}
	return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

export function expectedThemeColors(theme: ResolvedTheme): SampledThemeColors {
	const palette = DESKTOP_THEME_PALETTES[theme];
	return {
		rootBackground: palette.windowBackground,
		rootForeground: palette.foreground,
		"--window-background": palette.windowBackground,
		"--browser": palette.browserBackground,
		"--shell": palette.shell,
		"--shell-raised": palette.shellRaised,
		"--shell-hover": palette.shellHover,
		"--chat-canvas": palette.chatCanvas,
		"--code-surface": palette.codeSurface,
		"--line": palette.line,
		"--line-soft": palette.lineSoft,
		"--foreground": palette.foreground,
		"--foreground-strong": palette.foregroundStrong,
		"--foreground-muted": palette.foregroundMuted,
		"--foreground-disabled": palette.foregroundDisabled,
		"--accent": palette.accent,
		"--accent-hover": palette.accentHover,
		"--accent-surface": palette.accentSurface,
		"--accent-boundary": palette.accentBoundary,
		"--accent-foreground": palette.accentForeground,
		"--danger": palette.danger,
		"--danger-surface": palette.dangerSurface,
		"--danger-boundary": palette.dangerBoundary,
		"--danger-foreground": palette.dangerForeground,
		"--success": palette.success,
		"--success-surface": palette.successSurface,
		"--success-boundary": palette.successBoundary,
		"--success-foreground": palette.successForeground,
		"--warning": palette.warning,
		"--warning-surface": palette.warningSurface,
		"--warning-boundary": palette.warningBoundary,
		"--warning-foreground": palette.warningForeground,
		"--selection-surface": palette.selectionSurface,
		"--selection-foreground": palette.selectionForeground,
		"--focus-inner": palette.focusInner,
		"--focus-outer": palette.focusOuter,
		"--focus-ring": palette.focusInner,
		"--focus-ring-contrast": palette.focusOuter,
		"--placeholder": palette.foregroundMuted,
		"--terminal-background": palette.terminal.background,
		"--terminal-foreground": palette.terminal.foreground,
		"--terminal-shadow": palette.shadowColor,
		"--shadow-color": palette.shadowColor,
		"--backdrop": palette.backdrop,
	};
}

async function readThemeColors(page: Page): Promise<SampledThemeColors> {
	return page.evaluate((roles): SampledThemeColors => {
		const root = document.documentElement;
		const style = getComputedStyle(root);
		const resolve = (value: string, seen = new Set<string>()): string => {
			const match = /^var\((--[a-z0-9-]+)\)$/.exec(value);
			if (!match || seen.has(match[1])) return value;
			seen.add(match[1]);
			return resolve(style.getPropertyValue(match[1]).trim(), seen);
		};
		const readRole = (role: string): string => resolve(style.getPropertyValue(role).trim());
		return {
			rootBackground: style.backgroundColor,
			rootForeground: style.color,
			...Object.fromEntries(roles.map(role => [role, readRole(role)])),
		} as SampledThemeColors;
	}, CSS_COLOR_ROLES);
}

function expectContrast(theme: ResolvedTheme, label: string, first: string, second: string, minimum: number): void {
	const ratio = contrastRatio(first, second);
	expect(ratio, `${theme}: ${label} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(minimum);
}

function expectRoleContrast(
	theme: ResolvedTheme,
	colors: SampledThemeColors,
	firstRole: keyof SampledThemeColors,
	secondRole: keyof SampledThemeColors,
	minimum: number,
): void {
	expectContrast(theme, `${String(firstRole)} vs ${String(secondRole)}`, colors[firstRole], colors[secondRole], minimum);
}

const ANSI_FOREGROUND_ROLES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const satisfies ReadonlyArray<keyof DesktopTerminalTheme>;

export async function expectThemeContrast(page: Page, theme: ResolvedTheme): Promise<void> {
	await expect.poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 15_000 }).toBe(theme);
	const colors = canonicalizeThemeColors(await readThemeColors(page));
	const expected = canonicalizeThemeColors(expectedThemeColors(theme));
	for (const role of ["rootBackground", "rootForeground", ...CSS_COLOR_ROLES] as const) {
		expect(colors[role], `${theme}: computed ${role}`).toBe(expected[role]);
	}

	const neutralBases: Array<keyof SampledThemeColors> = [
		"--window-background",
		"--browser",
		"--shell",
		"--shell-raised",
		"--shell-hover",
		"--chat-canvas",
		"--code-surface",
	];
	const readableSurfaces: Array<keyof SampledThemeColors> = [
		...neutralBases,
		"--accent-surface",
		"--danger-surface",
		"--selection-surface",
		"--success-surface",
		"--warning-surface",
	];
	const textRoles: Array<keyof SampledThemeColors> = [
		"--foreground",
		"--foreground-strong",
		"--foreground-muted",
		"--foreground-disabled",
	];
	expectRoleContrast(theme, colors, "rootForeground", "rootBackground", 7);
	for (const textRole of textRoles) {
		for (const surfaceRole of readableSurfaces) expectRoleContrast(theme, colors, textRole, surfaceRole, 7);
	}

	for (const foregroundRole of ["--accent-foreground", "--danger-foreground", "--success-foreground", "--warning-foreground"] as const) {
		const fills =
			foregroundRole === "--accent-foreground"
				? (["--accent", "--accent-hover"] as const)
				: foregroundRole === "--danger-foreground"
					? (["--danger"] as const)
					: foregroundRole === "--success-foreground"
						? (["--success"] as const)
						: (["--warning"] as const);
		for (const fillRole of fills) expectRoleContrast(theme, colors, foregroundRole, fillRole, 7);
	}
	expectRoleContrast(theme, colors, "--selection-foreground", "--selection-surface", 7);

	for (const surfaceRole of readableSurfaces) expectRoleContrast(theme, colors, "--line", surfaceRole, 3);
	for (const boundaryRole of ["--accent-boundary", "--danger-boundary"] as const) {
		for (const surfaceRole of [...neutralBases, "--accent-surface", "--danger-surface", "--selection-surface"]) {
			expectRoleContrast(theme, colors, boundaryRole, surfaceRole, 3);
		}
	}
	for (const surfaceRole of [...neutralBases, "--success-surface"]) {
		expectRoleContrast(theme, colors, "--success-boundary", surfaceRole, 3);
	}
	for (const surfaceRole of [...neutralBases, "--warning-surface"]) {
		expectRoleContrast(theme, colors, "--warning-boundary", surfaceRole, 3);
	}

	expectRoleContrast(theme, colors, "--focus-inner", "--focus-outer", 9);
	for (const surfaceRole of readableSurfaces) {
		const inner = contrastRatio(colors["--focus-inner"], colors[surfaceRole]);
		const outer = contrastRatio(colors["--focus-outer"], colors[surfaceRole]);
		expect(Math.max(inner, outer), `${theme}: focus bands vs ${surfaceRole}`).toBeGreaterThanOrEqual(3);
	}

	const terminal = canonicalizeTerminalTheme(DESKTOP_THEME_PALETTES[theme].terminal);
	for (const role of ANSI_FOREGROUND_ROLES) {
		expectContrast(theme, `terminal.${role} vs terminal.background`, terminal[role], terminal.background, 7);
	}
	expectContrast(theme, "terminal.selectionForeground vs terminal.selectionBackground", terminal.selectionForeground, terminal.selectionBackground, 7);
}

function isKnownAxeIncomplete(message: string): boolean {
	const normalized = message.toLowerCase();
	return (
		normalized.includes("only non-text characters") ||
		normalized.includes("due to a pseudo element") ||
		normalized.includes("pseudo-element") ||
		normalized.includes("background color could not be determined") ||
		normalized.includes("background color is unknown") ||
		normalized.includes("unknown background color")
	);
}

function hasActionableIncomplete(node: { any: Array<{ message: string }>; all: Array<{ message: string }>; none: Array<{ message: string }> }): boolean {
	return [...node.any, ...node.all, ...node.none].some(check => !isKnownAxeIncomplete(check.message));
}

function actionableIncomplete(results: Array<{ nodes: Array<{ any: Array<{ message: string }>; all: Array<{ message: string }>; none: Array<{ message: string }> }> }>): unknown[] {
	return results.filter(result => result.nodes.some(hasActionableIncomplete));
}

export async function expectEnhancedContrast(page: Page, include?: string): Promise<void> {
	const builder = new AxeBuilder({ page }).setLegacyMode(true).withRules("color-contrast-enhanced");
	if (include) builder.include(include);
	const result = await builder.analyze();
	expect(actionableIncomplete(result.incomplete), `Enhanced contrast checks were incomplete: ${JSON.stringify(result.incomplete)}`).toEqual([]);
	expect(result.violations, `Enhanced contrast violations: ${JSON.stringify(result.violations)}`).toEqual([]);
}

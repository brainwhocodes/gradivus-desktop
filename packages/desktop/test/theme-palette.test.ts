import { relativeLuminance } from "@oh-my-pi/pi-utils/color";
import { describe, expect, it } from "vitest";
import { getAgentSwatch } from "../src/shared/agent-swatch";
import {
	DESKTOP_THEME_PALETTES,
	type DesktopNativePalette,
	type DesktopTerminalTheme,
	resolveTheme,
} from "../src/shared/theme-palette";

type NativeColorRole = Exclude<keyof DesktopNativePalette, "terminal">;
type TerminalForegroundRole = Exclude<
	keyof DesktopTerminalTheme,
	"background" | "cursorAccent" | "selectionBackground"
>;

const NEUTRAL_BASE_ROLES: readonly NativeColorRole[] = [
	"windowBackground",
	"browserBackground",
	"shell",
	"shellRaised",
	"shellHover",
	"chatCanvas",
	"codeSurface",
];

const READABLE_SURFACE_ROLES: readonly NativeColorRole[] = [
	...NEUTRAL_BASE_ROLES,
	"accentSurface",
	"dangerSurface",
	"selectionSurface",
	"successSurface",
	"warningSurface",
];

const SOLID_FILL_ROLES: readonly NativeColorRole[] = ["accent", "accentHover", "danger", "success", "warning"];

function contrastRatio(first: string, second: string): number {
	const firstLuminance = relativeLuminance(first);
	const secondLuminance = relativeLuminance(second);
	if (firstLuminance === undefined || secondLuminance === undefined) {
		throw new Error(`Expected parseable colors, received ${first} and ${second}`);
	}
	return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function expectContrast(
	theme: string,
	firstRole: string,
	first: string,
	secondRole: string,
	second: string,
	minimum: number,
): void {
	const ratio = contrastRatio(first, second);
	expect(ratio, `${theme}: ${firstRole} vs ${secondRole}`).toBeGreaterThanOrEqual(minimum);
}

function expectPaletteValue(
	palette: DesktopNativePalette,
	theme: string,
	role: NativeColorRole,
	expected: string,
): void {
	expect(palette[role], `${theme}: ${role}`).toBe(expected);
}

function isAchromatic(color: string): boolean {
	const match = /^#([0-9a-f]{6})$/i.exec(color);
	if (!match) return false;
	const [red, green, blue] = [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)];
	return red === green && green === blue;
}

describe("desktop theme palette", () => {
	it("prioritizes explicit themes over system color preferences", () => {
		expect(resolveTheme("dark", false)).toBe("dark");
		expect(resolveTheme("dark", true)).toBe("dark");
		expect(resolveTheme("light", false)).toBe("light");
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("system", true)).toBe("dark");
	});

	it("keeps the exact neutral native canvases and default foregrounds", () => {
		const dark = DESKTOP_THEME_PALETTES.dark;
		const light = DESKTOP_THEME_PALETTES.light;
		const exactRoles = [
			["windowBackground", "#0d0d0d", "#ffffff"],
			["browserBackground", "#0d0d0d", "#ffffff"],
			["shell", "#141414", "#fafafa"],
			["shellRaised", "#1c1c1c", "#ffffff"],
			["shellHover", "#292929", "#f2f2f2"],
			["chatCanvas", "#101010", "#ffffff"],
			["codeSurface", "#181818", "#f5f5f5"],
			["foreground", "#ffffff", "#000000"],
			["foregroundStrong", "#ffffff", "#000000"],
			["foregroundMuted", "#d1d1d1", "#333333"],
			["foregroundDisabled", "#b6b6b6", "#4b4b4b"],
			["line", "#747474", "#858585"],
			["lineSoft", "#454545", "#d4d4d4"],
		] as const;
		for (const [role, darkExpected, lightExpected] of exactRoles) {
			expectPaletteValue(dark, "dark", role, darkExpected);
			expectPaletteValue(light, "light", role, lightExpected);
		}
		expect(dark.terminal.background).toBe("#0d0d0d");
		expect(light.terminal.background).toBe("#ffffff");
		expect(dark.terminal.foreground).toBe("#ffffff");
		expect(dark.terminal.cursor).toBe("#ffffff");
		expect(light.terminal.foreground).toBe("#000000");
		expect(light.terminal.cursor).toBe("#000000");
	});

	it("keeps default, muted, disabled, and selected text at AAA across readable surfaces", () => {
		const textRoles: readonly NativeColorRole[] = [
			"foreground",
			"foregroundStrong",
			"foregroundMuted",
			"foregroundDisabled",
		];
		for (const [theme, palette] of Object.entries(DESKTOP_THEME_PALETTES)) {
			for (const textRole of textRoles) {
				for (const surfaceRole of READABLE_SURFACE_ROLES) {
					expectContrast(theme, textRole, palette[textRole], surfaceRole, palette[surfaceRole], 7);
				}
			}
			expectContrast(
				theme,
				"selectionForeground",
				palette.selectionForeground,
				"selectionSurface",
				palette.selectionSurface,
				7,
			);
		}
	});

	it("keeps every configured on-fill foreground at AAA on semantic fills", () => {
		const foregroundRoles: readonly NativeColorRole[] = [
			"accentForeground",
			"dangerForeground",
			"successForeground",
			"warningForeground",
		];
		for (const [theme, palette] of Object.entries(DESKTOP_THEME_PALETTES)) {
			for (const foregroundRole of foregroundRoles) {
				for (const fillRole of SOLID_FILL_ROLES) {
					expectContrast(theme, foregroundRole, palette[foregroundRole], fillRole, palette[fillRole], 7);
				}
			}
		}
	});

	it("keeps configured ANSI text and terminal selection at AAA", () => {
		for (const [theme, palette] of Object.entries(DESKTOP_THEME_PALETTES)) {
			const terminal = palette.terminal;
			const terminalForegroundRoles = Object.keys(terminal).filter(
				role => role !== "background" && role !== "cursorAccent" && role !== "selectionBackground",
			) as TerminalForegroundRole[];
			for (const role of terminalForegroundRoles) {
				expectContrast(theme, `terminal.${role}`, terminal[role], "terminal.background", terminal.background, 7);
			}
			expectContrast(
				theme,
				"terminal.selectionForeground",
				terminal.selectionForeground,
				"terminal.selectionBackground",
				terminal.selectionBackground,
				7,
			);
		}
	});

	it("keeps required boundaries above the non-text threshold", () => {
		for (const [theme, palette] of Object.entries(DESKTOP_THEME_PALETTES)) {
			for (const surfaceRole of READABLE_SURFACE_ROLES) {
				expectContrast(theme, "line", palette.line, surfaceRole, palette[surfaceRole], 3);
			}
			for (const boundaryRole of ["accentBoundary", "dangerBoundary"] as const) {
				for (const surfaceRole of [...NEUTRAL_BASE_ROLES, "accentSurface", "dangerSurface", "selectionSurface"]) {
					expectContrast(theme, boundaryRole, palette[boundaryRole], surfaceRole, palette[surfaceRole], 3);
				}
			}
			for (const [boundaryRole, surfaceRole] of [
				["successBoundary", "successSurface"],
				["warningBoundary", "warningSurface"],
			] as const) {
				for (const baseRole of NEUTRAL_BASE_ROLES) {
					expectContrast(theme, boundaryRole, palette[boundaryRole], baseRole, palette[baseRole], 3);
				}
				expectContrast(theme, boundaryRole, palette[boundaryRole], surfaceRole, palette[surfaceRole], 3);
			}
		}
	});

	it("keeps both neutral focus bands visible on every readable surface", () => {
		for (const [theme, palette] of Object.entries(DESKTOP_THEME_PALETTES)) {
			expectContrast(theme, "focusInner", palette.focusInner, "focusOuter", palette.focusOuter, 9);
			for (const surfaceRole of READABLE_SURFACE_ROLES) {
				const visibleBand = Math.max(
					contrastRatio(palette.focusInner, palette[surfaceRole]),
					contrastRatio(palette.focusOuter, palette[surfaceRole]),
				);
				expect(visibleBand, `${theme}: focus bands vs ${surfaceRole}`).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it("keeps neutral roles achromatic and confines hue to semantic roles", () => {
		const achromaticRoles: readonly NativeColorRole[] = [
			...NEUTRAL_BASE_ROLES,
			"foreground",
			"foregroundStrong",
			"foregroundMuted",
			"foregroundDisabled",
			"line",
			"lineSoft",
			"selectionForeground",
			"focusInner",
			"focusOuter",
		];
		for (const [theme, palette] of Object.entries(DESKTOP_THEME_PALETTES)) {
			for (const role of achromaticRoles) {
				expect(isAchromatic(palette[role]), `${theme}: ${role} must be achromatic`).toBe(true);
			}
			expect(palette.accent).toBe("#7f1d1d");
			expect(palette.accentHover).toMatch(/^#(?:991b1b|641414)$/);
			expect(palette.danger).toBe("#7f1d1d");
			expect(palette.success).toBe("#14532d");
			expect(palette.warning).toBe("#5f3700");
		}
	});

	it("retains the raw dark-theme contrast diagnostics", () => {
		const palette = DESKTOP_THEME_PALETTES.dark;
		const diagnostics = [
			["white text", palette.foreground, palette.shellHover, 14.55],
			["muted text", palette.foregroundMuted, palette.shellHover, 9.53],
			["disabled text", palette.foregroundDisabled, palette.shellHover, 7.17],
			["required line", palette.line, palette.shellHover, 3.11],
			["crimson boundary", palette.accentBoundary, palette.shellHover, 4.14],
			["success boundary", palette.successBoundary, palette.shellHover, 8.24],
			["warning boundary", palette.warningBoundary, palette.shellHover, 10.35],
		] as const;
		for (const [label, first, second, expected] of diagnostics) {
			expect(contrastRatio(first, second), label).toBeCloseTo(expected, 2);
		}

		const ansiForegrounds = Object.entries(palette.terminal)
			.filter(([role]) => role !== "background" && role !== "cursorAccent" && role !== "selectionBackground")
			.map(([, color]) => color);
		const ansiWorst = Math.min(...ansiForegrounds.map(color => contrastRatio(color, palette.terminal.background)));
		expect(ansiWorst, "configured ANSI foreground worst").toBeCloseTo(8.26, 2);
	});

	it("keeps every configured agent swatch at least 3:1 on both dark and light canvases", () => {
		const swatches = new Set<string>();
		for (let index = 0; index < 8192 && swatches.size < 8; index++) {
			swatches.add(getAgentSwatch(`theme-swatch-${index}`));
		}
		expect(swatches.size).toBe(8);
		for (const swatch of swatches) {
			expectContrast("dark", "agent swatch", swatch, "dark canvas", "#0d0d0d", 3);
			expectContrast("light", "agent swatch", swatch, "light canvas", "#ffffff", 3);
		}
	});
});

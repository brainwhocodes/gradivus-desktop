import { describe, expect, it } from "vitest";
import { selectTerminalRenderer } from "../src/renderer/terminal/terminal-renderer";

describe("terminal renderer selection", () => {
	it("selects wterm-dom for Windows (win32)", () => {
		expect(selectTerminalRenderer("win32")).toBe("wterm-dom");
	});

	it("selects ghostty-web for macOS (darwin)", () => {
		expect(selectTerminalRenderer("darwin")).toBe("ghostty-web");
	});

	it("selects ghostty-web for Linux (linux) fallback", () => {
		expect(selectTerminalRenderer("linux")).toBe("ghostty-web");
	});

	it("selects ghostty-web for other POSIX fallback platforms", () => {
		expect(selectTerminalRenderer("freebsd")).toBe("ghostty-web");
		expect(selectTerminalRenderer("openbsd")).toBe("ghostty-web");
		expect(selectTerminalRenderer("sunos")).toBe("ghostty-web");
	});
});

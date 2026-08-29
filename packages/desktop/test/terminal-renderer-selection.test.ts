import { describe, expect, it } from "vitest";
import { selectTerminalRenderer } from "../src/renderer/terminal/terminal-renderer";

describe("terminal renderer selection", () => {
	it("selects ghostty-web on Windows (win32)", () => {
		expect(selectTerminalRenderer("win32")).toBe("ghostty-web");
	});

	it("selects ghostty-web on macOS (darwin)", () => {
		expect(selectTerminalRenderer("darwin")).toBe("ghostty-web");
	});

	it("selects ghostty-web on Linux (linux)", () => {
		expect(selectTerminalRenderer("linux")).toBe("ghostty-web");
	});

	it("selects ghostty-web on other supported platforms", () => {
		expect(selectTerminalRenderer("freebsd")).toBe("ghostty-web");
		expect(selectTerminalRenderer("openbsd")).toBe("ghostty-web");
		expect(selectTerminalRenderer("sunos")).toBe("ghostty-web");
	});
});

import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { isPackaged: false },
}));

import { resolveOmpExecutablePath } from "../src/main/backend-path";

describe("OMP executable resolution", () => {
	it("resolves repository-root launches to the coding-agent binary", () => {
		const existing = new Set(["/repo/packages/coding-agent/dist/omp"]);
		const resolved = resolveOmpExecutablePath({
			cwd: "/repo",
			module: "/repo/packages/desktop/src/main",
			resources: "/repo/packages/desktop/resources",
			platform: "linux",
			exists: candidate => existing.has(candidate),
		});

		expect(resolved).toBe("/repo/packages/coding-agent/dist/omp");
	});

	it("resolves desktop-package launches without nesting packages/desktop", () => {
		const existing = new Set(["/repo/packages/coding-agent/dist/omp"]);
		const resolved = resolveOmpExecutablePath({
			cwd: "/repo/packages/desktop",
			module: "/repo/packages/desktop/src/main",
			resources: "/repo/packages/desktop/resources",
			platform: "linux",
			exists: candidate => existing.has(candidate),
		});

		expect(resolved).toBe("/repo/packages/coding-agent/dist/omp");
	});

	it("reports every attempted development path when the binary is missing", () => {
		const result = () =>
			resolveOmpExecutablePath({
				cwd: "/repo/packages/desktop",
				module: "/repo/packages/desktop/src/main",
				resources: "/repo/packages/desktop/resources",
				platform: "linux",
				exists: () => false,
			});

		expect(result).toThrowError(
			expect.objectContaining({
				message: expect.stringContaining("/repo/packages/desktop/packages/coding-agent/dist/omp"),
			}),
		);
		expect(result).toThrowError(
			expect.objectContaining({
				message: expect.stringContaining("/repo/packages/coding-agent/dist/omp"),
			}),
		);
	});

	it("uses only the packaged resources path", () => {
		const resolved = resolveOmpExecutablePath({
			cwd: "/repo/packages/desktop",
			module: "/repo/packages/desktop/src/main",
			resources: "/Applications/Gradivus.app/Contents/Resources",
			platform: "linux",
			isPackaged: true,
			exists: () => false,
		});

		expect(resolved).toBe("/Applications/Gradivus.app/Contents/Resources/omp");
	});

	it("selects the Windows executable name from the supplied platform", () => {
		const resolved = resolveOmpExecutablePath({
			cwd: "/repo",
			module: "/repo/packages/desktop/src/main",
			resources: "C:\\Gradivus\\resources",
			platform: "win32",
			isPackaged: true,
			exists: () => false,
		});

		expect(resolved).toBe(path.join("C:\\Gradivus\\resources", "omp.exe"));
	});
});

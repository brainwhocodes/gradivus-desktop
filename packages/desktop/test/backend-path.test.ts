import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { isPackaged: false },
}));

import { resolveOmpExecutablePath } from "../src/main/backend-path";

describe("OMP executable resolution", () => {
	const repo = path.resolve("/repo");
	const desktopDir = path.join(repo, "packages/desktop");
	const ompBinary = path.resolve(repo, "packages/coding-agent/dist/omp");

	it("resolves repository-root launches to the coding-agent binary", () => {
		const resolved = resolveOmpExecutablePath({
			cwd: repo,
			module: path.join(desktopDir, "src/main"),
			resources: path.join(desktopDir, "resources"),
			platform: "linux",
			exists: candidate => candidate === ompBinary,
		});

		expect(resolved).toBe(ompBinary);
	});

	it("resolves desktop-package launches without nesting packages/desktop", () => {
		const resolved = resolveOmpExecutablePath({
			cwd: desktopDir,
			module: path.join(desktopDir, "src/main"),
			resources: path.join(desktopDir, "resources"),
			platform: "linux",
			exists: candidate => candidate === ompBinary,
		});

		expect(resolved).toBe(ompBinary);
	});

	it("reports every attempted development path when the binary is missing", () => {
		const result = () =>
			resolveOmpExecutablePath({
				cwd: desktopDir,
				module: path.join(desktopDir, "src/main"),
				resources: path.join(desktopDir, "resources"),
				platform: "linux",
				exists: () => false,
			});

		expect(result).toThrowError(
			expect.objectContaining({
				message: expect.stringContaining(path.resolve(desktopDir, "packages/coding-agent/dist/omp")),
			}),
		);
		expect(result).toThrowError(
			expect.objectContaining({
				message: expect.stringContaining(ompBinary),
			}),
		);
	});

	it("uses only the packaged resources path", () => {
		const resources = path.resolve("/Applications/Gradivus.app/Contents/Resources");
		const resolved = resolveOmpExecutablePath({
			cwd: "/repo/packages/desktop",
			module: "/repo/packages/desktop/src/main",
			resources,
			platform: "linux",
			isPackaged: true,
			exists: () => false,
		});

		expect(resolved).toBe(path.join(resources, "omp"));
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

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "../src/temp";

describe("TempDir custom prefixes", () => {
	it("creates and removes an async directory beneath missing parent directories", async () => {
		const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-utils-temp-"));
		const prefix = path.join(root, "missing", "nested", "async-prefix-");
		let tempDir: TempDir | undefined;

		try {
			tempDir = await TempDir.create(prefix);

			expect(tempDir.path().startsWith(prefix)).toBe(true);
			expect((await fsPromises.stat(tempDir.path())).isDirectory()).toBe(true);
			await expect(fsPromises.access(path.dirname(prefix))).resolves.toBeNull();

			await tempDir.remove();
			await expect(fsPromises.access(tempDir.path())).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await tempDir?.remove();
			await fsPromises.rm(root, { recursive: true, force: true });
		}
	});

	it("creates and removes a sync directory beneath missing parent directories", async () => {
		const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "pi-utils-temp-"));
		const prefix = path.join(root, "missing", "nested", "sync-prefix-");
		let tempDir: TempDir | undefined;

		try {
			tempDir = TempDir.createSync(prefix);

			expect(tempDir.path().startsWith(prefix)).toBe(true);
			expect(fs.statSync(tempDir.path()).isDirectory()).toBe(true);
			expect(fs.existsSync(path.dirname(prefix))).toBe(true);

			tempDir.removeSync();
			expect(fs.existsSync(tempDir.path())).toBe(false);
		} finally {
			tempDir?.removeSync();
			await fsPromises.rm(root, { recursive: true, force: true });
		}
	});
});

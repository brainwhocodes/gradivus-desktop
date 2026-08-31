import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeTextFileAtomic } from "../src/atomic-write";

describe("writeTextFileAtomic", () => {
	it("replaces an existing file without leaving temporary artifacts", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-atomic-write-"));
		const target = path.join(root, "nested", "agent.md");
		try {
			await writeTextFileAtomic(target, "first\n");
			await writeTextFileAtomic(target, "second\n");

			await expect(Bun.file(target).text()).resolves.toBe("second\n");
			expect(await fs.readdir(path.dirname(target))).toEqual(["agent.md"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("concurrent replacements expose one complete writer result", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-atomic-write-"));
		const target = path.join(root, "state.txt");
		const contents = Array.from({ length: 8 }, (_, index) => `${index}:`.repeat(16_384));
		try {
			await Promise.all(contents.map(content => writeTextFileAtomic(target, content)));
			const stored = await Bun.file(target).text();
			expect(contents).toContain(stored);
			expect(await fs.readdir(root)).toEqual(["state.txt"]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

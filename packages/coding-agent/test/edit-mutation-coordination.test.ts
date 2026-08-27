import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { applyPatch } from "../src/edit/modes/patch";
import { editMutationCoordinator, withMutation } from "../src/edit/mutation";
import { applyWorkspaceEdit } from "../src/lsp/edits";

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-mutation-"));
}

describe("first-party edit mutation coordination", () => {
	it("serializes overlapping scopes while allowing unrelated files to proceed", async () => {
		const root = await makeTempDir();
		const first = path.join(root, "first.ts");
		const second = path.join(root, "second.ts");
		const order: string[] = [];
		const held = await editMutationCoordinator.acquire([{ kind: "exact", path: first }]);
		try {
			const same = withMutation([first], async () => {
				order.push("same");
			});
			const unrelated = withMutation([second], async () => {
				order.push("unrelated");
			});
			await unrelated;
			expect(order).toEqual(["unrelated"]);
			held.release();
			await same;
			expect(order).toEqual(["unrelated", "same"]);
		} finally {
			held.release();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("removes an aborted queued mutation without running it later", async () => {
		const root = await makeTempDir();
		const file = path.join(root, "queued.ts");
		const controller = new AbortController();
		let ran = false;
		const held = await editMutationCoordinator.acquire([{ kind: "exact", path: file }]);
		try {
			const queued = withMutation(
				[file],
				async () => {
					ran = true;
				},
				controller.signal,
			);
			controller.abort(new Error("cancelled"));
			await expect(queued).rejects.toThrow();
			held.release();
			expect(ran).toBe(false);
		} finally {
			held.release();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("holds patch read-modify-write through the shared coordinator", async () => {
		const root = await makeTempDir();
		const file = path.join(root, "patch.ts");
		await Bun.write(file, "before\nkeep\n");
		try {
			const result = await applyPatch({ path: file, op: "update", diff: "@@\n-before\n+after" }, { cwd: root });
			expect(result.change.oldContent).toBe("before\nkeep\n");
			expect(await Bun.file(file).text()).toBe("after\nkeep\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("serializes multi-file LSP workspace edits as one mutation", async () => {
		const root = await makeTempDir();
		const first = path.join(root, "first.ts");
		const second = path.join(root, "second.ts");
		await Bun.write(first, "one\n");
		await Bun.write(second, "two\n");
		try {
			const result = await applyWorkspaceEdit(
				{
					changes: {
						[pathToFileURL(first).href]: [
							{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "ONE" },
						],
						[pathToFileURL(second).href]: [
							{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "TWO" },
						],
					},
				},
				root,
			);
			expect(result.executed).toHaveLength(2);
			expect(await Bun.file(first).text()).toBe("ONE\n");
			expect(await Bun.file(second).text()).toBe("TWO\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptAttachmentStore } from "../src/main/prompt-attachments";

const PNG_BYTES = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		"base64",
	),
);

const stores: PromptAttachmentStore[] = [];

afterEach(async () => {
	await Promise.all(stores.splice(0).map(store => store.close()));
});

describe("PromptAttachmentStore", () => {
	it("stages generic files as quoted references without embedding contents", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "notes.md", data: new TextEncoder().encode("secret notes") }]);
		const resolved = await store.resolve([view!.id], "Read the attachment");

		expect(view).toMatchObject({ name: "notes.md", kind: "file", size: 12 });
		expect(resolved.images).toEqual([]);
		expect(resolved.text).toContain('File "notes.md": @"');
		expect(resolved.text).not.toContain("secret notes");
		const stagedPath = resolved.text.match(/@"([^"]+)"/)?.[1];
		expect(stagedPath).toBeDefined();
		expect(await fs.readFile(stagedPath!, "utf8")).toBe("secret notes");
	});

	it("keeps resolved files until the admission owner explicitly releases them", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "admitted.md", data: new TextEncoder().encode("admitted") }]);
		const resolved = await store.resolve([view!.id], "Admit this attachment");
		const stagedPath = resolved.text.match(/@"([^"]+)"/)?.[1];

		expect(stagedPath).toContain("gradivus-prompt-");
		await expect(fs.access(stagedPath!)).resolves.toBeUndefined();
		await store.release([view!.id]);
		await expect(fs.access(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(store.resolve([view!.id], "Admit again")).rejects.toThrow("unknown prompt attachment");
	});

	it("removes its temp directory when the last staged attachment is released and stages again afterwards", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "boundary.md", data: new TextEncoder().encode("boundary") }]);
		const resolved = await store.resolve([view!.id], "Resolve boundary");
		const stagedPath = resolved.text.match(/@"([^"]+)"/)?.[1];
		const tempDir = path.dirname(stagedPath!);
		await expect(fs.access(tempDir)).resolves.toBeUndefined();

		await store.release([view!.id]);
		await expect(fs.access(tempDir)).rejects.toMatchObject({ code: "ENOENT" });

		const [restaged] = await store.stageUploads([{ name: "after.md", data: new TextEncoder().encode("after") }]);
		expect(restaged).toMatchObject({ name: "after.md", kind: "file" });
	});

	it("classifies images by magic bytes and forwards one native image", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "screen.txt", mimeType: "text/plain", data: PNG_BYTES }]);
		const resolved = await store.resolve([view!.id], "Describe this");

		expect(view).toMatchObject({ name: "screen.txt", kind: "image" });
		expect(resolved.text).toContain('Image "screen.txt" is attached');
		expect(resolved.text).not.toContain("@/");
		expect(resolved.images).toEqual([
			{ type: "image", data: Buffer.from(PNG_BYTES).toString("base64"), mimeType: "image/png" },
		]);
	});

	it("persists oversized prompt text byte-for-byte behind a short reference", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const source = "é".repeat(300_000);
		const view = await store.stagePromptText(source);
		const resolved = await store.resolve([view.id], "");

		expect(view.kind).toBe("prompt");
		expect(Buffer.byteLength(resolved.text, "utf8")).toBeLessThan(512 * 1024);
		expect(await fs.readFile(resolved.text.match(/@"([^"]+)"/)?.[1] ?? "", "utf8")).toBe(source);
	});

	it("rejects invalid batches before writing and releases files idempotently", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		await expect(
			store.stageUploads([
				{ name: "ok.txt", data: new Uint8Array([1]) },
				{ name: "bad.txt", data: "path" },
			]),
		).rejects.toThrow();
		const [view] = await store.stageUploads([{ name: "ok.txt", data: new Uint8Array([1]) }]);
		await store.release([view!.id, view!.id]).catch(() => undefined);
		await store.release([view!.id]);
		await store.close();
		await store.close();
	});

	it("rejects separately staged attachments over the combined batch limit without consuming them", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const firstBytes = new Uint8Array(17 * 1024 * 1024);
		const secondBytes = new Uint8Array(17 * 1024 * 1024);
		const [first] = await store.stageUploads([{ name: "first.bin", data: firstBytes }]);
		const [second] = await store.stageUploads([{ name: "second.bin", data: secondBytes }]);

		await expect(store.resolve([first!.id, second!.id], "")).rejects.toThrow("attachment batch exceeds 32 MiB");
		await expect(store.resolve([first!.id], "")).resolves.toMatchObject({ views: [first] });
		await expect(store.resolve([second!.id], "")).resolves.toMatchObject({ views: [second] });

		await expect(store.release([first!.id, second!.id])).resolves.toBeUndefined();
		await expect(store.resolve([first!.id], "")).rejects.toThrow("unknown prompt attachment");
		await expect(store.resolve([second!.id], "")).rejects.toThrow("unknown prompt attachment");
	});
});

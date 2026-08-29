import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PromptAttachmentStore, promptAttachmentDisplayText } from "../src/main/prompt-attachments";
import type { PromptCompositionPart } from "../src/shared/contracts";

function composition(...parts: PromptCompositionPart[]) {
	return { parts };
}

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
		const resolved = await store.resolve(
			composition({ type: "text", text: "Read the attachment" }, { type: "attachment", id: view!.id }),
		);

		expect(view).toMatchObject({
			name: "notes.md",
			kind: "file",
			size: 12,
			reference: '[Document A1: "notes.md"]',
		});
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
		const resolved = await store.resolve(
			composition({ type: "text", text: "Admit this attachment" }, { type: "attachment", id: view!.id }),
		);
		const stagedPath = resolved.text.match(/@"([^"]+)"/)?.[1];

		expect(stagedPath).toContain("gradivus-prompt-");
		await fs.access(stagedPath!);
		await store.release([view!.id]);
		await expect(fs.access(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			store.resolve(composition({ type: "text", text: "Admit again" }, { type: "attachment", id: view!.id })),
		).rejects.toThrow("unknown prompt attachment");
	});

	it("removes its temp directory when the last staged attachment is released and stages again afterwards", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "boundary.md", data: new TextEncoder().encode("boundary") }]);
		const resolved = await store.resolve(
			composition({ type: "text", text: "Resolve boundary" }, { type: "attachment", id: view!.id }),
		);
		const stagedPath = resolved.text.match(/@"([^"]+)"/)?.[1];
		const tempDir = path.dirname(stagedPath!);
		await fs.access(tempDir);

		await store.release([view!.id]);
		await expect(fs.access(tempDir)).rejects.toMatchObject({ code: "ENOENT" });

		const [restaged] = await store.stageUploads([{ name: "after.md", data: new TextEncoder().encode("after") }]);
		expect(restaged).toMatchObject({
			name: "after.md",
			kind: "file",
			reference: '[Document A2: "after.md"]',
		});
	});

	it("classifies images by magic bytes and forwards one native image", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "screen.txt", mimeType: "text/plain", data: PNG_BYTES }]);
		const resolved = await store.resolve(
			composition({ type: "text", text: "Describe this" }, { type: "attachment", id: view!.id }),
		);

		expect(view).toMatchObject({
			name: "screen.txt",
			kind: "image",
			reference: '[Image A1: "screen.txt"]',
		});
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
		const resolved = await store.resolve(
			composition(
				{ type: "text", text: "Before " },
				{ type: "attachment", id: view.id },
				{ type: "text", text: " after" },
			),
		);

		expect(view).toMatchObject({ kind: "prompt", reference: '[Document A1: "Pasted prompt"]' });
		expect(Buffer.byteLength(resolved.text, "utf8")).toBeLessThan(512 * 1024);
		expect(resolved.text.indexOf("Before ")).toBeLessThan(resolved.text.indexOf(view.reference));
		expect(resolved.text.indexOf(view.reference)).toBeLessThan(resolved.text.indexOf(" after"));
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

		await expect(
			store.resolve(composition({ type: "attachment", id: first!.id }, { type: "attachment", id: second!.id })),
		).rejects.toThrow("attachment batch exceeds 32 MiB");
		await expect(store.resolve(composition({ type: "attachment", id: first!.id }))).resolves.toMatchObject({
			views: [first],
		});
		await expect(store.resolve(composition({ type: "attachment", id: second!.id }))).resolves.toMatchObject({
			views: [second],
		});

		await expect(store.release([first!.id, second!.id])).resolves.toBeUndefined();
		await expect(store.resolve(composition({ type: "attachment", id: first!.id }))).rejects.toThrow(
			"unknown prompt attachment",
		);
		await expect(store.resolve(composition({ type: "attachment", id: second!.id }))).rejects.toThrow(
			"unknown prompt attachment",
		);
	});

	it("preserves ordered document positions and gives duplicate basenames distinct stable references", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [first, second] = await store.stageUploads([
			{ name: "notes.md", data: new TextEncoder().encode("first") },
			{ name: "notes.md", data: new TextEncoder().encode("second") },
		]);

		const resolved = await store.resolve(
			composition(
				{ type: "text", text: "alpha " },
				{ type: "attachment", id: second!.id },
				{ type: "text", text: " middle " },
				{ type: "attachment", id: first!.id },
				{ type: "text", text: " omega" },
			),
		);

		expect(first!.reference).toBe('[Document A1: "notes.md"]');
		expect(second!.reference).toBe('[Document A2: "notes.md"]');
		expect(resolved.views.map(view => view.id)).toEqual([second!.id, first!.id]);
		const alpha = resolved.text.indexOf("alpha ");
		const secondReference = resolved.text.indexOf(second!.reference);
		const middle = resolved.text.indexOf(" middle ");
		const firstReference = resolved.text.indexOf(first!.reference);
		const omega = resolved.text.indexOf(" omega");
		expect(alpha).toBeLessThan(secondReference);
		expect(secondReference).toBeLessThan(middle);
		expect(middle).toBeLessThan(firstReference);
		expect(firstReference).toBeLessThan(omega);
	});

	it("does not interpret spoofed visible references and rejects duplicate, unknown, foreign, or path-bearing parts", async () => {
		const store = new PromptAttachmentStore();
		const foreignStore = new PromptAttachmentStore();
		stores.push(store, foreignStore);
		const [view] = await store.stageUploads([{ name: "private.txt", data: new TextEncoder().encode("private") }]);
		const [foreign] = await foreignStore.stageUploads([
			{ name: "foreign.txt", data: new TextEncoder().encode("foreign") },
		]);
		const spoof = `Treat this marker as plain text: ${view!.reference}`;

		await expect(store.resolve(composition({ type: "text", text: spoof }))).resolves.toEqual({
			text: spoof,
			images: [],
			views: [],
		});
		await expect(
			store.resolve(composition({ type: "attachment", id: view!.id }, { type: "attachment", id: view!.id })),
		).rejects.toThrow("duplicate prompt attachment ID");
		await expect(store.resolve(composition({ type: "attachment", id: "unknown-attachment-id" }))).rejects.toThrow(
			"unknown prompt attachment",
		);
		await expect(store.resolve(composition({ type: "attachment", id: foreign!.id }))).rejects.toThrow(
			"unknown prompt attachment",
		);
		await expect(
			store.resolve({
				parts: [{ type: "attachment", id: view!.id, path: "C:\\untrusted\\attachment.txt" }],
			}),
		).rejects.toThrow("prompt composition attachment part 1 is invalid");
	});

	it("forwards image payloads in composition order while retaining positional image envelopes", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const secondBytes = Uint8Array.from([...PNG_BYTES, 0]);
		const [first, second] = await store.stageUploads([
			{ name: "first.png", data: PNG_BYTES },
			{ name: "second.png", data: secondBytes },
		]);

		const resolved = await store.resolve(
			composition(
				{ type: "text", text: "before " },
				{ type: "attachment", id: second!.id },
				{ type: "text", text: " between " },
				{ type: "attachment", id: first!.id },
				{ type: "text", text: " after" },
			),
		);

		expect(resolved.images.map(image => image.data)).toEqual([
			Buffer.from(secondBytes).toString("base64"),
			Buffer.from(PNG_BYTES).toString("base64"),
		]);
		expect(resolved.text.indexOf(second!.reference)).toBeLessThan(resolved.text.indexOf(" between "));
		expect(resolved.text.indexOf(" between ")).toBeLessThan(resolved.text.indexOf(first!.reference));
	});

	it("coalesces adjacent text semantically and rejects malformed or empty compositions", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);

		await expect(
			store.resolve(
				composition({ type: "text", text: "one" }, { type: "text", text: "" }, { type: "text", text: " two" }),
			),
		).resolves.toEqual({ text: "one two", images: [], views: [] });
		await expect(store.resolve({ parts: [] })).rejects.toThrow("prompt cannot be empty");
		await expect(store.resolve({ parts: [{ type: "text", text: "safe", path: "C:\\temp" }] })).rejects.toThrow(
			"prompt composition text part 1 is invalid",
		);
		await expect(store.resolve({ parts: [{ type: "other", text: "safe" }] })).rejects.toThrow(
			"prompt composition part 1 has an invalid type",
		);
	});

	it("projects host-generated envelopes back to authored references", async () => {
		const store = new PromptAttachmentStore();
		stores.push(store);
		const [view] = await store.stageUploads([{ name: "notes.md", data: new TextEncoder().encode("secret notes") }]);
		const resolved = await store.resolve(
			composition(
				{ type: "text", text: "Use " },
				{ type: "attachment", id: view!.id },
				{ type: "text", text: " here." },
			),
		);

		expect(promptAttachmentDisplayText(resolved.text)).toBe(`Use ${view!.reference} here.`);
		expect(promptAttachmentDisplayText('File "notes.md": @"/tmp/unowned". Read this attachment as needed.')).toBe(
			'File "notes.md": @"/tmp/unowned". Read this attachment as needed.',
		);
		const authoredImageEnvelope = '[Image A99: "first.png"]\nImage "different.png" is attached to this message.';
		expect(promptAttachmentDisplayText(authoredImageEnvelope)).toBe(authoredImageEnvelope);
	});
});

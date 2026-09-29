import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "../src/main/transcript-store";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gradivus-generated-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(workspace);
	const image = path.join(root, "generated.png");
	await fs.writeFile(image, "generated image bytes");
	return { root, workspace, image };
}

describe("generated file authorization", () => {
	it("lists successful image outputs live and on replay with session-scoped opaque references", async () => {
		const { workspace, image } = await fixture();
		const args = { path: "xd://generate_image", content: '{"subject":"landscape"}' };
		const details = { xdev: { tool: "generate_image", mode: "execute", inner: { imagePaths: [image] } } };
		const store = new TranscriptStore(workspace);
		store.apply({ type: "tool_execution_start", toolCallId: "image-1", toolName: "write", args });
		expect(store.snapshot[0]?.files).toBeUndefined();
		const item = store.apply({
			type: "tool_execution_end",
			toolCallId: "image-1",
			isError: false,
			result: { details },
		});
		const token = item?.files?.[0]?.path;
		if (!token) throw new Error("Generated image was not listed");
		expect(item?.files).toEqual([{ path: token, operation: "generate" }]);
		expect(token).toMatch(/^@artifacts\/[a-f0-9]{64}\/generated\.png$/);
		expect(await store.resolveArtifact(token)).toBe(await fs.realpath(image));
		await expect(new TranscriptStore(workspace).resolveArtifact(token)).rejects.toThrow("not authorized");
		const restored = new TranscriptStore(workspace);
		restored.load([
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "toolCall", id: "image-1", name: "write", arguments: args }],
			},
			{ role: "toolResult", toolCallId: "image-1", toolName: "write", isError: false, content: [], details },
		]);
		expect(restored.snapshot[0]?.files).toEqual(item?.files);
		expect(await restored.resolveArtifact(token)).toBe(await fs.realpath(image));
		await fs.rm(image);
		await expect(restored.resolveArtifact(token)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not authorize paths from failed, unrelated, or textual results", async () => {
		const { workspace, image } = await fixture();
		for (const [toolName, isError, result] of [
			["generate_image", true, { details: { imagePaths: [image] } }],
			[
				"read",
				false,
				{
					details: {
						imagePaths: [image],
						xdev: { tool: "generate_image", mode: "execute", inner: { imagePaths: [image] } },
					},
				},
			],
			["generate_image", false, { content: [{ type: "text", text: `Saved image to ${image}` }] }],
		] as const) {
			const store = new TranscriptStore(workspace);
			store.apply({ type: "tool_execution_start", toolCallId: "untrusted", toolName, args: {} });
			const item = store.apply({ type: "tool_execution_end", toolCallId: "untrusted", isError, result });
			expect(item?.files).toBeUndefined();
		}
	});

	it("refuses replaced artifact identities and lists expired files rather than dropping them", async () => {
		const { workspace, image, root } = await fixture();
		const store = new TranscriptStore(workspace);
		store.apply({ type: "tool_execution_start", toolCallId: "image", toolName: "generate_image", args: {} });
		const item = store.apply({
			type: "tool_execution_end",
			toolCallId: "image",
			result: { details: { imagePaths: [image, path.join(root, "expired.png")] } },
		});
		const [first, expired] = item?.files ?? [];
		if (!first || !expired) throw new Error("Expected both generated files");
		await fs.rename(image, path.join(root, "original.png"));
		await fs.writeFile(image, "unrelated replacement");
		await expect(store.resolveArtifact(first.path)).rejects.toThrow("changed identity");
		await expect(store.resolveArtifact(expired.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses the actual local TTS WAV output rather than the requested MP3 path", async () => {
		const { workspace } = await fixture();
		const store = new TranscriptStore(workspace);
		store.apply({
			type: "tool_execution_start",
			toolCallId: "speech",
			toolName: "write",
			args: { path: "xd://tts" },
		});
		const item = store.apply({
			type: "tool_execution_end",
			toolCallId: "speech",
			result: {
				details: {
					xdev: {
						tool: "tts",
						mode: "execute",
						args: { output_path: "voice.mp3" },
						inner: { bytes: 46, codec: "wav", backend: "local-inference" },
					},
				},
			},
		});
		expect(item?.files).toEqual([{ path: "voice.wav", operation: "generate" }]);
	});
});

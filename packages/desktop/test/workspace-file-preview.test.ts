import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceTarget } from "../src/main/guards";
import { readWorkspaceFilePreview } from "../src/main/workspace-file-preview";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gradivus-preview-"));
	roots.push(root);
	return fs.realpath(root);
}
const noRasterDecode = () => {
	throw new Error("Unexpected raster decode");
};

describe("workspace file previews", () => {
	it("returns bounded text without executing HTML or truncating inside UTF-8 characters", async () => {
		const root = await workspace();
		const target = path.join(root, "page.html");
		await fs.writeFile(target, `${"a".repeat(256 * 1024 - 1)}😀<script>alert(1)</script>`);
		const result = await readWorkspaceFilePreview(target, "page.html", 512, noRasterDecode);
		expect(result.kind).toBe("text");
		if (result.kind !== "text") throw new Error("Expected text");
		expect(result.text).toBe("a".repeat(256 * 1024 - 1));
		expect(result.truncated).toBe(true);
		expect((await resolveWorkspaceTarget(root, "page.html")).revealOnly).toBe(true);
	});

	it("returns real audio bytes and rejects files disguised as media or text", async () => {
		const root = await workspace();
		const wav = Buffer.alloc(46);
		wav.write("RIFF", 0);
		wav.writeUInt32LE(38, 4);
		wav.write("WAVEfmt ", 8);
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20);
		wav.writeUInt16LE(1, 22);
		wav.writeUInt32LE(8000, 24);
		wav.writeUInt32LE(16000, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36);
		wav.writeUInt32LE(2, 40);
		await fs.writeFile(path.join(root, "voice.wav"), wav);
		const result = await readWorkspaceFilePreview(path.join(root, "voice.wav"), "voice.wav", 512, noRasterDecode);
		expect(result).toMatchObject({
			kind: "audio",
			byteSize: 46,
			mimeType: "audio/wav",
			dataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
		});
		await fs.writeFile(path.join(root, "fake.mp4"), "<html><script>alert(1)</script></html>");
		expect(
			await readWorkspaceFilePreview(path.join(root, "fake.mp4"), "fake.mp4", 512, noRasterDecode),
		).toMatchObject({ kind: "unavailable", message: expect.stringContaining("Open") });
		await fs.writeFile(path.join(root, "binary.txt"), Buffer.from([0, 1, 2, 3]));
		expect(
			await readWorkspaceFilePreview(path.join(root, "binary.txt"), "binary.txt", 512, noRasterDecode),
		).toMatchObject({ kind: "unavailable" });
	});

	it("does not base64 oversized media and preserves unsupported format metadata", async () => {
		const root = await workspace();
		const target = path.join(root, "movie.mp4");
		await fs.writeFile(target, "");
		await fs.truncate(target, 8 * 1024 * 1024 + 1);
		expect(await readWorkspaceFilePreview(target, "movie.mp4", 512, noRasterDecode)).toEqual({
			kind: "unavailable",
			path: "movie.mp4",
			byteSize: 8 * 1024 * 1024 + 1,
			mimeType: "video/mp4",
			message: expect.stringContaining("8 MiB"),
		});
		await fs.writeFile(path.join(root, "report.pdf"), "%PDF-1.7");
		expect(
			await readWorkspaceFilePreview(path.join(root, "report.pdf"), "report.pdf", 512, noRasterDecode),
		).toMatchObject({ kind: "unavailable", byteSize: 8, mimeType: "application/pdf" });
	});

	it("keeps SVG in an image-only payload and reveals rather than launches native SVG", async () => {
		const root = await workspace();
		await fs.writeFile(
			path.join(root, "vector.svg"),
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360"/></svg>',
		);
		expect(
			await readWorkspaceFilePreview(path.join(root, "vector.svg"), "vector.svg", 512, noRasterDecode),
		).toMatchObject({
			kind: "image",
			width: 640,
			height: 360,
			mimeType: "image/svg+xml",
			dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
		});
		expect((await resolveWorkspaceTarget(root, "vector.svg")).revealOnly).toBe(true);
	});

	it("rejects traversal and symlink escapes without opening the outside file", async () => {
		const root = await workspace();
		const outside = await workspace();
		await fs.writeFile(path.join(outside, "secret.txt"), "private");
		await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
		await expect(resolveWorkspaceTarget(root, "escape/secret.txt")).rejects.toThrow("outside the workspace");
		await expect(resolveWorkspaceTarget(root, "../secret.txt")).rejects.toThrow("Invalid workspace");
	});
});

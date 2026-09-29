import * as fsConstants from "node:fs";
import * as fs from "node:fs/promises";
import type { HostedWorkspaceFilePreview } from "@gradivus/chat/contracts";
import { isTextWorkspaceFile, workspaceFileKind, workspaceFileMimeType } from "@gradivus/chat/workspace-file-types";
import { parseImagePreviewMetadata, type ImagePreviewMetadata } from "@oh-my-pi/pi-utils/mime";
import type { NativeImage } from "electron";

// Authenticated loopback commands use JSON (17 MiB request cap). Keep preview responses
// below 12 MiB including base64 expansion; IPC uses the same bounded representation.
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 4_194_304;

function mediaSignature(bytes: Buffer, mimeType: string): boolean {
	switch (mimeType) {
		case "video/mp4":
		case "audio/mp4":
		case "video/quicktime":
			return bytes.toString("ascii", 4, 8) === "ftyp";
		case "video/webm":
			return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
		case "audio/ogg":
		case "video/ogg":
			return bytes.toString("ascii", 0, 4) === "OggS";
		case "audio/wav":
			return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
		case "audio/flac":
			return bytes.toString("ascii", 0, 4) === "fLaC";
		case "audio/mpeg":
			return bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
		case "audio/aac":
			return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
		default:
			return false;
	}
}

/** The caller must authorize and canonicalize the target before invoking this reader. */
export async function readWorkspaceFilePreview(
	target: string,
	displayPath: string,
	maxDimension: number,
	decodeImage: (bytes: Buffer) => NativeImage,
): Promise<HostedWorkspaceFilePreview> {
	const mimeType = workspaceFileMimeType(displayPath);
	const kind = workspaceFileKind(displayPath);
	const before = await fs.lstat(target);
	const metadata = { path: displayPath, byteSize: before.size, mimeType };
	const unavailable = (message: string): HostedWorkspaceFilePreview => ({ kind: "unavailable", ...metadata, message });
	if (!before.isFile()) return unavailable("This target is not a regular file. Use Open to reveal it on Desktop.");
	const file = await fs.open(
		target,
		fsConstants.constants.O_RDONLY |
			(fsConstants.constants.O_NOFOLLOW ?? 0) |
			(fsConstants.constants.O_NONBLOCK ?? 0),
	);
	try {
		const stat = await file.stat();
		if (
			!stat.isFile() ||
			stat.dev !== before.dev ||
			stat.ino !== before.ino ||
			(await fs.realpath(target)) !== target
		)
			throw new Error("Preview target changed identity");
		// Read from the same handle that was sized; never readFile an input that can grow unbounded.
		const text = isTextWorkspaceFile(displayPath);
		const limit = text ? MAX_TEXT_BYTES : kind === "image" ? MAX_IMAGE_INPUT_BYTES : MAX_MEDIA_BYTES;
		if (!text && stat.size > limit)
			return unavailable(
				`This file exceeds the ${limit / (1024 * 1024)} MiB preview limit. Use Open to view it on Desktop.`,
			);
		if (kind !== "image" && kind !== "audio" && kind !== "video" && !text)
			return unavailable("This file format has no inline preview. Use Open to view or reveal it on Desktop.");
		const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1);
		let length = 0;
		while (length < bytes.length) {
			const result = await file.read(bytes, length, bytes.length - length, length);
			if (!result.bytesRead) break;
			length += result.bytesRead;
		}
		const truncated = length > limit || stat.size > limit;
		const data = bytes.subarray(0, Math.min(length, limit));
		if (!text && truncated)
			return unavailable("The file grew beyond the preview limit. Use Open to view it on Desktop.");
		if (text) {
			try {
				const content = new TextDecoder("utf-8", { fatal: true }).decode(data, { stream: truncated });
				if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content))
					return unavailable("This file contains binary data. Use Open to view or reveal it on Desktop.");
				return { kind: "text", ...metadata, text: content, truncated };
			} catch {
				return unavailable("This file is not UTF-8 text. Use Open to view it on Desktop.");
			}
		}
		if (kind === "audio" || kind === "video") {
			if (!mediaSignature(data, mimeType))
				return unavailable(
					"This media container is unsupported or does not match its file type. Use Open to play it on Desktop.",
				);
			return { kind, ...metadata, dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
		}
		let imageMetadata: ImagePreviewMetadata | null;
		try {
			imageMetadata = parseImagePreviewMetadata(data, mimeType);
		} catch {
			return unavailable("This image is malformed. Use Open to view or reveal it on Desktop.");
		}
		const width = imageMetadata?.width ?? 0;
		const height = imageMetadata?.height ?? 0;
		if (
			!imageMetadata ||
			!Number.isFinite(width) ||
			!Number.isFinite(height) ||
			width <= 0 ||
			height <= 0 ||
			width > MAX_IMAGE_DIMENSION ||
			height > MAX_IMAGE_DIMENSION ||
			width * height > MAX_IMAGE_PIXELS
		)
			return unavailable(
				"The image format or dimensions are unsupported for preview. Use Open to view it on Desktop.",
			);
		// SVG is transported only as an image data URL, never HTML; browsers disable script/external loads in img.
		if (
			data.length <= MAX_MEDIA_BYTES &&
			(imageMetadata.mimeType === "image/svg+xml" ||
				imageMetadata.mimeType === "image/avif" ||
				Math.max(width, height) <= maxDimension)
		)
			return {
				kind: "image",
				...metadata,
				mimeType: imageMetadata.mimeType,
				dataUrl: `data:${imageMetadata.mimeType};base64,${data.toString("base64")}`,
				width,
				height,
			};
		const source = decodeImage(data);
		if (source.isEmpty())
			return unavailable("Desktop could not decode this image. Use Open to view it in another application.");
		const scale = Math.min(1, maxDimension / Math.max(width, height));
		const image =
			scale < 1
				? source.resize({
						width: Math.max(1, Math.round(width * scale)),
						height: Math.max(1, Math.round(height * scale)),
						quality: "good",
					})
				: source;
		const png = image.toPNG();
		if (png.length > MAX_MEDIA_BYTES)
			return unavailable("The decoded image exceeds the 8 MiB preview limit. Use Open to view it on Desktop.");
		return {
			kind: "image",
			...metadata,
			mimeType: "image/png",
			dataUrl: `data:image/png;base64,${png.toString("base64")}`,
			...image.getSize(),
		};
	} finally {
		await file.close();
	}
}

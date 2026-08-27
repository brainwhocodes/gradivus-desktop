import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseImageMetadata } from "@oh-my-pi/pi-utils/mime";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import {
	MAX_INLINE_PROMPT_BYTES,
	MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
	MAX_PROMPT_ATTACHMENT_BYTES,
	MAX_PROMPT_ATTACHMENT_COUNT,
	MAX_PROMPT_IMAGE_BYTES,
	MAX_TEMP_PROMPT_BYTES,
	type PromptAttachmentUpload,
	type PromptAttachmentView,
	type PromptImageContent,
} from "../shared/contracts";

const MAX_NAME_CODE_POINTS = 160;
const MAX_MIME_CODE_POINTS = 160;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

export interface ResolvedPromptAttachments {
	text: string;
	images: PromptImageContent[];
	views: PromptAttachmentView[];
}

type StoredAttachment = {
	view: PromptAttachmentView;
	path: string;
	bytes: Uint8Array;
};

export class PromptAttachmentStore {
	#tempDir: TempDir | undefined;
	#attachments = new Map<string, StoredAttachment>();
	#retainedBytes = 0;
	#closed = false;

	async stageUploads(value: unknown): Promise<PromptAttachmentView[]> {
		this.#assertOpen();
		const uploads = validateUploads(value);
		const batchBytes = uploads.reduce((total, upload) => total + upload.data.byteLength, 0);
		this.#assertQuota(batchBytes);
		const tempDir = await this.#getTempDir();
		const created: StoredAttachment[] = [];
		try {
			for (const upload of uploads) {
				const metadata = parseImageMetadata(upload.data);
				const kind = metadata ? "image" : "file";
				if (metadata && upload.data.byteLength > MAX_PROMPT_IMAGE_BYTES)
					throw new RangeError("image attachment exceeds 20 MiB");
				const view: PromptAttachmentView = {
					id: randomUUID(),
					name: displayName(upload.name),
					size: upload.data.byteLength,
					kind,
				};
				const stagedPath = tempDir.join(`${view.id}${extensionFor(upload.name, metadata?.mimeType)}`);
				await fs.writeFile(stagedPath, upload.data);
				await fs.chmod(stagedPath, 0o600);
				const stored = { view, path: path.resolve(stagedPath), bytes: upload.data };
				this.#attachments.set(view.id, stored);
				this.#retainedBytes += view.size;
				created.push(stored);
			}
			return created.map(item => ({ ...item.view }));
		} catch (error) {
			for (const item of created) {
				this.#attachments.delete(item.view.id);
				this.#retainedBytes -= item.view.size;
				await fs.rm(item.path, { force: true }).catch(() => {});
			}
			throw error;
		}
	}

	async stagePromptText(value: unknown): Promise<PromptAttachmentView> {
		this.#assertOpen();
		if (typeof value !== "string") throw new TypeError("prompt text must be text");
		const bytes = new TextEncoder().encode(value);
		if (bytes.byteLength === 0) throw new RangeError("prompt text cannot be empty");
		if (bytes.byteLength > MAX_TEMP_PROMPT_BYTES) throw new RangeError("prompt text exceeds 16 MiB");
		this.#assertQuota(bytes.byteLength);
		const tempDir = await this.#getTempDir();
		const view: PromptAttachmentView = {
			id: randomUUID(),
			name: "Pasted prompt",
			size: bytes.byteLength,
			kind: "prompt",
		};
		const stagedPath = tempDir.join(`${view.id}.txt`);
		await fs.writeFile(stagedPath, bytes);
		await fs.chmod(stagedPath, 0o600);
		this.#attachments.set(view.id, { view, path: path.resolve(stagedPath), bytes });
		this.#retainedBytes += view.size;
		return { ...view };
	}

	async resolve(attachmentIds: unknown, baseText: unknown): Promise<ResolvedPromptAttachments> {
		this.#assertOpen();
		if (typeof baseText !== "string") throw new TypeError("prompt text must be text");
		if (Buffer.byteLength(baseText, "utf8") > MAX_INLINE_PROMPT_BYTES) throw new RangeError("prompt exceeds 512 KiB");
		const ids = validateAttachmentIds(attachmentIds);
		const records = ids.map(id => {
			const record = this.#attachments.get(id);
			if (!record) throw new Error("unknown prompt attachment");
			return record;
		});
		const batchBytes = records.reduce((total, record) => total + record.view.size, 0);
		if (batchBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new RangeError("attachment batch exceeds 32 MiB");
		const envelope: string[] = [];
		const images: PromptImageContent[] = [];
		for (const record of records) {
			const mention = formatMention(record.path);
			if (record.view.kind === "prompt") {
				envelope.push(`Full prompt: ${mention}. Read this file as the complete user request before responding.`);
			} else if (record.view.kind === "image") {
				envelope.push(`Image ${JSON.stringify(record.view.name)} is attached to this message.`);
				const metadata = parseImageMetadata(record.bytes);
				if (!metadata) throw new Error("staged image is no longer valid");
				images.push({
					type: "image",
					data: Buffer.from(record.bytes).toString("base64"),
					mimeType: metadata.mimeType,
				});
			} else {
				envelope.push(`File ${JSON.stringify(record.view.name)}: ${mention}. Read this attachment as needed.`);
			}
		}
		const text = records.length === 0 ? baseText : [baseText.trim(), ...envelope].filter(Boolean).join("\n\n");
		if (!text) throw new RangeError("prompt cannot be empty");
		if (Buffer.byteLength(text, "utf8") > MAX_INLINE_PROMPT_BYTES)
			throw new RangeError("composed prompt exceeds 512 KiB");
		return { text, images, views: records.map(record => ({ ...record.view })) };
	}

	async release(attachmentIds: unknown): Promise<void> {
		if (this.#closed) return;
		const ids = validateAttachmentIds(attachmentIds, true);
		for (const id of ids) {
			const record = this.#attachments.get(id);
			if (!record) continue;
			this.#attachments.delete(id);
			this.#retainedBytes -= record.view.size;
			await fs.rm(record.path, { force: true }).catch(() => {});
		}
		if (this.#attachments.size === 0) {
			const tempDir = this.#tempDir;
			this.#tempDir = undefined;
			await tempDir?.remove().catch(() => {});
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#attachments.clear();
		this.#retainedBytes = 0;
		const tempDir = this.#tempDir;
		this.#tempDir = undefined;
		await tempDir?.remove().catch(() => {});
	}

	async #getTempDir(): Promise<TempDir> {
		if (this.#tempDir) return this.#tempDir;
		const tempDir = await TempDir.create("@gradivus-prompt-");
		if (this.#closed) {
			await tempDir.remove().catch(() => {});
			throw new Error("prompt attachment store is closed");
		}
		this.#tempDir = tempDir;
		return tempDir;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("prompt attachment store is closed");
	}

	#assertQuota(bytes: number): void {
		if (this.#retainedBytes + bytes > MAX_RETAINED_BYTES)
			throw new RangeError("prompt attachment storage quota exceeded");
	}
}

function validateUploads(value: unknown): PromptAttachmentUpload[] {
	if (!Array.isArray(value)) throw new TypeError("attachments must be an array");
	if (value.length === 0) throw new RangeError("attachments cannot be empty");
	if (value.length > MAX_PROMPT_ATTACHMENT_COUNT) throw new RangeError("too many attachments");
	let batchBytes = 0;
	const uploads: PromptAttachmentUpload[] = [];
	for (let index = 0; index < value.length; index++) {
		const candidate = value[index];
		if (typeof candidate !== "object" || candidate === null)
			throw new TypeError(`attachment ${index + 1} is invalid`);
		const input = candidate as Record<string, unknown>;
		if (
			typeof input.name !== "string" ||
			input.name.length === 0 ||
			Array.from(input.name).length > MAX_NAME_CODE_POINTS
		)
			throw new RangeError(`attachment ${index + 1} has an invalid name`);
		if (
			input.mimeType !== undefined &&
			(typeof input.mimeType !== "string" || Array.from(input.mimeType).length > MAX_MIME_CODE_POINTS)
		)
			throw new RangeError(`attachment ${index + 1} has an invalid MIME type`);
		if (!(input.data instanceof Uint8Array)) throw new TypeError(`attachment ${index + 1} data must be bytes`);
		const data = new Uint8Array(input.data);
		if (data.byteLength === 0 || data.byteLength > MAX_PROMPT_ATTACHMENT_BYTES)
			throw new RangeError(`attachment ${index + 1} exceeds 25 MiB`);
		batchBytes += data.byteLength;
		if (batchBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new RangeError("attachment batch exceeds 32 MiB");
		uploads.push({ name: input.name, mimeType: input.mimeType as string | undefined, data });
	}
	return uploads;
}

function validateAttachmentIds(value: unknown, allowDuplicates = false): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new TypeError("attachment IDs must be an array");
	if (value.length > MAX_PROMPT_ATTACHMENT_COUNT) throw new RangeError("too many attachment IDs");
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string" || candidate.length < 8 || candidate.length > 100)
			throw new TypeError("invalid prompt attachment ID");
		if (!allowDuplicates && seen.has(candidate)) throw new RangeError("duplicate prompt attachment ID");
		seen.add(candidate);
		ids.push(candidate);
	}
	return ids;
}

function displayName(value: string): string {
	const name = path.basename(value);
	if (!name || name === "." || name === "..") throw new RangeError("attachment name is invalid");
	return name;
}

function extensionFor(name: string, mimeType?: string): string {
	const extension = path.extname(displayName(name)).toLowerCase();
	if (/^\.[a-z0-9]{1,16}$/.test(extension)) return extension;
	if (mimeType === "image/png") return ".png";
	if (mimeType === "image/jpeg") return ".jpg";
	if (mimeType === "image/gif") return ".gif";
	if (mimeType === "image/webp") return ".webp";
	return ".bin";
}

function formatMention(value: string): string {
	if (!value.includes('"')) return `@"${value}"`;
	if (!value.includes("'")) return `@'${value}'`;
	throw new Error("staged attachment path cannot be represented by the file mention grammar");
}

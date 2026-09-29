import * as path from "node:path";
import { documentToMarkdown, type DocumentMarkdownResult } from "@oh-my-pi/pi-natives";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { resolveLocalRoot } from "../internal-urls";
import { Markit } from "../markit";
import type { ToolSession } from "../tools";
import { ToolAbortError } from "../tools/tool-errors";
import { recoverDocumentWithVision } from "./document-vision";
import {
	type MarkitConversionCacheStatus,
	markitConversionCacheKey,
	readMarkitConversionCache,
	writeMarkitConversionCache,
} from "./markit-cache";

/** AnyDoc's supported local formats; rich image extraction retains the Markit converters. */
export const CONVERTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
	".doc",
	".docx",
	".docm",
	".ppt",
	".pps",
	".pot",
	".pptx",
	".pptm",
	".ppsx",
	".ppsm",
	".xls",
	".xlsx",
	".xlsm",
	".xlsb",
	".odt",
	".ods",
	".odp",
	".rtf",
	".epub",
	".csv",
	".pdf",
]);

const DOCUMENT_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
	"application/pdf": ".pdf",
	"application/x-pdf": ".pdf",
	"application/msword": ".doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/vnd.ms-word.document.macroenabled.12": ".docm",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"application/vnd.openxmlformats-officedocument.presentationml.slideshow": ".ppsx",
	"application/vnd.ms-powerpoint.presentation.macroenabled.12": ".pptm",
	"application/vnd.ms-powerpoint.slideshow.macroenabled.12": ".ppsm",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.ms-excel.sheet.macroenabled.12": ".xlsm",
	"application/vnd.ms-excel.sheet.binary.macroenabled.12": ".xlsb",
	"application/vnd.oasis.opendocument.text": ".odt",
	"application/vnd.oasis.opendocument.spreadsheet": ".ods",
	"application/vnd.oasis.opendocument.presentation": ".odp",
	"application/rtf": ".rtf",
	"text/rtf": ".rtf",
	"application/epub+zip": ".epub",
	"text/csv": ".csv",
};

export function documentExtensionForMime(mime: string): string | undefined {
	return Object.hasOwn(DOCUMENT_EXTENSION_BY_MIME, mime) ? DOCUMENT_EXTENSION_BY_MIME[mime] : undefined;
}

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

export interface MarkitConversionResult {
	content: string;
	ok: boolean;
	error?: string;
	partial?: boolean;
	cache?: MarkitConversionCacheStatus;
}

export interface MarkitFileConversionOptions {
	/** Explicit rich extraction; bypasses the text-only engine and its cache. */
	imageDir?: string;
	/** Enables real page/image vision recovery when local extraction is incomplete. */
	session?: ToolSession;
}

/** Ignore structural/image placeholders without discarding short but genuine text. */
export function hasDocumentText(markdown: string): boolean {
	const visible = markdown
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/^\s*#{1,6}\s*(?:page|slide|sheet)\s*\d+\s*$/gim, "")
		.replace(/^\s*\[?(?:image|picture|figure)(?:[_\s-]*\d+)?\]?\s*$/gim, "");
	return /[\p{L}\p{N}]/u.test(visible);
}

async function convertText(
	bytes: Uint8Array,
	extension: string,
	signal?: AbortSignal,
	options?: { useCache?: boolean; session?: ToolSession; sourcePath?: string },
): Promise<MarkitConversionResult> {
	if (signal?.aborted) throw new ToolAbortError();
	if (bytes.byteLength > MAX_DOCUMENT_BYTES)
		return { content: "", ok: false, error: "Document exceeds the 64 MiB local conversion limit; source preserved." };
	const cacheKey = options?.useCache === false ? undefined : markitConversionCacheKey(bytes, extension);
	if (cacheKey) {
		const cached = await readMarkitConversionCache(cacheKey);
		if (signal?.aborted) throw new ToolAbortError();
		if (cached.status === "hit" && hasDocumentText(cached.content))
			return { content: cached.content, ok: true, cache: "hit" };
	}
	let conversion: DocumentMarkdownResult;
	try {
		conversion = await untilAborted(signal, () => documentToMarkdown(bytes, extension, signal));
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		conversion = {
			markdown: "",
			error: error instanceof Error ? error.message : String(error),
			pagesNeedingOcr: [],
			images: [],
			imageCount: 0,
		};
	}
	if (signal?.aborted) throw new ToolAbortError();
	const complete =
		!conversion.error && conversion.pagesNeedingOcr.length === 0 && hasDocumentText(conversion.markdown);
	if (complete) {
		if (cacheKey) await writeMarkitConversionCache(cacheKey, conversion.markdown);
		return { content: conversion.markdown, ok: true, cache: cacheKey ? "miss" : "skipped" };
	}
	if (!options?.session) {
		return {
			content: conversion.markdown,
			ok: false,
			partial: hasDocumentText(conversion.markdown),
			error: `AnyDoc: ${conversion.error ?? "document text is empty or incomplete"}. Vision recovery requires a model-enabled document read; source preserved.`,
			cache: "skipped",
		};
	}
	let sourcePath = options.sourcePath;
	if (!sourcePath) {
		const root = resolveLocalRoot(options.session.localProtocolOptions ?? options.session);
		const savedExtension = conversion.pageCount !== undefined ? ".pdf" : extension;
		sourcePath = path.join(
			root,
			`document-${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}${savedExtension}`,
		);
		await Bun.write(sourcePath, bytes);
	}
	if (conversion.errorCode === "resourceLimit") {
		return {
			content: conversion.markdown,
			ok: false,
			error: `AnyDoc safety limit: ${conversion.error}. Automatic rendering was not attempted because it would bypass the document's resource limit. Source preserved: ${sourcePath}`,
			cache: "skipped",
		};
	}
	const recovered = await recoverDocumentWithVision(options.session, sourcePath, conversion, signal);
	return { ...recovered, cache: "skipped" };
}

export async function convertFileWithMarkit(
	filePath: string,
	signal?: AbortSignal,
	options?: MarkitFileConversionOptions,
): Promise<MarkitConversionResult> {
	if (signal?.aborted) throw new ToolAbortError();
	try {
		const file = Bun.file(filePath);
		if ((await file.stat()).size > MAX_DOCUMENT_BYTES)
			return {
				content: "",
				ok: false,
				error: "Document exceeds the 64 MiB local conversion limit; source preserved.",
			};
		if (options?.imageDir && path.extname(filePath).toLowerCase() !== ".pdf") {
			const rich = await untilAborted(signal, () =>
				new Markit().convertFile(filePath, { imageDir: options.imageDir }),
			);
			return { content: rich.markdown, ok: rich.markdown.trim().length > 0, cache: "skipped" };
		}
		const bytes = await untilAborted(signal, () => file.bytes());
		return await convertText(bytes, path.extname(filePath).toLowerCase(), signal, {
			session: options?.session,
			sourcePath: filePath,
		});
	} catch (error) {
		if (signal?.aborted || error instanceof ToolAbortError) throw new ToolAbortError();
		return {
			content: "",
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			cache: "skipped",
		};
	}
}

export async function convertBufferWithMarkit(
	buffer: Uint8Array,
	extension: string,
	signal?: AbortSignal,
	options?: { useCache?: boolean; session?: ToolSession },
): Promise<MarkitConversionResult> {
	const normalized = extension.trim().toLowerCase().replace(/^\.+/, "");
	// Extensions may originate from HTTP headers; never allow path separators in saved source names.
	const safeExtension = /^[a-z0-9]+$/.test(normalized) ? `.${normalized}` : ".bin";
	return convertText(buffer, safeExtension, signal, options);
}

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { DocumentMarkdownResult } from "@oh-my-pi/pi-natives";
import { $which, prompt, ptree, TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import documentScanPrompt from "../prompts/tools/document-scan.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { renderPdfPageScreenshot } from "../tools/read-pdf";
import { ToolAbortError } from "../tools/tool-errors";
import { loadImageInput } from "./image-loading";
import { askImageQuestion, resolveImageQuestionModel } from "./image-question";

const MAX_VISION_PAGES = 12;
const VISION_DEADLINE_MS = 180_000;

export interface DocumentVisionResult {
	content: string;
	ok: boolean;
	partial?: boolean;
	error?: string;
}

/** Replace scanned PDF pages without appending them out of document order. */
export function mergePdfPageText(markdown: string, transcriptions: ReadonlyMap<number, string>): string {
	const markers = [...markdown.matchAll(/<!-- Page (\d+) -->/g)];
	const pages = new Map<number, string>();
	for (let index = 0; index < markers.length; index++) {
		const marker = markers[index]!;
		pages.set(Number(marker[1]), markdown.slice(marker.index! + marker[0].length, markers[index + 1]?.index).trim());
	}
	for (const [page, text] of transcriptions) pages.set(page, text);
	const preamble = markdown.slice(0, markers[0]?.index ?? 0).trim();
	return [
		preamble,
		...[...pages].sort(([left], [right]) => left - right).map(([page, text]) => `<!-- Page ${page} -->\n\n${text}`),
	]
		.filter(Boolean)
		.join("\n\n");
}

/** No installation, network conversion, or alteration of the source document. */
async function officeToPdf(source: string, temporary: TempDir, signal: AbortSignal): Promise<string> {
	const executable =
		(process.platform === "win32" ? $which("soffice.com") : undefined) ?? $which("soffice") ?? $which("libreoffice");
	if (!executable) {
		throw new ToolError(
			"No local full-page renderer for this format: LibreOffice (soffice/libreoffice) is not on PATH. Install LibreOffice and add its program directory to PATH, or export the source to PDF locally.",
		);
	}
	const profile = pathToFileURL(temporary.join("profile")).href;
	const result = await ptree.exec(
		[
			executable,
			`-env:UserInstallation=${profile}`,
			"--headless",
			"--nologo",
			"--nodefault",
			"--norestore",
			"--convert-to",
			"pdf",
			"--outdir",
			temporary.path(),
			source,
		],
		{ signal, timeout: 60_000, allowNonZero: true },
	);
	const pdf = temporary.join(`${path.parse(source).name}.pdf`);
	if (!result.ok || !(await Bun.file(pdf).exists())) {
		throw new ToolError(
			`LibreOffice could not render this document to PDF: ${result.stderr.trim() || "no PDF was produced"}`,
		);
	}
	return pdf;
}

/** Scan actual rendered pages, or explicitly partial embedded assets, with the image-question role. */
export async function recoverDocumentWithVision(
	session: ToolSession,
	source: string,
	conversion: DocumentMarkdownResult,
	signal?: AbortSignal,
): Promise<DocumentVisionResult> {
	if (signal?.aborted) throw new ToolAbortError();
	const deadline = AbortSignal.timeout(VISION_DEADLINE_MS);
	const effectiveSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const temporary = await TempDir.create("@omp-document-scan-");
	const parts: string[] = [];
	let covered = 0;
	let total: number | undefined;
	let partial = false;
	const pageText = new Map<number, string>();
	const mixedPdf = conversion.errorCode === "needsOcr" && /<!-- Page \d+ -->/.test(conversion.markdown);
	try {
		const model = resolveImageQuestionModel(session);
		const question = prompt.render(documentScanPrompt);
		const transcribe = async (imagePath: string, label: string): Promise<string> => {
			const image = await untilAborted(effectiveSignal, () =>
				loadImageInput({
					path: imagePath,
					resolvedPath: imagePath,
					cwd: session.cwd,
					autoResize: true,
					excludeWebP: true,
				}),
			);
			if (!image) throw new ToolError(`${label} did not render to a supported image.`);
			const answer = await askImageQuestion(session, model, image, question, effectiveSignal);
			const text = answer.text.trim();
			if (!text) throw new ToolError(`${label}: vision model returned no usable transcription.`);
			parts.push(`## ${label}\n\n${text}`);
			covered++;
			return text;
		};
		// The native bridge populates pageCount only for PDF inspection/NeedsOcr,
		// including PDFs whose source name has another extension.
		let pdf: string | undefined =
			path.extname(source).toLowerCase() === ".pdf" || conversion.pageCount !== undefined ? source : undefined;
		let renderFailure: string | undefined;
		if (!pdf) {
			try {
				pdf = await officeToPdf(source, temporary, effectiveSignal);
			} catch (error) {
				if (effectiveSignal.aborted) throw error;
				renderFailure = error instanceof Error ? error.message : String(error);
			}
		}
		if (pdf) {
			const nativePageCount = pdf === source ? conversion.pageCount : undefined;
			total =
				typeof nativePageCount === "number" && Number.isSafeInteger(nativePageCount) && nativePageCount > 0
					? nativePageCount
					: undefined;
			if (mixedPdf && pdf === source) {
				const requestedPages = [...new Set(conversion.pagesNeedingOcr)].sort((left, right) => left - right);
				for (const page of requestedPages.slice(0, MAX_VISION_PAGES)) {
					const screenshot = await renderPdfPageScreenshot(session, pdf, page, effectiveSignal);
					pageText.set(page, await transcribe(screenshot.dest, `Page ${page} (vision transcription)`));
				}
				const missing = requestedPages.filter(page => !pageText.has(page));
				partial = missing.length > 0;
				parts.splice(0, parts.length, mergePdfPageText(conversion.markdown, pageText));
				parts.unshift(
					`[AnyDoc local text plus vision transcription of pages ${[...pageText.keys()].join(", ")}; ${partial ? `PARTIAL: pages ${missing.join(", ")} still require OCR` : `all ${total ?? "known"} pages covered`}. Source preserved: ${source}]`,
				);
			} else {
				for (let page = 1; page <= Math.min(total ?? 1, MAX_VISION_PAGES); page++) {
					const screenshot = await renderPdfPageScreenshot(session, pdf, page, effectiveSignal);
					const reportedCount = screenshot.pageCount;
					if (
						total === undefined &&
						typeof reportedCount === "number" &&
						Number.isSafeInteger(reportedCount) &&
						reportedCount > 0
					)
						total = reportedCount;
					await transcribe(screenshot.dest, `Page ${page}`);
				}
				partial = total === undefined || covered < total;
				parts.unshift(
					`[Vision transcription: pages 1-${covered} of ${total ?? "unknown total"}; ${partial ? "PARTIAL coverage" : "all pages rendered"}. Source preserved: ${source}]`,
				);
			}
		} else {
			total = conversion.imageCount;
			if (conversion.images.length === 0)
				throw new ToolError(renderFailure ?? "No embedded images or local page renderer are available.");
			partial = true;
			if (conversion.markdown.trim()) parts.push(`## Partial local text (AnyDoc)\n\n${conversion.markdown}`);
			for (const [index, asset] of conversion.images.entries()) {
				if (covered >= MAX_VISION_PAGES) break;
				const imagePath = temporary.join(`asset-${index}${asset.mimeType === "image/svg+xml" ? ".svg" : ""}`);
				await Bun.write(imagePath, asset.data);
				try {
					await transcribe(imagePath, `Embedded image ${index + 1} (${asset.origin})`);
				} catch (error) {
					if (effectiveSignal.aborted) throw error;
					parts.push(
						`[Embedded image ${index + 1} unavailable: ${error instanceof Error ? error.message : String(error)}]`,
					);
				}
			}
			if (covered === 0) throw new ToolError(`No embedded image could be transcribed. ${parts.join("\n\n")}`);
			parts.unshift(
				`[PARTIAL document recovery: ${covered} of ${total} embedded images transcribed in asset order, not page order. Page layout and unrendered content are NOT covered. ${renderFailure ?? "No full-page renderer available."} Source preserved: ${source}]`,
			);
		}
		if (covered === 0) throw new ToolError("Document recovery produced no page or image transcription.");
		return { content: parts.join("\n\n"), ok: true, partial };
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		const reason = deadline.aborted
			? "Document vision scan exceeded its 180-second deadline"
			: error instanceof Error
				? error.message
				: String(error);
		const errorText = `AnyDoc: ${conversion.error ?? "text extraction was empty or incomplete"}. Vision fallback: ${reason}. Source preserved: ${source}`;
		if (covered > 0) {
			if (mixedPdf) parts.splice(0, parts.length, mergePdfPageText(conversion.markdown, pageText));
			return {
				content: `[PARTIAL recovery: ${covered} page(s)/asset(s) transcribed; remaining coverage unavailable. ${errorText}]\n\n${parts.join("\n\n")}`,
				ok: true,
				partial: true,
				error: errorText,
			};
		}
		return { content: conversion.markdown, ok: false, partial: Boolean(conversion.markdown), error: errorText };
	} finally {
		await temporary.remove();
	}
}

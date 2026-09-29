import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as pdfRead from "@oh-my-pi/pi-coding-agent/tools/read-pdf";
import * as vision from "@oh-my-pi/pi-coding-agent/utils/image-question";
import { mergePdfPageText, recoverDocumentWithVision } from "@oh-my-pi/pi-coding-agent/utils/document-vision";
import {
	convertBufferWithMarkit,
	convertFileWithMarkit,
	hasDocumentText,
} from "@oh-my-pi/pi-coding-agent/utils/markit";

const directories: string[] = [];
const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function mixedPdf(): string {
	const text = "BT /F1 12 Tf 72 720 Td (Local first page text) Tj 0 -18 Td (Second line of native text) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R >>",
		"<< /Length 0 >>\nstream\n\nendstream",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(pdf.length);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("local AnyDoc document scans", () => {
	it("converts text-only RTF and CSV without a model or hosted OCR", async () => {
		const rtf = await convertBufferWithMarkit(
			Buffer.from("{\\rtf1\\ansi Quarterly revenue: 42}"),
			".rtf",
			undefined,
			{ useCache: false },
		);
		const csv = await convertBufferWithMarkit(
			Buffer.from('Region,Revenue\n"North, East",42\nWest,17\n'),
			".csv",
			undefined,
			{ useCache: false },
		);
		expect(rtf.ok).toBe(true);
		expect(rtf.content).toContain("Quarterly revenue: 42");
		expect(csv.ok).toBe(true);
		expect(csv.content).toContain("North, East");
		expect(csv.content).toContain("42");
		expect(csv.content).toContain("West");
	});

	it("keeps usable local text local even when the document also contains an image", async () => {
		const rtf = Buffer.from(`{\\rtf1\\ansi Readable invoice 7429{\\pict\\pngblip ${png.toString("hex")}}}`);
		const result = await convertBufferWithMarkit(rtf, ".rtf", undefined, { useCache: false });
		expect(result.ok).toBe(true);
		expect(result.content).toContain("Readable invoice 7429");
		expect(result.partial).not.toBe(true);
	});

	it("does not mistake structural or image placeholders for extracted text", () => {
		expect(hasDocumentText("<!-- image: image_1 -->\n# Page 1\n![scan](scan.png)\n| --- | --- |\n")).toBe(false);
		expect(hasDocumentText("\nImage_1\n")).toBe(false);
		expect(hasDocumentText("42")).toBe(true);
		expect(hasDocumentText("日本語")).toBe(true);
	});

	it("replaces OCR pages in numeric order without losing adjacent local text", () => {
		const text = "Title\n<!-- Page 1 -->\nFirst\n<!-- Page 2 -->\nUnusable\n<!-- Page 10 -->\nLast";
		const result = mergePdfPageText(text, new Map([[2, "Recovered middle"]]));
		expect(result).toContain("Title");
		expect(result).toContain("First");
		expect(result).toContain("Recovered middle");
		expect(result).toContain("Last");
		expect(result).not.toContain("Unusable");
		expect(result.indexOf("First")).toBeLessThan(result.indexOf("Recovered middle"));
		expect(result.indexOf("Recovered middle")).toBeLessThan(result.indexOf("Last"));
	});

	it("sends a no-text PDF page through vision and retains the native text page", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anydoc-scan-"));
		directories.push(directory);
		const source = path.join(directory, "mixed.pdf");
		const screenshot = path.join(directory, "page.png");
		await Bun.write(source, mixedPdf());
		await Bun.write(screenshot, png);
		const model = buildModel({
			id: "document-vision",
			name: "document-vision",
			api: "openai-completions",
			provider: "fixture",
			baseUrl: "https://fixture.invalid",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		vi.spyOn(vision, "resolveImageQuestionModel").mockReturnValue({ model, selectedPattern: "@vision" });
		let visionText = "Recovered second page";
		let reportedPageCount = 2;
		vi.spyOn(vision, "askImageQuestion").mockImplementation(async () => ({
			text: visionText,
			model: "fixture/document-vision",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		}));
		const renderedPages: number[] = [];
		vi.spyOn(pdfRead, "renderPdfPageScreenshot").mockImplementation(async (_session, _source, page) => {
			renderedPages.push(page);
			return {
				dest: screenshot,
				mimeType: "image/png",
				bytes: png.length,
				width: 1,
				height: 1,
				pageCount: reportedPageCount,
			};
		});
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		};
		const result = await convertFileWithMarkit(source, undefined, { session });
		expect(result.ok).toBe(true);
		expect(result.partial).toBe(false);
		expect(renderedPages).toEqual([2]);
		expect(result.content).toContain("Local first page text");
		expect(result.content.indexOf("Local first page text")).toBeLessThan(
			result.content.indexOf("Recovered second page"),
		);
		expect(result.content).toContain("Recovered second page");
		expect(await Bun.file(source).text()).toBe(mixedPdf());

		// Invalid zero-page metadata is unknown coverage, never a successful no-op.
		reportedPageCount = 0;
		const unknownCoverage = await recoverDocumentWithVision(session, source, {
			markdown: "",
			error: "No local text",
			pageCount: 0,
			pagesNeedingOcr: [],
			images: [],
			imageCount: 0,
		});
		expect(unknownCoverage.ok).toBe(true);
		expect(unknownCoverage.partial).toBe(true);
		expect(renderedPages.at(-1)).toBe(1);

		visionText = " \n ";
		const emptyVision = await convertFileWithMarkit(source, undefined, { session });
		expect(emptyVision.ok).toBe(false);
		expect(emptyVision.content).not.toContain("Recovered second page");
		expect(emptyVision.content).toContain("Local first page text");
	});

	it("rejects pre-cancelled scans before requesting vision", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			convertBufferWithMarkit(Buffer.from("%PDF-invalid"), ".pdf", controller.signal, { useCache: false }),
		).rejects.toThrow("abort");
	});
});

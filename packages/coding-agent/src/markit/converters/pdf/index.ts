import { documentToMarkdown } from "@oh-my-pi/pi-natives";
import type { ConversionResult, Converter, StreamInfo } from "../../types";

const EXTENSIONS = [".pdf"];
const MIMETYPES = ["application/pdf", "application/x-pdf"];

/** Low-level local AnyDoc conversion; session-aware reads recover failures with vision. */
export class PdfConverter implements Converter {
	name = "pdf";

	accepts(streamInfo: StreamInfo): boolean {
		if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
			return true;
		}
		if (streamInfo.mimetype && MIMETYPES.some(m => streamInfo.mimetype?.startsWith(m))) {
			return true;
		}
		return false;
	}

	async convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult> {
		const result = await documentToMarkdown(input, ".pdf");
		if (result.error || result.pagesNeedingOcr.length > 0 || !result.markdown.trim()) {
			throw new Error(result.error ?? "PDF text extraction is incomplete");
		}
		return { markdown: result.markdown };
	}
}

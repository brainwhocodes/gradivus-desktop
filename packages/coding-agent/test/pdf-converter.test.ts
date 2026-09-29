import { describe, expect, it } from "bun:test";
import { PdfConverter } from "../src/markit/converters/pdf";

describe("PdfConverter", () => {
	it("keeps accepting PDF extensions and MIME types", () => {
		const converter = new PdfConverter();

		expect(converter.accepts({ extension: ".pdf" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/pdf" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/pdf; charset=binary" })).toBe(true);
		expect(converter.accepts({ mimetype: "application/x-pdf" })).toBe(true);
		expect(converter.accepts({ extension: ".txt", mimetype: "text/plain" })).toBe(false);
	});

});

import { describe, expect, it } from "vitest";
import {
	buildPromptComposition,
	insertAttachmentReferences,
	removeAttachmentReference,
	resolveAttachmentInsertionIndex,
} from "../src/renderer/attachment-composition";
import type { PromptAttachmentView } from "../src/shared/contracts";

function attachment(id: string, reference: string, kind: PromptAttachmentView["kind"] = "file"): PromptAttachmentView {
	return { id, reference, kind, name: `${id}.txt`, size: 12 };
}

describe("attachment prompt composition", () => {
	it("inserts broad readable references at the requested caret", () => {
		const image = attachment("image-1", '[Image A1: "mockup.png"]', "image");
		const document = attachment("document-2", '[Document A2: "spec.pdf"]');
		const result = insertAttachmentReferences("Compare  with the header", [image, document], 8);

		expect(result.draft).toBe('Compare [Image A1: "mockup.png"] [Document A2: "spec.pdf"] with the header');
		expect(result.caret).toBe(result.draft.indexOf(" with the header"));
	});

	it("rebases a saved caret when text changes during staging", () => {
		expect(resolveAttachmentInsertionIndex("before after", "new before after", 7, 0)).toBe(11);
		expect(resolveAttachmentInsertionIndex("before after", "before after later", 7, 18)).toBe(7);
		expect(resolveAttachmentInsertionIndex("before after", "unrelated", 7, 4)).toBe(4);
	});

	it("replaces only owned marker occurrences with ordered attachment parts", () => {
		const document = attachment("document-1", '[Document A1: "report.pdf"]');
		const image = attachment("image-2", '[Image A2: "chart.png"]', "image");
		const draft = `Use ${document.reference} before ${image.reference}. Repeat ${document.reference} literally.`;

		expect(buildPromptComposition(draft, [document, image])).toEqual({
			parts: [
				{ type: "text", text: "Use " },
				{ type: "attachment", id: "document-1" },
				{ type: "text", text: " before " },
				{ type: "attachment", id: "image-2" },
				{ type: "text", text: `. Repeat ${document.reference} literally.` },
			],
		});
	});

	it("removes the marker with one surrounding separator", () => {
		const reference = '[Document A1: "report.pdf"]';
		expect(removeAttachmentReference(`Review ${reference} now`, reference)).toBe("Review now");
		expect(removeAttachmentReference(reference, reference)).toBe("");
	});
});

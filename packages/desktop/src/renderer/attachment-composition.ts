import type { PromptAttachmentView, PromptComposition, PromptCompositionPart } from "../shared/contracts";

export interface AttachmentReferenceInsertion {
	draft: string;
	caret: number;
}

function clampedIndex(value: number, length: number): number {
	if (!Number.isFinite(value)) return length;
	return Math.min(Math.max(Math.trunc(value), 0), length);
}

function appendText(parts: PromptCompositionPart[], text: string): void {
	if (!text) return;
	const previous = parts.at(-1);
	if (previous?.type === "text") {
		previous.text += text;
		return;
	}
	parts.push({ type: "text", text });
}

export function resolveAttachmentInsertionIndex(
	originalDraft: string,
	currentDraft: string,
	originalIndex: number,
	currentCaret: number,
): number {
	const anchor = clampedIndex(originalIndex, originalDraft.length);
	if (currentDraft === originalDraft) return anchor;
	const prefix = originalDraft.slice(0, anchor);
	const suffix = originalDraft.slice(anchor);
	if (prefix && currentDraft.startsWith(prefix)) return prefix.length;
	if (suffix && currentDraft.endsWith(suffix)) return currentDraft.length - suffix.length;
	return clampedIndex(currentCaret, currentDraft.length);
}

export function insertAttachmentReferences(
	draft: string,
	views: readonly PromptAttachmentView[],
	index: number,
): AttachmentReferenceInsertion {
	if (views.length === 0) return { draft, caret: clampedIndex(index, draft.length) };
	const anchor = clampedIndex(index, draft.length);
	const before = draft.slice(0, anchor);
	const after = draft.slice(anchor);
	const references = views.map(view => view.reference).join(" ");
	const leadingSpace = before && !/\s$/u.test(before) ? " " : "";
	const trailingSpace = after && !/^\s/u.test(after) ? " " : "";
	const insertion = `${leadingSpace}${references}${trailingSpace}`;
	return {
		draft: `${before}${insertion}${after}`,
		caret: before.length + leadingSpace.length + references.length + trailingSpace.length,
	};
}

export function removeAttachmentReference(draft: string, reference: string): string {
	const index = draft.indexOf(reference);
	if (index < 0) return draft;
	let before = draft.slice(0, index);
	let after = draft.slice(index + reference.length);
	if (/\s$/u.test(before) && /^\s/u.test(after)) after = after.slice(1);
	if (!before.trim() && !after.trim()) return "";
	if (!before) after = after.replace(/^\s/u, "");
	if (!after) before = before.replace(/\s$/u, "");
	return `${before}${after}`;
}

export function attachmentsReferencedByDraft(
	draft: string,
	views: readonly PromptAttachmentView[],
): PromptAttachmentView[] {
	return views.filter(view => draft.includes(view.reference));
}

export function buildPromptComposition(draft: string, views: readonly PromptAttachmentView[]): PromptComposition {
	const references = views
		.map(view => ({ view, index: draft.indexOf(view.reference) }))
		.filter(candidate => candidate.index >= 0)
		.sort((left, right) => left.index - right.index);
	const parts: PromptCompositionPart[] = [];
	let cursor = 0;
	for (const { view, index } of references) {
		if (index < cursor) continue;
		appendText(parts, draft.slice(cursor, index));
		parts.push({ type: "attachment", id: view.id });
		cursor = index + view.reference.length;
	}
	appendText(parts, draft.slice(cursor));
	return { parts };
}

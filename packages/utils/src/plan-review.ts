/** ATX heading: 1-6 `#`, required whitespace, a title, optional closing `#`s. */
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** Opening/closing code fence run (``` or ~~~), allowing up to 3 lead spaces. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface PlanSection {
	/** `0` = preamble (no heading, no outline entry); `1..6` = heading depth. */
	level: number;
	/** Plain-text heading label with inline Markdown lightly stripped. */
	title: string;
	/** Exact source slice for this section, including its trailing newline(s). */
	raw: string;
	/** One-based source line where this section starts. */
	startLine: number;
}

export interface PlanReviewAnnotationState {
	annotations: Array<{
		section: {
			index: number;
			title: string;
			/** Heading ancestry from the document root, when available. */
			path?: string[];
			/** Hash of the section source, used to reject ambiguous moved headings. */
			contentHash?: string;
		};
		target: { kind: "section" } | { kind: "line"; row: number; context: string; contextTruncated?: boolean };
		note: string;
	}>;
	deletedSections: string[];
	additionalFeedback: string;
}

/**
 * Collapse inline Markdown emphasis/link/code syntax to readable outline text.
 * This is deliberately light rather than a full Markdown render.
 */
export function stripInlineMarkdown(text: string): string {
	let out = text;
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
	out = out.replace(/<([^>\s]+)>/g, "$1");
	out = out.replace(/`([^`]+)`/g, "$1");
	out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
	out = out.replace(/(\*|_)(.+?)\1/g, "$2");
	out = out.replace(/~~(.+?)~~/g, "$1");
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Split Markdown into a preamble and fence-aware ATX heading sections. Joining
 * every `raw` field reproduces the source bytes exactly.
 */
export function parsePlanSections(text: string): PlanSection[] {
	const lines = text.split("\n");
	const offsets: number[] = new Array(lines.length);
	let cursor = 0;
	for (let i = 0; i < lines.length; i++) {
		offsets[i] = cursor;
		cursor += lines[i]!.length + 1;
	}

	const heads: Array<{ line: number; level: number; title: string }> = [];
	let fenceChar: string | null = null;
	let fenceLen = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const fence = FENCE_RE.exec(line);
		if (fenceChar === null) {
			if (fence) {
				fenceChar = fence[1]![0]!;
				fenceLen = fence[1]!.length;
				continue;
			}
		} else {
			if (fence && fence[1]![0] === fenceChar && fence[1]!.length >= fenceLen && fence[2]!.trim() === "") {
				fenceChar = null;
				fenceLen = 0;
			}
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) heads.push({ line: i, level: heading[1]!.length, title: stripInlineMarkdown(heading[2]!) });
	}

	const sections: PlanSection[] = [];
	const sliceRaw = (startLine: number, endLine: number): string => {
		const startOffset = offsets[startLine]!;
		const endOffset = endLine < lines.length ? offsets[endLine]! : text.length;
		return text.slice(startOffset, endOffset);
	};

	const firstHeadLine = heads.length > 0 ? heads[0]!.line : lines.length;
	if (firstHeadLine > 0) {
		const raw = sliceRaw(0, firstHeadLine);
		if (raw.length > 0) sections.push({ level: 0, title: "", raw, startLine: 1 });
	}

	for (let h = 0; h < heads.length; h++) {
		const head = heads[h]!;
		const endLine = h + 1 < heads.length ? heads[h + 1]!.line : lines.length;
		sections.push({
			level: head.level,
			title: head.title,
			raw: sliceRaw(head.line, endLine),
			startLine: head.line + 1,
		});
	}

	return sections;
}

/** Concatenate section source and guarantee one trailing newline when non-empty. */
export function joinPlanSections(sections: readonly PlanSection[]): string {
	let joined = "";
	for (const section of sections) joined += section.raw;
	if (joined.length === 0) return "";
	return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** Return the selected heading and every immediately nested descendant index. */
export function sectionDeletionSpan(sections: readonly PlanSection[], index: number): number[] {
	const target = sections[index];
	if (!target || target.level === 0) return [];
	const span = [index];
	for (let j = index + 1; j < sections.length; j++) {
		if (sections[j]!.level > target.level) span.push(j);
		else break;
	}
	return span;
}

function formatAnnotationFeedback(note: string): string {
	if (!note.includes("\n")) return `- ${note}\n`;
	let fence = "```";
	while (note.includes(fence)) fence += "`";
	return `${fence}md\n${note}\n${fence}\n`;
}

/** Build the canonical user-visible feedback prompt for a plan refinement turn. */
export function buildPlanRefinementFeedback(state: PlanReviewAnnotationState): string {
	const annotations = state.annotations.filter(annotation => annotation.note.trim().length > 0);
	const deletedSections = state.deletedSections.filter(title => title.trim().length > 0);
	const additionalFeedback = state.additionalFeedback.trim();
	if (annotations.length === 0 && deletedSections.length === 0 && !additionalFeedback) return "";

	let feedback = "Refinement feedback on the plan:\n";
	if (deletedSections.length > 0) {
		feedback += "\nRemove these sections:\n";
		for (const title of deletedSections) feedback += `- ${title}\n`;
	}

	let priorSectionKey: string | undefined;
	for (const annotation of annotations) {
		const sectionKey = JSON.stringify([
			annotation.section.index,
			annotation.section.title,
			annotation.section.path,
			annotation.section.contentHash,
		]);
		if (sectionKey !== priorSectionKey) {
			feedback += `\n## ${annotation.section.title || "Plan preamble"}\n`;
			priorSectionKey = sectionKey;
		}
		if (annotation.target.kind === "line") feedback += `> Line: ${annotation.target.context}\n`;
		feedback += formatAnnotationFeedback(annotation.note.trim());
	}

	if (additionalFeedback) feedback += `\n## Additional feedback\n${additionalFeedback}\n`;
	return feedback;
}

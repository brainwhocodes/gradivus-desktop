import { describe, expect, it } from "bun:test";
import {
	buildPlanRefinementFeedback,
	joinPlanSections,
	type PlanReviewAnnotationState,
	type PlanSection,
	parsePlanSections,
	sectionDeletionSpan,
	stripInlineMarkdown,
} from "@oh-my-pi/pi-utils/plan-review";

const titles = (sections: readonly PlanSection[]): string[] => sections.map(section => section.title);
const levels = (sections: readonly PlanSection[]): number[] => sections.map(section => section.level);

const emptyAnnotationState = (): PlanReviewAnnotationState => ({
	annotations: [],
	deletedSections: [],
	additionalFeedback: "",
});

describe("parsePlanSections", () => {
	it("splits a preamble and one section per ATX heading with source lines", () => {
		const sections = parsePlanSections("intro\n\n# Overview\n\nbody\n\n## Goal\n\ngoal\n\n# Risks\n\nrisk\n");
		expect(levels(sections)).toEqual([0, 1, 2, 1]);
		expect(titles(sections)).toEqual(["", "Overview", "Goal", "Risks"]);
		expect(sections.map(section => section.startLine)).toEqual([1, 3, 7, 11]);
		expect(sections[0]!.raw).toBe("intro\n\n");
	});

	it("emits no preamble section when the document opens with a heading", () => {
		const sections = parsePlanSections("# Top\n\nbody\n");
		expect(levels(sections)).toEqual([1]);
		expect(sections[0]).toMatchObject({ title: "Top", startLine: 1 });
	});

	it("does not treat headings inside fenced code blocks as sections", () => {
		const sections = parsePlanSections("# Real\n\n```\n# not a heading\n```\n\n~~~\n## also not\n~~~\n");
		expect(levels(sections)).toEqual([1]);
		expect(titles(sections)).toEqual(["Real"]);
	});

	it("requires whitespace after heading markers", () => {
		const sections = parsePlanSections("#tag is not a heading\nmore body\n");
		expect(levels(sections)).toEqual([0]);
		expect(sections[0]!.startLine).toBe(1);
	});

	it("strips inline Markdown and closing markers from titles", () => {
		const sections = parsePlanSections("## **Goal** & [docs](http://x) ##\n\nbody\n");
		expect(sections[0]!.title).toBe("Goal & docs");
	});
});

describe("joinPlanSections", () => {
	it("round-trips a newline-terminated document byte-for-byte", () => {
		const text = "intro\n\n# A\n\nbody a\n\n## A1\n\nnested\n\n# B\n\nbody b\n";
		expect(joinPlanSections(parsePlanSections(text))).toBe(text);
	});

	it("adds a trailing newline when the source lacks one", () => {
		expect(joinPlanSections(parsePlanSections("# A\n\nbody"))).toBe("# A\n\nbody\n");
	});

	it("returns an empty string for an empty document", () => {
		expect(joinPlanSections(parsePlanSections(""))).toBe("");
	});
});

describe("sectionDeletionSpan", () => {
	const sections = parsePlanSections("intro\n\n# A\n\na\n\n## A1\n\na1\n\n## A2\n\na2\n\n# B\n\nb\n");

	it("removes a heading together with its nested descendants", () => {
		expect(sectionDeletionSpan(sections, 1)).toEqual([1, 2, 3]);
	});

	it("removes only a leaf section", () => {
		expect(sectionDeletionSpan(sections, 2)).toEqual([2]);
	});

	it("never targets the preamble", () => {
		expect(sectionDeletionSpan(sections, 0)).toEqual([]);
	});

	it("preserves sibling sections when joining survivors", () => {
		const span = new Set(sectionDeletionSpan(sections, 1));
		const result = joinPlanSections(sections.filter((_, index) => !span.has(index)));
		expect(result).toContain("# B");
		expect(result).not.toContain("# A");
		expect(result).not.toContain("## A1");
	});
});

describe("stripInlineMarkdown", () => {
	it("collapses emphasis, code, links, and whitespace to readable text", () => {
		expect(stripInlineMarkdown("**bold** _it_ `code` [t](u)")).toBe("bold it code t");
		expect(stripInlineMarkdown("a   b\tc")).toBe("a b c");
	});
});

describe("buildPlanRefinementFeedback", () => {
	it("serializes deleted sections, section and line notes, and free-form feedback", () => {
		const state: PlanReviewAnnotationState = {
			annotations: [
				{
					section: { index: 1, title: "Execution" },
					target: { kind: "section" },
					note: "Name the rollback owner.",
				},
				{
					section: { index: 1, title: "Execution" },
					target: { kind: "line", row: 42, context: "Deploy the service" },
					note: "Add a canary step.",
				},
			],
			deletedSections: ["Legacy fallback"],
			additionalFeedback: "Keep the migration reversible.",
		};
		expect(buildPlanRefinementFeedback(state)).toBe(
			"Refinement feedback on the plan:\n\n" +
				"Remove these sections:\n- Legacy fallback\n\n" +
				"## Execution\n- Name the rollback owner.\n" +
				"> Line: Deploy the service\n- Add a canary step.\n\n" +
				"## Additional feedback\nKeep the migration reversible.\n",
		);
	});

	it("uses a longer Markdown fence for multiline notes containing fences", () => {
		const state = emptyAnnotationState();
		state.annotations.push({
			section: { index: 0, title: "" },
			target: { kind: "section" },
			note: "Explain with:\n```\nexample\n```",
		});
		expect(buildPlanRefinementFeedback(state)).toContain("````md\nExplain with:\n```\nexample\n```\n````\n");
	});

	it("returns no prompt when every feedback field is empty", () => {
		expect(buildPlanRefinementFeedback(emptyAnnotationState())).toBe("");
	});
});

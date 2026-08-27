import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/renderer/markdown";

describe("renderMarkdown magic keywords", () => {
	it("wraps ultrathink with magic-keyword-ultrathink in prose", () => {
		const html = renderMarkdown("Please use ultrathink to solve this.");
		expect(html).toContain('<span class="magic-keyword magic-keyword-ultrathink">ultrathink</span>');
	});

	it("wraps orchestrate with magic-keyword-orchestrate in prose", () => {
		const html = renderMarkdown("Let us orchestrate the task across workers.");
		expect(html).toContain('<span class="magic-keyword magic-keyword-orchestrate">orchestrate</span>');
	});

	it("wraps workflowz with magic-keyword-workflowz in prose", () => {
		const html = renderMarkdown("Run a workflowz pass in eval.");
		expect(html).toContain('<span class="magic-keyword magic-keyword-workflowz">workflowz</span>');
	});

	it("does not wrap magic keywords inside inline code spans", () => {
		const html = renderMarkdown("Run `ultrathink` command");
		expect(html).toContain("<code>ultrathink</code>");
		expect(html).not.toContain("magic-keyword-ultrathink");
	});

	it("does not wrap magic keywords inside fenced code blocks", () => {
		const html = renderMarkdown("```\norchestrate\n```");
		expect(html).toContain("<code>orchestrate</code>");
		expect(html).not.toContain("magic-keyword-orchestrate");
	});

	it("highlights diff lines inside fenced diff code blocks", () => {
		const diff = "```diff\n@@ -1,3 +1,4 @@\n-const old = 1;\n+const next = 2;\n context\n```";
		const html = renderMarkdown(diff);
		expect(html).toContain('class="diff-line line-hunk"');
		expect(html).toContain('class="diff-line line-removed"');
		expect(html).toContain('class="diff-line line-added"');
		expect(html).toContain('class="diff-line line-context"');
	});
});

import { describe, expect, it, vi } from "vitest";
import {
	copyMarkdownText,
	renderMarkdown,
	renderMarkdownDocument,
	renderStreamingMarkdown,
} from "../src/renderer/markdown";

describe("Markdown syntax rendering", () => {
	it("highlights only registered explicit language tokens", () => {
		const result = renderMarkdownDocument("```ts\nconst answer: number = 42;\n```");

		expect(result.html).toContain('class="hljs language-typescript"');
		expect(result.html).toContain('class="hljs-keyword"');
		expect(result.codeBlocks).toEqual([
			{
				rawCode: "const answer: number = 42;",
				language: "typescript",
				highlighted: true,
			},
		]);
	});

	it("uses escaped plain code for unknown and unlabelled fences without auto-detection", () => {
		const unknown = renderMarkdownDocument("```brainlang\nconst node = <unsafe>;\n```");
		const unlabelled = renderMarkdownDocument("```\nconst node = <unsafe>;\n```");

		for (const result of [unknown, unlabelled]) {
			expect(result.html).toContain("const node = &lt;unsafe&gt;;");
			expect(result.html).not.toContain('class="hljs');
			expect(result.html).not.toContain("hljs-keyword");
			expect(result.codeBlocks[0]?.highlighted).toBe(false);
		}
		expect(unknown.codeBlocks[0]?.language).toBeNull();
		expect(unlabelled.codeBlocks[0]?.language).toBeNull();
	});

	it("leaves an oversized supported fence escaped and unhighlighted", () => {
		const code = `${"const value = '<unsafe>';\n".repeat(1_000)}const tail = 1;`;
		const result = renderMarkdownDocument(`\`\`\`javascript\n${code}\n\`\`\``);

		expect(new TextEncoder().encode(code).byteLength).toBeGreaterThan(24 * 1024);
		expect(result.html).toContain("&lt;unsafe&gt;");
		expect(result.html).not.toContain('class="hljs');
		expect(result.codeBlocks[0]).toMatchObject({
			rawCode: code,
			language: "javascript",
			highlighted: false,
		});
	});

	it("keeps the dedicated diff renderer unchanged", () => {
		const diff = "```diff\n@@ -1 +1 @@\n-old\n+next\n context\n```";
		const html = renderMarkdown(diff);

		expect(html).toContain('<pre class="diff-code"><code>');
		expect(html).toContain('<span class="diff-line line-hunk">@@ -1 +1 @@</span>');
		expect(html).toContain('<span class="diff-line line-removed">-old</span>');
		expect(html).toContain('<span class="diff-line line-added">+next</span>');
		expect(html).toContain('<span class="diff-line line-context"> context</span>');
		expect(html).not.toContain('class="hljs');
		expect(html).not.toContain("markdown-code-frame");
	});

	it("escapes malicious HTML and removes unsafe links while retaining safe links", () => {
		const html = renderMarkdown(
			'<img src=x onerror="alert(1)"> [unsafe](javascript:alert(2)) [safe](https://example.com/docs)',
		);

		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("javascript:");
		expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener">safe</a>');
	});
});

describe("Markdown copy behavior", () => {
	it("exposes copy controls only when requested and retains raw fenced code", () => {
		const rawCode = 'const element = "<button data-id=\\"α\\">";';
		const result = renderMarkdownDocument(`\`\`\`js\n${rawCode}\n\`\`\``, {
			codeCopyActions: true,
		});

		expect(result.html).toContain('data-markdown-code-copy="0"');
		expect(result.html).toContain('class="markdown-code-copy-status sr-only" role="status" aria-live="polite"');
		expect(result.html).toContain('aria-label="Copy javascript code"');
		expect(result.html).not.toContain(rawCode);
		expect(result.codeBlocks[0]?.rawCode).toBe(rawCode);
	});

	it("passes raw Markdown and raw code to the injected callback", async () => {
		const rawMarkdown = 'Before\n\n```json\n{"tag":"<raw>","emoji":"🜁"}\n```\n\nAfter';
		const rendered = renderMarkdownDocument(rawMarkdown, { codeCopyActions: true });
		const onCopyText = vi.fn(async (_text: string) => {});

		expect(await copyMarkdownText(rawMarkdown, onCopyText)).toBe("copied");
		expect(await copyMarkdownText(rendered.codeBlocks[0]?.rawCode ?? "", onCopyText)).toBe("copied");
		expect(onCopyText).toHaveBeenNthCalledWith(1, rawMarkdown);
		expect(onCopyText).toHaveBeenNthCalledWith(2, '{"tag":"<raw>","emoji":"🜁"}');
	});

	it("reports rejected copy callbacks as an accessible failure state input", async () => {
		const onCopyText = vi.fn(async () => {
			throw new Error("clipboard unavailable");
		});

		expect(await copyMarkdownText("raw", onCopyText)).toBe("failed");
		expect(onCopyText).toHaveBeenCalledWith("raw");
	});

	it("does not highlight or render copy actions while streaming", () => {
		const html = renderStreamingMarkdown("```typescript\nconst active = true;\n```");

		expect(html).toContain("<pre><code>const active = true;</code></pre>");
		expect(html).not.toContain("hljs");
		expect(html).not.toContain("data-markdown-code-copy");
		expect(html).not.toContain("markdown-code-frame");
	});
});

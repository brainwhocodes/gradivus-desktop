import { Marked, type RendererObject } from "@oh-my-pi/pi-utils/marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const MAX_MARKDOWN_LENGTH = 64 * 1024;
const MAX_HIGHLIGHT_BYTES = 24 * 1024;
const MAX_CACHE_ENTRIES = 512;

type HighlightLanguage =
	| "bash"
	| "css"
	| "go"
	| "javascript"
	| "json"
	| "markdown"
	| "python"
	| "rust"
	| "scss"
	| "sql"
	| "typescript"
	| "xml"
	| "yaml";

const LANGUAGE_ALIASES: Record<string, HighlightLanguage> = {
	bash: "bash",
	cjs: "javascript",
	css: "css",
	cts: "typescript",
	go: "go",
	golang: "go",
	html: "xml",
	htm: "xml",
	javascript: "javascript",
	js: "javascript",
	json: "json",
	jsonc: "json",
	jsx: "javascript",
	markdown: "markdown",
	md: "markdown",
	mjs: "javascript",
	mts: "typescript",
	py: "python",
	python: "python",
	rs: "rust",
	rust: "rust",
	scss: "scss",
	sh: "bash",
	shell: "bash",
	sql: "sql",
	svg: "xml",
	ts: "typescript",
	tsx: "typescript",
	typescript: "typescript",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	zsh: "bash",
};

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdownLanguage);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

export interface MarkdownCodeBlock {
	readonly rawCode: string;
	readonly language: string | null;
	readonly highlighted: boolean;
}

export interface MarkdownRenderResult {
	readonly html: string;
	readonly codeBlocks: readonly MarkdownCodeBlock[];
}

export interface MarkdownRenderOptions {
	readonly syntaxHighlight?: boolean;
	readonly codeCopyActions?: boolean;
	readonly sourceAnchors?: { readonly lineOffset: number };
}

export type MarkdownCopyStatus = "copied" | "failed";
export type MarkdownCopyText = (text: string) => Promise<void>;

function escapeHtml(value: string): string {
	return value
		.replace(/&(?!(?:#\d+|#x[\da-f]+|\w+);)/gi, "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function safeHref(value: string): string | null {
	const href = value.trim();
	if (/^(?:https:|mailto:)/i.test(href)) return href;
	if (/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(href)) return href;
	if (/^#[A-Za-z0-9._-]+$/.test(href)) return href;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
	return null;
}

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (bytes > MAX_HIGHLIGHT_BYTES) return bytes;
	}
	return bytes;
}

function explicitLanguage(value: string | undefined): string | null {
	const token = value?.trim().split(/\s+/, 1)[0]?.toLowerCase();
	if (!token) return null;
	return LANGUAGE_ALIASES[token] ?? null;
}

const MAGIC_KEYWORD_REGEX = /\b(ultrathink|orchestrate|workflowz)\b/g;

export function highlightMagicKeywords(text: string): string {
	if (!text.includes("ultrathink") && !text.includes("orchestrate") && !text.includes("workflowz")) {
		return text;
	}
	return text.replace(
		MAGIC_KEYWORD_REGEX,
		match => `<span class="magic-keyword magic-keyword-${match}">${match}</span>`,
	);
}

function renderDiff(text: string): string {
	const lines = text.split("\n");
	const formattedLines = lines.map(line => {
		let kind = "context";
		if (line.startsWith("@@")) kind = "hunk";
		else if (line.startsWith("+") && !line.startsWith("+++")) kind = "added";
		else if (line.startsWith("-") && !line.startsWith("---")) kind = "removed";
		else if (
			line.startsWith("diff ") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++")
		) {
			kind = "meta";
		}
		return `<span class="diff-line line-${kind}">${escapeHtml(line || " ")}</span>`;
	});
	return `<pre class="diff-code"><code>${formattedLines.join("\n")}</code></pre>`;
}

function renderCodeFrame(content: string, index: number, language: string | null): string {
	const label = language ?? "code";
	const accessibleLabel = language ? `Copy ${language} code` : "Copy code";
	return `<div class="markdown-code-frame"><div class="markdown-code-toolbar"><span class="markdown-code-language">${escapeHtml(label)}</span><button type="button" class="markdown-copy-action markdown-code-copy-action" data-markdown-code-copy="${index}" aria-label="${escapeHtml(accessibleLabel)}"><span class="markdown-copy-glyph" aria-hidden="true"></span><span class="markdown-copy-label">Copy</span></button><span class="markdown-code-copy-status sr-only" role="status" aria-live="polite"></span></div>${content}</div>`;
}

const markdown = new Marked({
	gfm: true,
	breaks: true,
});
const markdownCache = new Map<string, MarkdownRenderResult>();

function cacheResult(key: string, result: MarkdownRenderResult): MarkdownRenderResult {
	if (markdownCache.size >= MAX_CACHE_ENTRIES) {
		const first = markdownCache.keys().next().value;
		if (first !== undefined) markdownCache.delete(first);
	}
	markdownCache.set(key, result);
	return result;
}

export function renderMarkdownDocument(value: string, options: MarkdownRenderOptions = {}): MarkdownRenderResult {
	const syntaxHighlight = options.syntaxHighlight ?? true;
	const codeCopyActions = options.codeCopyActions ?? false;
	const sourceAnchors = options.sourceAnchors;
	const cacheKey = `${syntaxHighlight ? "h" : "p"}${codeCopyActions ? "c" : "n"}${
		sourceAnchors ? `a${sourceAnchors.lineOffset}` : ""
	}:${value}`;
	const cached = markdownCache.get(cacheKey);
	if (cached) return cached;

	if (!sourceAnchors && value.length > MAX_MARKDOWN_LENGTH) {
		let html: string;
		try {
			html = `<pre class="large-markdown">${escapeHtml(value)}</pre>`;
		} catch {
			html = escapeHtml(value);
		}
		return cacheResult(cacheKey, { html, codeBlocks: [] });
	}

	const codeBlocks: MarkdownCodeBlock[] = [];
	const renderer: RendererObject = {
		html({ text }) {
			return escapeHtml(text);
		},
		code(token) {
			const { text, lang } = token;
			const fenced = token.codeBlockStyle !== "indented";
			const index = codeBlocks.length;
			const language = explicitLanguage(lang);
			const isDiff = lang?.trim().toLowerCase() === "diff";
			let highlighted = false;
			let renderedCode: string;

			if (isDiff) {
				renderedCode = renderDiff(text);
			} else if (syntaxHighlight && language !== null && utf8ByteLength(text) <= MAX_HIGHLIGHT_BYTES) {
				try {
					const markup = hljs.highlight(text, { language, ignoreIllegals: false }).value;
					renderedCode = `<pre><code class="hljs language-${language}">${markup}</code></pre>`;
					highlighted = true;
				} catch {
					renderedCode = `<pre><code>${escapeHtml(text)}</code></pre>`;
				}
			} else {
				renderedCode = `<pre><code>${escapeHtml(text)}</code></pre>`;
			}

			if (!fenced) return renderedCode;
			codeBlocks.push({ rawCode: text, language: isDiff ? "diff" : language, highlighted });
			return codeCopyActions ? renderCodeFrame(renderedCode, index, isDiff ? "diff" : language) : renderedCode;
		},
		text(token) {
			const raw = typeof token === "string" ? token : token.text;
			return highlightMagicKeywords(escapeHtml(raw));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const safe = safeHref(href);
			if (!safe) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			const target = safe.startsWith("#") ? "" : ' target="_blank" rel="noopener"';
			return `<a href="${escapeHtml(safe)}"${titleAttr}${target}>${inner}</a>`;
		},
	};
	const parseOptions = { async: false as const, renderer };
	let html: string;
	try {
		if (!sourceAnchors) {
			html = markdown.parse(value, parseOptions);
		} else {
			const tokens = markdown.lexer(value);
			let sourceLine = sourceAnchors.lineOffset + 1;
			const blocks: string[] = [];
			for (const token of tokens) {
				const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
				const renderedBlock = markdown.parser([token], parseOptions);
				if (renderedBlock) {
					const context =
						raw
							.split(/\r?\n/)
							.map(line => line.trim())
							.find(Boolean)
							?.slice(0, 240) ?? "";
					blocks.push(
						`<div class="markdown-source-block" data-source-row="${sourceLine}" data-source-context="${escapeHtml(
							context,
						)}"><button type="button" class="markdown-line-annotate" data-markdown-annotate-line="${sourceLine}" aria-label="Annotate line ${sourceLine}"><span aria-hidden="true">+</span></button><div class="markdown-source-content">${renderedBlock}</div></div>`,
					);
				}
				sourceLine += raw.match(/\n/g)?.length ?? 0;
			}
			html = blocks.join("");
		}
	} catch {
		html = escapeHtml(value);
		codeBlocks.length = 0;
	}

	return cacheResult(cacheKey, { html, codeBlocks });
}

export function renderMarkdown(value: string): string {
	return renderMarkdownDocument(value).html;
}

export function renderStreamingMarkdown(value: string): string {
	return renderMarkdownDocument(value, { syntaxHighlight: false, codeCopyActions: false }).html;
}

export async function copyMarkdownText(text: string, onCopyText: MarkdownCopyText): Promise<MarkdownCopyStatus> {
	try {
		await onCopyText(text);
		return "copied";
	} catch {
		return "failed";
	}
}

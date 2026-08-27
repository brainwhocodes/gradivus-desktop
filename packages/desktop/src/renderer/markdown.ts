import { Marked } from "@oh-my-pi/pi-utils/marked";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
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

const markdown = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		},
		code({ text, lang }) {
			if (lang === "diff") {
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
			const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
			return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
		},
		text(token) {
			const raw = typeof token === "string" ? token : token.text;
			return highlightMagicKeywords(raw);
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const safe = safeHref(href);
			if (!safe) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			const target = safe.startsWith("#") ? "" : ' target="_blank" rel="noopener"';
			return `<a href="${escapeHtml(safe)}"${titleAttr}${target}>${inner}</a>`;
		},
	},
});
const markdownCache = new Map<string, string>();

export function renderMarkdown(value: string): string {
	if (value.length > 64 * 1024) {
		try {
			return `<pre class="large-markdown">${escapeHtml(value)}</pre>`;
		} catch {
			return escapeHtml(value);
		}
	}
	if (markdownCache.has(value)) return markdownCache.get(value) ?? "";
	let rendered: string;
	try {
		rendered = markdown.parse(value, { async: false });
	} catch {
		rendered = escapeHtml(value);
	}
	if (markdownCache.size >= 512) {
		const first = markdownCache.keys().next().value;
		if (first !== undefined) markdownCache.delete(first);
	}
	markdownCache.set(value, rendered);
	return rendered;
}

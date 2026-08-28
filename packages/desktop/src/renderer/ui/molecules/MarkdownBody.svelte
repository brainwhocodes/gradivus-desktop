<script lang="ts">
	import Copy from "@solar-icons/svelte/linear/copy";
	import {
		copyMarkdownText,
		renderMarkdownDocument,
		type MarkdownCopyText,
	} from "../../markdown";

	interface Props {
		value: string;
		streaming?: boolean;
		showResponseCopy?: boolean;
		onCopyText?: MarkdownCopyText;
		className?: string;
	}

	let {
		value,
		streaming = false,
		showResponseCopy = false,
		onCopyText,
		className = "message-copy",
	}: Props = $props();
	let responseCopying = $state(false);
	let responseStatus = $state("");
	const rendered = $derived(
		renderMarkdownDocument(value, {
			syntaxHighlight: !streaming,
			codeCopyActions: !streaming && onCopyText !== undefined,
		}),
	);

	async function copyResponse(): Promise<void> {
		if (!onCopyText || streaming || responseCopying) return;
		responseCopying = true;
		responseStatus = "";
		const status = await copyMarkdownText(value, onCopyText);
		responseStatus = status === "copied" ? "Copied" : "Copy failed";
		responseCopying = false;
	}

	function copyCodeBlocks(node: HTMLElement): { destroy(): void } {
		async function handleClick(event: MouseEvent): Promise<void> {
			if (!(event.target instanceof Element) || !onCopyText || streaming) return;
			const button = event.target.closest<HTMLButtonElement>("button[data-markdown-code-copy]");
			if (!button || !node.contains(button) || button.disabled) return;

			const index = Number.parseInt(button.dataset.markdownCodeCopy ?? "", 10);
			const block = Number.isSafeInteger(index) ? rendered.codeBlocks[index] : undefined;
			if (!block) return;

			const label = button.querySelector<HTMLElement>(".markdown-copy-label");
			const statusNode = button.parentElement?.querySelector<HTMLElement>(
				".markdown-code-copy-status",
			);
			button.disabled = true;
			if (label) label.textContent = "Copying…";
			if (statusNode) statusNode.textContent = "";
			const status = await copyMarkdownText(block.rawCode, onCopyText);
			const message = status === "copied" ? "Copied" : "Copy failed";
			button.dataset.copyStatus = status;
			if (label) label.textContent = message;
			if (statusNode) statusNode.textContent = message;
			button.disabled = false;
		}

		node.addEventListener("click", handleClick);
		return {
			destroy() {
				node.removeEventListener("click", handleClick);
			},
		};
	}
</script>

<div class={`markdown-body ${className}`}>
	{#if showResponseCopy && !streaming && onCopyText}
		<div class="markdown-response-actions">
			<button
				type="button"
				class="markdown-copy-action markdown-response-copy-action"
				disabled={responseCopying}
				onclick={copyResponse}
				aria-label="Copy raw Markdown"
			>
				<Copy size={15} aria-hidden="true" />
				<span>{responseCopying ? "Copying…" : "Copy"}</span>
			</button>
			{#if responseStatus}<span class="markdown-response-copy-status" role="status" aria-live="polite">{responseStatus}</span>{/if}
		</div>
	{/if}
	<div class="markdown-rendered" use:copyCodeBlocks>{@html rendered.html}</div>
</div>

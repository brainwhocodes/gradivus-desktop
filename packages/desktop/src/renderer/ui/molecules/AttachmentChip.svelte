<script lang="ts">
	import DocumentText from "@solar-icons/svelte/linear/document-text";
	import Gallery from "@solar-icons/svelte/linear/gallery";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import type { PromptAttachmentView } from "../../../shared/contracts";

	interface Props {
		kind: PromptAttachmentView["kind"];
		displayName: string;
		sizeLabel: string;
		removeLabel: string;
		onremove: (event: MouseEvent) => void;
	}

	let { kind, displayName, sizeLabel, removeLabel, onremove, ...rest }: Props = $props();
	const category = $derived(kind === "image" ? "Image" : "Document");
</script>

<span class="attachment-chip" {...rest}>
	<span class="attachment-chip-kind" title={category} aria-hidden="true">
		{#if kind === "image"}<Gallery size={14} />{:else}<DocumentText size={14} />{/if}
	</span>
	<span class="sr-only">{category}: </span>
	<span class="attachment-chip-name" title={displayName}>{displayName}</span>
	<span class="attachment-chip-size">{sizeLabel}</span>
	<button type="button" class="attachment-chip-remove" aria-label={removeLabel} title={removeLabel} onclick={onremove}><CloseCircle size={14} aria-hidden="true" /></button>
</span>

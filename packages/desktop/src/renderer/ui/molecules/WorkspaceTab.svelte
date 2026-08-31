<script lang="ts">
	import type { Component } from "svelte";
	import type { SVGAttributes } from "svelte/elements";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Stars from "@solar-icons/svelte/linear/stars";

	type IconComponent = Component<SVGAttributes<SVGSVGElement> & { size?: number | string }>;

	interface Props {
		icon?: IconComponent;
		variant: "chat" | "browser";
		active: boolean;
		title: string;
		tabId: string;
		controlsId: string;
		onactivate: () => void;
		onclose?: () => void;
		onduplicate?: () => void;
		onmoveleft?: () => void;
		onmoveright?: () => void;
		onkeydown?: (event: KeyboardEvent) => void;
		ondragstart?: (event: DragEvent) => void;
		ondragend?: (event: DragEvent) => void;
		ondragover?: (event: DragEvent) => void;
		ondrop?: (event: DragEvent) => void;
		glyph?: string;
		pill?: string;
		attentionLabel?: string;
		faviconUrl?: string;
		tabindex?: number;
		draggable?: boolean;
	}

	let {
		variant,
		active,
		title,
		tabId,
		controlsId,
		onduplicate,
		onmoveleft,
		onmoveright,
		onactivate,
		onclose,
		onkeydown,
		ondragstart,
		ondragend,
		ondragover,
		ondrop,
		glyph,
		icon,
		pill,
		attentionLabel,
		faviconUrl,
		tabindex = active ? 0 : -1,
		draggable = false,
	}: Props = $props();
	const DefaultChatIcon = Stars;
</script>

{#if variant === "chat"}
	<button
		type="button"
		class="workspace-tab chat-tab-button"
		class:is-active={active}
		role="tab"
		aria-selected={active}
		id={tabId}
		aria-controls={controlsId}
		{tabindex}
		onclick={onactivate}
		{onkeydown}
	>
		<span class="chat-glyph" aria-hidden="true">
			{#if icon}
				{@const Icon = icon}
				<Icon size={14} />
			{:else}
				<DefaultChatIcon size={14} />
			{/if}
		</span>
		{title}
		{#if pill}<span class="runtime-pill">{pill}</span>{/if}
		{#if attentionLabel}
			<span class="workspace-tab-attention" aria-label={attentionLabel}>{attentionLabel.split(" ", 1)[0]}</span>
		{/if}
	</button>
{:else}
	<div
		class="workspace-tab browser-tab"
		class:is-active={active}
		role="presentation"
		{draggable}
		{ondragstart}
		{ondragend}
		{ondragover}
		{ondrop}
	>
		<button
			type="button"
			class="browser-tab-activate"
			role="tab"
			aria-selected={active}
			id={tabId}
			aria-controls={controlsId}
			{tabindex}
			onclick={onactivate}
			{onkeydown}
		>
			{#if faviconUrl}
				{#key faviconUrl}
					<img class="tab-favicon" src={faviconUrl} alt="" onerror={(event) => (event.currentTarget as HTMLImageElement).hidden = true} />
				{/key}
			{:else if icon}
				{@const Icon = icon}
				<Icon size={15} aria-hidden="true" />
			{/if}
			<span class="tab-title">{title}</span>
		</button>
		{#if onduplicate || onmoveleft || onmoveright}
			<details class="tab-actions">
				<summary aria-label={`Actions for ${title}`}>•••</summary>
				<div class="tab-actions-menu">
					{#if onduplicate}<button type="button" onclick={onduplicate}>Duplicate</button>{/if}
					{#if onmoveleft}<button type="button" onclick={onmoveleft}>Move left</button>{/if}
					{#if onmoveright}<button type="button" onclick={onmoveright}>Move right</button>{/if}
					{#if onclose}<button type="button" class="is-danger" onclick={onclose}>Close</button>{/if}
				</div>
			</details>
		{/if}
		{#if onclose}
			<button
				type="button"
				class="tab-close"
				aria-label={`Close ${title}`}
				onclick={(event) => {
					event.stopPropagation();
					onclose?.();
				}}
			><CloseCircle size={14} aria-hidden="true" /></button>
		{/if}
	</div>
{/if}

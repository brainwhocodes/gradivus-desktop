<script lang="ts">
	import type { Component } from "svelte";
	import type { SVGAttributes } from "svelte/elements";

	type IconComponent = Component<SVGAttributes<SVGSVGElement> & { size?: number | string }>;

	interface Props {
		icon?: IconComponent;
		variant: "chat" | "browser";
		active: boolean;
		title: string;
		onactivate: () => void;
		onclose?: () => void;
		glyph?: string;
		pill?: string;
	}

let { variant, active, title, onactivate, onclose, glyph = "✦", icon, pill, ...rest }: Props = $props();

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") {
			onactivate();
		}
	}
</script>

{#if variant === "chat"}
	<button
		type="button"
		class="workspace-tab chat-tab-button"
		class:is-active={active}
		role="tab"
		aria-selected={active}
		onclick={onactivate}
		{...rest}
	>
		<span class="chat-glyph" aria-hidden="true">{glyph}</span>
		{title}
		{#if pill}<span class="runtime-pill">{pill}</span>{/if}
	</button>
{:else}
	<div
		class="workspace-tab browser-tab"
		class:is-active={active}
		role="tab"
		tabindex="0"
		aria-selected={active}
		onclick={onactivate}
		onkeydown={handleKeydown}
		{...rest}
	>
		{#if icon}
			{@const Icon = icon}
			<Icon size={15} aria-hidden="true" />
		{/if}
		<span class="tab-title">{title}</span>
		{#if onclose}
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<span
				class="tab-close"
				aria-hidden="true"
				onclick={(event) => {
					event.stopPropagation();
					onclose?.();
				}}
			>×</span>
		{/if}
	</div>
{/if}

<script lang="ts">
	import type { Component } from "svelte";
	import type { SVGAttributes } from "svelte/elements";

	type IconComponent = Component<SVGAttributes<SVGSVGElement> & { size?: number | string }>;

	interface Props {
		icon?: IconComponent;
		glyph?: string;
		label: string;
		title?: string;
		size?: number;
		class?: string;
		disabled?: boolean;
		active?: boolean;
		onclick?: () => void;
	}

	let {
		icon,
		glyph,
		label,
		title,
		size = 15,
		disabled = false,
		active = false,
		onclick,
		class: extraClass = "",
		...rest
	}: Props = $props();
</script>

<button type="button" {...rest} class={extraClass || undefined} class:is-active={active} {disabled} {onclick} aria-label={label} title={title ?? label}>
	{#if icon}
		{@const Icon = icon}
		<Icon size={size} />
	{:else}
		{glyph}
	{/if}
</button>

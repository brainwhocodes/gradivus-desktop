<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";

	interface Props extends Omit<HTMLAttributes<HTMLElement>, "onchange"> {
		label: string;
		description?: string;
		badge?: string;
		checked: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		onchange: (checked: boolean) => void;
	}

	let {
		label,
		description,
		badge,
		checked,
		disabled = false,
		ariaLabel,
		onchange,
		...rest
	}: Props = $props();
</script>

<label class="settings-toggle" {...rest}>
	<span>
		<strong>{label}</strong>
		{#if description}<small>{description}</small>{/if}
		{#if badge}<span class="setting-scope">{badge}</span>{/if}
	</span>
	<input
		type="checkbox"
		aria-label={ariaLabel ?? label}
		{checked}
		{disabled}
		onchange={(event) => onchange(event.currentTarget.checked)}
	/>
</label>

<script lang="ts">
	interface Props {
		variant: string;
		message: string;
		role?: "status" | "alert";
		title?: string;
		dismissLabel?: string;
		ondismiss?: () => void;
		actionLabel?: string;
		onaction?: () => void;
	}

	let { variant, message, role = "status", title, dismissLabel, ondismiss, actionLabel, onaction, ...rest }: Props =
		$props();

	const rich = $derived(title !== undefined || ondismiss !== undefined || onaction !== undefined);
</script>

<div class="toast {variant}" {role} {...rest}>
	{#if rich}
		{#if title}<strong>{title}</strong>{/if}
			<span>{message}</span>
			{#if onaction}
				<button type="button" class="toast-action" onclick={onaction}>{actionLabel ?? "Retry"}</button>
			{/if}
		{#if ondismiss}
			<button type="button" aria-label={dismissLabel} onclick={ondismiss}>×</button>
		{/if}
	{:else}
		{message}
	{/if}
</div>

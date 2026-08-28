<script lang="ts">
	import CheckCircle from "@solar-icons/svelte/linear/check-circle";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import DangerCircle from "@solar-icons/svelte/linear/danger-circle";
	import InfoCircle from "@solar-icons/svelte/linear/info-circle";
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
	const iconComponent = $derived(
		variant.includes("tone-success")
			? CheckCircle
			: variant.includes("tone-error") || variant.includes("tone-warning") || variant.includes("error-toast")
				? DangerCircle
				: variant.includes("notice-toast") || variant.includes("tone-info")
					? InfoCircle
					: undefined,
	);
</script>

<div class="toast {variant}" {role} {...rest}>
	{#if iconComponent}
		{@const Icon = iconComponent}
		<span class="toast-icon" aria-hidden="true"><Icon size={16} /></span>
	{/if}
	{#if rich}
		{#if title}<strong>{title}</strong>{/if}
			<span>{message}</span>
			{#if onaction}
				<button type="button" class="toast-action" onclick={onaction}>{actionLabel ?? "Retry"}</button>
			{/if}
		{#if ondismiss}
			<button type="button" aria-label={dismissLabel} onclick={ondismiss}><CloseCircle size={14} aria-hidden="true" /></button>
		{/if}
	{:else}
		{message}
	{/if}
</div>

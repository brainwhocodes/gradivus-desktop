<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		backdrop?: boolean;
		backdropClass?: string;
		dialogClass: string;
		labelledbyId?: string;
		ariaLabel?: string;
		onclose?: () => void;
		cancelable?: boolean;
		onclickbackdrop?: () => void;
		backdropDismissLabel?: string;
		class?: string;
		children: Snippet;
		[key: string]: unknown;
	}

	let {
		backdrop = false,
		backdropClass,
		dialogClass,
		labelledbyId,
		ariaLabel,
		onclose,
		cancelable = false,
		onclickbackdrop,
		backdropDismissLabel = "Close dialog",
		class: extraClass = "",
		children,
		...rest
 }: Props = $props();

	// The file-diff shell is a <div class="file-diff-dialog" role="dialog"> rather than a native
	// <dialog>; passing role="dialog" through rest selects that exact DOM shape. Native dialogs
	// never carry an explicit role attribute, so the inference is unambiguous.
	const dialogTag = $derived(rest.role === "dialog" ? "div" : "dialog");
	const shellClass = $derived([dialogClass, extraClass].filter(Boolean).join(" "));
</script>

{#if backdrop}
	<div class={`modal-backdrop${backdropClass ? ` ${backdropClass}` : ""}`}>
		<svelte:element
			this={dialogTag}
			class={shellClass}
			aria-labelledby={labelledbyId}
			aria-label={ariaLabel}
			open={dialogTag === "dialog"}
			tabindex={dialogTag === "dialog" ? -1 : undefined}
			oncancel={
				cancelable
					? (event: Event) => {
							event.preventDefault();
							onclose?.();
						}
					: undefined
			}
			{...rest}
		>
			{@render children()}
		</svelte:element>
		{#if onclickbackdrop}
			<button
				type="button"
				class="modal-backdrop-dismiss"
				aria-label={backdropDismissLabel}
				onclick={onclickbackdrop}
			></button>
		{/if}
	</div>
{:else}
	<dialog
		open
		class={shellClass}
		aria-labelledby={labelledbyId}
		aria-label={ariaLabel}
		onkeydown={
			onclose
				? (event: KeyboardEvent) => {
						if (event.key === "Escape") onclose?.();
					}
				: undefined
		}
		{...rest}
	>
		{@render children()}
	</dialog>
{/if}

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
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class={`modal-backdrop${backdropClass ? ` ${backdropClass}` : ""}`}
		onclick={(event) => {
			if (event.target === event.currentTarget) onclickbackdrop?.();
		}}
	>
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

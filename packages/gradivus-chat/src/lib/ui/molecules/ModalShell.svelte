<script lang="ts">
	import { tick, type Snippet } from "svelte";

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
		trapFocus?: boolean;
		initialFocusId?: string;
		returnFocus?: HTMLElement | null;
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
		trapFocus = false,
		initialFocusId,
		returnFocus,
		class: extraClass = "",
		children,
		...rest
	}: Props = $props();

	// The file-diff shell is a <div class="file-diff-dialog" role="dialog"> rather than a native
	// <dialog>; passing role="dialog" through rest selects that exact DOM shape. Native dialogs
	// never carry an explicit role attribute, so the inference is unambiguous.
	const dialogTag = $derived(rest.role === "dialog" ? "div" : "dialog");
	const shellClass = $derived([dialogClass, extraClass].filter(Boolean).join(" "));
	let dialogElement = $state<HTMLElement>();
	const focusableSelector =
		'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape" && (cancelable || (!backdrop && onclose))) {
			event.preventDefault();
			event.stopPropagation();
			onclose?.();
			return;
		}
		const dialog = dialogElement;
		if (!trapFocus || event.key !== "Tab" || !dialog) return;
		const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
			element =>
				!element.hidden &&
				element.getAttribute("aria-hidden") !== "true" &&
				element.getClientRects().length > 0,
		);
		if (focusable.length === 0) {
			event.preventDefault();
			dialog.focus();
			return;
		}
		const first = focusable[0]!;
		const last = focusable.at(-1)!;
		const active = document.activeElement;
		if (event.shiftKey && (active === first || !dialog.contains(active))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
			event.preventDefault();
			first.focus();
		}
	}
	function handleWindowKeydown(event: KeyboardEvent): void {
		const dialog = dialogElement;
		if (!trapFocus || (dialog && event.target instanceof Node && dialog.contains(event.target))) return;
		handleKeydown(event);
	}


	$effect(() => {
		if (!trapFocus) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		void tick().then(() => {
			const dialog = dialogElement;
			if (!dialog) return;
			const initial = initialFocusId ? dialog.querySelector<HTMLElement>(`#${CSS.escape(initialFocusId)}`) : null;
			(initial ?? dialog).focus();
		});
		return () => {
			const target = returnFocus ?? previous;
			void tick().then(() => {
				if (target?.isConnected) target.focus();
			});
		};
	});
</script>

<svelte:window onkeydown={trapFocus ? handleWindowKeydown : undefined} />

{#if backdrop}
	<div class={`modal-backdrop${backdropClass ? ` ${backdropClass}` : ""}`}>
		<svelte:element
			this={dialogTag}
			bind:this={dialogElement}
			class={shellClass}
			aria-labelledby={labelledbyId}
			aria-label={ariaLabel}
			aria-modal={trapFocus ? "true" : undefined}
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
			onkeydown={trapFocus || cancelable ? handleKeydown : undefined}
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
		bind:this={dialogElement}
		open
		class={shellClass}
		aria-labelledby={labelledbyId}
		aria-label={ariaLabel}
		aria-modal={trapFocus ? "true" : undefined}
		onkeydown={trapFocus || onclose ? handleKeydown : undefined}
		{...rest}
	>
		{@render children()}
	</dialog>
{/if}

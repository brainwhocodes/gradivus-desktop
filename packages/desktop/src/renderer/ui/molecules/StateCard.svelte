<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		variant: "welcome" | "empty" | "error";
		alertRole?: boolean;
		class?: string;
		children: Snippet;
	}

	let { variant, alertRole = false, class: extraClass = "", children, ...rest }: Props = $props();

	// Roots mirror the page monolith exactly: welcome renders <section class="welcome-state">,
	// empty and error render <div class="session-empty"> / <div class="error-card">. None of the
	// real roots carry a role today; alertRole stays opt-in so default DOM is identical.
	const rootTag = $derived(variant === "welcome" ? "section" : "div");
	const baseClass = $derived(
		variant === "welcome" ? "welcome-state" : variant === "empty" ? "session-empty" : "error-card"
	);
	const rootClass = $derived(extraClass ? `${baseClass} ${extraClass}` : baseClass);
</script>

<svelte:element this={rootTag} class={rootClass} role={alertRole ? "alert" : undefined} {...rest}>
	{@render children()}
</svelte:element>

<script lang="ts">
	import { tick } from "svelte";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import type { BrowserFindState } from "../../../shared/contracts";
	import IconButton from "./IconButton.svelte";

	interface Props {
		value?: string;
		findState?: BrowserFindState;
		onfind: (query: string, forward: boolean) => void;
		onclose: () => void;
	}

	let { value = $bindable(""), findState, onfind, onclose }: Props = $props();
	let input = $state<HTMLInputElement>();

	$effect(() => {
		void tick().then(() => {
			input?.focus();
			input?.select();
		});
	});
</script>

<form
	class="browser-find-bar"
	aria-label="Find in page"
	onsubmit={(event) => {
		event.preventDefault();
		if (value.trim()) onfind(value, true);
	}}
>
	<input
		bind:this={input}
		bind:value
		type="search"
		aria-label="Find in page"
		placeholder="Find in page"
		oninput={(event) => {
			const query = event.currentTarget.value;
			if (query.trim()) onfind(query, true);
	}}
		onkeydown={(event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onclose();
			} else if (event.key === "Enter" && event.shiftKey) {
				event.preventDefault();
				if (value.trim()) onfind(value, false);
			}
		}}
	/>
	<span class="browser-find-count" role="status">
		{findState?.matches ? `${findState.activeMatchOrdinal} of ${findState.matches}` : value.trim() ? "No matches" : ""}
	</span>
	<button type="button" class="browser-find-direction" aria-label="Previous match" disabled={!value.trim()} onclick={() => onfind(value, false)}>↑</button>
	<button type="submit" class="browser-find-direction" aria-label="Next match" disabled={!value.trim()}>↓</button>
	<IconButton icon={CloseCircle} size={15} label="Close find in page" onclick={onclose} />
</form>

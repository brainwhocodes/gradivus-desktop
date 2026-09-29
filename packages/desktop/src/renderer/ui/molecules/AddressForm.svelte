<script lang="ts">
	import Global from "@solar-icons/svelte/linear/global";

	interface Props {
		value: string;
		loading?: boolean;
		onnavigate: (address: string) => void;
	}

	let { value, loading = false, onnavigate }: Props = $props();
	let input: HTMLInputElement;
	let draft = $state("");
	let editing = $state(false);

	$effect(() => {
		if (!editing) draft = value;
	});
</script>

<form
	class="address-form"
	class:is-loading={loading}
	onsubmit={(event) => {
		event.preventDefault();
		const address = draft.trim();
		if (!address) {
			input.focus();
			return;
		}
		onnavigate(address);
		input.blur();
	}}
>
	<Global size={14} aria-hidden="true" />
	<input
		bind:this={input}
		bind:value={draft}
		name="address"
		aria-label="Address"
		placeholder="Enter a web address"
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		onfocus={() => {
			editing = true;
			input.select();
		}}
		onblur={() => { editing = false; }}
		onkeydown={(event) => {
			if (event.key !== "Escape" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			draft = value;
			input.select();
		}}
	/>
</form>

<script lang="ts">
	import Global from "@solar-icons/svelte/linear/global";

	interface Props {
		value: string;
		onnavigate: (address: string) => void;
	}

	let { value, onnavigate }: Props = $props();
</script>

<form
	class="address-form"
	onsubmit={(event) => {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		void onnavigate(String(data.get("address") ?? ""));
	}}
>
	<Global size={14} aria-hidden="true" />
	<input name="address" aria-label="Address" {value} autocomplete="off" spellcheck="false" />
</form>

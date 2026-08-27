<script lang="ts">
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import MaximizeSquare from "@solar-icons/svelte/linear/maximize-square";
	import Minimize from "@solar-icons/svelte/linear/minimize";
	import IconButton from "./IconButton.svelte";

	interface Props {
		maximized: boolean;
		onminimize: () => void;
		ontogglemaximize: () => void;
		onclose: () => void;
	}

	let { maximized, onminimize, ontogglemaximize, onclose }: Props = $props();
</script>

<IconButton icon={Minimize} size={15} label="Minimize" onclick={onminimize} />
<IconButton
	icon={MaximizeSquare}
	size={15}
	label={maximized ? "Restore" : "Maximize"}
	title={maximized ? "Restore" : "Maximize"}
	onclick={ontogglemaximize}
/>
<IconButton icon={CloseCircle} size={16} label="Close" title="Close" class="close-window" onclick={onclose} />

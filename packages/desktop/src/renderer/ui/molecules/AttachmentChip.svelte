<script lang="ts">
	interface Props {
		kindLabel: string;
		displayName: string;
		sizeLabel: string;
		removeLabel: string;
		onremove: () => void;
	}

	let { kindLabel, displayName, sizeLabel, removeLabel, onremove, ...rest }: Props = $props();
</script>

<span class="attachment-chip" {...rest}>
	<span class="attachment-chip-kind" aria-hidden="true">{kindLabel}</span>
	<span class="attachment-chip-name" title={displayName}>{displayName}</span>
	<span class="attachment-chip-size">{sizeLabel}</span>
	<button type="button" class="attachment-chip-remove" aria-label={removeLabel} title={removeLabel} onclick={onremove}>×</button>
</span>

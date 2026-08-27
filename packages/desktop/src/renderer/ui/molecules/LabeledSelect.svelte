<script lang="ts">
	import CustomDropdown from "../atoms/CustomDropdown.svelte";
	import type { DropdownOption } from "../../settings-types";
	import type { HTMLAttributes } from "svelte/elements";

	type DropdownMode = "listbox" | "menu";

	interface Props extends Omit<HTMLAttributes<HTMLElement>, "onselect"> {
		label: string;
		description?: string;
		badge?: string;
		tone: "field" | "inline";
		titleClass?: string;
		options: readonly DropdownOption[];
		selectedKey: string | undefined;
		ariaLabel: string;
		placeholder?: string;
		disabled?: boolean;
		busy?: boolean;
		mode?: DropdownMode;
		restoreFocusOnCommit?: boolean;
		onSelect: (option: DropdownOption) => void;
		onOpenChange: (open: boolean, popupHeight: number) => void;
		onBeforeOpen?: () => void | Promise<void>;
		onAfterClose?: () => void | Promise<void>;
	}

	let {
		label,
		description,
		badge,
		tone,
		titleClass = "select-title",
		options,
		selectedKey,
		ariaLabel,
		placeholder = "Select an option",
		disabled = false,
		busy = false,
		mode = "listbox",
		restoreFocusOnCommit = true,
		onSelect,
		onOpenChange,
		onBeforeOpen,
		onAfterClose,
		...rest
	}: Props = $props();
</script>

{#if tone === "field"}
	<label class="settings-field" {...rest}>
		<span>{label}{#if badge}<span class="setting-scope">{badge}</span>{/if}</span>
		{#if description}<small>{description}</small>{/if}
		<CustomDropdown
			{options}
			{selectedKey}
			{ariaLabel}
			{placeholder}
			{disabled}
			{busy}
			{mode}
			{restoreFocusOnCommit}
			{onSelect}
			{onOpenChange}
			{onBeforeOpen}
			{onAfterClose}
		/>
	</label>
{:else}
	<label {...rest}>
		<span class={titleClass}>{label}</span>
		<CustomDropdown
			{options}
			{selectedKey}
			{ariaLabel}
			{placeholder}
			{disabled}
			{busy}
			{mode}
			{restoreFocusOnCommit}
			{onSelect}
			{onOpenChange}
			{onBeforeOpen}
			{onAfterClose}
		/>
	</label>
{/if}

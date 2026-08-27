<script lang="ts">
	import type { ThinkingLevel } from "../../../shared/contracts";
	import type { DropdownOption } from "../../settings-types";
	import LabeledSelect from "./LabeledSelect.svelte";

	interface Props {
		providerOptions: readonly DropdownOption[];
		providerSelectedKey: string;
		providerDisabled: boolean;
		modelOptions: readonly DropdownOption[];
		modelSelectedKey: string;
		modelDisabled: boolean;
		onProviderSelect: (option: DropdownOption) => void;
		onModelSelect: (option: DropdownOption) => void;
		thinkingLevel: ThinkingLevel | undefined;
		thinkingBusy: boolean;
		onThinkingSelect: (option: DropdownOption) => void;
	}

	let {
		providerOptions,
		providerSelectedKey,
		providerDisabled,
		modelOptions,
		modelSelectedKey,
		modelDisabled,
		onProviderSelect,
		onModelSelect,
		thinkingLevel,
		thinkingBusy,
		onThinkingSelect,
	}: Props = $props();

	const THINKING_OPTIONS: readonly DropdownOption[] = [
		{ key: "inherit", value: "inherit", label: "default" },
		{ key: "off", value: "off", label: "off" },
		{ key: "minimal", value: "minimal", label: "minimal" },
		{ key: "low", value: "low", label: "low" },
		{ key: "medium", value: "medium", label: "medium" },
		{ key: "high", value: "high", label: "high" },
		{ key: "xhigh", value: "xhigh", label: "xhigh" },
		{ key: "max", value: "max", label: "max" },
	];

	const panelId = "runtime-picker-panel";
	let open = $state(false);
	let triggerEl = $state<HTMLButtonElement>();
	const providerLabel = $derived(labelFor(providerOptions, providerSelectedKey, "Provider"));
	const modelLabel = $derived(labelFor(modelOptions, modelSelectedKey, "Model"));
	const thinkingLabel = $derived(labelFor(THINKING_OPTIONS, thinkingLevel ?? "inherit", "default"));

	function labelFor(options: readonly DropdownOption[], selectedKey: string, fallback: string): string {
		return options.find(option => option.key === selectedKey)?.label ?? (selectedKey || fallback);
	}

	function close(): void {
		if (!open) return;
		open = false;
		queueMicrotask(() => triggerEl?.focus({ preventScroll: true }));
	}

	function toggle(): void {
		if (open) close();
		else open = true;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		close();
	}
</script>
<svelte:window onkeydown={open ? handleKeydown : undefined} />

<div class="runtime-picker" class:open aria-label="Runtime settings">
	<button
		type="button"
		class="runtime-picker-trigger"
		bind:this={triggerEl}
		aria-label={`Runtime settings: ${providerLabel}, ${modelLabel}, thinking ${thinkingLabel}`}
		aria-expanded={open}
		aria-controls={panelId}
		onclick={toggle}
		onkeydown={handleKeydown}
	>
		<span class="runtime-picker-kicker" aria-hidden="true">Runtime</span>
		<span class="runtime-picker-summary" aria-live="polite">
			<span class="runtime-picker-provider">{providerLabel}</span>
			<span class="runtime-picker-divider" aria-hidden="true">/</span>
			<span class="runtime-picker-model">{modelLabel}</span>
			<span class="runtime-picker-divider" aria-hidden="true">/</span>
			<span class="runtime-picker-thinking">{thinkingLabel}</span>
		</span>
		<span class="runtime-picker-chevron" aria-hidden="true">⌄</span>
	</button>

	{#if open}
		<div id={panelId} class="runtime-picker-panel" role="region" aria-label="Runtime settings" tabindex="-1">
			<div class="runtime-picker-panel-heading">
				<span>Runtime settings</span>
				<button type="button" class="runtime-picker-close" aria-label="Close runtime settings" onclick={toggle}>×</button>
			</div>
			<div class="runtime-picker-controls">
				<LabeledSelect
					tone="inline"
					class="model-select-item"
					label="Provider"
					titleClass="select-title"
					options={providerOptions}
					selectedKey={providerSelectedKey}
					ariaLabel="Model provider"
					disabled={providerDisabled}
					onSelect={onProviderSelect}
					onOpenChange={() => undefined}
				/>
				<LabeledSelect
					tone="inline"
					class="model-select-item"
					label="Model"
					titleClass="select-title"
					options={modelOptions}
					selectedKey={modelSelectedKey}
					ariaLabel="Model"
					disabled={modelDisabled}
					onSelect={onModelSelect}
					onOpenChange={() => undefined}
				/>
				<LabeledSelect
					tone="inline"
					label="Thinking"
					class="thinking-select"
					titleClass="thinking-label"
					options={THINKING_OPTIONS}
					selectedKey={thinkingLevel ?? "inherit"}
					ariaLabel="Thinking level"
					disabled={thinkingBusy}
					onSelect={onThinkingSelect}
					onOpenChange={() => undefined}
				/>
			</div>
		</div>
	{/if}
</div>

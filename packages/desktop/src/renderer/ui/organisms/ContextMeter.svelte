<script lang="ts">
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import IconButton from "../molecules/IconButton.svelte";

	interface Props {
		usedTokens: number;
		contextLimit: number;
		tokensPerSecond?: number;
		modelName: string;
		compactDisabled: boolean;
		handoffDisabled: boolean;
		oncompact: () => void;
		onhandoff: () => void;
	}

	const { usedTokens, contextLimit, tokensPerSecond, modelName, compactDisabled, handoffDisabled, oncompact, onhandoff }: Props = $props();
	const panelId = "context-meter-panel";

	let open = $state(false);
	let triggerEl = $state<HTMLButtonElement>();

	const ratio = $derived(Math.min(1, Math.max(0, usedTokens / (contextLimit || 1))));
	const percent = $derived(Math.round(ratio * 100));
	const colorClass = $derived(ratio >= 0.85 ? "danger" : ratio >= 0.65 ? "warning" : "normal");

	function close(restoreFocus = true): void {
		if (!open) return;
		open = false;
		if (restoreFocus) queueMicrotask(() => triggerEl?.focus({ preventScroll: true }));
	}

	function toggle(): void {
		if (open) close(false);
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

<!-- Donut Graph Context Usage Meter -->
<div class="context-meter-anchor">
	<button
		type="button"
		bind:this={triggerEl}
		class="context-donut-btn"
		class:warning={colorClass === "warning"}
		class:danger={colorClass === "danger"}
		class:is-active={open}
		title={`Context: ${percent}% (${usedTokens.toLocaleString()} / ${contextLimit.toLocaleString()} tokens)`}
		aria-label={`Context window: ${percent} percent used. Click for details.`}
		aria-expanded={open}
		aria-controls={panelId}
		onclick={toggle}
	>
		<svg class="donut-svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<circle class="donut-bg" cx="12" cy="12" r="8.5" fill="none" stroke-width="3" />
			<circle
				class="donut-fill"
				cx="12"
				cy="12"
				r="8.5"
				fill="none"
				stroke-width="3"
				stroke-dasharray="53.4"
				stroke-dashoffset={53.4 * (1 - ratio)}
				transform="rotate(-90 12 12)"
			/>
		</svg>
		<span class="donut-percent-text">{percent}%</span>
	</button>

	{#if open}
		<div id={panelId} class="context-popover" role="dialog" aria-label="Context window information">
			<header class="context-popover-header">
				<strong>Context Window</strong>
				<IconButton class="context-popover-close" icon={CloseCircle} size={15} label="Close context details" onclick={() => close()} />
			</header>

			<div class="context-popover-body">
				<div class="context-metric-row">
					<span class="metric-label">Model limit</span>
					<strong class="metric-value">{contextLimit.toLocaleString()} tokens</strong>
				</div>
				<div class="context-metric-row">
					<span class="metric-label">Used tokens</span>
					<strong class="metric-value" class:text-warning={colorClass === "warning"} class:text-danger={colorClass === "danger"}>
						{usedTokens.toLocaleString()} ({percent}%)
					</strong>
				</div>
				<div class="context-metric-row">
					<span class="metric-label">Remaining</span>
					<span class="metric-value">{Math.max(0, contextLimit - usedTokens).toLocaleString()} tokens</span>
				</div>

				<div class="context-progress-track">
					<div
						class="context-progress-bar"
						class:warning={colorClass === "warning"}
						class:danger={colorClass === "danger"}
						style={`width: ${Math.min(100, Math.max(2, percent))}%`}
					></div>
				</div>

				{#if tokensPerSecond}
					<div class="context-metric-row">
						<span class="metric-label">Throughput</span>
						<span class="metric-value">{Math.round(tokensPerSecond)} tok/s</span>
					</div>
				{/if}

				<div class="context-model-name">
					<span>Active Model:</span>
					<code>{modelName}</code>
				</div>
				<div class="context-actions">
					<button type="button" class="secondary-button" disabled={compactDisabled} onclick={() => { close(false); oncompact(); }}>Compact…</button>
					<button type="button" class="secondary-button" disabled={handoffDisabled} onclick={() => { close(false); onhandoff(); }}>Hand off…</button>
				</div>
			</div>
		</div>
	{/if}
</div>

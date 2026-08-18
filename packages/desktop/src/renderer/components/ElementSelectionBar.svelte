<script lang="ts">
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import type {
		ElementSelectionState,
		SelectionCaptureMode,
		WorkspaceAgent,
	} from "../workspace-types";

	interface Props {
		selectionState: ElementSelectionState;
		deliverableAgents?: WorkspaceAgent[];
		onCancel?: () => void;
		onCommit?: (instruction?: string) => void;
		onReset?: () => void;
		onRetry?: () => void;
		onChangeCaptureMode?: (mode: SelectionCaptureMode) => void;
		onSelectRecipientAgent?: (agentId: string) => void;
	}

	const {
		selectionState,
		deliverableAgents = [],
		onCancel,
		onCommit,
		onReset,
		onRetry,
		onChangeCaptureMode,
		onSelectRecipientAgent,
	}: Props = $props();

	let selectedAgentId = $derived(
		selectionState.agentId ?? deliverableAgents[0]?.id ?? "",
	);
	let currentRecipient = $derived(
		deliverableAgents.find(a => a.id === selectedAgentId) ?? deliverableAgents[0],
	);
	let captureMode = $derived(selectionState.captureMode ?? "dom");

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel?.();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div
	class="element-selection-bar"
	role="region"
	aria-label="Element selection in progress"
	data-phase={selectionState.phase}
>
	<div class="selection-indicator">
		<span class="selection-pulse" class:working={selectionState.phase === "working" || selectionState.phase === "sending"} aria-hidden="true"></span>
		<span class="selection-phase-badge">{selectionState.phase}</span>
	</div>

	<!-- Recipient agent -->
	<div class="selection-recipient">
		<span class="selection-label">Target:</span>
		{#if deliverableAgents.length > 1 && selectionState.phase === "picking"}
			<select
				class="recipient-select"
				aria-label="Select target agent"
				value={selectedAgentId}
				onchange={(e) => onSelectRecipientAgent?.(e.currentTarget.value)}
			>
				{#each deliverableAgents as agent (agent.id)}
					<option value={agent.id}>{agent.name} ({agent.agent})</option>
				{/each}
			</select>
		{:else}
			<div class="recipient-pill">
				<span
					class="agent-swatch"
					style={`background-color: ${currentRecipient?.swatch ?? 'var(--accent)'}`}
					aria-hidden="true"
				></span>
				<span class="agent-name">{currentRecipient?.name ?? selectionState.agentName ?? selectionState.agentId ?? "Active Agent"}</span>
			</div>
		{/if}
	</div>

	<!-- Capture mode selector (DOM vs Screenshot) -->
	<div class="capture-mode-radios" role="radiogroup" aria-label="Capture mode">
		<button
			type="button"
			role="radio"
			aria-checked={captureMode === "dom"}
			class="capture-mode-option"
			class:is-selected={captureMode === "dom"}
			disabled={selectionState.phase !== "picking"}
			onclick={() => onChangeCaptureMode?.("dom")}
		>
			DOM
		</button>
		<button
			type="button"
			role="radio"
			aria-checked={captureMode === "screenshot"}
			class="capture-mode-option"
			class:is-selected={captureMode === "screenshot"}
			disabled={selectionState.phase !== "picking"}
			onclick={() => onChangeCaptureMode?.("screenshot")}
		>
			Screenshot
		</button>
	</div>

	<!-- Status & Target hint text -->
	<div class="selection-hint" role="status" aria-live="polite">
		{#if selectionState.phase === "picking"}
			<span class="hint-text">Click an element on the page to target. Press Esc to cancel.</span>
		{:else if selectionState.phase === "selected"}
			<span class="hint-text selected">
				Targeted: <code>{selectionState.selector || selectionState.elementLabel || (selectionState.tagName ? `<${selectionState.tagName}>` : "element")}</code>
			</span>
		{:else if selectionState.phase === "sending" || selectionState.phase === "working"}
			<span class="hint-text working">
				<span class="selection-spinner" aria-hidden="true"></span>
				<span>{selectionState.workingMessage || "Agent is processing element..."}</span>
			</span>
		{:else if selectionState.phase === "ready" || selectionState.phase === "preview"}
			<span class="hint-text ready">
				Element changes applied.
			</span>
		{:else if selectionState.phase === "error"}
			<span class="hint-text error">
				{selectionState.error || "Element selection failed."}
			</span>
		{/if}
	</div>

	<!-- Action buttons -->
	<div class="selection-actions">
		{#if selectionState.phase === "selected"}
			<button
				type="button"
				class="selection-btn btn-commit"
				onclick={() => onCommit?.()}
			>
				Send to Agent
			</button>
		{/if}
		{#if selectionState.phase === "ready" || selectionState.phase === "preview"}
			<button
				type="button"
				class="selection-btn btn-done"
				onclick={() => onReset?.()}
			>
				Done
			</button>
		{/if}
		{#if selectionState.phase === "error"}
			<button
				type="button"
				class="selection-btn btn-retry"
				onclick={() => onRetry?.()}
			>
				<Refresh size={13} aria-hidden="true" />
				<span>Retry</span>
			</button>
		{/if}
		<button
			type="button"
			class="selection-btn btn-cancel"
			aria-label="Cancel selection"
			onclick={() => onCancel?.()}
		>
			<CloseCircle size={14} aria-hidden="true" />
			<span>Cancel</span>
		</button>
	</div>
</div>

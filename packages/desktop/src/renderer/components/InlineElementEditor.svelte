<script lang="ts">
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import Target from "@solar-icons/svelte/linear/target";
	import {
		isLocalUrl,
		type ElementSelectionState,
		type SelectionCaptureMode,
	} from "../workspace-types";

	interface Props {
		selectionState: ElementSelectionState;
		onCancel?: () => void;
		onCommit?: (instruction: string) => void;
		onReset?: () => void;
		onRetry?: () => void;
		onChangeCaptureMode?: (mode: SelectionCaptureMode) => void;
	}

	const {
		selectionState,
		onCancel,
		onCommit,
		onReset,
		onRetry,
		onChangeCaptureMode,
	}: Props = $props();

	let promptText = $state("");
	let textareaRef: HTMLTextAreaElement | undefined = $state();
	let captureMode = $derived(selectionState.captureMode ?? "dom");
	let isSubmitting = $derived(
		selectionState.phase === "sending" || selectionState.phase === "working",
	);
	let isLocal = $derived(isLocalUrl(selectionState.url));

	const LOCAL_SUGGESTIONS = [
		{ label: "🎨 Restyle", prompt: "Restyle this element with modern colors, subtle borders, and clean typography." },
		{ label: "📝 Edit Copy", prompt: "Update the text and messaging of this element to be clear and concise." },
		{ label: "📐 Spacing & Layout", prompt: "Fix the alignment, padding, and layout of this element." },
		{ label: "✨ Add Hover", prompt: "Add a smooth hover and focus transition effect to this element." },
	];

	const EXTERNAL_SUGGESTIONS = [
		{ label: "🔍 Explain", prompt: "Explain how this element is structured, its CSS styling, and layout behavior." },
		{ label: "🐛 Debug Layout", prompt: "Analyze this element's DOM and styles for layout bugs, overflows, or a11y issues." },
		{ label: "📐 Extract Specs", prompt: "Extract the exact CSS rules, colors, typography, and spacing for this component." },
	];

	let suggestions = $derived(isLocal ? LOCAL_SUGGESTIONS : EXTERNAL_SUGGESTIONS);
	let placeholderText = $derived(
		isLocal
			? "Describe changes to this element (e.g. 'Make it full-width with a smooth hover gradient')..."
			: "Ask OMP about this element, request debugging analysis, or extract its design...",
	);
	let submitButtonLabel = $derived(isLocal ? "Apply Edit" : "Ask OMP");

	function applySuggestion(suggestion: string): void {
		if (promptText.trim()) {
			promptText = `${promptText.trim()}\n${suggestion}`;
		} else {
			promptText = suggestion;
		}
		textareaRef?.focus();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel?.();
		} else if (event.key === "Enter" && !event.shiftKey && promptText.trim() && !isSubmitting) {
			event.preventDefault();
			handleSubmit();
		}
	}

	function handleSubmit(): void {
		if (!promptText.trim() || isSubmitting) return;
		onCommit?.(promptText.trim());
	}
</script>

<div
	class="inline-element-editor"
	role="dialog"
	aria-labelledby="inline-editor-title"
	aria-modal="true"
>
	<header class="editor-header">
		<div class="target-tag">
			<Target size={15} aria-hidden="true" />
			<strong id="inline-editor-title">
				{#if selectionState.tagName}&lt;{selectionState.tagName}&gt;{:else}Element{/if}
			</strong>
			{#if selectionState.selector}
				<code class="selector-snippet">{selectionState.selector}</code>
			{/if}
			<span class="editor-mode-badge" class:local={isLocal} class:external={!isLocal}>
				{isLocal ? "Local · Edit" : "External · Debug & Inspect"}
			</span>
		</div>
		<button
			type="button"
			class="editor-close"
			aria-label="Close inline editor"
			onclick={() => onCancel?.()}
		>
			<CloseCircle size={16} aria-hidden="true" />
		</button>
	</header>

	{#if selectionState.phase === "error"}
		<div class="editor-status error" role="alert">
			<span>{selectionState.error || "Failed to process element"}</span>
			<button type="button" class="retry-btn" onclick={() => onRetry?.()}>
				<Refresh size={13} aria-hidden="true" />
				<span>Retry</span>
			</button>
		</div>
	{:else if selectionState.phase === "ready" || selectionState.phase === "preview"}
		<div class="editor-status ready" role="status">
			<span>{isLocal ? "✓ Element edits applied to local repository." : "✓ Element and screenshot sent to session for analysis."}</span>
			<button type="button" class="primary-button" onclick={() => onReset?.()}>
				Done
			</button>
		</div>
	{:else}
		<form
			class="editor-body"
			onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
		>
			<textarea
				bind:this={textareaRef}
				bind:value={promptText}
				class="editor-textarea"
				placeholder={placeholderText}
				aria-label="Element edit instructions"
				rows={3}
				disabled={isSubmitting}
				onkeydown={handleKeydown}
			></textarea>

			<div class="suggestion-chips" aria-label="Prompt suggestions">
				{#each suggestions as item}
					<button
						type="button"
						class="chip-button"
						disabled={isSubmitting}
						onclick={() => applySuggestion(item.prompt)}
					>
						{item.label}
					</button>
				{/each}

				{#if !isLocal}
					<select
						class="recreate-dropdown"
						aria-label="Recreate component in framework"
						disabled={isSubmitting}
						onchange={(e) => {
							const val = e.currentTarget.value;
							if (val) {
								applySuggestion(val);
								e.currentTarget.selectedIndex = 0;
							}
						}}
					>
						<option value="" disabled selected>📋 Recreate in…</option>
						<option value="Recreate this element as an accessible, modern Svelte 5 component with scoped styles and TypeScript.">Recreate in Svelte</option>
						<option value="Recreate this element as an accessible, modern React component with TypeScript and Tailwind CSS.">Recreate in React</option>
						<option value="Recreate this element as an accessible, modern Vue 3 component with <script setup> and scoped styles.">Recreate in Vue</option>
					</select>
				{/if}
			</div>

			<footer class="editor-footer">
				<div class="mode-toggles" role="radiogroup" aria-label="Context capture mode">
					<button
						type="button"
						role="radio"
						aria-checked={captureMode === "dom"}
						class="mode-toggle-btn"
						class:active={captureMode === "dom"}
						disabled={isSubmitting}
						onclick={() => onChangeCaptureMode?.("dom")}
					>
						DOM
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={captureMode === "screenshot"}
						class="mode-toggle-btn"
						class:active={captureMode === "screenshot"}
						disabled={isSubmitting}
						onclick={() => onChangeCaptureMode?.("screenshot")}
					>
						Screenshot
					</button>
				</div>

				<div class="editor-actions">
					<button
						type="button"
						class="secondary-button"
						disabled={isSubmitting}
						onclick={() => onCancel?.()}
					>
						Cancel
					</button>
					<button
						type="submit"
						class="primary-button"
						disabled={!promptText.trim() || isSubmitting}
					>
						{#if isSubmitting}
							<span class="editor-spinner" aria-hidden="true"></span>
							<span>{isLocal ? "Applying…" : "Analyzing…"}</span>
						{:else}
							<span>{submitButtonLabel}</span>
							<span>↗</span>
						{/if}
					</button>
				</div>
			</footer>
		</form>
	{/if}
</div>

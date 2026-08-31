<script lang="ts">
	import { tick } from "svelte";
	import type { PromptAttachmentView, SlashCommand, ThinkingLevel } from "../../../shared/contracts";
	import { formatBytes } from "@oh-my-pi/pi-utils/format";
	import { highlightMagicKeywords } from "../../markdown";
	import ArrowUp from "@solar-icons/svelte/linear/arrow-up";
	import ClipboardList from "@solar-icons/svelte/linear/clipboard-list";
	import Paperclip from "@solar-icons/svelte/linear/paperclip";
	import type { DropdownOption } from "../../settings-types";
	import AttachmentChip from "../molecules/AttachmentChip.svelte";
	import RuntimePicker from "../molecules/RuntimePicker.svelte";
	import SessionActionsMenu from "../molecules/SessionActionsMenu.svelte";
	import ContextMeter from "./ContextMeter.svelte";

	interface Props {
		providerOptions: readonly DropdownOption[];
		providerSelectedKey: string;
		providerDisabled: boolean;
		modelOptions: readonly DropdownOption[];
		modelSelectedKey: string;
		modelDisabled: boolean;
		onProviderSelect: (option: DropdownOption) => void;
		onModelSelect: (option: DropdownOption) => void;
		dragging: boolean;
		canCompose: boolean;
		attachDisabled: boolean;
		attachments: PromptAttachmentView[];
		attachmentStatus?: string;
		displayNameFor: (name: string) => string;
		onStageFiles: (files: FileList, insertionIndex: number) => void;
		onRemoveAttachment: (attachment: PromptAttachmentView) => void;
		attachmentInputEl?: HTMLInputElement;
		inputEl?: HTMLTextAreaElement;
		draft?: string;
		commandMenuOpen: boolean;
		commandOptionCount: number;
		commandSelectedIndex: number;
		thinkingLevel: ThinkingLevel | undefined;
		thinkingBusy: boolean;
		onThinkingSelect: (option: DropdownOption) => void;
		onInput: (event: Event) => void;
		onKeydown: (event: KeyboardEvent) => void;
		onPaste: (event: ClipboardEvent) => void;
		turnActive: boolean;
		sendDisabled: boolean;
		queuedMessageCount: number;
		contextUsedTokens: number;
		contextLimit: number;
		contextTokensPerSecond?: number;
		contextModelName: string;
		planMode?: { enabled: boolean; planFilePath?: string; workflow?: string };
		planRefinementAwaiting?: boolean;
		inspectorOpen: boolean;
		inspectorTab: "agents" | "files";
		agentUnreadCount: number;
		fileActivityCount: number;
		commandShortcuts: SlashCommand[];
		commandsAvailable: boolean;
		onCommand: (command: SlashCommand) => void;
		onAllCommands: () => void;
		onToggleInspector: (tab: "agents" | "files") => void;
		compactDisabled: boolean;
		handoffDisabled: boolean;
		retryDisabled: boolean;
		restartDisabled: boolean;
		onCompact: () => void;
		onHandoff: () => void;
		onRetry: () => void;
		onStats: () => void;
		onExport: () => void;
		onRestart: () => void;
		onTogglePlanMode?: () => void;
		onSend: () => void;
		onQueueFollowUp: () => void;
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
		dragging,
		canCompose,
		attachDisabled,
		attachments,
		attachmentStatus = "",
		displayNameFor,
		onStageFiles,
		onRemoveAttachment,
		attachmentInputEl = $bindable(),
		inputEl = $bindable(),
		draft = $bindable(""),
		commandMenuOpen,
		commandOptionCount,
		commandSelectedIndex,
		thinkingLevel,
		thinkingBusy,
		onThinkingSelect,
		onInput,
		onKeydown,
		onPaste,
		turnActive,
		sendDisabled,
		queuedMessageCount,
		contextUsedTokens,
		contextLimit,
		contextTokensPerSecond,
		contextModelName,
		planMode,
		planRefinementAwaiting = false,
		inspectorOpen,
		inspectorTab,
		agentUnreadCount,
		fileActivityCount,
		commandShortcuts,
		commandsAvailable,
		onCommand,
		onAllCommands,
		onToggleInspector,
		compactDisabled,
		handoffDisabled,
		retryDisabled,
		restartDisabled,
		onCompact,
		onHandoff,
		onRetry,
		onStats,
		onExport,
		onRestart,
		onTogglePlanMode,
		onSend,
		onQueueFollowUp,
	}: Props = $props();
	let backdropEl = $state<HTMLDivElement>();
	let actionMenuOpen = $state(false);
	let actionMenuTriggerEl = $state<HTMLElement>();
	let attachmentInsertionIndex = $state<number>();
	let attachmentBarEl = $state<HTMLDivElement>();
	let attachmentAddButtonEl = $state<HTMLButtonElement>();

	function rememberAttachmentInsertion(): void {
		attachmentInsertionIndex = inputEl?.selectionEnd ?? draft.length;
	}

	async function handleAttachmentRemoval(
		attachment: PromptAttachmentView,
		index: number,
		event: MouseEvent,
	): Promise<void> {
		const restoreKeyboardFocus = event.detail === 0;
		onRemoveAttachment(attachment);
		if (!restoreKeyboardFocus) return;
		await tick();
		const removeButtons = attachmentBarEl?.querySelectorAll<HTMLButtonElement>(".attachment-chip-remove");
		const nextButton = removeButtons?.[Math.min(index, Math.max(0, removeButtons.length - 1))];
		(nextButton ?? attachmentAddButtonEl)?.focus({ preventScroll: true });
	}

	function closeActionMenu(restoreFocus = false): void {
		if (!actionMenuOpen) return;
		actionMenuOpen = false;
		if (restoreFocus) queueMicrotask(() => actionMenuTriggerEl?.focus({ preventScroll: true }));
	}

	function handleActionMenuKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || !actionMenuOpen) return;
		event.preventDefault();
		event.stopPropagation();
		closeActionMenu(true);
	}

	function syncBackdropScroll(): void {
		if (!inputEl || !backdropEl) return;
		backdropEl.scrollTop = inputEl.scrollTop;
		backdropEl.scrollLeft = inputEl.scrollLeft;
	}

	function syncTextareaLayout(): void {
		const textarea = inputEl;
		if (!textarea) return;

		// Reset before measuring so shrinking drafts do not retain the previous height.
		textarea.style.height = "0px";
		const styles = getComputedStyle(textarea);
		const minHeight = Number.parseFloat(styles.minHeight) || 0;
		const maxHeight = Number.parseFloat(styles.maxHeight) || Number.POSITIVE_INFINITY;
		const contentHeight = textarea.scrollHeight;
		const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);

		textarea.style.height = `${nextHeight}px`;
		textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
		syncBackdropScroll();
	}
	function handleTextareaInput(event: Event): void {
		onInput(event);
		syncTextareaLayout();
	}

	$effect(() => {
		void draft;
		if (!turnActive) actionMenuOpen = false;
		syncTextareaLayout();
	});

	const hasUltrathink = $derived(/\bultrathink\b/.test(draft));
	const hasOrchestrate = $derived(/\borchestrate\b/.test(draft));
	const hasWorkflowz = $derived(/\bworkflowz\b/.test(draft));
	function escapeHtml(text: string): string {
		return text
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	}

	function renderBackdrop(text: string): string {
		if (!text) return "";
		const escaped = escapeHtml(text);
		return highlightMagicKeywords(escaped);
	}

</script>
<svelte:window onkeydown={actionMenuOpen ? handleActionMenuKeydown : undefined} />

<div class="composer" class:is-plan-mode={planMode?.enabled}>
<div class="composer-top-bar" class:is-plan-mode={planMode?.enabled}>
  {#if planMode?.enabled}
    <div class="plan-mode-pill" role="status" title="Plan mode is active">
      <span class="plan-mode-icon" aria-hidden="true"><ClipboardList size={14} /></span>
      <span class="plan-mode-title">PLAN MODE</span>
      {#if onTogglePlanMode}
        <button type="button" class="plan-mode-exit" onclick={onTogglePlanMode} title="Exit plan mode">Exit</button>
      {/if}
    </div>
  {/if}
  <div bind:this={attachmentBarEl} class="composer-attachment-bar">
    <input
      bind:this={attachmentInputEl}
      class="sr-only"
      type="file"
      multiple
      aria-label="Choose files to attach"
      disabled={attachDisabled}
      onchange={(event) => {
        if (attachDisabled) return;
        const files = (event.currentTarget as HTMLInputElement).files;
        const insertionIndex = attachmentInsertionIndex ?? inputEl?.selectionEnd ?? draft.length;
        attachmentInsertionIndex = undefined;
        if (files) onStageFiles(files, insertionIndex);
      }}
    />
    <button
      bind:this={attachmentAddButtonEl}
      type="button"
      class="attachment-add-button"
      aria-label="Attach files"
      title="Attach files"
      disabled={attachDisabled}
      onclick={() => {
        rememberAttachmentInsertion();
        attachmentInputEl?.click();
      }}
    >
      <Paperclip size={16} aria-hidden="true" />
      <span>Attach</span>
    </button>
    {#if attachments.length > 0}
      <div class="attachment-chip-list" aria-label="Attached files">
        {#each attachments as attachment, index (attachment.id)}
          <AttachmentChip
            kind={attachment.kind}
            displayName={displayNameFor(attachment.name)}
            sizeLabel={formatBytes(attachment.size)}
            removeLabel={`Remove ${displayNameFor(attachment.name)}`}
            onremove={(event) => void handleAttachmentRemoval(attachment, index, event)}
          />
        {/each}
      </div>
    {/if}
    {#if attachmentStatus}
      <span class="attachment-status" role="status" aria-live="polite">{attachmentStatus}</span>
    {/if}
  </div>
</div>
  {#if commandShortcuts.length > 0 || commandsAvailable}
    <nav class="composer-command-shortcuts" aria-label="OMP command shortcuts">
      {#each commandShortcuts as command (command.name)}
        <button type="button" title={command.description ?? `Prepare /${command.name}`} onclick={() => onCommand(command)}>
          /{command.name}
        </button>
      {/each}
      {#if commandsAvailable}
        <button type="button" class="all-commands" onclick={onAllCommands}>All commands…</button>
      {/if}
    </nav>
  {/if}
  {#if dragging}
    <div class="composer-drop-overlay" role="status" aria-live="polite">Drop files to attach</div>
  {/if}
  <div class="composer-input-container">
    {#if hasUltrathink || hasOrchestrate || hasWorkflowz}
      <div bind:this={backdropEl} class="composer-backdrop" aria-hidden="true">
        {@html renderBackdrop(draft)}
      </div>
    {/if}
    <textarea
      bind:this={inputEl}
      bind:value={draft}
      class:has-backdrop={hasUltrathink || hasOrchestrate || hasWorkflowz}
      aria-label="Message OMP"
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      aria-expanded={commandMenuOpen}
      aria-controls={commandMenuOpen ? "slash-command-menu" : undefined}
      aria-activedescendant={commandMenuOpen && commandOptionCount > 0 ? `slash-command-option-${commandSelectedIndex}` : undefined}
      placeholder={planRefinementAwaiting
        ? "Describe how OMP should refine the plan…"
        : planMode?.enabled
          ? (turnActive ? "Steer the current turn in plan mode…" : "Plan mode active: Ask OMP to create or update an implementation plan…")
          : (turnActive ? "Steer the current turn…" : "Ask OMP to work in this folder…")}
      disabled={!canCompose}
      oninput={handleTextareaInput}
      onkeydown={onKeydown}
      onpaste={onPaste}
      onscroll={syncBackdropScroll}
    ></textarea>
  </div>
  <div class="composer-actions">
    <div class="composer-tools">
      <nav class="composer-inspector-links" aria-label="Run details">
        <button
          type="button"
          class:is-active={inspectorOpen && inspectorTab === "agents"}
          aria-label={`${inspectorOpen && inspectorTab === "agents" ? "Close" : "Open"} Agent Hub${agentUnreadCount > 0 ? `, ${agentUnreadCount} unread` : ""}`}
          onclick={() => onToggleInspector("agents")}
        >Agents{#if agentUnreadCount > 0}<span>{agentUnreadCount}</span>{/if}</button>
        <button
          type="button"
          class:is-active={inspectorOpen && inspectorTab === "files"}
          aria-label={`${inspectorOpen && inspectorTab === "files" ? "Close" : "Open"} Files${fileActivityCount > 0 ? `, ${fileActivityCount} changed` : ""}`}
          onclick={() => onToggleInspector("files")}
        >Files{#if fileActivityCount > 0}<span>{fileActivityCount}</span>{/if}</button>
      </nav>
      <RuntimePicker
        {providerOptions}
        {providerSelectedKey}
        {providerDisabled}
        {modelOptions}
        {modelSelectedKey}
        {modelDisabled}
        {onProviderSelect}
        {onModelSelect}
        {thinkingLevel}
        {thinkingBusy}
        {onThinkingSelect}
      />

      <ContextMeter
        usedTokens={contextUsedTokens}
        contextLimit={contextLimit}
        tokensPerSecond={contextTokensPerSecond}
        modelName={contextModelName}
        {compactDisabled}
        {handoffDisabled}
        oncompact={onCompact}
        onhandoff={onHandoff}
      />
      <SessionActionsMenu
        {retryDisabled}
        {restartDisabled}
        onretry={onRetry}
        onstats={onStats}
        onexport={onExport}
        onrestart={onRestart}
      />
    </div>

    <div class="composer-action-rail" class:active={turnActive}>
      {#if turnActive}
        <details class="composer-action-menu" bind:open={actionMenuOpen}>
          <summary
            bind:this={actionMenuTriggerEl}
            class="secondary-button action-menu-trigger"
            aria-label="More actions"
            aria-expanded={actionMenuOpen}
            aria-controls="composer-more-actions"
          >More actions</summary>
          <div id="composer-more-actions" class="action-menu-panel">
            <button
              type="button"
              class="secondary-button queue-follow-up-button"
              title={`Queue for the next turn${queuedMessageCount > 0 ? ` (${queuedMessageCount} queued)` : ""}`}
              aria-label={`Queue for the next turn${queuedMessageCount > 0 ? `, ${queuedMessageCount} queued ${queuedMessageCount === 1 ? "message" : "messages"}` : ""}`}
              disabled={sendDisabled}
              onclick={() => { actionMenuOpen = false; onQueueFollowUp(); }}
            >Queue for next turn{#if queuedMessageCount > 0}<span class="queue-count">{queuedMessageCount}</span>{/if}</button>
          </div>
        </details>
        <button
          type="button"
          class="action-button send-turn-btn"
          title="Steer the current turn"
          aria-label="Steer"
          disabled={sendDisabled}
          onclick={onSend}
        >
          <span class="send-glyph" aria-hidden="true"><ArrowUp size={15} aria-hidden="true" /></span>
          <span class="send-label">Steer</span>
        </button>
      {:else}
        <button
          type="button"
          class="action-button send-turn-btn"
          title={planRefinementAwaiting ? "Refine plan (Enter)" : "Send message (Enter)"}
          aria-label={planRefinementAwaiting ? "Refine plan" : "Send message"}
          disabled={sendDisabled}
          onclick={onSend}
        >
          <span class="send-glyph" aria-hidden="true"><ArrowUp size={15} /></span>
          <span class="send-label">{planRefinementAwaiting ? "Refine plan" : "Send"}</span>
        </button>
      {/if}
    </div>
  </div>
</div>

<script lang="ts">
	import { tick } from "svelte";
	import type { AgentPromptScope, AgentPromptView } from "../../../shared/contracts";
	import ModalShell from "../molecules/ModalShell.svelte";

	export let agents: AgentPromptView[] = [];
	export let loading = false;
	export let loadError = "";
	export let onSave: (
		name: string,
		scope: AgentPromptScope,
		systemPrompt: string,
		expectedRevision: string | null,
	) => Promise<AgentPromptView>;
	export let onReset: (
		name: string,
		scope: AgentPromptScope,
		expectedRevision: string,
	) => Promise<AgentPromptView>;
	export let onDirtyChange: (dirty: boolean) => void = () => undefined;

	let selectedName = "";
	let scope: AgentPromptScope = "project";
	let draft = "";
	let baseline = "";
	let loadedSelection = "";
	let saving = false;
	let status = "";
	let baselineRevision: string | null = null;
	let error = "";
	let resetOpen = false;
	let pendingSelection: { name: string; scope: AgentPromptScope; trigger: HTMLElement } | undefined;
	let returnFocus: HTMLElement | undefined;
	let textarea: HTMLTextAreaElement | undefined;
	let confirmationDefaultAction: HTMLButtonElement | undefined;
	let dirtyReported = false;

	$: if (!selectedName || !agents.some(agent => agent.name === selectedName)) {
		selectedName = agents[0]?.name ?? "";
	}
	$: selected = agents.find(agent => agent.name === selectedName);
	$: selectedOverride = selected?.[scope];
	$: selectionKey = selected ? `${selected.name}:${scope}:${selectedOverride?.revision ?? "absent"}` : "";
	$: if (selectionKey && selectionKey !== loadedSelection && !dirty) loadSelection();
	$: dirty = Boolean(selected && draft !== baseline);
	$: if (dirty !== dirtyReported) {
		dirtyReported = dirty;
		onDirtyChange(dirty);
	}
	$: shadowedUser = scope === "user" && Boolean(selected?.project);
	$: if ((pendingSelection || resetOpen) && confirmationDefaultAction) {
		confirmationDefaultAction.focus({ preventScroll: true });
	}

	function loadSelection(): void {
		if (!selected) return;
		baseline = selectedOverride?.systemPrompt ?? selected.systemPrompt;
		draft = baseline;
		loadedSelection = selectionKey;
		status = "";
		baselineRevision = selectedOverride?.revision ?? null;
		error = "";
	}

	function requestSelection(name: string, nextScope: AgentPromptScope, trigger: HTMLElement): void {
		if (name === selectedName && nextScope === scope) return;
		if (dirty) {
			pendingSelection = { name, scope: nextScope, trigger };
			returnFocus = trigger;
			return;
		}
		applySelection(name, nextScope);
	}

	function applySelection(name: string, nextScope: AgentPromptScope): void {
		selectedName = name;
		scope = nextScope;
		loadedSelection = "";
		void tick().then(() => textarea?.focus({ preventScroll: true }));
	}

	function keepEditing(): void {
		pendingSelection = undefined;
		void tick().then(() => returnFocus?.focus({ preventScroll: true }));
	}

	function discardAndSwitch(): void {
		const pending = pendingSelection;
		pendingSelection = undefined;
		if (pending) applySelection(pending.name, pending.scope);
	}

	function replaceAgent(updated: AgentPromptView): void {
		agents = agents.map(agent => (agent.name === updated.name ? updated : agent));
		selectedName = updated.name;
		baseline = updated[scope]?.systemPrompt ?? updated.systemPrompt;
		draft = baseline;
		baselineRevision = updated[scope]?.revision ?? null;
		loadedSelection = `${updated.name}:${scope}:${baselineRevision ?? "absent"}`;
	}

	async function save(): Promise<void> {
		if (!selected || !dirty || saving || !draft.trim()) return;
		saving = true;
		status = "Saving…";
		error = "";
		try {
			const updated = await onSave(selected.name, scope, draft, baselineRevision);
			replaceAgent(updated);
			status = `${updated.name} ${scope} override saved. New subagents use it on their next spawn.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			status = "";
		} finally {
			saving = false;
		}
	}

	function openReset(event: MouseEvent): void {
		if (!selectedOverride) return;
		returnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
		resetOpen = true;
	}

	function closeReset(): void {
		resetOpen = false;
		void tick().then(() => returnFocus?.focus({ preventScroll: true }));
	}

	async function reset(): Promise<void> {
		if (!selected || !selectedOverride || !baselineRevision || saving) return;
		const revision = baselineRevision;
		resetOpen = false;
		saving = true;
		status = "Resetting…";
		error = "";
		try {
			const updated = await onReset(selected.name, scope, revision);
			replaceAgent(updated);
			status = `${updated.name} now uses its ${updated.effectiveSource} definition.`;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			status = "";
		} finally {
			saving = false;
			void tick().then(() => returnFocus?.focus({ preventScroll: true }));
		}
	}

	function overridePath(): string {
		if (!selected) return "";
		return scope === "project" ? `.omp/agents/${selected.name}.md` : `~/.omp/agent/agents/${selected.name}.md`;
	}

	function fallbackLabel(): string {
		if (!selected) return "the next discovered definition";
		if (scope === "project" && selected.user) return "the user override";
		if (scope === "user" && selected.project) return "the project override, which remains effective";
		return "the next extension or bundled definition";
	}
</script>

<section class="prompt-editor" aria-label="Subagent prompts">
	<div class="editor-context">
		<div>
			<strong>Subagent definitions</strong>
			<p>Edit the system prompt used when a new subagent spawns. Running subagents are unchanged.</p>
		</div>
		<span class="apply-badge">Next spawn</span>
	</div>

	{#if loading}
		<div class="editor-empty" role="status">Loading subagent prompts…</div>
	{:else if loadError}
		<div class="editor-empty" role="alert"><strong>Subagent prompts unavailable</strong><span>{loadError}</span></div>
	{:else if !selected}
		<div class="editor-empty"><strong>No subagents discovered</strong><span>Refresh Settings after adding an OMP agent definition.</span></div>
	{:else}
		<div class="editor-toolbar">
			<label>
				<span>Subagent</span>
				<select
					value={selectedName}
					disabled={saving}
					onchange={(event) => requestSelection(event.currentTarget.value, scope, event.currentTarget)}
				>
					{#each agents as agent (agent.name)}
						<option value={agent.name}>{agent.name}</option>
					{/each}
				</select>
			</label>
			<fieldset disabled={saving}>
				<legend>Override scope</legend>
				<label><input type="radio" name="agent-prompt-scope" checked={scope === "project"} onchange={(event) => requestSelection(selectedName, "project", event.currentTarget)} /> Project</label>
				<label><input type="radio" name="agent-prompt-scope" checked={scope === "user"} onchange={(event) => requestSelection(selectedName, "user", event.currentTarget)} /> User</label>
			</fieldset>
		</div>

		<div class="definition-summary">
			<div><span>Effective source</span><strong>{selected.effectiveSource}</strong></div>
			<div><span>Editing</span><strong>{scope} {selectedOverride ? "override" : "new override"}</strong></div>
		</div>
		<p class="description">{selected.description}</p>
		{#if shadowedUser}
			<p class="shadow-note" role="note">This user override is shadowed by the project override.</p>
		{/if}

		<label class="prompt-field">
			<span>System prompt</span>
			<textarea bind:this={textarea} bind:value={draft} disabled={saving} spellcheck="false" rows="18"></textarea>
		</label>
		<div class="editor-footer">
			<div class="editor-state" aria-live="polite">
				{#if error}<span class="editor-error" role="alert">{error}</span>{:else if status}<span>{status}</span>{:else if dirty}<span>Unsaved changes</span>{:else}<span>Saved</span>{/if}
			</div>
			<div class="editor-actions">
				{#if selectedOverride}<button type="button" class="secondary-button" disabled={saving} onclick={openReset}>Reset {scope}</button>{/if}
				<button type="button" class="primary-button" disabled={!dirty || !draft.trim() || saving} onclick={() => void save()}>{saving ? "Saving…" : "Save prompt"}</button>
			</div>
		</div>
	{/if}
</section>

{#if pendingSelection}
	<ModalShell backdrop dialogClass="agent-prompt-confirm" labelledbyId="agent-prompt-dirty-title" onclose={keepEditing}>
		<h2 id="agent-prompt-dirty-title">Discard unsaved prompt?</h2>
		<p>Your {selectedName} {scope} draft is not saved. Keep editing to preserve it.</p>
		<div class="dialog-actions">
			<button bind:this={confirmationDefaultAction} type="button" class="primary-button" onclick={keepEditing}>Keep editing</button>
			<button type="button" class="secondary-button" onclick={discardAndSwitch}>Discard changes</button>
		</div>
	</ModalShell>
{/if}

{#if resetOpen && selected && selectedOverride}
	<ModalShell backdrop dialogClass="agent-prompt-confirm" labelledbyId="agent-prompt-reset-title" onclose={closeReset}>
		<h2 id="agent-prompt-reset-title">Reset {selected.name} {scope} override?</h2>
		<p>This permanently deletes <code>{overridePath()}</code>. {fallbackLabel()} will become effective. This cannot be undone.</p>
		<div class="dialog-actions">
			<button bind:this={confirmationDefaultAction} type="button" class="primary-button" onclick={closeReset}>Keep override</button>
			<button type="button" class="danger-button" onclick={() => void reset()}>Delete override</button>
		</div>
	</ModalShell>
{/if}

<style>
	.prompt-editor { display: grid; gap: 16px; }
	.editor-context, .editor-footer, .editor-toolbar, .definition-summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
	.editor-context p, .description { margin: 4px 0 0; color: var(--foreground-muted); }
	.apply-badge { flex: none; border: 1px solid var(--line-soft); border-radius: 999px; padding: 4px 8px; color: var(--foreground-muted); font-size: 12px; }
	.editor-toolbar { align-items: end; padding: 14px; border: 1px solid var(--line-soft); border-radius: var(--radius-medium); background: var(--shell-raised); }
	.editor-toolbar > label { display: grid; gap: 6px; min-width: min(320px, 48%); font-size: 12px; color: var(--foreground-muted); }
	select { min-height: 34px; border: 1px solid var(--line); border-radius: var(--radius-small); background: var(--chat-canvas); color: var(--foreground); padding: 0 10px; }
	fieldset { display: flex; gap: 12px; border: 0; margin: 0; padding: 0; }
	legend { margin-bottom: 6px; color: var(--foreground-muted); font-size: 12px; }
	fieldset label { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; }
	.definition-summary { justify-content: flex-start; gap: 28px; }
	.definition-summary div { display: grid; gap: 2px; }
	.definition-summary span { color: var(--foreground-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
	.definition-summary strong { text-transform: capitalize; }
	.shadow-note { margin: 0; padding: 9px 11px; border-left: 3px solid var(--warning-boundary); background: var(--warning-surface); }
	.prompt-field { display: grid; gap: 7px; font-weight: 600; }
	textarea { width: 100%; min-height: 280px; resize: vertical; border: 1px solid var(--line); border-radius: var(--radius-medium); background: var(--chat-canvas); color: var(--foreground); padding: 14px; font: 13px/1.55 "Cascadia Mono", "SFMono-Regular", Consolas, monospace; tab-size: 2; }
	textarea:focus, select:focus-visible, input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
	.editor-state { min-height: 24px; color: var(--foreground-muted); }
	.editor-error { color: var(--danger); }
	.editor-actions { display: flex; gap: 8px; }
	.editor-empty { display: grid; gap: 5px; padding: 22px; border: 1px dashed var(--line-soft); border-radius: var(--radius-medium); color: var(--foreground-muted); }
	code { font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace; }
	@media (max-width: 760px) {
		.editor-context, .editor-footer, .editor-toolbar { align-items: stretch; flex-direction: column; }
		.editor-toolbar > label { min-width: 0; }
		.editor-actions { display: grid; grid-template-columns: 1fr 1fr; }
		.editor-actions :global(button) { min-height: 36px; }
	}
</style>

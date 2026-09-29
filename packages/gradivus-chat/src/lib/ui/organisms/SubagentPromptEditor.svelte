<script lang="ts">
	import { tick } from "svelte";
	import type {
		HostedAgentPromptScope as AgentPromptScope,
		HostedAgentPrompt as AgentPromptView,
	} from "../../contracts";
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
			<div class="definition-summary">
				<div><span>Effective source</span><strong>{selected.effectiveSource}</strong></div>
				<div><span>Editing {scope} {selectedOverride ? "override" : "new override"}</span><code>{overridePath()}</code></div>
			</div>
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
			<div class="editor-state" class:is-dirty={dirty} class:has-error={Boolean(error)} aria-live="polite">
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
	.prompt-editor { display: grid; gap: 24px; font: 14px/1.5 var(--font-ui); }
	.editor-context, .editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
	.editor-context strong { color: var(--foreground-strong); font-size: 16px; font-weight: 600; }
	.editor-context p, .description { margin: 4px 0 0; color: var(--foreground-muted); }
	.apply-badge { flex: none; border: 1px solid var(--accent-boundary); border-radius: 999px; padding: 4px 10px; color: var(--selection-foreground); background: var(--selection-surface); font-size: 12px; }
	.editor-toolbar { display: grid; grid-template-columns: minmax(160px, 1fr) auto minmax(180px, 1fr); align-items: start; gap: 28px; padding: 24px 0; border-block: 1px solid var(--line); }
	.editor-toolbar > label { display: grid; gap: 10px; min-width: 0; font-size: 14px; color: var(--foreground-strong); }
	select { width: 100%; min-height: var(--control-height); border: 1px solid var(--line); border-radius: var(--radius-small); background: var(--shell-raised); color: var(--foreground); padding: 0 12px; font: inherit; }
	fieldset { display: flex; align-items: center; gap: 16px; border: 0; border-inline: 1px solid var(--line); margin: 0; padding: 0 24px; }
	legend { margin-bottom: 10px; color: var(--foreground-strong); font-size: 14px; }
	fieldset label { display: inline-flex; align-items: center; gap: 8px; min-height: var(--control-height); }
	fieldset input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
	.definition-summary { display: grid; gap: 10px; min-width: 0; }
	.definition-summary div { display: grid; gap: 4px; }
	.definition-summary span { color: var(--foreground-muted); font-size: 12px; }
	.definition-summary strong { text-transform: capitalize; font-weight: 500; }
	.definition-summary code { overflow-wrap: anywhere; color: var(--foreground-muted); font-size: 12px; }
	.shadow-note { margin: 0; padding: 12px 16px; border-left: 3px solid var(--warning-boundary); background: var(--warning-surface); }
	.prompt-field { display: grid; gap: 12px; font-size: 16px; font-weight: 600; }
	textarea { width: 100%; min-height: 360px; resize: vertical; border: 1px solid var(--line); border-radius: var(--radius-medium); background: var(--shell-raised); color: var(--foreground); padding: 20px; font: 14px/1.7 var(--font-mono); tab-size: 2; }
	textarea:focus, select:focus-visible, input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
	.editor-footer { padding-top: 20px; border-top: 1px solid var(--line); }
	.editor-state { display: flex; align-items: center; gap: 8px; min-height: 24px; color: var(--foreground-muted); }
	.editor-state::before { content: ""; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--success-boundary); }
	.editor-state.is-dirty::before { background: var(--warning-boundary); }
	.editor-state.has-error::before { background: var(--danger-boundary); }
	.editor-error { color: var(--danger-boundary); overflow-wrap: anywhere; }
	.editor-actions { display: flex; gap: 8px; }
	.editor-empty { display: grid; gap: 5px; padding: 22px; border: 1px dashed var(--line-soft); border-radius: var(--radius-medium); color: var(--foreground-muted); }
	code { font-family: var(--font-mono); }
	@media (max-width: 1100px) {
		.editor-toolbar { grid-template-columns: minmax(0, 1fr) auto; }
		.definition-summary { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; }
		fieldset { border-right: 0; padding-right: 0; }
	}
	@media (max-width: 760px) {
		.editor-context, .editor-footer { align-items: stretch; flex-direction: column; }
		.editor-toolbar { grid-template-columns: minmax(0, 1fr); gap: 20px; }
		fieldset { border: 0; padding: 0; }
		.definition-summary { grid-template-columns: minmax(0, 1fr); }
		.apply-badge { width: fit-content; }
		textarea { min-height: 300px; padding: 16px; }
		.editor-actions { display: grid; grid-template-columns: 1fr 1fr; }
		.editor-actions :global(button) { min-height: 36px; }
	}
</style>

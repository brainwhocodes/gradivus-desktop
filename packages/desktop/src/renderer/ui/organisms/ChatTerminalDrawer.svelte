<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { GradivusSettings, TerminalAttachmentState, WorkspaceEvent } from "../../../shared/contracts";
  import { DESKTOP_THEME_PALETTES, type ResolvedTheme } from "../../../shared/theme-palette";
  import type { WorkspacePane, WorkspaceTab } from "../../workspace-types";
  import {
    createTerminalRenderer,
    selectTerminalRenderer,
    type TerminalRenderer,
    type TerminalRendererAppearance,
    type TerminalRendererConfiguration,
  } from "../../terminal/terminal-renderer";
  import ModalShell from "../molecules/ModalShell.svelte";

  const NATIVE_MONO_FONT =
    'ui-monospace, "SFMono-Regular", Menlo, Monaco, "Cascadia Mono", Consolas, "Liberation Mono", monospace';

  export let workspaceId: string;
  export let tabs: WorkspaceTab[] = [];
  export let open = false;
  export let confirmClose = true;
  export let theme: ResolvedTheme = "dark";
  export let terminalSettings: GradivusSettings["terminal"] | undefined = undefined;

  let selectedTabId = "";
  let selectedPane: WorkspacePane | undefined;
  let knownTabSignature = "";
  let creating = false;
  let activationToken = 0;
  let activatedPaneId = "";
  let focusTabAfterActivationId = "";
  let renderer: TerminalRenderer | undefined;
  let terminalElement: HTMLDivElement | undefined;
  let removeWorkspaceEvent: (() => void) | undefined;
  let writeQueue: Promise<void> = Promise.resolve();
  let renderedOffsets = new Map<string, number>();
  let terminalStatuses = new Map<string, "starting" | "running" | "exited" | "failed">();
  let initializedWorkspaces = new Set<string>();
  let terminalErrors = new Map<string, string>();
  let createdTabs = new Set<string>();
  let relaunchedPanes = new Set<string>();
  let renameTabId = "";
  let renameValue = "";
  let renameInput: HTMLInputElement | undefined;
  let closeCandidate: { tab: WorkspaceTab; pane: WorkspacePane } | undefined;
  let closeReturnFocus: HTMLElement | undefined;
  let keepTerminalButton: HTMLButtonElement | undefined;

  const selectedKind = selectTerminalRenderer(window.gradivus.platform);

  $: terminalTabs = tabs.filter(tab => tab.kind === "terminal" && tab.panes.length > 0);
  $: tabSignature = terminalTabs.map(tab => `${tab.id}:${tab.activePaneId}:${tab.title}`).join("\0");
  $: if (tabSignature !== knownTabSignature) {
    knownTabSignature = tabSignature;
    reconcileSelection();
  }
  $: if (open && workspaceId && !initializedWorkspaces.has(workspaceId)) {
    initializedWorkspaces = new Set(initializedWorkspaces).add(workspaceId);
    if (terminalTabs.length === 0 && !creating) void createNewTerminal();
  }
  $: selectedTab = terminalTabs.find(tab => tab.id === selectedTabId);
  $: selectedPane = selectedTab?.panes.find(pane => pane.id === selectedTab.activePaneId) ?? selectedTab?.panes[0];
  $: if (open && selectedPane && terminalElement && activatedPaneId !== selectedPane.id) {
    activatedPaneId = selectedPane.id;
    void activateSelectedPane();
  }
  $: if (open && renderer) void tick().then(() => renderer?.fit());

  $: if (renderer) {
    const appearance: TerminalRendererAppearance = {
      theme: DESKTOP_THEME_PALETTES[theme].terminal,
      cursorBlink: terminalSettings?.cursorBlink ?? true,
      cursorStyle: terminalSettings?.cursorStyle ?? "block",
    };
    renderer.updateAppearance(appearance);
  }

  function reconcileSelection(): void {
    if (terminalTabs.some(tab => tab.id === selectedTabId)) return;
    selectedTabId = terminalTabs[0]?.id ?? "";
    activatedPaneId = "";
    disposeRenderer();
  }

  function dimensions(): { cols: number; rows: number } {
    const width = terminalElement?.clientWidth ?? 720;
    const height = terminalElement?.clientHeight ?? 280;
    return {
      cols: Math.max(2, Math.min(500, Math.floor(width / 8))),
      rows: Math.max(2, Math.min(500, Math.floor(height / 18))),
    };
  }

  function buildConfiguration(): TerminalRendererConfiguration {
    return {
      fontSize: terminalSettings?.fontSize ?? 14,
      fontFamily: terminalSettings?.fontFamily ?? NATIVE_MONO_FONT,
      cursorBlink: terminalSettings?.cursorBlink ?? true,
      cursorStyle: terminalSettings?.cursorStyle ?? "block",
      scrollback: terminalSettings?.scrollback ?? 10_000,
      theme: DESKTOP_THEME_PALETTES[theme].terminal,
    };
  }

  function nextTerminalName(): string {
    const used = new Set(terminalTabs.map(tab => tab.title));
    let index = 1;
    while (used.has(`Terminal ${index}`)) index++;
    return `Terminal ${index}`;
  }

  async function createNewTerminal(): Promise<void> {
    if (creating || !workspaceId) return;
    creating = true;
    const tabId = `terminal-tab-${crypto.randomUUID()}`;
    const paneId = `terminal-${crypto.randomUUID()}`;
    const name = nextTerminalName();
    const { cols, rows } = dimensions();
    try {
      await window.gradivus.createTerminal({ id: paneId, tabId, workspaceId, name, cols, rows });
      createdTabs = new Set(createdTabs).add(tabId);
      selectedTabId = tabId;
    } catch (error) {
      setTerminalError(paneId, error);
    } finally {
      creating = false;
    }
  }

  function disposeRenderer(): void {
    activationToken++;
    renderer?.dispose();
    renderer = undefined;
    terminalElement?.replaceChildren();
  }

  async function mountRenderer(pane: WorkspacePane, token: number): Promise<TerminalRenderer | undefined> {
    if (!terminalElement || token !== activationToken) return undefined;
    const { cols, rows } = dimensions();
    const instance = await createTerminalRenderer(window.gradivus.platform, {
      element: terminalElement,
      cols,
      rows,
      configuration: buildConfiguration(),
      onData(data) {
        writeQueue = writeQueue.then(() => window.gradivus.writeTerminal(pane.id, data)).catch(error => {
          setTerminalError(pane.id, error);
        });
      },
      onResize(columns, nextRows) {
        if (!open || selectedPane?.id !== pane.id) return;
        void window.gradivus.resizeTerminal(pane.id, columns, nextRows).catch(() => {});
      },
    });
    if (token !== activationToken) {
      instance.dispose();
      return undefined;
    }
    renderer = instance;
    return instance;
  }

  async function activateSelectedPane(): Promise<void> {
    const pane = selectedPane;
    if (!pane) return;
    const token = ++activationToken;
    disposeRenderer();
    const currentToken = ++activationToken;
    try {
      await tick();
      if (!open || selectedPane?.id !== pane.id || currentToken !== activationToken) return;
      const instance = await mountRenderer(pane, currentToken);
      if (!instance) return;
      const fromOffset = renderedOffsets.get(pane.id) ?? 0;
      const state = await window.gradivus.attachTerminal(pane.id, fromOffset);
      applyAttachmentState(pane, state, instance, fromOffset);
      await instance.fit();
      if (focusTabAfterActivationId === pane.tabId) {
        await tick();
        document.getElementById(`terminal-tab-${pane.tabId}`)?.focus({ preventScroll: true });
      } else {
        instance.focus();
      }
    } catch (error) {
      if (token <= activationToken) {
        setTerminalStatus(pane.id, "failed");
        setTerminalError(pane.id, error);
      }
    }
  }

  function applyAttachmentState(
    pane: WorkspacePane,
    state: TerminalAttachmentState,
    instance: TerminalRenderer,
    requestedOffset: number,
  ): void {
    setTerminalStatus(pane.id, state.status);
    if (state.error) setTerminalError(pane.id, state.error);
    else clearTerminalError(pane.id);
    let offset = renderedOffsets.get(pane.id) ?? requestedOffset;
    if (state.firstAvailableOffset > offset) {
      instance.write("\r\n[Earlier terminal output was discarded]\r\n");
      offset = state.firstAvailableOffset;
    }
    for (const chunk of state.chunks) offset = writeFrame(instance, pane.id, chunk.data, chunk.offset, offset);
    offset = Math.max(offset, state.totalBytesProduced);
    renderedOffsets = new Map(renderedOffsets).set(pane.id, offset);
    if (!createdTabs.has(pane.tabId ?? "") && requestedOffset === 0 && state.firstAvailableOffset === 0) {
      relaunchedPanes = new Set(relaunchedPanes).add(pane.id);
    }
  }

  function writeFrame(
    instance: TerminalRenderer,
    paneId: string,
    data: string,
    frameOffset: number,
    expectedOffset = renderedOffsets.get(paneId) ?? 0,
  ): number {
    const bytes = new TextEncoder().encode(data);
    const end = frameOffset + bytes.byteLength;
    if (end <= expectedOffset) return expectedOffset;
    const delta = Math.max(0, expectedOffset - frameOffset);
    const visible = new TextDecoder().decode(bytes.slice(delta));
    if (visible) instance.write(visible);
    const next = Math.max(expectedOffset, end);
    renderedOffsets = new Map(renderedOffsets).set(paneId, next);
    return next;
  }

  function handleWorkspaceEvent(event: WorkspaceEvent): void {
    if (event.type !== "terminal-data" && event.type !== "terminal-exit" && event.type !== "terminal-error") return;
    const pane = selectedPane;
    if (!pane || event.paneId !== pane.id) return;
    if (event.type === "terminal-data") {
      if (renderer) writeFrame(renderer, pane.id, event.data, event.offset);
    } else if (event.type === "terminal-exit") {
      setTerminalStatus(pane.id, "exited");
    } else if (event.type === "terminal-error") {
      setTerminalStatus(pane.id, "failed");
      setTerminalError(pane.id, event.message);
    }
  }

  function setTerminalStatus(id: string, status: "starting" | "running" | "exited" | "failed"): void {
    terminalStatuses = new Map(terminalStatuses).set(id, status);
  }

  function setTerminalError(id: string, error: unknown): void {
    terminalErrors = new Map(terminalErrors).set(id, error instanceof Error ? error.message : String(error));
  }

  function clearTerminalError(id: string): void {
    const next = new Map(terminalErrors);
    next.delete(id);
    terminalErrors = next;
  }

  async function selectTerminal(tab: WorkspaceTab, focus = true): Promise<void> {
    if (selectedTabId === tab.id && renderer) {
      if (focus) renderer.focus();
      return;
    }
    selectedTabId = tab.id;
    focusTabAfterActivationId = focus ? tab.id : "";
    disposeRenderer();
    await tick();
    if (focus) document.getElementById(`terminal-tab-${tab.id}`)?.focus({ preventScroll: true });
  }

  function startRename(): void {
    if (!selectedTab) return;
    renameTabId = selectedTab.id;
    renameValue = selectedTab.title;
    void tick().then(() => {
      renameInput?.focus({ preventScroll: true });
      renameInput?.select();
    });
  }

  async function commitRename(): Promise<void> {
    const tabId = renameTabId;
    const name = renameValue.trim();
    if (!tabId || !name) {
      renameTabId = "";
      return;
    }
    try {
      await window.gradivus.updateTab(tabId, { name });
      renameTabId = "";
    } catch (error) {
      setTerminalError(selectedPane?.id ?? tabId, error);
    }
  }

  function requestClose(tab: WorkspaceTab, event?: Event): void {
    const pane = tab.panes[0];
    if (!pane) return;
    const status = terminalStatuses.get(pane.id) ?? pane.status;
    if (confirmClose && (status === "running" || status === "starting" || status === "ready")) {
      closeReturnFocus = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
      void tick().then(() => keepTerminalButton?.focus({ preventScroll: true }));
      closeCandidate = { tab, pane };
      return;
    }
    void closeTerminalTab(tab, pane);
  }

  function keepTerminal(): void {
    closeCandidate = undefined;
    void tick().then(() => closeReturnFocus?.focus({ preventScroll: true }));
  }

  async function confirmTerminalClose(): Promise<void> {
    const candidate = closeCandidate;
    closeCandidate = undefined;
    if (candidate) await closeTerminalTab(candidate.tab, candidate.pane);
  }

  async function closeTerminalTab(tab: WorkspaceTab, pane: WorkspacePane): Promise<void> {
    const index = terminalTabs.findIndex(candidate => candidate.id === tab.id);
    const nextTab = terminalTabs[index + 1] ?? terminalTabs[index - 1];
    try {
      await window.gradivus.closeTerminal(pane.id);
      renderedOffsets.delete(pane.id);
      renderedOffsets = new Map(renderedOffsets);
      terminalStatuses.delete(pane.id);
      terminalStatuses = new Map(terminalStatuses);
      terminalErrors.delete(pane.id);
      focusTabAfterActivationId = nextTab?.id ?? "";
      terminalErrors = new Map(terminalErrors);
      selectedTabId = nextTab?.id ?? "";
      activatedPaneId = "";
      disposeRenderer();
      await tick();
      if (nextTab) document.getElementById(`terminal-tab-${nextTab.id}`)?.focus({ preventScroll: true });
      else document.getElementById("terminal-new")?.focus({ preventScroll: true });
    } catch (error) {
      setTerminalError(pane.id, error);
    }
  }

  async function restartSelected(): Promise<void> {
    focusTabAfterActivationId = "";
    const pane = selectedPane;
    if (!pane) return;
    try {
      const state = await window.gradivus.restartTerminal(pane.id);
      disposeRenderer();
      renderedOffsets.delete(pane.id);
      renderedOffsets = new Map(renderedOffsets);
      clearTerminalError(pane.id);
      await tick();
      const token = ++activationToken;
      const instance = await mountRenderer(pane, token);
      if (!instance) return;
      applyAttachmentState(pane, state, instance, 0);
      activatedPaneId = pane.id;
      await instance.fit();
      instance.focus();
    } catch (error) {
      setTerminalStatus(pane.id, "failed");
      setTerminalError(pane.id, error);
    }
  }

  function handleTabKeydown(event: KeyboardEvent, tab: WorkspaceTab): void {
    const index = terminalTabs.findIndex(candidate => candidate.id === tab.id);
    let target: WorkspaceTab | undefined;
    if (event.key === "ArrowRight" || (event.ctrlKey && event.key === "PageDown")) {
      target = terminalTabs[(index + 1) % terminalTabs.length];
    } else if (event.key === "ArrowLeft" || (event.ctrlKey && event.key === "PageUp")) {
      target = terminalTabs[(index - 1 + terminalTabs.length) % terminalTabs.length];
    } else if (event.key === "Home") {
      target = terminalTabs[0];
    } else if (event.key === "End") {
      target = terminalTabs.at(-1);
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestClose(tab, event);
      return;
    } else {
      return;
    }
    event.preventDefault();
    if (target) void selectTerminal(target);
  }

  onMount(() => {
    removeWorkspaceEvent = window.gradivus.onWorkspaceEvent(handleWorkspaceEvent);
    return () => {
      removeWorkspaceEvent?.();
      disposeRenderer();
    };
  });
</script>

<section class="chat-terminal" aria-label="Workspace terminal tabs">
  <div id="chat-terminal-drawer" class="chat-terminal-drawer" hidden={!open}>
    <header class="terminal-tabs-bar">
      <div class="terminal-tablist" role="tablist" aria-label="Workspace terminals">
        {#each terminalTabs as tab (tab.id)}
          <button
            id={`terminal-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selectedTabId === tab.id}
            aria-controls="terminal-active-panel"
            tabindex={selectedTabId === tab.id ? 0 : -1}
            class:active={selectedTabId === tab.id}
            onkeydown={(event) => handleTabKeydown(event, tab)}
            onclick={() => void selectTerminal(tab, false)}
          >{tab.title}</button>
        {/each}
      </div>
      <div class="terminal-tab-actions">
        <button id="terminal-new" type="button" class="secondary-button compact" disabled={creating || !workspaceId} onclick={() => void createNewTerminal()}>{creating ? "Creating…" : "New terminal"}</button>
        <button type="button" class="secondary-button compact" disabled={!selectedTab} onclick={startRename}>Rename</button>
        <button type="button" class="secondary-button compact" disabled={!selectedPane} onclick={() => void restartSelected()}>Restart</button>
        <button type="button" class="secondary-button compact" disabled={!selectedTab} onclick={(event) => selectedTab && requestClose(selectedTab, event)}>Close</button>
      </div>
    </header>

    {#if renameTabId}
      <form class="terminal-rename" aria-label="Rename terminal" onsubmit={(event) => { event.preventDefault(); void commitRename(); }}>
        <label for="terminal-rename-input">Terminal name</label>
        <input id="terminal-rename-input" bind:this={renameInput} bind:value={renameValue} maxlength="160" onblur={() => void commitRename()} onkeydown={(event) => { if (event.key === "Escape") { event.preventDefault(); renameTabId = ""; } }} />
      </form>
    {/if}

    {#if terminalTabs.length === 0}
      <div class="terminal-empty" role="status">
        <strong>No terminal tabs</strong>
        <span>Create a durable shell for this workspace.</span>
      </div>
    {:else}
      <div
        id="terminal-active-panel"
        role="tabpanel"
        aria-labelledby={selectedTab ? `terminal-tab-${selectedTab.id}` : undefined}
        class="chat-terminal-shell"
        data-rendered-offset={selectedPane ? (renderedOffsets.get(selectedPane.id) ?? 0) : 0}
        data-terminal-renderer={selectedKind}
      >
        <div bind:this={terminalElement} class="chat-terminal-canvas" role="region" aria-label="Shell terminal"></div>
        {#if selectedPane && relaunchedPanes.has(selectedPane.id)}<p class="terminal-relaunch-note" role="status">Shell restarted after app relaunch. Earlier process state and scrollback were unavailable.</p>{/if}
        {#if selectedPane && terminalErrors.get(selectedPane.id)}<p class="chat-terminal-error" role="alert">{terminalErrors.get(selectedPane.id)}</p>{/if}
        {#if selectedPane && (terminalStatuses.get(selectedPane.id) === "failed" || terminalStatuses.get(selectedPane.id) === "exited")}<button type="button" class="chat-terminal-restart" onclick={() => void restartSelected()}>Restart shell</button>{/if}
      </div>
    {/if}
  </div>
</section>

{#if closeCandidate}
  <ModalShell backdrop dialogClass="terminal-close-dialog" labelledbyId="terminal-close-title" cancelable onclose={keepTerminal}>
    <h2 id="terminal-close-title">Close {closeCandidate.tab.title}?</h2>
    <p>The running shell and its durable terminal tab will close. Process state and buffered output cannot be recovered.</p>
    <div class="dialog-actions">
      <button bind:this={keepTerminalButton} type="button" class="primary-button" onclick={keepTerminal}>Keep terminal</button>
      <button type="button" class="danger-button" onclick={() => void confirmTerminalClose()}>Close terminal</button>
    </div>
  </ModalShell>
{/if}

<style>
  .chat-terminal { width: 100%; }
  .chat-terminal-drawer { display: flex; flex-direction: column; height: min(38vh, 380px); min-height: 200px; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-medium); background: var(--terminal-background); box-shadow: 0 12px 30px var(--terminal-shadow); }
  .chat-terminal-drawer[hidden] { display: none; }
  .terminal-tabs-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 38px; padding: 4px; border-bottom: 1px solid var(--line); background: var(--shell-raised); }
  .terminal-tablist { display: flex; align-items: center; min-width: 0; overflow-x: auto; }
  .terminal-tablist button { flex: none; min-height: 28px; max-width: 180px; overflow: hidden; border: 1px solid transparent; border-radius: var(--radius-small); padding: 4px 9px; color: var(--foreground-muted); background: transparent; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-tablist button.active { border-color: var(--accent-boundary); color: var(--foreground); background: var(--selection-surface); }
  .terminal-tablist button:focus-visible, .terminal-tab-actions button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .terminal-tab-actions { display: flex; align-items: center; gap: 4px; flex: none; }
  .terminal-tab-actions :global(button) { min-width: 24px; min-height: 28px; }
  .terminal-rename { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--line-soft); }
  .terminal-rename label { color: var(--foreground-muted); font-size: 12px; }
  .terminal-rename input { min-width: 160px; height: 30px; border: 1px solid var(--line); border-radius: var(--radius-small); padding: 0 8px; color: var(--foreground); background: var(--shell); }
  .chat-terminal-shell { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
  .chat-terminal-canvas { width: 100%; min-height: 0; flex: 1; overflow: hidden; background: var(--terminal-background); font-family: var(--font-mono); }
  .terminal-empty { display: grid; place-content: center; gap: 4px; flex: 1; text-align: center; color: var(--foreground-muted); }
  .chat-terminal-error, .terminal-relaunch-note { margin: 0; border-top: 1px solid var(--line); padding: 6px 8px; color: var(--foreground); background: var(--danger-surface); font-size: 12px; }
  .terminal-relaunch-note { background: var(--warning-surface); }
  .chat-terminal-restart { align-self: flex-start; min-height: 28px; margin: 6px 8px; border: 1px solid var(--line); border-radius: var(--radius-small); padding: 5px 9px; background: transparent; color: var(--terminal-foreground); cursor: pointer; }
  .chat-terminal-restart:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  @media (max-width: 760px) { .chat-terminal-drawer { height: 44vh; } .terminal-tabs-bar { align-items: stretch; flex-direction: column; } .terminal-tab-actions { display: grid; grid-template-columns: repeat(4, 1fr); } }
</style>

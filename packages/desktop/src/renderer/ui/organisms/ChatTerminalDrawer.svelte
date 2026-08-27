<script lang="ts">
  import { Ghostty, Terminal } from "ghostty-web";
  import ghosttyWasmUrl from "ghostty-web/ghostty-vt.wasm?url";
  import { onMount, tick } from "svelte";
  import type { GradivusSettings, WorkspaceEvent } from "../../../shared/contracts";
  import { DESKTOP_THEME_PALETTES, type ResolvedTheme } from "../../../shared/theme-palette";

  const NATIVE_MONO_FONT =
    'ui-monospace, "SFMono-Regular", Menlo, Monaco, "Cascadia Mono", Consolas, "Liberation Mono", monospace';

  export let sessionId: string;
  export let open = false;
  export let theme: ResolvedTheme = "dark";
  export let terminalSettings: GradivusSettings["terminal"] | undefined = undefined;

  let shellId = "";
  let presentationId = "";
  let shellStatus: "starting" | "running" | "exited" | "failed" = "starting";
  let shellError = "";
  let replayOffset = 0;
  let renderedOffset = 0;
  let pendingOutput: Array<{ data: string; offset: number }> = [];
  let terminal: Terminal | undefined;
  let terminalElement: HTMLDivElement | undefined;
  let ghostty: Ghostty | undefined;
  let removeWorkspaceEvent: (() => void) | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let activationPromise: Promise<void> | undefined;
  let writeQueue: Promise<void> = Promise.resolve();

  $: if (open) {
    void activateTerminal();
  }

  $: if (terminal) {
    terminal.options.theme = DESKTOP_THEME_PALETTES[theme].terminal;
    terminal.options.fontSize = terminalSettings?.fontSize ?? 14;
    terminal.options.fontFamily = terminalSettings?.fontFamily ?? NATIVE_MONO_FONT;
    terminal.options.cursorBlink = terminalSettings?.cursorBlink ?? true;
    terminal.options.cursorStyle = terminalSettings?.cursorStyle ?? "block";
    terminal.options.scrollback = terminalSettings?.scrollback ?? 10_000;
    void fitTerminal();
  }

  function dimensions(): { cols: number; rows: number } {
    const width = terminalElement?.clientWidth ?? 720;
    const height = terminalElement?.clientHeight ?? 280;
    return {
      cols: Math.max(2, Math.min(500, Math.floor(width / 8))),
      rows: Math.max(2, Math.min(500, Math.floor(height / 18))),
    };
  }

  async function fitTerminal(): Promise<void> {
    if (!open || !shellId || !terminalElement || !terminal) return;
    if (terminalElement.clientWidth <= 0 || terminalElement.clientHeight <= 0) return;
    const next = dimensions();
    terminal.resize(next.cols, next.rows);
    await window.gradivus.resizeTerminal(shellId, next.cols, next.rows).catch(() => {});
  }

  async function mountTerminal(): Promise<void> {
    if (!terminalElement || terminal || !shellId) return;
    ghostty ??= await Ghostty.load(ghosttyWasmUrl);
    const instance = new Terminal({
      fontSize: terminalSettings?.fontSize ?? 14,
      fontFamily: terminalSettings?.fontFamily ?? NATIVE_MONO_FONT,
      cursorBlink: terminalSettings?.cursorBlink ?? true,
      cursorStyle: terminalSettings?.cursorStyle ?? "block",
      scrollback: terminalSettings?.scrollback ?? 10_000,
      theme: DESKTOP_THEME_PALETTES[theme].terminal,
      ghostty,
    });
    instance.open(terminalElement);
    terminal = instance;
    for (const frame of pendingOutput) {
      instance.write(frame.data);
      renderedOffset = Math.max(renderedOffset, frame.offset + new TextEncoder().encode(frame.data).byteLength);
    }
    pendingOutput = [];
    instance.onData(data => {
      writeQueue = writeQueue.then(() => window.gradivus.writeTerminal(shellId, data)).catch(error => {
        shellError = error instanceof Error ? error.message : String(error);
      });
    });
    resizeObserver = new ResizeObserver(() => {
      if (!open) return;
      void fitTerminal();
    });
    resizeObserver.observe(terminalElement);
  }

  async function closeKnownPresentation(): Promise<void> {
    const knownId = shellId || presentationId;
    if (!knownId) return;
    await window.gradivus.closeTerminal(knownId).catch(() => {});
    if (shellId === knownId) shellId = "";
    if (presentationId === knownId) presentationId = "";
  }

  async function openChatTerminal(): Promise<void> {
    if (shellId) return;
    presentationId = `chat-term-${crypto.randomUUID()}`;
    shellError = "";
    shellStatus = "starting";
    const { cols, rows } = dimensions();
    try {
      const state = await window.gradivus.openChatTerminal({
        id: presentationId,
        sessionId,
        cols,
        rows,
        fromOffset: replayOffset,
      });
      shellId = state.id;
      shellStatus = state.status;
      replayOffset = Math.max(replayOffset, state.offset);
      if (state.error) shellError = state.error;
    } catch (error) {
      shellStatus = "failed";
      shellError = error instanceof Error ? error.message : String(error);
      await closeKnownPresentation();
    }
  }

  async function activateTerminal(): Promise<void> {
    if (activationPromise) return activationPromise;
    const run = (async () => {
      await tick();
      if (!open || !terminalElement) return;
      if (!shellId) await openChatTerminal();
      if (!shellId) return;
      await tick();
      if (!terminal) await mountTerminal();
      if (!terminal) return;
      await fitTerminal();
      terminal.focus();
    })();
    activationPromise = run.catch(async error => {
      shellStatus = "failed";
      shellError = error instanceof Error ? error.message : String(error);
      await closeKnownPresentation();
    });
    try {
      await activationPromise;
    } finally {
      activationPromise = undefined;
    }
  }

  function handleWorkspaceEvent(event: WorkspaceEvent): void {
    const activeId = shellId || presentationId;
    if (!activeId) return;
    if (event.type === "terminal-data") {
      if (event.paneId !== activeId) return;
      if (event.offset < replayOffset) return;
      const nextOffset = event.offset + new TextEncoder().encode(event.data).byteLength;
      replayOffset = Math.max(replayOffset, nextOffset);
      if (terminal) {
        terminal.write(event.data);
        renderedOffset = Math.max(renderedOffset, nextOffset);
      } else {
        pendingOutput = [...pendingOutput, { data: event.data, offset: event.offset }];
      }
    } else if (event.type === "terminal-exit") {
      if (event.paneId !== activeId) return;
      shellStatus = "exited";
    } else if (event.type === "terminal-error") {
      if (event.paneId !== activeId) return;
      shellStatus = "failed";
      shellError = event.message;
    }
  }

  async function restartShell(): Promise<void> {
    await terminateShell(true);
    await activateTerminal();
  }

  async function terminateShell(close = true): Promise<void> {
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    terminal?.dispose();
    terminal = undefined;
    pendingOutput = [];
    renderedOffset = 0;
    const knownId = shellId || presentationId;
    if (knownId && close) await window.gradivus.closeTerminal(knownId).catch(() => {});
    shellId = "";
    if (close && presentationId === knownId) presentationId = "";
    shellStatus = "exited";
    if (close) replayOffset = 0;
  }

  onMount(() => {
    removeWorkspaceEvent = window.gradivus.onWorkspaceEvent(handleWorkspaceEvent);
    return () => {
      removeWorkspaceEvent?.();
      resizeObserver?.disconnect();
      terminal?.dispose();
      void closeKnownPresentation();
    };
  });
</script>

<section class="chat-terminal" aria-label="Local chat terminal">
  <div id="chat-terminal-drawer" class="chat-terminal-drawer" hidden={!open}>
    <div class="chat-terminal-shell" data-rendered-offset={renderedOffset}>
      <div bind:this={terminalElement} class="chat-terminal-canvas" role="region" aria-label="Shell terminal"></div>
      {#if shellError}<p class="chat-terminal-error" role="alert">{shellError}</p>{/if}
      {#if shellStatus === "failed" || shellStatus === "exited"}
        <button type="button" class="chat-terminal-restart" onclick={() => void restartShell()}>Restart shell</button>
      {/if}
    </div>
  </div>
</section>

<style>
  .chat-terminal {
    width: 100%;
  }

  .chat-terminal-drawer {
    display: flex;
    flex-direction: column;
    height: min(35vh, 340px);
    min-height: 180px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--terminal-background);
    box-shadow: 0 12px 30px var(--terminal-shadow);
  }
  .chat-terminal-drawer[hidden] {
    display: none;
  }

  .chat-terminal-canvas {
    width: 100%;
    min-height: 0;
    flex: 1;
    overflow: hidden;
    background: var(--terminal-background);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Monaco, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
  }

  .chat-terminal-error {
    margin: 7px 0 0;
    border: 1px solid var(--danger-boundary);
    border-radius: 4px;
    padding: 6px 8px;
    color: var(--foreground);
    background: var(--danger-surface);
  }
  .chat-terminal-restart {
    align-self: flex-start;
    margin-top: 8px;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 5px 9px;
    background: transparent;
    color: var(--terminal-foreground);
    cursor: pointer;
  }

  .chat-terminal-restart:focus-visible {
    outline: 2px solid var(--focus-inner);
    outline-offset: 0;
    box-shadow: 0 0 0 4px var(--focus-outer);
  }

  @media (max-width: 700px) {
    .chat-terminal-drawer {
      height: 42vh;
    }
  }
</style>

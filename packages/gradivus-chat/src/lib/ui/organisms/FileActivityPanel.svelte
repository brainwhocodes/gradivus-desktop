<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { formatBytes, formatDuration } from "@oh-my-pi/pi-utils/format";
  import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
  import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
  import Folder from "@solar-icons/svelte/linear/folder";
  import type { HostedWorkspaceFilePreview, HostedTimelineFileChange as TimelineFileChange } from "../../contracts";
  import {
    buildChangedFileTree,
    collectChangedFileDirectoryIds,
    collectChangedFileLeaves,
    fileDispositionLabel,
    flattenChangedFileTree,
    type ChangedFileTreeLeaf,
    type ChangedFileTreeRow,
  } from "../../changed-file-tree";
  import { workspaceFileKind, isTextWorkspaceFile, type WorkspaceFileKind } from "../../workspace-file-types";
  import WorkspaceFileIcon from "../atoms/WorkspaceFileIcon.svelte";

  export let files: TimelineFileChange[] = [];
  export let selectedPath = "";
  export let loading = false;
  export let error: string | undefined = undefined;
  export let onRetry: (() => void) | undefined = undefined;
  export let onOpenFile: (path: string) => void;
  export let onOpenDiff: (path: string) => void;
  export let loadPreview: (path: string, maxDimension: number) => Promise<HostedWorkspaceFilePreview>;

  type PreviewState =
    | { status: "idle" | "loading" }
    | { status: "ready"; preview: HostedWorkspaceFilePreview }
    | { status: "error"; message: string };
  type FileFilter = WorkspaceFileKind | "all";
  const FILTERS: { kind: FileFilter; label: string }[] = [
    { kind: "all", label: "All" }, { kind: "image", label: "Images" },
    { kind: "video", label: "Video" }, { kind: "audio", label: "Audio" },
    { kind: "document", label: "Docs" }, { kind: "code", label: "Code" },
    { kind: "other", label: "Other" },
  ];
  const IDLE_PREVIEW: PreviewState = { status: "idle" };
  const THUMBNAIL_MAX_DIMENSION = 160;
  const HERO_MAX_DIMENSION = 1_600;
  let filter: FileFilter = "all";
  let query = "";
  let expandedDirectoryIds = new Set<string>();
  let knownDirectorySignature = "";
  let selectedFileId = "";
  let appliedSelectedPath = "";
  let activeNodeId = "";
  let detailOpen = false;
  let treeElement: HTMLDivElement | undefined;
  let backButton: HTMLButtonElement | undefined;
  let thumbnailRail: HTMLDivElement | undefined;
  let thumbnailPreviews = new Map<string, PreviewState>();
  let knownFiles = new Map<string, TimelineFileChange>();
  let previewSource: TimelineFileChange | undefined;
  let previewState: PreviewState = IDLE_PREVIEW;
  let previewRequest = 0;
  let cacheGeneration = 0;
  let mediaError = "";
  let mediaDuration = "";
  let destroyed = false;

  $: allLeaves = collectChangedFileLeaves(buildChangedFileTree(files));
  $: filterCounts = new Map(FILTERS.map(item => [item.kind, item.kind === "all" ? allLeaves.length : allLeaves.filter(leaf => workspaceFileKind(leaf.path) === item.kind).length]));
  $: filteredFiles = allLeaves.filter(leaf => (filter === "all" || workspaceFileKind(leaf.path) === filter) && leaf.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(leaf => leaf.file);
  $: tree = buildChangedFileTree(filteredFiles);
  $: directories = collectChangedFileDirectoryIds(tree);
  $: reconcileDirectories(directories);
  $: visibleRows = flattenChangedFileTree(tree, expandedDirectoryIds);
  $: reconcileActiveNode(visibleRows);
  $: leaves = collectChangedFileLeaves(tree);
  $: reconcileSelection(leaves);
  $: reconcileRequestedPath(selectedPath, allLeaves);
  $: selectedLeaf = leaves.find(leaf => leaf.id === selectedFileId);
  $: imageLeaves = leaves.filter(leaf => workspaceFileKind(leaf.path) === "image");
  $: reconcilePreviews(allLeaves);
  $: synchronizePreview(detailOpen ? selectedLeaf : undefined);
  $: selectedIndex = leaves.findIndex(leaf => leaf.id === selectedFileId);

  onDestroy(() => { destroyed = true; previewRequest += 1; });

  function reconcileDirectories(ids: readonly string[]): void {
    const signature = ids.join("\u0000");
    if (signature === knownDirectorySignature) return;
    const previous = new Set(knownDirectorySignature ? knownDirectorySignature.split("\u0000") : []);
    const valid = new Set(ids);
    expandedDirectoryIds = new Set([...expandedDirectoryIds].filter(id => valid.has(id)));
    for (const id of ids) if (!previous.has(id)) expandedDirectoryIds.add(id);
    knownDirectorySignature = signature;
  }
  function reconcileActiveNode(rows: readonly ChangedFileTreeRow[]): void {
    if (!rows.some(row => row.node.id === activeNodeId)) activeNodeId = rows[0]?.node.id ?? "";
  }
  function reconcileSelection(nextLeaves: readonly ChangedFileTreeLeaf[]): void {
    if (nextLeaves.some(leaf => leaf.id === selectedFileId)) return;
    selectedFileId = nextLeaves[0]?.id ?? "";
    activeNodeId = selectedFileId || visibleRows[0]?.node.id || "";
    detailOpen = false;
  }
  function reconcileRequestedPath(path: string, nextLeaves: readonly ChangedFileTreeLeaf[]): void {
    const normalized = path.replaceAll("\\", "/");
    if (!normalized || normalized === appliedSelectedPath) return;
    const leaf = nextLeaves.find(candidate => candidate.path === normalized);
    if (!leaf) return;
    appliedSelectedPath = normalized;
    filter = "all";
    query = "";
    void selectLeaf(leaf);
  }
  function reconcilePreviews(nextLeaves: readonly ChangedFileTreeLeaf[]): void {
    const next = new Map(nextLeaves.map(leaf => [leaf.file.path, leaf.file]));
    let changed = next.size !== knownFiles.size;
    const thumbnails = new Map(thumbnailPreviews);
    for (const [path, source] of knownFiles) {
      if (next.get(path) !== source) { thumbnails.delete(path); changed = true; }
    }
    for (const [path, source] of next) if (knownFiles.get(path) !== source) changed = true;
    if (!changed) return;
    knownFiles = next;
    thumbnailPreviews = thumbnails;
    cacheGeneration += 1;
  }
  function synchronizePreview(leaf: ChangedFileTreeLeaf | undefined): void {
    if (previewSource === leaf?.file) return;
    previewSource = leaf?.file;
    previewRequest += 1;
    previewState = IDLE_PREVIEW;
    mediaError = "";
    mediaDuration = "";
    if (leaf) void ensurePreview(leaf);
  }
  function toggleDirectory(id: string, force?: boolean): void {
    const expanded = new Set(expandedDirectoryIds);
    if (force ?? !expanded.has(id)) expanded.add(id); else expanded.delete(id);
    expandedDirectoryIds = expanded;
  }
  async function focusTreeNode(id: string): Promise<void> {
    activeNodeId = id;
    await tick();
    for (const item of treeElement?.querySelectorAll<HTMLElement>("[role='treeitem']") ?? []) {
      if (item.dataset.treeNodeId === id) { item.focus(); break; }
    }
  }
  async function handleTreeKeydown(event: KeyboardEvent, row: ChangedFileTreeRow, index: number): Promise<void> {
    const node = row.node;
    let target: string | undefined;
    if (event.key === "ArrowDown") target = visibleRows[Math.min(index + 1, visibleRows.length - 1)]?.node.id;
    else if (event.key === "ArrowUp") target = visibleRows[Math.max(index - 1, 0)]?.node.id;
    else if (event.key === "Home" || event.key === "End") target = (event.key === "Home" ? visibleRows[0] : visibleRows.at(-1))?.node.id;
    else if (event.key === "ArrowRight" && node.kind === "directory") {
      if (!expandedDirectoryIds.has(node.id)) toggleDirectory(node.id, true);
      else target = visibleRows.find(candidate => candidate.parentId === node.id)?.node.id;
    } else if (event.key === "ArrowLeft") {
      if (node.kind === "directory" && expandedDirectoryIds.has(node.id)) toggleDirectory(node.id, false);
      else target = row.parentId;
    } else if (event.key === "Enter" || event.key === " ") {
      if (node.kind === "directory") toggleDirectory(node.id); else await selectLeaf(node);
    } else return;
    event.preventDefault();
    if (target) await focusTreeNode(target);
  }
  async function selectLeaf(leaf: ChangedFileTreeLeaf, focus = true): Promise<void> {
    const opening = !detailOpen;
    selectedFileId = leaf.id;
    activeNodeId = leaf.id;
    detailOpen = true;
    if (focus && opening) { await tick(); backButton?.focus(); }
  }
  async function returnToTree(): Promise<void> {
    detailOpen = false;
    await focusTreeNode(selectedFileId);
  }
  function changeFilter(next: FileFilter): void { detailOpen = false; filter = next; }
  function previewErrorMessage(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : "The file preview could not be loaded.";
    return message.replaceAll("\u0000", "").replace(/\s+/g, " ").trim().slice(0, 240);
  }
  async function ensurePreview(leaf: ChangedFileTreeLeaf): Promise<void> {
    const request = ++previewRequest;
    previewState = { status: "loading" };
    mediaError = "";
    mediaDuration = "";
    try {
      const preview = await loadPreview(leaf.file.path, HERO_MAX_DIMENSION);
      if (!destroyed && request === previewRequest) previewState = { status: "ready", preview };
    } catch (cause) {
      if (!destroyed && request === previewRequest) previewState = { status: "error", message: previewErrorMessage(cause) };
    }
  }
  async function ensureThumbnail(path: string): Promise<void> {
    const state = thumbnailPreviews.get(path);
    if (state?.status === "loading" || state?.status === "ready") return;
    const source = knownFiles.get(path);
    thumbnailPreviews = new Map(thumbnailPreviews).set(path, { status: "loading" });
    try {
      const preview = await loadPreview(path, THUMBNAIL_MAX_DIMENSION);
      if (!destroyed && knownFiles.get(path) === source) thumbnailPreviews = new Map(thumbnailPreviews).set(path, { status: "ready", preview });
    } catch (cause) {
      if (!destroyed && knownFiles.get(path) === source) thumbnailPreviews = new Map(thumbnailPreviews).set(path, { status: "error", message: previewErrorMessage(cause) });
    }
  }
  function lazyThumbnail(node: HTMLElement, path: string): { destroy(): void } {
    if (!("IntersectionObserver" in window)) { void ensureThumbnail(path); return { destroy() {} }; }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void ensureThumbnail(path);
    }, { root: node.closest(".image-thumbnail-rail"), rootMargin: "96px" });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
  async function handleThumbnailKeydown(event: KeyboardEvent, index: number): Promise<void> {
    const nextIndex = event.key === "ArrowRight" ? Math.min(index + 1, imageLeaves.length - 1)
      : event.key === "ArrowLeft" ? Math.max(index - 1, 0)
      : event.key === "Home" ? 0 : event.key === "End" ? imageLeaves.length - 1 : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = imageLeaves[nextIndex];
    if (!next) return;
    await selectLeaf(next, false);
    await tick();
    thumbnailRail?.querySelectorAll<HTMLButtonElement>("button")[nextIndex]?.focus();
  }
  function initializeTextPreview(node: HTMLTextAreaElement): void {
    node.setSelectionRange(0, 0);
  }
  function loadedMedia(event: Event): void {
    const media = event.currentTarget;
    if (media instanceof HTMLMediaElement && Number.isFinite(media.duration)) mediaDuration = formatDuration(media.duration * 1_000);
  }
</script>

<section class="file-activity-panel" aria-labelledby="file-activity-title">
  <header class="panel-header">
    <div class="panel-heading"><h2 id="file-activity-title">Files</h2><span>{allLeaves.length}</span></div>
    <p>Artifacts and changes from this chat</p>
    {#if allLeaves.length > 0}
      <input class="file-search" type="search" aria-label="Filter files by path" placeholder="Find a file…" bind:value={query} oninput={() => { detailOpen = false; }} />
      <div class="file-filters" role="group" aria-label="File types">
        {#each FILTERS.filter(item => item.kind === "all" || (filterCounts.get(item.kind) ?? 0) > 0 || item.kind === filter) as item (item.kind)}
          <button type="button" class:is-active={filter === item.kind} aria-pressed={filter === item.kind} onclick={() => changeFilter(item.kind)}>{item.label}<span>{filterCounts.get(item.kind) ?? 0}</span></button>
        {/each}
      </div>
    {/if}
  </header>
  {#if loading}
    <div class="panel-state" role="status"><strong>Loading files…</strong><p>Collecting successful outputs from this chat.</p></div>
  {:else if error}
    <div class="panel-state" role="alert"><strong>Files are unavailable</strong><p>{error}</p>{#if onRetry}<button type="button" class="panel-button" onclick={onRetry}>Retry</button>{/if}</div>
  {:else if allLeaves.length === 0}
    <div class="panel-state"><strong>No files yet</strong><p>Generated artifacts and files successfully written or edited will appear here.</p></div>
  {:else if leaves.length === 0}
    <div class="panel-state" role="status"><strong>No matching files</strong><p>Try another name or file type.</p><button type="button" class="panel-button" onclick={() => { query = ""; changeFilter("all"); }}>Clear filters</button></div>
  {:else if detailOpen && selectedLeaf}
    <div class="file-detail">
      <div class="detail-navigation">
        <button bind:this={backButton} type="button" class="back-button" onclick={() => void returnToTree()}><AltArrowLeft size={16} aria-hidden="true" />All files</button>
        <div class="step-controls">
          <span>{selectedIndex + 1} / {leaves.length}</span>
          <button type="button" aria-label="Previous file" disabled={selectedIndex <= 0} onclick={() => void selectLeaf(leaves[selectedIndex - 1]!, false)}><AltArrowLeft size={16} aria-hidden="true" /></button>
          <button type="button" aria-label="Next file" disabled={selectedIndex >= leaves.length - 1} onclick={() => void selectLeaf(leaves[selectedIndex + 1]!, false)}><AltArrowRight size={16} aria-hidden="true" /></button>
        </div>
      </div>
      <div class="detail-heading"><WorkspaceFileIcon kind={workspaceFileKind(selectedLeaf.path)} size={20} /><div><h3 title={selectedLeaf.name}>{selectedLeaf.name}</h3><p>{fileDispositionLabel(selectedLeaf.file)} · {workspaceFileKind(selectedLeaf.path)}</p></div></div>
      <div class="preview-area">
        {#if previewState.status === "ready"}
          {@const preview = previewState.preview}
          {#key selectedLeaf.file}
            {#if preview.kind === "image"}
              <figure class="image-preview"><img src={preview.dataUrl} alt={`Preview of ${selectedLeaf.name}`} decoding="async" onerror={() => { mediaError = "This image cannot be displayed here. Open the file in a compatible application."; }} /></figure>
            {:else if preview.kind === "video"}
              <!-- svelte-ignore a11y_media_has_caption (Local artifact preview; captions are not supplied by the source file.) -->
              <video controls playsinline preload="metadata" src={preview.dataUrl} aria-label={`Preview of ${selectedLeaf.name}`} onloadedmetadata={loadedMedia} onerror={() => { mediaError = "This video format cannot be played here. Open the file in a compatible application."; }}></video>
            {:else if preview.kind === "audio"}
              <div class="audio-preview"><WorkspaceFileIcon kind="audio" size={44} /><strong>{selectedLeaf.name}</strong><audio controls preload="metadata" src={preview.dataUrl} aria-label={`Preview of ${selectedLeaf.name}`} onloadedmetadata={loadedMedia} onerror={() => { mediaError = "This audio format cannot be played here. Open the file in a compatible application."; }}></audio></div>
            {:else if preview.kind === "text"}
              <textarea class="text-preview" use:initializeTextPreview readonly wrap="off" spellcheck="false" aria-label={`Contents of ${selectedLeaf.name}`} value={preview.text}></textarea>
              {#if preview.truncated}<p class="preview-note">Preview truncated. Open the file to read the rest.</p>{/if}
            {:else if preview.kind === "unavailable"}
              <div class="preview-state"><WorkspaceFileIcon kind={workspaceFileKind(selectedLeaf.path)} size={32} /><strong>Preview unavailable</strong><p>{preview.message}</p></div>
            {/if}
          {/key}
          {#if mediaError}<p class="preview-note" role="alert">{mediaError}</p>{/if}
          <div class="preview-metadata">
            {#if preview.byteSize !== undefined}<span>{formatBytes(preview.byteSize)}</span>{/if}
            {#if preview.kind === "image"}<span>Preview {preview.width} × {preview.height}</span>{/if}
            {#if mediaDuration}<span>{mediaDuration}</span>{/if}
            {#if preview.mimeType}<span>{preview.mimeType}</span>{/if}
          </div>
        {:else if previewState.status === "error"}
          <div class="preview-state" role="alert"><strong>Preview unavailable</strong><p>{previewState.message}</p><button type="button" class="panel-button" onclick={() => void ensurePreview(selectedLeaf!)}>Retry preview</button></div>
        {:else}
          <div class="preview-state" role="status"><strong>Loading preview…</strong></div>
        {/if}
      </div>
      {#if workspaceFileKind(selectedLeaf.path) === "image" && imageLeaves.length > 1}
        <div class="image-thumbnail-rail" bind:this={thumbnailRail} role="group" aria-label="Images">
          {#each imageLeaves as image, index (`${image.id}:${cacheGeneration}`)}
            {@const thumbnail = thumbnailPreviews.get(image.file.path) ?? IDLE_PREVIEW}
            <button type="button" class="image-thumbnail" class:is-selected={image.id === selectedLeaf.id} aria-label={`Show ${image.name}`} aria-pressed={image.id === selectedLeaf.id} tabindex={image.id === selectedLeaf.id ? 0 : -1} title={image.file.path} use:lazyThumbnail={image.file.path} onclick={() => void selectLeaf(image, false)} onkeydown={event => void handleThumbnailKeydown(event, index)}>
              {#if thumbnail.status === "ready" && thumbnail.preview.kind === "image"}<img src={thumbnail.preview.dataUrl} alt="" loading="lazy" decoding="async" />{:else}<WorkspaceFileIcon kind="image" />{/if}
            </button>
          {/each}
        </div>
      {/if}
      <footer class="selection-footer"><p class="selection-path" title={selectedLeaf.file.path}>{selectedLeaf.file.path}</p><div class="selection-actions">
        {#if isTextWorkspaceFile(selectedLeaf.path) && selectedLeaf.file.operation !== "generate"}<button type="button" class="panel-button" onclick={() => onOpenDiff(selectedLeaf.file.path)}>Review diff</button>{/if}
        <button type="button" class="panel-button" onclick={() => onOpenFile(selectedLeaf.file.path)}>Open file</button>
      </div></footer>
    </div>
  {:else}
    <div class="tree-scroll"><div bind:this={treeElement} class="changed-file-tree" role="tree" aria-label="Files and artifacts">
      {#each visibleRows as row, index (row.node.id)}
        <button type="button" role="treeitem" class="tree-row" class:is-selected={row.node.kind === "file" && row.node.id === selectedFileId} aria-level={row.depth} aria-expanded={row.node.kind === "directory" ? expandedDirectoryIds.has(row.node.id) : undefined} aria-selected={row.node.kind === "file" ? row.node.id === selectedFileId : undefined} tabindex={row.node.id === activeNodeId || (!activeNodeId && index === 0) ? 0 : -1} title={row.node.kind === "file" ? row.node.file.path : row.node.path} data-tree-node-id={row.node.id} style={`--tree-indent: ${(row.depth - 1) * 14}px`} onfocus={() => { activeNodeId = row.node.id; }} onclick={() => row.node.kind === "directory" ? toggleDirectory(row.node.id) : void selectLeaf(row.node)} onkeydown={event => void handleTreeKeydown(event, row, index)}>
          {#if row.node.kind === "directory"}
            <span class="tree-chevron" class:is-expanded={expandedDirectoryIds.has(row.node.id)}><AltArrowRight size={14} aria-hidden="true" /></span><Folder size={16} aria-hidden="true" /><span class="tree-name">{row.node.name}</span>
          {:else}
            <span class="tree-spacer" aria-hidden="true"></span><WorkspaceFileIcon kind={workspaceFileKind(row.node.path)} /><span class="tree-label"><span class="tree-name">{row.node.name}</span><span class="file-kind">{workspaceFileKind(row.node.path)}</span></span><span class="disposition">{fileDispositionLabel(row.node.file)}</span>
          {/if}
        </button>
      {/each}
    </div></div>
    {#if selectedLeaf}<footer class="selection-footer"><p class="selection-path" title={selectedLeaf.file.path}>{selectedLeaf.file.path}</p><div class="selection-actions"><button type="button" class="panel-button" onclick={() => void selectLeaf(selectedLeaf!)}>Preview</button><button type="button" class="panel-button" onclick={() => onOpenFile(selectedLeaf.file.path)}>Open file</button></div></footer>{/if}
  {/if}
</section>

<style>
  .file-activity-panel { container-type: inline-size; display: flex; width: 100%; height: 100%; min-height: 0; flex-direction: column; color: var(--foreground); background: var(--shell); font: 14px/1.5 var(--font-ui); }
  .panel-header { flex: 0 0 auto; border-bottom: 1px solid var(--line); padding: 16px; }
  .panel-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h2, h3 { margin: 0; color: var(--foreground-strong); font-size: 16px; font-weight: 600; }
  .panel-heading > span, .panel-header > p, .detail-heading p { color: var(--foreground-muted); font-size: 12px; }
  .panel-header > p, .detail-heading p { margin: 3px 0 0; }
  .file-search { box-sizing: border-box; width: 100%; min-height: 36px; margin-top: 14px; border: 1px solid var(--line); border-radius: var(--radius-small); padding: 7px 9px; background: var(--shell-raised); color: var(--foreground); font: inherit; font-size: 13px; }
  .file-search::placeholder { color: var(--foreground-muted); }
  .file-filters { display: flex; gap: 5px; overflow-x: auto; margin-top: 10px; padding: 2px; scrollbar-width: thin; }
  .file-filters button { display: flex; gap: 5px; flex: 0 0 auto; min-height: 32px; border: 1px solid var(--line-soft); border-radius: var(--radius-small); padding: 4px 8px; background: transparent; color: var(--foreground); font: inherit; font-size: 12px; cursor: pointer; }
  .file-filters button span { color: var(--foreground-muted); font-variant-numeric: tabular-nums; }
  .file-filters button.is-active { border-color: var(--accent-boundary); background: var(--selection-surface); color: var(--selection-foreground); }
  .file-filters button.is-active span { color: inherit; }
  .tree-scroll { min-height: 0; flex: 1 1 auto; overflow: auto; padding: 10px; overscroll-behavior: contain; }
  .changed-file-tree { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .tree-row { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 8px; border: 1px solid transparent; border-radius: var(--radius-small); padding: 7px 7px 7px calc(4px + var(--tree-indent)); color: var(--foreground); background: transparent; text-align: start; cursor: pointer; }
  .tree-row:hover, button:hover:not(:disabled) { background: var(--shell-hover); }
  .tree-row.is-selected { color: var(--selection-foreground); background: var(--selection-surface); border-color: var(--accent-boundary); }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--focus-inner); outline-offset: 2px; box-shadow: 0 0 0 4px var(--focus-outer); }
  .tree-chevron, .tree-spacer { display: inline-flex; width: 12px; height: 16px; flex: 0 0 auto; align-items: center; }
  .tree-chevron { transition: transform 100ms ease; }
  .tree-chevron.is-expanded { transform: rotate(90deg); }
  .tree-row :global(svg), .detail-heading :global(svg) { flex-shrink: 0; }
  .tree-label { display: flex; min-width: 0; flex: 1 1 auto; flex-direction: column; }
  .tree-name, h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tree-name { font: 13px/1.4 var(--font-ui); }
  .file-kind, .disposition { color: var(--foreground-muted); font: 11px/1.5 var(--font-ui); }
  .file-kind { text-transform: capitalize; }
  .disposition { flex: 0 0 auto; }
  .tree-row.is-selected :is(.file-kind, .disposition) { color: inherit; }
  .panel-state { display: flex; min-height: 160px; flex: 1 1 auto; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; padding: 24px 16px; color: var(--foreground-muted); }
  .panel-state strong, .preview-state strong { color: var(--foreground); }
  .panel-state p, .preview-state p { margin: 0; overflow-wrap: anywhere; }
  .file-detail { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; }
  .detail-navigation { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; }
  .back-button, .step-controls button { display: inline-flex; min-height: 32px; align-items: center; justify-content: center; gap: 4px; border: 0; border-radius: var(--radius-small); padding: 5px; color: var(--foreground); background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
  .step-controls { display: flex; align-items: center; gap: 4px; }
  .step-controls > span { margin-right: 4px; color: var(--foreground-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .step-controls button { width: 32px; }
  button:disabled { opacity: 0.45; cursor: default; }
  .detail-heading { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 4px 16px 14px; }
  .detail-heading > div { min-width: 0; }
  .detail-heading h3 { font-size: 14px; }
  .detail-heading p { text-transform: capitalize; }
  .preview-area { display: flex; min-height: 0; flex: 1 1 auto; flex-direction: column; overflow: auto; margin: 0 12px; border: 1px solid var(--line-soft); border-radius: var(--radius-small); background: var(--chat-canvas); }
  .image-preview { display: flex; min-height: 160px; flex: 1 1 auto; margin: 0; }
  .image-preview img { width: 100%; min-width: 0; min-height: 0; object-fit: contain; }
  video { width: 100%; max-height: 100%; margin-block: auto; background: #000; }
  .audio-preview { display: flex; min-height: 180px; flex: 1 1 auto; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 16px 10px; }
  .audio-preview strong { max-width: 100%; overflow-wrap: anywhere; text-align: center; font-size: 13px; }
  audio { width: 100%; min-width: 0; }
  .text-preview { width: 100%; min-width: 0; min-height: 150px; flex: 1 1 auto; overflow: auto; margin: 0; border: 0; padding: 12px; color: var(--foreground); background: transparent; resize: none; font: 12px/1.6 var(--font-mono); tab-size: 4; }
  .preview-note { margin: 0; padding: 10px 12px; border-top: 1px solid var(--line-soft); color: var(--foreground-muted); font-size: 12px; overflow-wrap: anywhere; }
  .preview-metadata { display: flex; flex-wrap: wrap; flex: 0 0 auto; gap: 4px 12px; border-top: 1px solid var(--line-soft); padding: 8px 10px; color: var(--foreground-muted); font: 11px/1.5 var(--font-mono); overflow-wrap: anywhere; }
  .preview-state { display: flex; min-height: 180px; flex: 1 1 auto; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 20px; color: var(--foreground-muted); text-align: center; font-size: 13px; }
  .image-thumbnail-rail { display: flex; width: auto; min-width: 0; min-height: 0; flex: 0 0 auto; gap: 8px; overflow-x: auto; padding: 12px 14px; overscroll-behavior: contain; }
  .image-thumbnail { display: flex; width: 64px; height: 48px; flex: 0 0 auto; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-small); padding: 2px; color: var(--foreground-muted); background: var(--shell-raised); cursor: pointer; }
  .image-thumbnail.is-selected { border-color: var(--accent-boundary); box-shadow: 0 0 0 1px var(--accent-boundary); }
  .image-thumbnail img { width: 100%; height: 100%; object-fit: contain; }
  .selection-footer { flex: 0 0 auto; border-top: 1px solid var(--line); padding: 12px 16px; margin-top: 12px; background: var(--shell); }
  .selection-path { margin: 0 0 9px; color: var(--foreground-muted); font: 11px/1.5 var(--font-mono); overflow-wrap: anywhere; }
  .selection-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .panel-button { min-height: 34px; border: 1px solid var(--line); border-radius: var(--radius-small); padding: 6px 10px; color: var(--foreground); background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
  @container (max-width: 300px) { .disposition { display: none; } .tree-row { gap: 5px; } }
  @media (prefers-reduced-motion: reduce) { .tree-chevron { transition: none; } }
  @media (forced-colors: active) { .tree-row.is-selected, .file-filters button.is-active, .image-thumbnail.is-selected { outline: 2px solid Highlight; } }
</style>

<script lang="ts">
  import { tick } from "svelte";
  import AddCircle from "@solar-icons/svelte/linear/add-circle";
  import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
  import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
  import Diskette from "@solar-icons/svelte/linear/diskette";
  import Document from "@solar-icons/svelte/linear/document";
  import Folder from "@solar-icons/svelte/linear/folder";
  import Gallery from "@solar-icons/svelte/linear/gallery";
  import Pen from "@solar-icons/svelte/linear/pen";
  import type { TimelineFileChange, WorkspaceImagePreview } from "../../../shared/contracts";
  import {
    buildChangedFileTree,
    collectChangedFileDirectoryIds,
    collectChangedFileLeaves,
    fileDispositionLabel,
    flattenChangedFileTree,
    isRasterImagePath,
    type ChangedFileTreeLeaf,
    type ChangedFileTreeRow,
  } from "../../changed-file-tree";

  export let files: TimelineFileChange[] = [];
  export let selectedPath = "";
  export let loading = false;
  export let error: string | undefined = undefined;
  export let onRetry: (() => void) | undefined = undefined;
  export let onOpenFile: (path: string) => void;
  export let onOpenDiff: (path: string) => void;
  export let loadImagePreview: (path: string, maxDimension: number) => Promise<WorkspaceImagePreview>;

  type PreviewState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ready"; preview: WorkspaceImagePreview }
    | { status: "error"; message: string };

  const THUMBNAIL_MAX_DIMENSION = 160;
  const HERO_MAX_DIMENSION = 1_600;
  const IDLE_PREVIEW: PreviewState = { status: "idle" };

  let expandedDirectoryIds = new Set<string>();
  let knownDirectorySignature = "";
  let selectedFileId = "";
  let appliedSelectedPath = "";
  let activeNodeId = "";
  let imageDetailOpen = false;
  let treeElement: HTMLElement | undefined;
  let backButton: HTMLButtonElement | undefined;
  let thumbnailRail: HTMLElement | undefined;
  let thumbnailPreviews = new Map<string, PreviewState>();
  let heroPreviews = new Map<string, PreviewState>();
  let knownImageFiles = new Map<string, TimelineFileChange>();
  let imageCacheGeneration = 0;

  $: tree = buildChangedFileTree(files);
  $: directoryIds = collectChangedFileDirectoryIds(tree);
  $: reconcileDirectories(directoryIds);
  $: visibleRows = flattenChangedFileTree(tree, expandedDirectoryIds);
  $: reconcileActiveNode(visibleRows);
  $: leaves = collectChangedFileLeaves(tree);
  $: reconcileSelection(leaves);
  $: reconcileRequestedPath(selectedPath, leaves);
  $: selectedLeaf = leaves.find(leaf => leaf.id === selectedFileId);
  $: imageLeaves = leaves.filter(leaf => isRasterImagePath(leaf.path));
  $: reconcileImagePreviews(imageLeaves);
  $: selectedImageLeaf = imageDetailOpen && selectedLeaf && isRasterImagePath(selectedLeaf.path)
    ? selectedLeaf
    : undefined;
  $: selectedHeroState = selectedImageLeaf
    ? (heroPreviews.get(selectedImageLeaf.file.path) ?? IDLE_PREVIEW)
    : IDLE_PREVIEW;

  function reconcileDirectories(ids: readonly string[]): void {
    const signature = ids.join("\u0000");
    if (signature === knownDirectorySignature) return;
    const previousIds = new Set(knownDirectorySignature ? knownDirectorySignature.split("\u0000") : []);
    const validIds = new Set(ids);
    const nextExpanded = new Set([...expandedDirectoryIds].filter(id => validIds.has(id)));
    for (const id of ids) {
      if (!previousIds.has(id)) nextExpanded.add(id);
    }
    expandedDirectoryIds = nextExpanded;
    knownDirectorySignature = signature;
  }
  function reconcileActiveNode(rows: readonly ChangedFileTreeRow[]): void {
    if (rows.some(row => row.node.id === activeNodeId)) return;
    activeNodeId = rows.find(row => row.node.id === selectedFileId)?.node.id ?? rows[0]?.node.id ?? "";
  }

  function reconcileSelection(nextLeaves: readonly ChangedFileTreeLeaf[]): void {
    if (nextLeaves.some(leaf => leaf.id === selectedFileId)) return;
    selectedFileId = nextLeaves[0]?.id ?? "";
    activeNodeId = selectedFileId || nextLeaves[0]?.id || "";
    imageDetailOpen = false;
  }
  function reconcileRequestedPath(path: string, nextLeaves: readonly ChangedFileTreeLeaf[]): void {
    const normalized = path.replaceAll("\\", "/");
    if (!normalized || normalized === appliedSelectedPath) return;
    const leaf = nextLeaves.find(candidate => candidate.path === normalized);
    if (!leaf) return;
    appliedSelectedPath = normalized;
    const segments = normalized.split("/");
    segments.pop();
    const expanded = new Set(expandedDirectoryIds);
    let directoryPath = "";
    for (const segment of segments) {
      directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
      expanded.add(`directory:${directoryPath}`);
    }
    expandedDirectoryIds = expanded;
    selectLeaf(leaf);
  }
  function reconcileImagePreviews(nextImages: readonly ChangedFileTreeLeaf[]): void {
    const nextFiles = new Map<string, TimelineFileChange>();
    let changed = knownImageFiles.size !== nextImages.length;
    for (const image of nextImages) {
      nextFiles.set(image.file.path, image.file);
      if (knownImageFiles.get(image.file.path) !== image.file) changed = true;
    }
    if (!changed) return;

    const nextThumbnails = new Map(thumbnailPreviews);
    const nextHeroes = new Map(heroPreviews);
    for (const [path, previousFile] of knownImageFiles) {
      if (nextFiles.get(path) === previousFile) continue;
      nextThumbnails.delete(path);
      nextHeroes.delete(path);
    }
    for (const [path, nextFile] of nextFiles) {
      if (knownImageFiles.get(path) === nextFile) continue;
      nextThumbnails.delete(path);
      nextHeroes.delete(path);
    }
    knownImageFiles = nextFiles;
    thumbnailPreviews = nextThumbnails;
    heroPreviews = nextHeroes;
    imageCacheGeneration += 1;

    const selectedImage = nextImages.find(image => image.id === selectedFileId);
    if (imageDetailOpen && selectedImage) void ensureHero(selectedImage.file.path);
  }

  function toggleDirectory(id: string, force?: boolean): void {
    const next = new Set(expandedDirectoryIds);
    const expanded = force ?? !next.has(id);
    if (expanded) next.add(id);
    else next.delete(id);
    expandedDirectoryIds = next;
  }

  async function focusTreeNode(id: string): Promise<void> {
    activeNodeId = id;
    await tick();
    const items = treeElement?.querySelectorAll<HTMLElement>("[role='treeitem']");
    for (const item of items ?? []) {
      if (item.dataset.treeNodeId === id) {
        item.focus();
        break;
      }
    }
  }

  async function handleTreeKeydown(event: KeyboardEvent, row: ChangedFileTreeRow, index: number): Promise<void> {
    const node = row.node;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = visibleRows[Math.min(index + 1, visibleRows.length - 1)];
      if (next) await focusTreeNode(next.node.id);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = visibleRows[Math.max(index - 1, 0)];
      if (previous) await focusTreeNode(previous.node.id);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const edge = event.key === "Home" ? visibleRows[0] : visibleRows.at(-1);
      if (edge) await focusTreeNode(edge.node.id);
      return;
    }
    if (event.key === "ArrowRight" && node.kind === "directory") {
      event.preventDefault();
      if (!expandedDirectoryIds.has(node.id)) {
        toggleDirectory(node.id, true);
        return;
      }
      await tick();
      const child = visibleRows.find(candidate => candidate.parentId === node.id);
      if (child) await focusTreeNode(child.node.id);
      return;
    }
    if (event.key === "ArrowLeft") {
      if (node.kind === "directory" && expandedDirectoryIds.has(node.id)) {
        event.preventDefault();
        toggleDirectory(node.id, false);
      } else if (row.parentId) {
        event.preventDefault();
        await focusTreeNode(row.parentId);
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (node.kind === "directory") toggleDirectory(node.id);
    else selectLeaf(node);
  }

  function selectLeaf(leaf: ChangedFileTreeLeaf): void {
    selectedFileId = leaf.id;
    activeNodeId = leaf.id;
    if (!isRasterImagePath(leaf.path)) {
      imageDetailOpen = false;
      return;
    }
    const openingDetail = !imageDetailOpen;
    imageDetailOpen = true;
    void ensureThumbnail(leaf.file.path);
    void ensureHero(leaf.file.path);
    if (openingDetail) void focusImageDetail();
  }

  async function focusImageDetail(): Promise<void> {
    await tick();
    backButton?.focus();
  }

  async function returnToTree(): Promise<void> {
    imageDetailOpen = false;
    await focusTreeNode(selectedFileId);
  }

  function previewErrorMessage(cause: unknown): string {
    const fallback = "The image preview could not be loaded.";
    const message = cause instanceof Error ? cause.message : fallback;
    const normalized = message.replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
    if (!normalized) return fallback;
    return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
  }

  async function ensureThumbnail(path: string, retry = false): Promise<void> {
    const state = thumbnailPreviews.get(path);
    if (!retry && (state?.status === "loading" || state?.status === "ready")) return;
    const sourceFile = knownImageFiles.get(path);
    const loadingStates = new Map(thumbnailPreviews);
    loadingStates.set(path, { status: "loading" });
    thumbnailPreviews = loadingStates;
    try {
      const preview = await loadImagePreview(path, THUMBNAIL_MAX_DIMENSION);
      if (knownImageFiles.get(path) !== sourceFile) return;
      const readyStates = new Map(thumbnailPreviews);
      readyStates.set(path, { status: "ready", preview });
      thumbnailPreviews = readyStates;
    } catch (cause) {
      if (knownImageFiles.get(path) !== sourceFile) return;
      const failedStates = new Map(thumbnailPreviews);
      failedStates.set(path, { status: "error", message: previewErrorMessage(cause) });
      thumbnailPreviews = failedStates;
    }
  }

  async function ensureHero(path: string, retry = false): Promise<void> {
    const state = heroPreviews.get(path);
    if (!retry && (state?.status === "loading" || state?.status === "ready")) return;
    const sourceFile = knownImageFiles.get(path);
    const loadingStates = new Map(heroPreviews);
    loadingStates.set(path, { status: "loading" });
    heroPreviews = loadingStates;
    try {
      const preview = await loadImagePreview(path, HERO_MAX_DIMENSION);
      if (knownImageFiles.get(path) !== sourceFile) return;
      const readyStates = new Map(heroPreviews);
      readyStates.set(path, { status: "ready", preview });
      heroPreviews = readyStates;
    } catch (cause) {
      if (knownImageFiles.get(path) !== sourceFile) return;
      const failedStates = new Map(heroPreviews);
      failedStates.set(path, { status: "error", message: previewErrorMessage(cause) });
      heroPreviews = failedStates;
    }
  }

  function lazyThumbnail(node: HTMLElement, initialPath: string): { update(path: string): void; destroy(): void } {
    let path = initialPath;
    let observer: IntersectionObserver | undefined;

    const observe = (): void => {
      observer?.disconnect();
      if (!("IntersectionObserver" in window)) {
        void ensureThumbnail(path);
        return;
      }
      observer = new IntersectionObserver(
        entries => {
          if (!entries.some(entry => entry.isIntersecting)) return;
          observer?.disconnect();
          void ensureThumbnail(path);
        },
        { root: node.closest(".image-thumbnail-rail"), rootMargin: "96px 0px" },
      );
      observer.observe(node);
    };

    observe();
    return {
      update(nextPath: string): void {
        path = nextPath;
        observe();
      },
      destroy(): void {
        observer?.disconnect();
      },
    };
  }

  async function handleThumbnailKeydown(event: KeyboardEvent, index: number): Promise<void> {
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, imageLeaves.length - 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = imageLeaves.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextLeaf = imageLeaves[nextIndex];
    if (!nextLeaf) return;
    selectLeaf(nextLeaf);
    await tick();
    const buttons = thumbnailRail?.querySelectorAll<HTMLButtonElement>("[data-image-thumbnail]");
    buttons?.[nextIndex]?.focus();
  }
</script>

<section class="file-activity-panel" aria-labelledby="file-activity-title">
  <header class="panel-header">
    <div>
      <h2 id="file-activity-title">Files</h2>
      <p>{leaves.length} changed file{leaves.length === 1 ? "" : "s"}</p>
    </div>
  </header>

  {#if loading}
    <div class="panel-state" role="status" aria-live="polite">
      <strong>Loading changed files…</strong>
      <p>Collecting the latest successful changes from this chat.</p>
    </div>
  {:else if error}
    <div class="panel-state panel-error" role="alert">
      <strong>Changed files are unavailable</strong>
      <p>{error}</p>
      {#if onRetry}
        <button type="button" class="panel-button" onclick={onRetry}>Retry</button>
      {/if}
    </div>
  {:else if leaves.length === 0}
    <div class="panel-state" role="status">
      <strong>No changed files yet</strong>
      <p>Files successfully written or edited in this chat will appear here.</p>
    </div>
  {:else if selectedImageLeaf}
    <div class="image-detail">
      <header class="detail-header">
        <button bind:this={backButton} type="button" class="back-button" onclick={() => void returnToTree()}>
          <AltArrowLeft size={16} aria-hidden="true" />
          <span>All files</span>
        </button>
        <div class="detail-heading">
          <span class="category-icon"><Gallery size={17} aria-hidden="true" /></span>
          <div>
            <h3 title={selectedImageLeaf.file.path}>{selectedImageLeaf.name}</h3>
            <p>{imageLeaves.length} changed image{imageLeaves.length === 1 ? "" : "s"}</p>
          </div>
        </div>
      </header>

      <div class="image-browser">
        <div class="image-thumbnail-rail" bind:this={thumbnailRail} role="group" aria-label="Changed images">
          {#each imageLeaves as image, index (`${image.id}:${imageCacheGeneration}`)}
            {@const thumbnail = thumbnailPreviews.get(image.file.path) ?? IDLE_PREVIEW}
            <button
              type="button"
              class="image-thumbnail"
              class:is-selected={image.id === selectedImageLeaf.id}
              aria-label={`Show ${image.name}`}
              aria-pressed={image.id === selectedImageLeaf.id}
              tabindex={image.id === selectedImageLeaf.id ? 0 : -1}
              title={image.file.path}
              data-image-thumbnail
              use:lazyThumbnail={image.file.path}
              onclick={() => void selectLeaf(image)}
              onkeydown={(event) => void handleThumbnailKeydown(event, index)}
            >
              {#if thumbnail.status === "ready"}
                <img src={thumbnail.preview.dataUrl} alt="" loading="lazy" decoding="async" />
              {:else if thumbnail.status === "error"}
                <span class="thumbnail-error" title={thumbnail.message}>Retry</span>
              {:else}
                <span class="thumbnail-loading" aria-hidden="true"></span>
              {/if}
            </button>
          {/each}
        </div>

        <div class="image-hero" aria-live="polite">
          {#if selectedHeroState.status === "ready"}
            <figure>
              <img
                src={selectedHeroState.preview.dataUrl}
                alt={`Preview of ${selectedImageLeaf.name}`}
                decoding="async"
              />
              <figcaption>
                <span title={selectedImageLeaf.file.path}>{selectedImageLeaf.file.path}</span>
                <span>{selectedHeroState.preview.width} × {selectedHeroState.preview.height}</span>
              </figcaption>
            </figure>
          {:else if selectedHeroState.status === "error"}
            <div class="preview-state preview-error" role="alert">
              <strong>Preview unavailable</strong>
              <p>{selectedHeroState.message}</p>
              <button type="button" class="panel-button" onclick={() => void ensureHero(selectedImageLeaf.file.path, true)}>
                Retry preview
              </button>
            </div>
          {:else}
            <div class="preview-state" role="status">
              <span class="hero-loading" aria-hidden="true"></span>
              <strong>Loading preview…</strong>
            </div>
          {/if}
        </div>
      </div>

      <footer class="selection-footer">
        <div class="selection-summary">
          <span class="category-icon"><Gallery size={16} aria-hidden="true" /></span>
          <span class="selection-path" title={selectedImageLeaf.file.path}>{selectedImageLeaf.file.path}</span>
        </div>
        <div class="selection-actions">
          <button type="button" class="panel-button" onclick={() => onOpenDiff(selectedImageLeaf.file.path)}>Review diff</button>
          <button type="button" class="panel-button" onclick={() => onOpenFile(selectedImageLeaf.file.path)}>Open file</button>
        </div>
      </footer>
    </div>
  {:else}
    <div class="tree-scroll">
      <div bind:this={treeElement} class="changed-file-tree" role="tree" aria-label="Changed files">
        {#each visibleRows as row, index (row.node.id)}
          <button
            type="button"
            role="treeitem"
            class="tree-row"
            class:is-selected={row.node.kind === "file" && row.node.id === selectedFileId}
            aria-level={row.depth}
            aria-expanded={row.node.kind === "directory" ? expandedDirectoryIds.has(row.node.id) : undefined}
            aria-selected={row.node.kind === "file" ? row.node.id === selectedFileId : undefined}
            tabindex={row.node.id === activeNodeId || (!activeNodeId && index === 0) ? 0 : -1}
            title={row.node.kind === "file" ? row.node.file.path : row.node.path}
            data-tree-node-id={row.node.id}
            style={`--tree-indent: ${(row.depth - 1) * 17}px`}
            onfocus={() => { activeNodeId = row.node.id; }}
            onclick={() => row.node.kind === "directory" ? toggleDirectory(row.node.id) : void selectLeaf(row.node)}
            onkeydown={(event) => void handleTreeKeydown(event, row, index)}
          >
            {#if row.node.kind === "directory"}
              <span class="tree-chevron" class:is-expanded={expandedDirectoryIds.has(row.node.id)}>
                <AltArrowRight size={14} aria-hidden="true" />
              </span>
              <span class="category-icon"><Folder size={16} aria-hidden="true" /></span>
              <span class="tree-name">{row.node.name}</span>
            {:else}
              {@const disposition = fileDispositionLabel(row.node.file)}
              <span class="tree-spacer" aria-hidden="true"></span>
              <span class="category-icon">
                {#if isRasterImagePath(row.node.path)}
                  <Gallery size={16} aria-hidden="true" />
                {:else}
                  <Document size={16} aria-hidden="true" />
                {/if}
              </span>
              <span class="tree-name">{row.node.name}</span>
              <span class="disposition disposition-{disposition.toLowerCase()}">
                {#if disposition === "Created"}
                  <AddCircle size={13} aria-hidden="true" />
                {:else if disposition === "Edited"}
                  <Pen size={13} aria-hidden="true" />
                {:else}
                  <Diskette size={13} aria-hidden="true" />
                {/if}
                <span>{disposition}</span>
              </span>
            {/if}
          </button>
        {/each}
      </div>
    </div>

    {#if selectedLeaf}
      <footer class="selection-footer">
        <div class="selection-summary">
          <span class="category-icon">
            {#if isRasterImagePath(selectedLeaf.path)}
              <Gallery size={16} aria-hidden="true" />
            {:else}
              <Document size={16} aria-hidden="true" />
            {/if}
          </span>
          <span class="selection-path" title={selectedLeaf.file.path}>{selectedLeaf.file.path}</span>
        </div>
        <div class="selection-actions">
          <button type="button" class="panel-button" onclick={() => onOpenDiff(selectedLeaf.file.path)}>Review diff</button>
          <button type="button" class="panel-button" onclick={() => onOpenFile(selectedLeaf.file.path)}>Open file</button>
        </div>
      </footer>
    {/if}
  {/if}
</section>

<style>
  .file-activity-panel {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    color: var(--foreground);
    background: var(--shell);
  }

  .panel-header {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--line);
    padding: 14px 16px;
  }

  .panel-header h2,
  .detail-heading h3 {
    margin: 0;
    color: var(--foreground-strong);
    font: 600 0.875rem/1.25 var(--font-sans);
  }

  .panel-header p,
  .detail-heading p {
    margin: 3px 0 0;
    color: var(--foreground-muted);
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .tree-scroll {
    min-height: 0;
    flex: 1 1 auto;
    overflow: auto;
    padding: 8px;
    overscroll-behavior: contain;
  }

  .changed-file-tree {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 1px;
  }

  .tree-row {
    display: flex;
    width: 100%;
    min-height: 34px;
    align-items: center;
    gap: 7px;
    border: 1px solid transparent;
    border-radius: var(--radius-small);
    padding: 5px 8px 5px calc(7px + var(--tree-indent));
    color: var(--foreground);
    background: transparent;
    text-align: start;
    cursor: pointer;
  }

  .tree-row:hover {
    background: var(--shell-hover);
  }

  .tree-row.is-selected {
    border-color: var(--accent-boundary);
    color: var(--selection-foreground);
    background: var(--selection-surface);
  }

  .tree-row:focus-visible,
  .image-thumbnail:focus-visible,
  .panel-button:focus-visible,
  .back-button:focus-visible {
    outline: 2px solid var(--accent-boundary);
    outline-offset: 1px;
  }

  .tree-chevron,
  .tree-spacer,
  .category-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
  }

  .tree-chevron,
  .tree-spacer {
    width: 14px;
    height: 18px;
  }

  .tree-chevron {
    transition: transform 100ms ease;
  }

  .tree-chevron.is-expanded {
    transform: rotate(90deg);
  }

  .category-icon {
    width: 18px;
    height: 18px;
    color: var(--foreground-muted);
  }

  .tree-row.is-selected .category-icon {
    color: currentColor;
  }

  .tree-name,
  .selection-path,
  .detail-heading h3,
  .image-hero figcaption span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-name {
    flex: 1 1 auto;
    font: 0.8125rem/1.3 var(--font-sans);
  }

  .disposition {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 4px;
    color: var(--foreground-muted);
    font-size: 0.6875rem;
    line-height: 1;
  }

  .disposition-created {
    color: var(--success);
  }

  .disposition-edited {
    color: var(--foreground);
  }

  .panel-state {
    display: flex;
    min-height: 176px;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 7px;
    padding: 24px 16px;
    color: var(--foreground-muted);
  }

  .panel-state strong,
  .preview-state strong {
    color: var(--foreground);
    font-size: 0.8125rem;
  }

  .panel-state p,
  .preview-state p {
    max-width: 54ch;
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .panel-error,
  .preview-error {
    color: var(--foreground);
  }

  .image-detail {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
  }

  .detail-header {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 10px;
    border-bottom: 1px solid var(--line-soft);
    padding: 10px 12px;
  }

  .back-button {
    display: inline-flex;
    width: fit-content;
    min-height: 28px;
    align-items: center;
    gap: 5px;
    border: 0;
    border-radius: var(--radius-small);
    padding: 3px 5px 3px 2px;
    color: var(--foreground);
    background: transparent;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .back-button:hover {
    background: var(--shell-hover);
  }

  .detail-heading,
  .selection-summary,
  .selection-actions {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 8px;
  }

  .detail-heading > div {
    min-width: 0;
  }

  .image-browser {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    gap: 10px;
    padding: 10px;
    background: var(--chat-canvas);
  }

  .image-thumbnail-rail {
    display: flex;
    width: 68px;
    min-width: 68px;
    min-height: 0;
    flex-direction: column;
    gap: 7px;
    overflow-y: auto;
    padding: 2px;
    overscroll-behavior: contain;
  }

  .image-thumbnail {
    display: flex;
    width: 62px;
    height: 62px;
    min-height: 62px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
    padding: 3px;
    color: var(--foreground-muted);
    background: var(--shell-raised);
    cursor: pointer;
  }

  .image-thumbnail:hover {
    border-color: var(--foreground-muted);
  }

  .image-thumbnail.is-selected {
    border-color: var(--accent-boundary);
    box-shadow: 0 0 0 1px var(--accent-boundary);
  }

  .image-thumbnail img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .thumbnail-loading,
  .hero-loading {
    display: block;
    border-radius: var(--radius-small);
    background: var(--shell-hover);
  }

  .thumbnail-loading {
    width: 100%;
    height: 100%;
  }

  .thumbnail-error {
    padding: 4px;
    font-size: 0.6875rem;
  }

  .image-hero {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-small);
    background: var(--shell);
  }

  .image-hero figure {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    margin: 0;
    flex-direction: column;
  }

  .image-hero figure > img {
    width: 100%;
    min-height: 0;
    flex: 1 1 auto;
    object-fit: contain;
  }

  .image-hero figcaption {
    display: flex;
    flex: 0 0 auto;
    justify-content: space-between;
    gap: 12px;
    border-top: 1px solid var(--line-soft);
    padding: 7px 9px;
    color: var(--foreground-muted);
    font: 0.6875rem/1.35 var(--font-mono);
  }

  .image-hero figcaption span:first-child {
    flex: 1 1 auto;
  }

  .image-hero figcaption span:last-child {
    flex: 0 0 auto;
  }

  .preview-state {
    display: flex;
    max-width: 34ch;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 18px;
    color: var(--foreground-muted);
    text-align: center;
  }

  .hero-loading {
    width: 38px;
    height: 38px;
  }

  .selection-footer {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 9px;
    border-top: 1px solid var(--line);
    padding: 10px 12px;
    background: var(--shell-raised);
  }

  .selection-path {
    flex: 1 1 auto;
    color: var(--foreground);
    font: 0.75rem/1.35 var(--font-mono);
  }

  .selection-actions {
    justify-content: flex-end;
  }

  .panel-button {
    min-height: 30px;
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
    padding: 5px 9px;
    color: var(--foreground);
    background: transparent;
    cursor: pointer;
    font-size: 0.75rem;
    line-height: 1.2;
  }

  .panel-button:hover:not(:disabled) {
    background: var(--shell-hover);
  }

  @media (max-width: 420px) {
    .tree-row {
      padding-inline-end: 6px;
    }

    .disposition span {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    .image-browser {
      gap: 7px;
      padding: 8px;
    }

    .image-thumbnail-rail {
      width: 56px;
      min-width: 56px;
    }

    .image-thumbnail {
      width: 50px;
      height: 50px;
      min-height: 50px;
    }
  }
</style>

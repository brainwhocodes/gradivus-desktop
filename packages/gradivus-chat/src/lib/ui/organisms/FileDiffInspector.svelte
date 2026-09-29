<script lang="ts">
  import ArrowRightUp from "@solar-icons/svelte/linear/arrow-right-up";
  import CloseCircle from "@solar-icons/svelte/linear/close-circle";
  import type { HostedFileView } from "../../contracts";

  type FileDiffView = Extract<HostedFileView, { kind: "diff" }>;

  export let path: string;
  export let diff: FileDiffView | undefined;
  export let loading: boolean;
  export let error: string;
  export let onClose: () => void;
  export let closeLabel = "Close diff";
  export let onOpenFile: () => void;

  $: lines = diff?.diff ? diff.diff.split("\n") : [];

  function lineKind(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+") && !line.startsWith("+++")) return "added";
    if (line.startsWith("-") && !line.startsWith("---")) return "removed";
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
    return "context";
  }
</script>

<section class="diff-inspector" aria-label={`Git diff for ${path}`} aria-busy={loading}>
  <header class="diff-header">
    <div class="diff-title">
      <span class="eyebrow">Git diff</span>
      <h2 title={path}>{path}</h2>
    </div>
    <div class="diff-actions">
      <button
        type="button"
        class="icon-button"
        aria-label={`Open ${path}`}
        title="Open file"
        disabled={!diff || diff.status === "deleted" || diff.status === "unavailable"}
        onclick={onOpenFile}
      ><ArrowRightUp size={16} aria-hidden="true" /></button>
      <button type="button" class="icon-button diff-back-button" aria-label={closeLabel} title={closeLabel} onclick={onClose}><CloseCircle size={16} aria-hidden="true" /><span>{closeLabel}</span></button>
    </div>
  </header>

  {#if diff}
    <div class="diff-summary" aria-label="Diff summary">
      <span class="diff-status status-{diff.status}">{diff.status}</span>
      <span class="diff-additions">+{diff.additions}</span>
      <span class="diff-deletions">−{diff.deletions}</span>
    </div>
    <p class="working-tree-note">Current working-tree changes for this file.</p>
  {/if}

  {#if loading}
    <div class="diff-state" role="status"><span class="spinner"></span><span>Loading current working-tree diff…</span></div>
  {:else if error}
    <div class="diff-state diff-error" role="alert"><strong>Diff unavailable</strong><span>{error}</span></div>
  {:else if diff?.diff}
    <div class="diff-code" role="document" aria-label={`Patch for ${path}`}>
      {#each lines as line}
        <div class="diff-line line-{lineKind(line)}"><code>{line || " "}</code></div>
      {/each}
    </div>
    {#if diff.truncated}<p class="diff-note">Preview capped at 2,000 lines or 256 KiB. Counts cover the complete patch.</p>{/if}
  {:else if diff}
    <div class="diff-state"><strong>{diff.status === "clean" ? "No Git changes" : diff.status === "binary" ? "Binary change" : "No text preview"}</strong><span>{diff.message ?? "No patch content is available for this file."}</span></div>
  {/if}
</section>

<style>
  .diff-inspector {
    min-width: 0;
    min-height: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--chat-canvas);
    font: 14px/1.5 var(--font-ui);
  }
  .diff-header {
    position: static;
    flex: 0 0 auto;
    align-items: center;
    gap: 20px;
    padding: 24px;
    background: var(--shell);
  }
  .diff-title .eyebrow {
    color: var(--foreground-muted);
    font: 12px/1.4 var(--font-ui);
    text-transform: none;
    letter-spacing: 0;
  }
  .diff-title h2 { margin-top: 6px; font: 550 15px/1.4 var(--font-mono); }
  .diff-actions { align-items: center; gap: 8px; }
  .diff-actions .icon-button { min-height: var(--control-height); }
  .diff-summary { flex: 0 0 auto; gap: 16px; padding: 12px 24px; background: var(--shell); font: 13px/1.4 var(--font-ui); font-variant-numeric: tabular-nums; }
  .diff-status { text-transform: capitalize; }
  .diff-additions { color: var(--success-boundary); }
  .diff-deletions { color: var(--danger-boundary); }
  .working-tree-note { flex: 0 0 auto; margin: 0; padding: 12px 24px; border-bottom: 1px solid var(--line-soft); color: var(--foreground-muted); background: var(--shell-raised); font-size: 13px; }
  .diff-code { min-height: 0; flex: 1 1 auto; padding: 16px 0; }
  .diff-line { padding: 1px 24px; contain-intrinsic-size: 23px; }
  .diff-line code { font: 13px/1.7 var(--font-mono); }
  .line-added { color: var(--foreground); background: var(--success-surface); box-shadow: inset 3px 0 var(--success-boundary); }
  .line-removed { color: var(--foreground); background: var(--danger-surface); box-shadow: inset 3px 0 var(--danger-boundary); }
  .line-hunk { margin: 12px 0; padding-block: 6px; color: var(--foreground-muted); background: var(--shell-raised); font-weight: 500; }
  .line-meta { font-style: normal; }
  .diff-state { flex: 1 1 auto; padding: 32px 24px; font-size: 14px; }
  .diff-note { flex: 0 0 auto; padding: 12px 24px; font-size: 13px; }
  @media (max-width: 640px) {
    .diff-header { align-items: flex-start; flex-direction: column; padding: 16px; }
    .diff-actions { width: 100%; justify-content: flex-end; }
    .diff-summary, .working-tree-note, .diff-note { padding-inline: 16px; }
    .diff-line { padding-inline: 16px; }
  }
</style>

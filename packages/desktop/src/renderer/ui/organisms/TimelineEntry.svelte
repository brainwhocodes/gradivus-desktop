<script lang="ts">
  import CheckCircle from "@solar-icons/svelte/linear/check-circle";
  import DangerCircle from "@solar-icons/svelte/linear/danger-circle";
  import Pen2 from "@solar-icons/svelte/linear/pen-2";
  import Stars from "@solar-icons/svelte/linear/stars";
  import type { SessionKind, TimelineImage, TimelineItem, TimelineToolActivity } from "../../../shared/contracts";
  import TimelinePresentation from "./TimelinePresentation.svelte";
  import MarkdownBody from "../molecules/MarkdownBody.svelte";

  export let item: TimelineItem;
  export let kind: SessionKind;
  export let reasoningLoading: Set<string>;
  export let openReasoning: Set<string>;
  export let onReasoning: (item: TimelineItem) => void;
  export let onCopyText: (text: string) => Promise<void>;
  export let showToolDetails = true;
  export let queued = false;
  export let queuedSteering = false;
  export let onSteer: () => void = () => undefined;
  export let canEdit = false;
  export let onEdit: (item: TimelineItem) => void = () => undefined;
  const REASONING_PREVIEW_LIMIT = 64 * 1024;
  function toolLabel(value: TimelineItem): string {
    return value.toolName === "generate_image" ? "Generate image" : value.toolName ?? value.text;
  }

  function toolStatus(value: TimelineItem): string {
    if (value.toolName === "generate_image" && value.status === "running") return "generating image";
    return value.status ?? "pending";
  }

  function imageSource(image: TimelineImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
  }

  function lineKind(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+") && !line.startsWith("+++")) return "added";
    if (line.startsWith("-") && !line.startsWith("---")) return "removed";
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
    return "context";
  }


  function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 1) + "…";
  }

  function extractToolArgBadges(item: TimelineItem): Array<{ key: string; value: string }> {
    const args = item.args;
    if (!args || typeof args !== "object") return [];
    const record = args as Record<string, unknown>;
    const isEditTool = item.toolName === "edit" || item.toolActivity?.operation === "edit";
    const badges: Array<{ key: string; value: string }> = [];
    const priorityKeys = isEditTool
      ? ["path", "file"]
      : ["path", "file", "pattern", "command", "query", "url", "action", "key", "signal", "name"];

    for (const key of priorityKeys) {
      if (key in record) {
        const val = record[key];
        if (val !== undefined && val !== null && typeof val !== "object") {
          badges.push({ key, value: truncate(String(val), 48) });
        }
      }
    }

    if (!isEditTool && badges.length === 0) {
      for (const [k, v] of Object.entries(record)) {
        if (badges.length >= 2) break;
        if (v !== undefined && v !== null && typeof v !== "object") {
          badges.push({ key: k, value: truncate(String(v), 48) });
        }
      }
    }

    return badges;
  }

  function formatReasoningTokens(item: TimelineItem): string {
    const text = item.text || item.detail || "";
    const trimmed = text.trim();
    if (!trimmed) return "0 tokens";
    const words = trimmed.split(/\s+/).length;
    const tokens = Math.max(1, Math.round(words / 0.75));
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k tokens`;
    }
    return `${tokens} tokens`;
  }

  function activityPreview(activity: TimelineToolActivity): string[] {
    if (activity.operation === "read") return activity.preview;
    if (activity.operation === "write") return activity.preview;
    return activity.operation === "edit" ? activity.diff : [];
  }
  function activityExpanded(activity: TimelineToolActivity): string[] {
    return activity.operation === "read" ? activity.expandedPreview : activityPreview(activity);
  }

  function activityTarget(activity: TimelineToolActivity): string {
    if (activity.operation === "read" || activity.operation === "write") return activity.path;
    if (activity.operation === "edit") return activity.paths.join(", ");
    return activity.target ? `${activity.operationName} → ${activity.target}` : activity.operationName;
  }

  function activityLabel(activity: TimelineToolActivity): string {
    if (activity.operation === "read") return "Read";
    if (activity.operation === "write") return "Wrote";
    if (activity.operation === "edit") return "Edited";
    return "Hub";
  }

  function gutterLabel(value: TimelineItem): string {
    if (value.kind === "user") return "YOU";
    if (value.kind === "assistant") return "OMP";
    if (value.kind === "tool") return "TOOL";
    if (value.kind === "thinking") return "THINK";
    if (value.kind === "raw") return "LOG";
    const presentation = value.presentation;
    if (!presentation) return "EXT";
    switch (presentation.type) {
      case "irc":
        return "IRC";
      case "advisor":
        return "ADV";
      case "context":
        return "CTX";
      case "execution":
        return "RUN";
      case "activity":
        return presentation.category === "files" ? "FILE" : presentation.category === "job" ? "JOB" : "SYS";
      case "status":
        return "SYS";
      case "custom":
        return "EXT";
      case "assistant-outcome":
        return "SYS";
      default:
        return "EXT";
    }
  }

  $: toolArgBadges = item.kind === "tool" ? extractToolArgBadges(item) : [];
</script>

<article class="timeline-item item-{item.kind}" data-timeline-id={item.id} class:has-error={item.isError} class:is-running={item.status === "running"} class:is-queued={queued}>
  <div class="timeline-gutter"><span>{gutterLabel(item)}</span></div>
  <div class="timeline-body">
    {#if item.kind === "tool"}
      <div class="activity-row" class:is-running={item.status === "running"} class:has-error={item.status === "error" || item.isError}>
        {#if item.status === "running"}
          <span class="tool-running-radar" aria-hidden="true" title="Running">
            <span class="radar-ring"></span>
            <span class="radar-ring radar-ring-outer"></span>
            <span class="radar-dot"></span>
          </span>
        {:else}
          <span class="activity-icon" aria-hidden="true">{#if item.status === "error" || item.isError}<DangerCircle size={14} />{:else}<CheckCircle size={14} />{/if}</span>
        {/if}
        <strong class="tool-name">{toolLabel(item)}</strong>
        <span class="activity-status" class:status-running={item.status === "running"}>{toolStatus(item)}</span>
      </div>
      {#if item.toolActivity && showToolDetails}
        <div class="tool-activity-summary" aria-label={`${activityLabel(item.toolActivity)} activity`}>
          <div class="tool-activity-target">
            <span class="tool-arg-key">{activityLabel(item.toolActivity)}</span>
            <code title={activityTarget(item.toolActivity)}>{activityTarget(item.toolActivity)}</code>
            {#if item.toolActivity.operation === "read" && (item.toolActivity.range || item.toolActivity.count !== undefined)}
              <span class="activity-status">{item.toolActivity.range ?? ""}{item.toolActivity.range && item.toolActivity.count !== undefined ? " · " : ""}{item.toolActivity.count !== undefined ? `${item.toolActivity.count} lines` : ""}</span>
            {/if}
          </div>
          {#if activityPreview(item.toolActivity).length > 0}
            <div class="tool-activity-preview" role="region" aria-label="Activity preview">
              {#each activityPreview(item.toolActivity) as line}
                <div class="diff-line line-{lineKind(line)}"><code>{line || " "}</code></div>
              {/each}
            </div>
            {#if activityExpanded(item.toolActivity).length > activityPreview(item.toolActivity).length}
              <details class="tool-activity-preview-more">
                <summary>Show full preview</summary>
                <div class="tool-activity-preview">
                  {#each activityExpanded(item.toolActivity) as line}
                    <div class="diff-line line-{lineKind(line)}"><code>{line || " "}</code></div>
                  {/each}
                </div>
              </details>
            {/if}
          {/if}
        </div>
      {/if}
      {#if showToolDetails && toolArgBadges.length > 0}
        <div class="tool-args-badges" aria-label="Tool arguments">
          {#each toolArgBadges as badge (badge.key)}
            <span class="tool-arg-badge"><span class="tool-arg-key">{badge.key}:</span><code class="tool-arg-val" title={badge.value}>{badge.value}</code></span>
          {/each}
        </div>
      {/if}
      {#if item.images && item.images.length > 0}
        <div class="tool-images" aria-label="Generated images">
          {#each item.images as image, index (image.mimeType + ":" + index)}
            <figure class="tool-image">
              <img src={imageSource(image)} alt={`Generated image ${index + 1}`} loading="lazy" />
              <figcaption>{image.mimeType.replace("image/", "").toUpperCase()}</figcaption>
            </figure>
          {/each}
        </div>
      {/if}
      {#if kind === "code"}
        <details class="technical-details"><summary>Technical details</summary>{#if item.args}<pre>{JSON.stringify(item.args, null, 2)}</pre>{/if}{#if item.detail}<pre>{item.detail}</pre>{/if}</details>
      {/if}
    {:else if item.kind === "thinking"}
      <details class="reasoning-details reasoning-card" class:is-running={item.status === "running"} open={openReasoning.has(item.id)}>
        <summary class="reasoning-summary" aria-busy={reasoningLoading.has(item.id) || item.status === "running"} onclick={() => onReasoning(item)}>
          <span class="reasoning-sparkle" aria-hidden="true"><Stars size={14} /></span>
          <span class="reasoning-label">Reasoning</span>
          <span class="reasoning-badge-pill" class:is-thinking={item.status === "running"} class:thinking={item.status === "running"}>{formatReasoningTokens(item)}</span>
          {#if item.status === "running"}
            <span class="reasoning-status-pill thinking is-running">thinking…</span>
          {:else if item.status === "error" || item.isError}
            <span class="reasoning-status-pill error has-error">error</span>
          {/if}
        </summary>
        {#if item.text.length > REASONING_PREVIEW_LIMIT}<pre class="reasoning-copy">{item.text.slice(0, REASONING_PREVIEW_LIMIT)}{"\n\n[Preview truncated · showing first 64 KiB]"}</pre>{:else}<MarkdownBody value={item.text} streaming={item.status === "running"} className="reasoning-copy" />{/if}
      </details>
    {:else if item.kind === "special"}
      <TimelinePresentation presentation={item.presentation} text={item.text} />
      {#if item.detail && kind === "code"}<details class="technical-details"><summary>Details</summary><pre>{item.detail}</pre></details>{/if}
    {:else if item.kind === "raw"}
      <div class="timeline-special-fallback" aria-label="Unhandled event"><div class="marker-row"><span class="marker-label">LOG</span><span>{item.text}</span></div>{#if item.detail && kind === "code"}<details class="technical-details"><summary>Technical details</summary><pre>{item.detail}</pre></details>{/if}</div>
    {:else}
      {#if item.text}
        <div
          class="message-row"
          class:queued-message-row={queued}
          class:editable-message-row={item.kind === "user" && canEdit && !queued}
        >
          <div class="message-row-copy">
            <MarkdownBody
              value={item.text}
              streaming={item.kind === "assistant" && item.status === "running"}
              showResponseCopy={item.kind === "assistant" && item.status !== "running"}
              onCopyText={item.kind === "assistant" ? onCopyText : undefined}
              className="message-copy"
            />
          </div>
          {#if item.kind === "user" && canEdit && !queued}
            <button
              type="button"
              class="message-edit-button"
              data-timeline-item-id={item.id}
              aria-label="Edit message"
              title="Edit message"
              onclick={() => onEdit(item)}
            ><Pen2 size={13} aria-hidden="true" /><span>Edit</span></button>
          {/if}
          {#if queued}
            <button
              type="button"
              class="queued-steer-button"
              aria-label="Steer queued message"
              title="Steer queued message"
              disabled={queuedSteering}
              onclick={onSteer}
            >{queuedSteering ? "Steering…" : "Steer"}</button>
          {/if}
        </div>
        {#if item.kind === "assistant" && item.status === "running"}<span class="typing-cursor-blink" aria-hidden="true">▌</span>{/if}
      {/if}
      {#if item.kind === "assistant" && item.presentation?.type === "assistant-outcome"}
        <TimelinePresentation presentation={item.presentation} text={item.detail ?? item.text} />
      {/if}
      {#if kind === "code" && item.detail}<details class="technical-details"><summary>Technical details</summary><pre>{item.detail}</pre></details>{/if}
    {/if}
  </div>
</article>


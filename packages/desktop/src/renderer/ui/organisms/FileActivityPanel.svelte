<script lang="ts">
  import type { TimelineItem } from "../../../shared/contracts";

  export let items: TimelineItem[] = [];
  export let onOpenFile: (path: string) => void;
  export let onOpenDiff: (path: string) => void;
  export let onFocusItem: (id: string) => void;

  type ActivityStatus = "running" | "complete" | "error";
  type ActivityView =
    | {
        key: string;
        itemId: string;
        operation: "read";
        path: string;
        range?: string;
        count?: number;
        preview: string[];
        expandedPreview: string[];
        status: ActivityStatus;
      }
    | {
        key: string;
        itemId: string;
        operation: "write" | "edit";
        path: string;
        preview: string[];
        status: "complete";
      }
    | {
        key: string;
        itemId: string;
        operation: "hub";
        operationName: string;
        target?: string;
        status: ActivityStatus;
      };

  const ACTIVITY_LIMIT = 100;
  const PREVIEW_LINE_LIMIT = 12;
  const DIFF_LINE_LIMIT = 40;
  const LINE_CHARACTER_LIMIT = 320;
  const LABEL_CHARACTER_LIMIT = 180;

  $: activities = deriveActivities(items);

  function boundedLabel(value: string): string {
    const normalized = value.replaceAll("\u0000", "").replace(/\s+/g, " ").trim();
    return normalized.length > LABEL_CHARACTER_LIMIT
      ? `${normalized.slice(0, LABEL_CHARACTER_LIMIT - 1)}…`
      : normalized;
  }

  function boundedLines(lines: string[], limit: number): string[] {
    return lines.slice(0, limit).map(line => {
      const normalized = line.replaceAll("\u0000", "");
      return normalized.length > LINE_CHARACTER_LIMIT
        ? `${normalized.slice(0, LINE_CHARACTER_LIMIT - 1)}…`
        : normalized;
    });
  }

  function statusFor(item: TimelineItem): ActivityStatus {
    if (item.status === "error" || item.isError) return "error";
    return item.status === "running" ? "running" : "complete";
  }

  function deriveActivities(source: TimelineItem[]): ActivityView[] {
    const activityViews: ActivityView[] = [];
    const seenChanges = new Set<string>();

    outer: for (let index = source.length - 1; index >= 0; index -= 1) {
      const item = source[index];
      const activity = item.toolActivity;
      if (!activity) continue;

      if (activity.operation === "read") {
        activityViews.push({
          key: `${item.id}:read:${activity.path}`,
          itemId: item.id,
          operation: "read",
          path: activity.path,
          range: activity.range,
          count: activity.count,
          preview: boundedLines(activity.preview, 3),
          expandedPreview: boundedLines(activity.expandedPreview, PREVIEW_LINE_LIMIT),
          status: statusFor(item),
        });
      } else if (activity.operation === "hub") {
        activityViews.push({
          key: `${item.id}:hub`,
          itemId: item.id,
          operation: "hub",
          operationName: boundedLabel(activity.operationName),
          target: activity.target ? boundedLabel(activity.target) : undefined,
          status: statusFor(item),
        });
      } else if (activity.operation === "write") {
        if (statusFor(item) !== "complete") continue;
        const successfulChange = item.files?.some(file => file.operation === "write" && file.path === activity.path);
        if (!successfulChange || seenChanges.has(activity.path)) continue;
        seenChanges.add(activity.path);
        activityViews.push({
          key: `${item.id}:write:${activity.path}`,
          itemId: item.id,
          operation: "write",
          path: activity.path,
          preview: boundedLines(activity.preview, PREVIEW_LINE_LIMIT),
          status: "complete",
        });
      } else {
        if (statusFor(item) !== "complete") continue;
        const successfulPaths = item.files
          ?.filter(file => file.operation === "edit")
          .map(file => file.path) ?? [];
        for (const path of successfulPaths) {
          if (seenChanges.has(path)) continue;
          seenChanges.add(path);
          activityViews.push({
            key: `${item.id}:edit:${path}`,
            itemId: item.id,
            operation: "edit",
            path,
            preview: boundedLines(activity.diff, DIFF_LINE_LIMIT),
            status: "complete",
          });
          if (activityViews.length >= ACTIVITY_LIMIT) break outer;
        }
      }

      if (activityViews.length >= ACTIVITY_LIMIT) break;
    }

    return activityViews;
  }

  function operationLabel(activity: ActivityView): string {
    if (activity.operation === "read") return "Read";
    if (activity.operation === "write") return "Wrote";
    if (activity.operation === "edit") return "Edited";
    return "Agent Hub";
  }

  function statusLabel(status: ActivityStatus): string {
    if (status === "running") return "In progress";
    if (status === "error") return "Failed";
    return "Complete";
  }

  function diffLineKind(line: string): "added" | "removed" | "hunk" | "meta" | "context" {
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+") && !line.startsWith("+++")) return "added";
    if (line.startsWith("-") && !line.startsWith("---")) return "removed";
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
    return "context";
  }
</script>

<section class="file-activity-panel" aria-labelledby="file-activity-title">
  <header class="panel-header">
    <div>
      <h2 id="file-activity-title">Files</h2>
      <p>{activities.length} recent activit{activities.length === 1 ? "y" : "ies"}</p>
    </div>
  </header>

  {#if activities.length === 0}
    <div class="panel-empty" role="status">
      <strong>No file activity yet</strong>
      <p>Reads, successful file changes, and Agent Hub operations from this run will appear here.</p>
    </div>
  {:else}
    <ol class="activity-list" aria-label="Recent file and Agent Hub activity">
      {#each activities as activity (activity.key)}
        <li>
          <article class="activity-entry activity-{activity.operation}">
            <header class="activity-header">
              <div class="activity-title">
                <span class="operation-badge">{operationLabel(activity)}</span>
                <span class="activity-status status-{activity.status}">{statusLabel(activity.status)}</span>
              </div>
              <button
                type="button"
                class="text-button"
                aria-label={`Focus ${operationLabel(activity).toLowerCase()} activity in the chat timeline`}
                on:click={() => onFocusItem(activity.itemId)}
              >
                Focus in chat
              </button>
            </header>

            {#if activity.operation === "hub"}
              <div class="hub-summary">
                <strong>{activity.operationName || "Hub operation"}</strong>
                {#if activity.target}<span title={activity.target}>{activity.target}</span>{/if}
              </div>
            {:else}
              <code class="activity-path" title={activity.path}>{boundedLabel(activity.path)}</code>

              {#if activity.operation === "read" && (activity.range || activity.count !== undefined)}
                <dl class="read-metadata" aria-label="Read details">
                  {#if activity.range}<div><dt>Range</dt><dd>{boundedLabel(activity.range)}</dd></div>{/if}
                  {#if activity.count !== undefined}<div><dt>Count</dt><dd>{activity.count} line{activity.count === 1 ? "" : "s"}</dd></div>{/if}
                </dl>
              {/if}

              {#if activity.preview.length > 0}
                {#if activity.operation === "edit"}
                  <div class="diff-preview" role="document" aria-label={`Edit preview for ${boundedLabel(activity.path)}`}>
                    {#each activity.preview as line}
                      <code class="line-{diffLineKind(line)}">{line || " "}</code>
                    {/each}
                  </div>
                {:else}
                  <pre class="file-preview" aria-label={`${operationLabel(activity)} preview for ${boundedLabel(activity.path)}`}>{activity.preview.join("\n")}</pre>
                  {#if activity.operation === "read" && activity.expandedPreview.length > activity.preview.length}
                    <details class="expanded-preview">
                      <summary>Show {activity.expandedPreview.length - activity.preview.length} more line{activity.expandedPreview.length - activity.preview.length === 1 ? "" : "s"}</summary>
                      <pre>{activity.expandedPreview.join("\n")}</pre>
                    </details>
                  {/if}
                {/if}
              {:else}
                <p class="preview-empty">No text preview is available.</p>
              {/if}

              <div class="activity-actions">
                <button
                  type="button"
                  class="panel-button"
                  aria-label={`Open ${boundedLabel(activity.path)} in the workspace editor`}
                  on:click={() => onOpenFile(activity.path)}
                >
                  Open file
                </button>
                {#if activity.operation === "write" || activity.operation === "edit"}
                  <button
                    type="button"
                    class="panel-button"
                    aria-label={`Review the current diff for ${boundedLabel(activity.path)}`}
                    on:click={() => onOpenDiff(activity.path)}
                  >
                    Review diff
                  </button>
                {/if}
              </div>
            {/if}
          </article>
        </li>
      {/each}
    </ol>
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

  .panel-header,
  .activity-header,
  .activity-title,
  .activity-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-header {
    flex: 0 0 auto;
    justify-content: space-between;
    border-bottom: 1px solid var(--line);
    padding: 16px;
  }

  .panel-header h2 {
    margin: 0;
    color: var(--foreground-strong);
    font: 600 0.875rem/1.25 var(--font-sans);
  }

  .panel-header p {
    margin: 4px 0 0;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.4;
  }

  .activity-list {
    min-height: 0;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
    overscroll-behavior: contain;
  }

  .activity-list > li {
    border-bottom: 1px solid var(--line);
  }

  .activity-entry {
    padding: 12px 16px;
  }

  .activity-header {
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .operation-badge,
  .activity-status {
    font-size: 14px;
    line-height: 1;
  }

  .operation-badge {
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
    padding: 3px 5px;
    color: var(--foreground);
    background: var(--shell-raised);
  }

  .activity-status {
    color: var(--foreground-muted);
    border-bottom: 1px solid var(--line);
  }

  .activity-status.status-running {
    color: var(--foreground);
    border-color: var(--accent-boundary);
  }

  .activity-status.status-error {
    color: var(--foreground);
    border-color: var(--danger-boundary);
  }

  .activity-status.status-complete {
    color: var(--foreground);
    border-color: var(--success-boundary);
  }

  .activity-path {
    display: block;
    overflow: hidden;
    margin-bottom: 8px;
    color: var(--foreground-strong);
    font: 14px/1.4 var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .read-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin: 0 0 8px;
  }

  .read-metadata div {
    display: flex;
    align-items: baseline;
    gap: 5px;
  }

  .read-metadata dt,
  .read-metadata dd {
    margin: 0;
    font-size: 14px;
    line-height: 1.35;
  }

  .read-metadata dt {
    color: var(--foreground-muted);
  }

  .read-metadata dd {
    color: var(--foreground);
  }

  .file-preview,
  .expanded-preview pre,
  .diff-preview {
    max-width: 100%;
    margin: 0;
    overflow: auto;
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-small);
    color: var(--foreground);
    background: var(--chat-canvas);
    font: 14px/1.5 var(--font-mono);
    overscroll-behavior: contain;
  }

  .file-preview,
  .expanded-preview pre {
    max-height: 160px;
    padding: 8px;
    white-space: pre;
  }

  .expanded-preview {
    margin-top: 6px;
  }

  .expanded-preview summary {
    width: fit-content;
    margin-bottom: 6px;
    color: var(--foreground);
    cursor: pointer;
    font-size: 14px;
    line-height: 1.35;
  }

  .expanded-preview pre {
    max-height: 240px;
  }

  .diff-preview {
    max-height: 240px;
    padding: 6px 0;
  }

  .diff-preview code {
    min-width: max-content;
    display: block;
    padding: 1px 8px;
    white-space: pre;
  }

  .diff-preview .line-added {
    border-inline-start: 1px solid var(--success-boundary);
    color: var(--foreground);
    background: var(--success-surface);
  }

  .diff-preview .line-removed {
    border-inline-start: 1px solid var(--danger-boundary);
    color: var(--foreground);
    background: var(--danger-surface);
  }

  .diff-preview .line-hunk {
    margin: 3px 0;
    color: var(--selection-foreground);
    background: var(--selection-surface);
    box-shadow: inset 2px 0 0 var(--accent-boundary);
  }

  .diff-preview .line-meta {
    color: var(--foreground-muted);
  }

  .preview-empty {
    margin: 0;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.45;
  }

  .activity-actions {
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .panel-button,
  .text-button {
    border-radius: var(--radius-small);
    color: var(--foreground);
    background: transparent;
    cursor: pointer;
  }

  .panel-button {
    min-height: 28px;
    border: 1px solid var(--line);
    padding: 4px 8px;
    font-size: 14px;
    line-height: 1.2;
  }

  .panel-button:hover:not(:disabled) {
    border-color: var(--line);
    background: var(--shell-hover);
  }

  .text-button {
    flex: 0 0 auto;
    border: 0;
    padding: 4px;
    color: var(--foreground);
    font-size: 14px;
    line-height: 1.25;
  }

  .text-button:hover:not(:disabled) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .hub-summary {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-small);
    padding: 8px;
    background: var(--chat-canvas);
  }

  .hub-summary strong,
  .hub-summary span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hub-summary strong {
    color: var(--foreground-strong);
    font-size: 14px;
    line-height: 1.4;
  }

  .hub-summary span {
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.35;
  }

  .panel-empty {
    display: flex;
    min-height: 176px;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 6px;
    padding: 24px 16px;
    color: var(--foreground-muted);
  }

  .panel-empty strong {
    color: var(--foreground);
    font-size: 14px;
  }

  .panel-empty p {
    max-width: 65ch;
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
  }

  @media (max-width: 420px) {
    .activity-header {
      align-items: flex-start;
      flex-direction: column;
    }

    .text-button {
      padding-inline: 0;
    }
  }
</style>

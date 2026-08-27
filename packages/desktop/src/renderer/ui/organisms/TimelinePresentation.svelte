<script lang="ts">
  import type { TimelinePresentation, TimelineTone } from "../../../shared/contracts";
  import { renderMarkdown } from "../../markdown";

  export let presentation: TimelinePresentation | undefined;
  export let text = "";

  let customExpanded = false;
  let contextExpanded = false;
  let executionExpanded = false;
  let outcomeExpanded = false;

  function toneLabel(tone: TimelineTone): string {
    return tone === "neutral" ? "neutral" : tone;
  }

  function displayRoute(presentation: Extract<TimelinePresentation, { type: "irc" }>): string {
    if (presentation.direction === "incoming") return `IRC ← ${presentation.from ?? "unknown"}`;
    if (presentation.direction === "autoreply") return `IRC → ${presentation.to ?? "unknown"}`;
    return `IRC ${presentation.from ?? "unknown"} → ${presentation.to ?? "unknown"}`;
  }

  function executionState(presentation: Extract<TimelinePresentation, { type: "execution" }>): string {
    if (presentation.state === "error") return presentation.exitCode === undefined ? "error" : `exit ${presentation.exitCode}`;
    if (presentation.state === "cancelled") return "cancelled";
    if (presentation.state === "running") return "running";
    if (presentation.truncated) return "truncated";
    return "complete";
  }

  function executionTone(presentation: Extract<TimelinePresentation, { type: "execution" }>): TimelineTone {
    if (presentation.state === "error") return "error";
    if (presentation.state === "cancelled") return "warning";
    return "neutral";
  }

  function customNeedsDetails(presentation: Extract<TimelinePresentation, { type: "custom" }>): boolean {
    return presentation.collapsed === true || text.length > 16 * 1024 || (presentation.omittedCount ?? 0) > 0;
  }

  function contextSummary(presentation: Extract<TimelinePresentation, { type: "context" }>): string {
    const counts: string[] = [];
    if (presentation.tokenCount !== undefined) counts.push(`${presentation.tokenCount.toLocaleString()} tokens`);
    if (presentation.frameCount !== undefined) counts.push(`${presentation.frameCount.toLocaleString()} frames`);
    return counts.join(" · ");
  }

  function previewText(value: string): string {
    return value.length > 240 ? `${value.slice(0, 239)}…` : value;
  }
</script>

{#if !presentation}
  <div class="timeline-special-fallback" aria-label="Special message">
    <div class="message-copy">{@html renderMarkdown(text)}</div>
  </div>
{:else if presentation.type === "irc"}
  <section class="timeline-presentation timeline-irc tone-info" aria-label={`${displayRoute(presentation)} message`}>
    <header class="timeline-presentation-header">
      <strong>{displayRoute(presentation)}</strong>
      {#if presentation.direction === "autoreply"}<span class="timeline-badge">auto</span>{/if}
      {#if presentation.reply}<span class="timeline-meta">reply: {presentation.reply}</span>{/if}
    </header>
    {#if presentation.previewLines.length > 0}
      <div class="timeline-irc-preview">
        {#each presentation.previewLines.slice(0, 3) as line}
          <div>{@html renderMarkdown(line)}</div>
        {/each}
      </div>
    {/if}
    {#if text}
      <details class="timeline-presentation-details">
        <summary>Show full IRC message</summary>
        <div class="message-copy">{@html renderMarkdown(text)}</div>
      </details>
    {/if}
  </section>
{:else if presentation.type === "advisor"}
  <section class="timeline-presentation timeline-advisor" aria-label={`Advisor notes, ${presentation.blockerCount} blockers`}>
    <header class="timeline-presentation-header">
      <strong>Advisor notes</strong>
      <span class="timeline-meta">{presentation.total} total · {presentation.blockerCount} blockers</span>
    </header>
    <div class="timeline-advisor-notes">
      {#each presentation.notes.slice(0, 3) as note}
        <div class="timeline-advisor-note severity-{note.severity}" aria-label={`${note.severity} advisor note`}>
          <span class="timeline-advisor-severity">{note.severity}</span>
          {#if note.advisor}<span class="timeline-meta">{note.advisor}</span>{/if}
          <div>{@html renderMarkdown(note.note)}</div>
        </div>
      {/each}
    </div>
    {#if presentation.notes.length > 3 || (presentation.omittedCount ?? 0) > 0}
      <details class="timeline-presentation-details">
        <summary>Show remaining advisor notes</summary>
        {#each presentation.notes.slice(3) as note}
          <div class="timeline-advisor-note severity-{note.severity}">
            <span class="timeline-advisor-severity">{note.severity}</span>
            {#if note.advisor}<span class="timeline-meta">{note.advisor}</span>{/if}
            <div>{@html renderMarkdown(note.note)}</div>
          </div>
        {/each}
        {#if presentation.omittedCount}<p class="timeline-meta">{presentation.omittedCount} more notes omitted.</p>{/if}
      </details>
    {/if}
  </section>
{:else if presentation.type === "status"}
  <section class="timeline-presentation timeline-status tone-{toneLabel(presentation.tone)}" aria-label={`${presentation.title}, ${presentation.tone}`}>
    <div class="timeline-status-row">
      <strong>{presentation.title}</strong>
      {#if presentation.source}<span class="timeline-meta">{presentation.source}</span>{/if}
      {#if presentation.meta}
        {#each presentation.meta as entry}<span class="timeline-meta">{entry.label}: {entry.value}</span>{/each}
      {/if}
    </div>
    {#if text}<span class="timeline-status-message">{text}</span>{/if}
    {#if presentation.entries && presentation.entries.length > 0}
      <div class="timeline-status-entries">
        {#each presentation.entries.slice(0, 4) as entry}
          <span class="timeline-status-entry" class:tone-warning={entry.tone === "warning"} class:tone-error={entry.tone === "error"}>{entry.label}: {entry.value}</span>
        {/each}
      </div>
      {#if presentation.entries.length > 4 || (presentation.omittedCount ?? 0) > 0}
        <details class="timeline-presentation-details">
          <summary>Show status details</summary>
          {#each presentation.entries.slice(4) as entry}<div>{entry.label}: {entry.value}</div>{/each}
          {#if presentation.omittedCount}<div class="timeline-meta">{presentation.omittedCount} more entries omitted.</div>{/if}
        </details>
      {/if}
    {/if}
  </section>
{:else if presentation.type === "activity"}
  <section class="timeline-presentation timeline-activity tone-{toneLabel(presentation.tone)}" aria-label={`${presentation.title} activity`}>
    <header class="timeline-presentation-header"><strong>{presentation.title}</strong><span class="timeline-meta">{presentation.category}</span></header>
    <div class="timeline-activity-entries">
      {#each presentation.entries.slice(0, 4) as entry}
        <div class="timeline-activity-entry"><span>{entry.label}</span>{#if entry.value}<code>{entry.value}</code>{/if}{#if entry.status}<span class="timeline-meta">{entry.status}</span>{/if}</div>
      {/each}
    </div>
    {#if presentation.entries.length > 4 || (presentation.omittedCount ?? 0) > 0}
      <details class="timeline-presentation-details">
        <summary>Show activity details</summary>
        {#each presentation.entries.slice(4) as entry}<div class="timeline-activity-entry"><span>{entry.label}</span>{#if entry.value}<code>{entry.value}</code>{/if}{#if entry.status}<span class="timeline-meta">{entry.status}</span>{/if}</div>{/each}
        {#if presentation.omittedCount}<div class="timeline-meta">{presentation.omittedCount} more entries omitted.</div>{/if}
      </details>
    {/if}
  </section>
{:else if presentation.type === "custom"}
  <section class="timeline-presentation timeline-custom variant-{presentation.variant}" aria-label={presentation.title}>
    <header class="timeline-presentation-header">
      <strong>{presentation.title}</strong>
      {#if presentation.attribution}<span class="timeline-meta">{presentation.attribution}</span>{/if}
    </header>
    {#if presentation.meta}
      <div class="timeline-custom-meta">
        {#each presentation.meta as entry}<span class="timeline-meta">{entry.label}: {entry.value}</span>{/each}
      </div>
    {/if}
    {#if customNeedsDetails(presentation) && presentation.previewLines.length > 0}
      <div class="timeline-custom-preview">
        {#each presentation.previewLines.slice(0, 3) as line}<pre>{previewText(line)}</pre>{/each}
      </div>
    {/if}
    {#if text}
      {#if customNeedsDetails(presentation)}
        <details class="timeline-presentation-details" bind:open={customExpanded}>
          <summary>Show full {presentation.variant} message</summary>
          {#if customExpanded}<div class="message-copy">{@html renderMarkdown(text)}</div>{/if}
        </details>
      {:else}
        <div class="message-copy">{@html renderMarkdown(text)}</div>
      {/if}
    {/if}
    {#if presentation.omittedCount}<p class="timeline-meta">{presentation.omittedCount} more lines omitted.</p>{/if}
  </section>
{:else if presentation.type === "context"}
  <section class="timeline-presentation timeline-context" aria-label={presentation.title}>
    <div class="timeline-context-divider"><span>{presentation.title}</span>{#if contextSummary(presentation)}<span class="timeline-meta">{contextSummary(presentation)}</span>{/if}{#if presentation.warning}<span class="timeline-warning">{presentation.warning}</span>{/if}</div>
    {#if presentation.previewLines.length > 0}<div class="timeline-context-preview">{#each presentation.previewLines.slice(0, 2) as line}<span>{previewText(line)}</span>{/each}</div>{/if}
    {#if text}
      <details class="timeline-presentation-details" bind:open={contextExpanded}>
        <summary>Show full {presentation.transition} summary</summary>
        {#if contextExpanded}<div class="message-copy">{@html renderMarkdown(text)}</div>{/if}
      </details>
    {/if}
    {#if presentation.omittedCount}<span class="timeline-meta">{presentation.omittedCount} more lines omitted.</span>{/if}
  </section>
{:else if presentation.type === "execution"}
  <section class="timeline-presentation timeline-execution tone-{executionTone(presentation)}" aria-label={`${presentation.engine} execution, ${executionState(presentation)}`}>
    <header class="timeline-presentation-header"><strong>{presentation.engine}</strong><span class="timeline-execution-state">{executionState(presentation)}</span>{#if presentation.excludedFromContext}<span class="timeline-meta">excluded from context</span>{/if}</header>
    <pre class="timeline-execution-input">{presentation.input}</pre>
    {#if presentation.outputPreview.length > 0}<pre class="timeline-execution-output">{presentation.outputPreview.slice(0, 3).join("\n")}</pre>{/if}
    {#if text}
      <details class="timeline-presentation-details" bind:open={executionExpanded}>
        <summary>Show full output</summary>
        {#if executionExpanded}<pre class="timeline-execution-output-full">{text}</pre>{/if}
      </details>
    {/if}
    {#if presentation.omittedCount}<span class="timeline-meta">{presentation.omittedCount} more output lines omitted.</span>{/if}
  </section>
{:else}
  <section class="timeline-presentation timeline-assistant-outcome outcome-{presentation.mode} tone-{toneLabel(presentation.tone)}" aria-label={presentation.label}>
    <div class="timeline-status-row"><strong>{presentation.label}</strong>{#if presentation.mode === "recovered"}<span class="timeline-meta">Recovered retry</span>{/if}</div>
    {#if presentation.previewLines.length > 0}<div class="timeline-outcome-preview">{#each presentation.previewLines.slice(0, 8) as line}<span>{@html renderMarkdown(line)}</span>{/each}</div>{/if}
    {#if presentation.mode === "error" && text}
      <details class="timeline-presentation-details" bind:open={outcomeExpanded}>
        <summary>Show full provider error</summary>
        {#if outcomeExpanded}<div class="message-copy">{@html renderMarkdown(text)}</div>{/if}
      </details>
    {/if}
    {#if presentation.omittedCount}<span class="timeline-meta">{presentation.omittedCount} more lines omitted.</span>{/if}
  </section>
{/if}

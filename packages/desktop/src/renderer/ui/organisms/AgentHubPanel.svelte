<script lang="ts">
  import type { AgentHubAgent } from "../../../shared/contracts";

  export let agents: AgentHubAgent[] = [];
  export let selectedAgentId = "";
  export let rosterOnly = false;
  export let detailOnly = false;
  export let titleId = "agent-hub-title";
  export let messageInputId = "agent-hub-message";
  export let messages: unknown[] = [];
  export let messagesLoading = false;
  export let messageError = "";
  export let draft = "";
  export let actionBusy = "";
  export let onSelect: (agentId: string) => void;
  export let onLoadMessages: () => void;
  export let onSend: (message: string) => void;
  export let onKill: (agentId: string) => void;
  export let onRevive: (agentId: string) => void;

  interface MessageSummary {
    key: string;
    role: string;
    text: string;
  }

  const MESSAGE_CHARACTER_LIMIT = 1_600;
  const MESSAGE_LINE_LIMIT = 24;
  const MESSAGE_LINE_CHARACTER_LIMIT = 240;
  const MESSAGE_CHUNK_LIMIT = 12;
  const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const currency = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });

  $: selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  $: messageSummaries = messages.map(summarizeMessage);
  $: busy = actionBusy.length > 0;
  $: selectedIsReadOnly = selectedAgent ? isReadOnly(selectedAgent) : true;
  $: canSend = Boolean(selectedAgent && !selectedIsReadOnly && selectedAgent.status !== "aborted" && draft.trim());

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedText(value: string): string {
    const normalized = value.replace(/\r\n?/g, "\n").replaceAll("\u0000", "");
    const sourceLines = normalized.split("\n");
    const lines = sourceLines
      .slice(0, MESSAGE_LINE_LIMIT)
      .map(line => line.length > MESSAGE_LINE_CHARACTER_LIMIT ? `${line.slice(0, MESSAGE_LINE_CHARACTER_LIMIT - 1)}…` : line);
    let text = lines.join("\n").trim();
    let truncated = sourceLines.length > MESSAGE_LINE_LIMIT;
    if (text.length > MESSAGE_CHARACTER_LIMIT) {
      text = `${text.slice(0, MESSAGE_CHARACTER_LIMIT - 1).trimEnd()}…`;
      truncated = false;
    }
    if (truncated) text = `${text}\n…`;
    return text;
  }

  function collectText(value: unknown, chunks: string[], depth = 0): void {
    if (chunks.length >= MESSAGE_CHUNK_LIMIT || depth > 3) return;
    if (typeof value === "string") {
      if (value.trim()) chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, MESSAGE_CHUNK_LIMIT)) {
        collectText(entry, chunks, depth + 1);
        if (chunks.length >= MESSAGE_CHUNK_LIMIT) break;
      }
      return;
    }
    if (!isRecord(value)) return;

    for (const key of ["text", "content", "message", "summary"] as const) {
      const child: unknown = value[key];
      if (child === value) continue;
      collectText(child, chunks, depth + 1);
      if (chunks.length >= MESSAGE_CHUNK_LIMIT) break;
    }
  }

  function roleLabel(value: unknown): string {
    if (!isRecord(value)) return "Message";
    const role = typeof value.role === "string"
      ? value.role
      : typeof value.type === "string"
        ? value.type
        : typeof value.sender === "string"
          ? value.sender
          : "Message";
    const normalized = boundedText(role)
      .slice(0, 32)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim();
    return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Message";
  }

  function summarizeMessage(message: unknown, index: number): MessageSummary {
    const chunks: string[] = [];
    collectText(message, chunks);
    const text = boundedText(chunks.join("\n\n"));
    return {
      key: `${index}:${roleLabel(message)}`,
      role: roleLabel(message),
      text: text || "Message text is not available.",
    };
  }

  function activityFor(agent: AgentHubAgent): string {
    return agent.activity ?? agent.progress?.lastIntent ?? agent.progress?.currentTool ?? "Waiting for activity";
  }

  function modelFor(agent: AgentHubAgent): string {
    return agent.resolvedModel ?? agent.progress?.resolvedModel ?? agent.modelRole ?? agent.agent ?? "Model unavailable";
  }

  function tokensFor(agent: AgentHubAgent): number | undefined {
    return agent.metrics?.tokens ?? agent.progress?.tokens;
  }

  function contextFor(agent: AgentHubAgent): string | undefined {
    const used = agent.metrics?.contextTokens ?? agent.progress?.contextTokens;
    const window = agent.metrics?.contextWindow ?? agent.progress?.contextWindow;
    if (used === undefined && window === undefined) return undefined;
    if (used === undefined) return `${compactNumber.format(window ?? 0)} context`;
    if (window === undefined) return `${compactNumber.format(used)} context`;
    return `${compactNumber.format(used)} / ${compactNumber.format(window)} context`;
  }

  function costFor(agent: AgentHubAgent): number | undefined {
    return agent.metrics?.cost ?? agent.progress?.cost;
  }

  function durationFor(agent: AgentHubAgent): number | undefined {
    return agent.metrics?.durationMs ?? agent.progress?.durationMs;
  }

  function formatDuration(durationMs: number): string {
    const seconds = Math.max(0, Math.round(durationMs / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function isReadOnly(agent: AgentHubAgent): boolean {
    return agent.kind === "advisor" || agent.readOnly || agent.status === "aborted";
  }

  function handleSubmit(): void {
    const message = draft.trim();
    if (!selectedAgent || !canSend || busy) return;
    onSend(message);
  }

  function handleKill(agent: AgentHubAgent): void {
    if (busy || agent.kind === "advisor" || agent.readOnly || agent.status === "aborted") return;
    if (window.confirm(`Kill ${agent.displayName}? The transcript remains available as history.`)) {
      onKill(agent.id);
    }
  }
</script>

<section class="agent-hub-panel" class:roster-only={rosterOnly} class:detail-only={detailOnly} aria-labelledby={titleId} aria-busy={messagesLoading || busy}>
  <header class="panel-header">
    <div>
      <h2 id={titleId}>Agent Hub</h2>
      <p>{agents.length} agent{agents.length === 1 ? "" : "s"}</p>
    </div>
    {#if busy}<span class="busy-label" role="status">Updating…</span>{/if}
  </header>

  {#if agents.length === 0}
    <div class="panel-empty" role="status">
      <strong>No retained agents</strong>
      <p>Agents and advisor transcripts from this chat will appear here when they are available.</p>
    </div>
  {:else}
    <nav class="agent-roster" aria-label="Agents in this chat">
      <ul class="agent-list">
        {#each agents as agent (agent.id)}
          <li class:is-child={Boolean(agent.parentId)}>
            <button
              type="button"
              class="agent-card"
              class:selected={agent.id === selectedAgentId}
              aria-current={agent.id === selectedAgentId ? "true" : undefined}
              aria-label={`${agent.displayName}, ${agent.status}${isReadOnly(agent) ? ", read only" : ""}`}
              on:click={() => onSelect(agent.id)}
            >
              <span class="status-dot status-{agent.status}" aria-hidden="true"></span>
              <span class="agent-copy">
                <span class="agent-name-line">
                  <strong>{agent.displayName}</strong>
                  {#if agent.kind === "advisor"}<span class="read-only-badge">Advisor · read only</span>{/if}
                  {#if agent.status === "aborted"}<span class="history-badge">History</span>{/if}
                </span>
                <small title={activityFor(agent)}>{activityFor(agent)}</small>
                <span class="agent-model" title={modelFor(agent)}>{modelFor(agent)}</span>
                <span class="agent-metrics" aria-label={`Metrics for ${agent.displayName}`}>
                  {#if tokensFor(agent) !== undefined}<span>{compactNumber.format(tokensFor(agent) ?? 0)} tokens</span>{/if}
                  {#if contextFor(agent)}<span>{contextFor(agent)}</span>{/if}
                  {#if costFor(agent) !== undefined}<span>{currency.format(costFor(agent) ?? 0)}</span>{/if}
                </span>
              </span>
              <span class="agent-status">{agent.status}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>

    {#if selectedAgent}
      <section class="agent-detail" aria-labelledby="selected-agent-title">
        <header class="agent-detail-header">
          <div class="agent-detail-title">
            <span class="status-dot status-{selectedAgent.status}" aria-hidden="true"></span>
            <div>
              <h3 id="selected-agent-title">{selectedAgent.displayName}</h3>
              <p>{selectedAgent.kind === "advisor" ? "Advisor transcript" : `${selectedAgent.status} agent`}</p>
            </div>
          </div>
          <div class="agent-actions">
            {#if selectedAgent.status === "parked" && selectedAgent.kind !== "advisor" && !selectedAgent.readOnly}
              <button type="button" class="panel-button" disabled={busy} on:click={() => onRevive(selectedAgent.id)}>
                Revive agent
              </button>
            {/if}
            {#if selectedAgent.kind !== "advisor" && !selectedAgent.readOnly && selectedAgent.status !== "aborted"}
              <button type="button" class="panel-button danger" disabled={busy} on:click={() => handleKill(selectedAgent)}>
                Kill agent
              </button>
            {/if}
          </div>
        </header>

        <dl class="selected-agent-metrics">
          <div><dt>Status</dt><dd>{selectedAgent.status}</dd></div>
          <div><dt>Model</dt><dd title={modelFor(selectedAgent)}>{modelFor(selectedAgent)}</dd></div>
          <div><dt>Activity</dt><dd title={activityFor(selectedAgent)}>{activityFor(selectedAgent)}</dd></div>
          {#if tokensFor(selectedAgent) !== undefined}<div><dt>Tokens</dt><dd>{compactNumber.format(tokensFor(selectedAgent) ?? 0)}</dd></div>{/if}
          {#if contextFor(selectedAgent)}<div><dt>Context</dt><dd>{contextFor(selectedAgent)}</dd></div>{/if}
          {#if selectedAgent.metrics?.requests !== undefined}<div><dt>Requests</dt><dd>{selectedAgent.metrics.requests}</dd></div>{/if}
          {#if selectedAgent.metrics?.tools !== undefined}<div><dt>Tools</dt><dd>{selectedAgent.metrics.tools}</dd></div>{/if}
          {#if costFor(selectedAgent) !== undefined}<div><dt>Cost</dt><dd>{currency.format(costFor(selectedAgent) ?? 0)}</dd></div>{/if}
          {#if durationFor(selectedAgent) !== undefined}<div><dt>Duration</dt><dd>{formatDuration(durationFor(selectedAgent) ?? 0)}</dd></div>{/if}
        </dl>

        {#if selectedAgent.kind === "advisor" || selectedAgent.readOnly}
          <p class="read-only-notice" role="note">This advisor is read only. You can review its transcript, but you cannot send messages or change its lifecycle.</p>
        {:else if selectedAgent.status === "aborted"}
          <p class="read-only-notice" role="note">This agent was aborted. Its transcript remains available as history.</p>
        {/if}

        <div class="transcript-toolbar">
          <strong>Transcript</strong>
          <button
            type="button"
            class="text-button"
            disabled={messagesLoading || !selectedAgent.transcriptAvailable}
            on:click={onLoadMessages}
          >
            {messagesLoading ? "Refreshing…" : "Refresh transcript"}
          </button>
        </div>

        <div class="transcript-region" role="log" aria-label={`${selectedAgent.displayName} transcript`} aria-live="polite">
          {#if messageError}
            <div class="transcript-state error" role="alert">
              <strong>Transcript unavailable</strong>
              <span>{messageError}</span>
            </div>
          {/if}

          {#if !selectedAgent.transcriptAvailable}
            <div class="transcript-state">
              <strong>No transcript</strong>
              <span>This agent does not have a retained transcript.</span>
            </div>
          {:else if messagesLoading && messageSummaries.length === 0 && !messageError}
            <div class="transcript-loading" role="status" aria-label="Loading agent transcript">
              <span></span><span></span><span></span>
            </div>
          {:else if messageSummaries.length === 0 && !messageError}
            <div class="transcript-state">
              <strong>No messages yet</strong>
              <span>Refresh after the agent begins work to load its transcript.</span>
            </div>
          {:else if messageSummaries.length > 0}
            <ol class="message-list">
              {#each messageSummaries as message (message.key)}
                <li>
                  <span class="message-role">{message.role}</span>
                  <pre>{message.text}</pre>
                </li>
              {/each}
            </ol>
          {/if}
        </div>

        {#if !selectedIsReadOnly && selectedAgent.transcriptAvailable}
          <form class="message-composer" on:submit|preventDefault={handleSubmit}>
            <label for={messageInputId}>Message {selectedAgent.displayName}</label>
            <textarea
              id={messageInputId}
              rows="3"
              maxlength="4000"
              placeholder="Send a focused follow-up"
              bind:value={draft}
              disabled={busy}
            ></textarea>
            <div class="composer-footer">
              {#if selectedAgent.status === "parked"}<span>Sending a message revives this parked agent.</span>{:else}<span>Message the selected agent.</span>{/if}
              <button type="submit" class="panel-button primary" disabled={!canSend || busy}>Send message</button>
            </div>
          </form>
        {/if}
      </section>
    {:else}
      <div class="panel-empty selection-empty" role="status">
        <strong>Select an agent</strong>
        <p>Choose a roster entry to review its transcript, activity, and available actions.</p>
      </div>
    {/if}
  {/if}
</section>

<style>
  .agent-hub-panel {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    color: var(--foreground);
    background: var(--shell);
  }

  .agent-hub-panel.roster-only .agent-detail,
  .agent-hub-panel.roster-only .selection-empty {
    display: none;
  }

  .agent-hub-panel.detail-only .agent-roster,
  .agent-hub-panel.detail-only > .panel-empty {
    display: none;
  }
  .agent-hub-panel.detail-only > .panel-header {
    display: none;
  }


  .panel-header,
  .agent-detail-header,
  .transcript-toolbar,
  .composer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .panel-header {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--line);
    padding: 16px;
  }

  .panel-header h2,
  .agent-detail-header h3 {
    margin: 0;
    color: var(--foreground-strong);
    font-family: var(--font-sans);
  }

  .panel-header h2 {
    font-size: 0.875rem;
    line-height: 1.25;
  }

  .panel-header p,
  .agent-detail-header p {
    margin: 4px 0 0;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.4;
  }

  .busy-label {
    color: var(--foreground);
    font-size: 14px;
  }

  .agent-roster {
    max-height: min(38%, 320px);
    flex: 0 1 auto;
    overflow: auto;
    border-bottom: 1px solid var(--line);
    padding: 8px;
    overscroll-behavior: contain;
  }

  .agent-list,
  .message-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .agent-list li.is-child {
    position: relative;
    padding-inline-start: 16px;
  }

  .agent-list li.is-child::before {
    position: absolute;
    width: 8px;
    height: 12px;
    margin: 8px 0 0 -12px;
    border-bottom: 1px solid var(--line);
    border-left: 1px solid var(--line);
    border-radius: 0 0 0 var(--radius-small);
    content: "";
  }

  .agent-card {
    width: 100%;
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) auto;
    align-items: start;
    gap: 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-small);
    padding: 8px;
    color: var(--foreground);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background 160ms var(--ease-standard), border-color 160ms var(--ease-standard);
  }

  .agent-card:hover {
    border-color: var(--line);
    background: var(--shell-hover);
  }

  .agent-card.selected {
    border-color: var(--accent-boundary);
    color: var(--selection-foreground);
    background: var(--selection-surface);
    box-shadow: inset 2px 0 0 var(--accent-boundary);
  }

  .agent-card.selected .agent-copy strong,
  .agent-card.selected .agent-copy small,
  .agent-card.selected .agent-model,
  .agent-card.selected .agent-metrics,
  .agent-card.selected .agent-status,
  .agent-card.selected .read-only-badge,
  .agent-card.selected .history-badge {
    color: var(--selection-foreground);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    display: inline-block;
    flex: 0 0 8px;
    border-radius: 50%;
    background: var(--foreground-muted);
  }

  .agent-card .status-dot {
    margin-top: 4px;
  }

  .status-running,
  .status-idle {
    background: var(--success-boundary);
  }

  .status-parked {
    background: var(--warning-boundary);
  }

  .status-aborted {
    background: var(--danger-boundary);
  }

  .agent-copy,
  .agent-copy > span,
  .agent-copy strong,
  .agent-copy small {
    min-width: 0;
  }

  .agent-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .agent-name-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .agent-name-line strong,
  .agent-copy small,
  .agent-model {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-name-line strong {
    color: var(--foreground-strong);
    font-size: 14px;
    line-height: 1.35;
  }

  .agent-copy small,
  .agent-model {
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.35;
  }
  .agent-model {
    color: var(--foreground-muted);
  }

  .read-only-badge,
  .history-badge {
    flex: 0 0 auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
    padding: 2px 4px;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1;
  }

  .history-badge {
    border-color: var(--danger-boundary);
    color: var(--foreground);
  }

  .agent-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    margin-top: 2px;
    color: var(--foreground);
    font-size: 14px;
    line-height: 1.3;
  }

  .agent-status {
    margin-top: 1px;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.4;
    text-transform: lowercase;
  }

  .agent-detail {
    min-height: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
  }

  .agent-detail-header {
    align-items: flex-start;
    flex: 0 0 auto;
    border-bottom: 1px solid var(--line-soft);
    padding: 12px 16px;
  }

  .agent-detail-title,
  .agent-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .agent-detail-title {
    min-width: 0;
  }

  .agent-detail-title > div {
    min-width: 0;
  }

  .agent-detail-header h3 {
    overflow: hidden;
    font-size: 14px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-actions {
    flex: 0 0 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .selected-agent-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    flex: 0 0 auto;
    gap: 1px;
    margin: 0;
    border-bottom: 1px solid var(--line-soft);
    background: var(--line-soft);
  }

  .selected-agent-metrics > div {
    min-width: 0;
    padding: 8px 12px;
    background: var(--shell);
  }

  .selected-agent-metrics dt,
  .selected-agent-metrics dd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-agent-metrics dt {
    color: var(--foreground-muted);
    font-size: 14px;
  }

  .selected-agent-metrics dd {
    margin: 3px 0 0;
    color: var(--foreground);
    font-size: 14px;
    line-height: 1.35;
  }
  .read-only-notice {
    flex: 0 0 auto;
    margin: 0;
    border-bottom: 1px solid var(--line-soft);
    padding: 8px 16px;
    color: var(--foreground-muted);
    background: var(--shell-raised);
    font-size: 14px;
    line-height: 1.5;
  }

  .transcript-toolbar {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--line-soft);
    padding: 8px 16px;
  }

  .transcript-toolbar strong,
  .message-composer label {
    color: var(--foreground-strong);
    font-size: 14px;
    line-height: 1.4;
  }

  .transcript-region {
    min-height: 128px;
    flex: 1 1 auto;
    overflow: auto;
    background: var(--chat-canvas);
    overscroll-behavior: contain;
  }

  .message-list {
    display: flex;
    flex-direction: column;
  }

  .message-list li {
    border-bottom: 1px solid var(--line-soft);
    padding: 12px 16px;
  }

  .message-role {
    display: block;
    margin-bottom: 6px;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1;
  }

  .message-list pre {
    max-width: 75ch;
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--foreground);
    font: 14px/1.55 var(--font-mono);
    white-space: pre-wrap;
  }

  .transcript-state,
  .panel-empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 6px;
    padding: 24px 16px;
    color: var(--foreground-muted);
  }

  .transcript-state strong,
  .panel-empty strong {
    color: var(--foreground);
    font-size: 14px;
  }

  .transcript-state span,
  .panel-empty p {
    margin: 0;
    max-width: 65ch;
    font-size: 14px;
    line-height: 1.5;
  }

  .transcript-state.error {
    border-bottom: 1px solid var(--danger-boundary);
    color: var(--foreground);
    background: var(--danger-surface);
  }

  .transcript-state.error strong {
    color: var(--foreground-strong);
  }

  .transcript-loading {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
  }

  .transcript-loading span {
    width: 100%;
    height: 12px;
    border-radius: var(--radius-small);
    background: var(--line-soft);
    animation: loading-pulse 1.2s ease-in-out infinite alternate;
  }

  .transcript-loading span:nth-child(2) {
    width: 76%;
  }

  .transcript-loading span:nth-child(3) {
    width: 88%;
  }

  .message-composer {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 8px;
    border-top: 1px solid var(--line);
    padding: 12px 16px;
    background: var(--shell);
  }

  .message-composer textarea {
    width: 100%;
    min-height: 64px;
    resize: vertical;
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
    padding: 8px;
    color: var(--foreground);
    background: var(--chat-canvas);
    font: 14px/1.5 var(--font-mono);
  }

  .message-composer textarea::placeholder {
    color: var(--foreground-muted);
  }

  .composer-footer {
    align-items: flex-end;
  }

  .composer-footer > span {
    max-width: 42ch;
    color: var(--foreground-muted);
    font-size: 14px;
    line-height: 1.4;
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

  .panel-button.primary {
    border-color: var(--accent);
    color: var(--accent-foreground);
    background: var(--accent);
  }

  .panel-button.primary:hover:not(:disabled) {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
  }

  .panel-button.danger {
    border-color: var(--danger-boundary);
    color: var(--danger-foreground);
    background: var(--danger);
  }

  .panel-button.danger:hover:not(:disabled) {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
    color: var(--accent-foreground);
  }

  .text-button {
    border: 0;
    padding: 4px;
    color: var(--foreground);
    font-size: 14px;
  }

  .text-button:hover:not(:disabled) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .selection-empty {
    flex: 1 1 auto;
  }

  @keyframes loading-pulse {
    from { opacity: 0.48; }
    to { opacity: 1; }
  }

  @media (max-width: 420px) {
    .agent-detail-header,
    .composer-footer {
      align-items: stretch;
      flex-direction: column;
    }

    .agent-actions {
      justify-content: flex-start;
    }

    .selected-agent-metrics {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .agent-card {
      transition: none;
    }

    .transcript-loading span {
      animation: none;
    }
  }
</style>

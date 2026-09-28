<script lang="ts">
	import type { LocalChatConnectionView } from "../../../shared/local-chat-consent";

	export let connections: LocalChatConnectionView[] = [];
	export let loading = false;
	export let error = "";
	export let busyGrantIds: ReadonlySet<string> = new Set();
	export let onRevoke: (grantId: string) => Promise<void>;

	const dateTime = new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

	function formatDate(value: number): string {
		return dateTime.format(new Date(value));
	}
</script>

<section class="settings-section local-connections" aria-labelledby="local-connections-title">
	<header class="settings-section-heading">
		<div>
			<h3 id="local-connections-title">Local app connections</h3>
			<p>Browser tabs approved to use the local Gradivus Chat API.</p>
		</div>
	</header>
	<p class="security-note-copy">
		The Gradivus Chat connection API does not expose provider credentials or local API tokens.
	</p>

	{#if error}
		<p class="settings-feedback settings-feedback-error" role="alert">{error}</p>
	{/if}
	{#if loading}
		<div class="settings-empty compact" role="status"><p>Loading local app connections…</p></div>
	{:else if connections.length === 0}
		<div class="settings-empty compact">
			<strong>No local app connections</strong>
			<p>Connections appear here after you allow a browser tab to use Gradivus Desktop.</p>
		</div>
	{:else}
		<div class="local-connection-list">
			{#each connections as connection (connection.grantId)}
				<article class="local-connection-row" aria-labelledby={`local-connection-${connection.grantId}`}>
					<div class="local-connection-heading">
						<div>
							<strong id={`local-connection-${connection.grantId}`}>{connection.clientName}</strong>
							<code>{connection.origin}</code>
						</div>
						<span class={`provider-state ${connection.status === "active" ? "connected" : ""}`}>
							{connection.status}
						</span>
					</div>
					<ul class="local-connection-scopes" aria-label="Approved access">
						{#each connection.scopes as scope (scope.scope)}
							<li>{scope.label}</li>
						{/each}
					</ul>
					<dl class="local-connection-meta">
						<div><dt>Created</dt><dd>{formatDate(connection.createdAt)}</dd></div>
						<div><dt>Last used</dt><dd>{formatDate(connection.lastUsedAt)}</dd></div>
						<div><dt>Expires</dt><dd>{formatDate(connection.expiresAt)}</dd></div>
						<div><dt>Active tokens</dt><dd>{connection.activeTokenCount}</dd></div>
					</dl>
					<div class="local-connection-actions">
						<button
							type="button"
							class="danger-button"
							disabled={busyGrantIds.has(connection.grantId) || connection.status !== "active"}
							aria-busy={busyGrantIds.has(connection.grantId)}
							onclick={() => void onRevoke(connection.grantId)}
						>
							{busyGrantIds.has(connection.grantId) ? "Revoking…" : "Revoke access"}
						</button>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</section>

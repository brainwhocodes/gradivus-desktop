<script lang="ts">
	import type { PaneAutomationState } from "../../../shared/contracts";

	interface Props {
		sessionId: string;
		paneId: string;
		automationState?: PaneAutomationState;
		onstate: (state: PaneAutomationState) => void;
		onclose: () => void;
	}

	let { sessionId, paneId, automationState, onstate, onclose }: Props = $props();
	let busy = $state<"observe" | "control" | "revoke" | "refresh" | "">("");
	let error = $state("");

	async function authorize(access: "observe" | "control"): Promise<void> {
		busy = access;
		error = "";
		try {
			onstate(await window.gradivus.requestPaneAuthorization(sessionId, paneId, access));
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			busy = "";
		}
	}

	async function revoke(): Promise<void> {
		busy = "revoke";
		error = "";
		try {
			onstate(await window.gradivus.revokePane(sessionId, paneId));
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			busy = "";
		}
	}

	async function refresh(): Promise<void> {
		if (!sessionId) return;
		busy = "refresh";
		error = "";
		try {
			onstate(await window.gradivus.getPaneAutomation(sessionId, paneId));
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			busy = "";
		}
	}

	async function closeOmpTab(name: string): Promise<void> {
		error = "";
		try {
			const result = await window.gradivus.closeBrowserTabForSession(sessionId, name);
			onstate({ ...(automationState ?? { available: true }), tabs: result.inventory });
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
	}
</script>

<aside class="browser-automation-pane" aria-label="Browser automation access">
	<header>
		<div><span class="eyebrow">Agent access</span><h2>Browser automation</h2></div>
		<button type="button" class="secondary-button" onclick={onclose}>Close</button>
	</header>
	{#if !sessionId}
		<p>Select an OMP chat before authorizing this pane.</p>
	{:else if automationState?.available === false}
		<p role="status">{automationState.reason ?? "Pane automation is unavailable."}</p>
	{:else if automationState?.lease}
		<div class="browser-automation-lease">
			<strong>{automationState.lease.access === "control" ? "Control" : "Read"} access</strong>
			<span>{automationState.lease.healthy ? "Authorized for this OMP runtime" : "Authorization lost"}</span>
			<code>Epoch {automationState.lease.documentEpoch}</code>
		</div>
		<div class="browser-automation-actions">
			{#if automationState.lease.access === "observe"}
				<button type="button" class="primary-button" disabled={Boolean(busy)} onclick={() => void authorize("control")}>Upgrade to Control</button>
			{/if}
			<button type="button" class="secondary-button" disabled={Boolean(busy)} onclick={() => void revoke()}>{busy === "revoke" ? "Revoking…" : "Revoke"}</button>
		</div>
	{:else}
		<p>Authorization is memory-only and bound to this pane, session, page epoch, and OMP runtime.</p>
		<div class="browser-automation-actions">
			<button type="button" class="secondary-button" disabled={Boolean(busy)} onclick={() => void authorize("observe")}>{busy === "observe" ? "Waiting…" : "Allow Read"}</button>
			<button type="button" class="primary-button" disabled={Boolean(busy)} onclick={() => void authorize("control")}>{busy === "control" ? "Waiting…" : "Allow Control"}</button>
		</div>
	{/if}
	{#if sessionId}
		<section class="browser-automation-tabs" aria-labelledby="omp-browser-tabs-heading">
			<header>
				<div>
					<h3 id="omp-browser-tabs-heading">OMP browser tabs</h3>
					<span>Scoped to this chat process</span>
				</div>
				<button type="button" class="secondary-button" disabled={Boolean(busy)} onclick={() => void refresh()}>
					{busy === "refresh" ? "Refreshing…" : "Refresh"}
				</button>
			</header>
			{#if automationState === undefined}
				<p role="status">Loading OMP browser inventory…</p>
			{:else if (automationState.tabs?.length ?? 0) === 0}
				<p>No OMP-owned browser tabs in this chat.</p>
			{:else}
				<ul>
					{#each automationState.tabs ?? [] as tab (tab.name)}
						<li>
							<div class="browser-automation-tab-copy">
								<strong>{tab.title || tab.name}</strong>
								<span>{tab.name} · {tab.browser} · {tab.state}</span>
								<code>{tab.url || "No URL"}</code>
								<span title={tab.owners.join(", ")}>{tab.owners.length > 0 ? tab.owners.join(", ") : "No owners"} · {tab.activeRunCount} active · {tab.queuedRunCount} queued</span>
							</div>
							<button type="button" class="secondary-button" onclick={() => void closeOmpTab(tab.name)}>Close OMP tab</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
	{#if error}<p class="browser-automation-error" role="alert">{error}</p>{/if}
</aside>

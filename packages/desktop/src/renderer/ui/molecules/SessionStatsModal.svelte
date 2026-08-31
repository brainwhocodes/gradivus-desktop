<script lang="ts">
	import type { SessionStatsView } from "../../../shared/contracts";
	import ModalShell from "./ModalShell.svelte";

	interface Props {
		stats: SessionStatsView;
		onclose: () => void;
	}

	let { stats, onclose }: Props = $props();
</script>

<svelte:window onkeydown={(event) => {
	if (event.key !== "Escape") return;
	event.preventDefault();
	onclose();
}} />

<ModalShell
	backdrop={true}
	backdropClass="session-stats-backdrop"
	dialogClass="session-stats-dialog"
	labelledbyId="session-stats-title"
	{onclose}
	cancelable={true}
>
	<header>
		<div>
			<span class="eyebrow">OMP session</span>
			<h2 id="session-stats-title">Session statistics</h2>
		</div>
		<button type="button" class="secondary-button" onclick={onclose}>Close</button>
	</header>
	<div class="session-stats-grid">
		<div><span>User messages</span><strong>{stats.userMessages.toLocaleString()}</strong></div>
		<div><span>Assistant messages</span><strong>{stats.assistantMessages.toLocaleString()}</strong></div>
		<div><span>Tool calls</span><strong>{stats.toolCalls.toLocaleString()}</strong></div>
		<div><span>Tool results</span><strong>{stats.toolResults.toLocaleString()}</strong></div>
		<div><span>Total tokens</span><strong>{stats.tokens.total.toLocaleString()}</strong></div>
		<div><span>Input</span><strong>{stats.tokens.input.toLocaleString()}</strong></div>
		<div><span>Output</span><strong>{stats.tokens.output.toLocaleString()}</strong></div>
		<div><span>Reasoning</span><strong>{stats.tokens.reasoning.toLocaleString()}</strong></div>
		<div><span>Cache read</span><strong>{stats.tokens.cacheRead.toLocaleString()}</strong></div>
		<div><span>Cache write</span><strong>{stats.tokens.cacheWrite.toLocaleString()}</strong></div>
		<div><span>Premium requests</span><strong>{stats.premiumRequests.toLocaleString()}</strong></div>
		<div><span>Cost</span><strong>${stats.cost.toFixed(4)}</strong></div>
	</div>
	{#if stats.contextUsage}
		<p class="session-stats-context">
			Context: {stats.contextUsage.tokens.toLocaleString()} / {stats.contextUsage.contextWindow.toLocaleString()} tokens
			{#if stats.contextUsage.percentage !== undefined} ({Math.round(stats.contextUsage.percentage)}%){/if}
		</p>
	{/if}
</ModalShell>

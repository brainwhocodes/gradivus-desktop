<script lang="ts">
	import type { HostedSessionStats as SessionStatsView } from "../../contracts";
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
	dialogClass="session-stats-dialog stats-redesign"
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
	<div class="stats-layout" class:has-context={Boolean(stats.contextUsage)}>
		<div class="stats-main">
			<dl class="stats-summary">
				<div><dt>Total tokens</dt><dd>{stats.tokens.total.toLocaleString()}</dd></div>
				<div><dt>Cost</dt><dd>${stats.cost.toFixed(4)}</dd></div>
				<div><dt>Premium requests</dt><dd>{stats.premiumRequests.toLocaleString()}</dd></div>
			</dl>
			<section class="stats-section" aria-labelledby="session-stats-usage">
				<h3 id="session-stats-usage">Usage</h3>
				<dl class="stats-rows">
					<div><dt>Input</dt><dd>{stats.tokens.input.toLocaleString()}</dd></div>
					<div><dt>Output</dt><dd>{stats.tokens.output.toLocaleString()}</dd></div>
					<div><dt>Reasoning</dt><dd>{stats.tokens.reasoning.toLocaleString()}</dd></div>
					<div><dt>Cache read</dt><dd>{stats.tokens.cacheRead.toLocaleString()}</dd></div>
					<div><dt>Cache write</dt><dd>{stats.tokens.cacheWrite.toLocaleString()}</dd></div>
				</dl>
			</section>
			<section class="stats-section" aria-labelledby="session-stats-activity">
				<h3 id="session-stats-activity">Activity</h3>
				<dl class="stats-rows">
					<div><dt>User messages</dt><dd>{stats.userMessages.toLocaleString()}</dd></div>
					<div><dt>Assistant messages</dt><dd>{stats.assistantMessages.toLocaleString()}</dd></div>
					<div><dt>Tool calls</dt><dd>{stats.toolCalls.toLocaleString()}</dd></div>
					<div><dt>Tool results</dt><dd>{stats.toolResults.toLocaleString()}</dd></div>
				</dl>
			</section>
		</div>
		{#if stats.contextUsage}
			<aside class="stats-context" aria-labelledby="session-stats-context-title">
				<h3 id="session-stats-context-title">Context window</h3>
				{#if stats.contextUsage.percentage !== undefined}
					<strong class="stats-context-value">{Math.round(stats.contextUsage.percentage)}%</strong>
				{/if}
				{#if stats.contextUsage.contextWindow > 0}
					<progress aria-label="Context window used" max={stats.contextUsage.contextWindow} value={stats.contextUsage.tokens}></progress>
				{/if}
				<dl class="stats-rows">
					<div><dt>Used</dt><dd>{stats.contextUsage.tokens.toLocaleString()}</dd></div>
					<div><dt>Limit</dt><dd>{stats.contextUsage.contextWindow.toLocaleString()}</dd></div>
					<div><dt>Remaining</dt><dd>{Math.max(0, stats.contextUsage.contextWindow - stats.contextUsage.tokens).toLocaleString()}</dd></div>
				</dl>
				<p>Token usage for the current context window.</p>
			</aside>
		{/if}
	</div>
</ModalShell>

<style>
	:global(.session-stats-dialog.stats-redesign) {
		width: min(860px, calc(100vw - 40px));
		max-height: calc(100dvh - 64px);
		overflow: auto;
		padding: 28px;
		border: 1px solid var(--line);
		border-radius: var(--radius-medium);
		background: var(--shell);
		color: var(--foreground);
		font: 14px/1.5 var(--font-ui);
	}
	header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
	header h2 { margin: 4px 0 0; color: var(--foreground-strong); font: 650 24px/1.25 var(--font-ui); }
	.eyebrow { color: var(--foreground-muted); font: 13px/1.4 var(--font-ui); letter-spacing: 0; text-transform: none; }
	.stats-layout { display: grid; gap: 28px; padding-top: 24px; }
	.stats-layout.has-context { grid-template-columns: minmax(0, 1fr) 200px; }
	.stats-main { min-width: 0; }
	dl { margin: 0; }
	dd { margin: 0; color: var(--foreground-strong); font-variant-numeric: tabular-nums; }
	dt { color: var(--foreground-muted); }
	.stats-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 28px; }
	.stats-summary > div + div { padding-left: 16px; border-left: 1px solid var(--line); }
	.stats-summary dt { font-size: 12px; }
	.stats-summary dd { margin-top: 6px; font-size: clamp(22px, 2.5vw, 32px); font-weight: 550; line-height: 1.25; letter-spacing: -0.04em; }
	h3 { margin: 0 0 12px; color: var(--foreground-strong); font-size: 14px; font-weight: 600; }
	.stats-section + .stats-section { margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--line); }
	.stats-rows { display: grid; gap: 10px; }
	.stats-rows > div { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; }
	.stats-context { padding-left: 24px; border-left: 1px solid var(--line); }
	.stats-context-value { display: block; margin: 12px 0; font-size: 36px; font-weight: 550; line-height: 1.2; color: var(--foreground-strong); }
	.stats-context progress { appearance: none; display: block; width: 100%; height: 10px; margin: 16px 0 24px; overflow: hidden; border: 0; border-radius: 999px; background: var(--shell-hover); accent-color: var(--success-boundary); }
	.stats-context progress::-webkit-progress-bar { background: var(--shell-hover); }
	.stats-context progress::-webkit-progress-value { border-radius: 999px; background: var(--success-boundary); }
	.stats-context progress::-moz-progress-bar { border-radius: 999px; background: var(--success-boundary); }
	.stats-context p { margin: 20px 0 0; color: var(--foreground-muted); font-size: 12px; }
	@media (max-width: 640px) {
		:global(.session-stats-dialog.stats-redesign) { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); padding: 20px; }
		.stats-layout.has-context { grid-template-columns: minmax(0, 1fr); }
		.stats-context { padding: 24px 0 0; border-left: 0; border-top: 1px solid var(--line); }
		.stats-summary { gap: 12px; }
		.stats-summary > div + div { padding-left: 12px; }
		.stats-summary dd { font-size: 22px; overflow-wrap: anywhere; }
	}
</style>

<script lang="ts">
	import type { TimelineToolActivity } from "../../../shared/contracts";
	import { TRANSCRIPT_PRESENTATION_LIMITS } from "../../../shared/transcript-limits";

	export let activity: Extract<TimelineToolActivity, { operation: "eval" }>;
	export let status: "running" | "complete" | "error" | undefined;
	export let loading = false;
	export let error = "";
	export let onLoad: () => void;

	$: visibleCode = activity.codePreview.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.collapsedLines);
	$: visibleOutput = activity.outputPreview.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.collapsedLines);
	$: languageLabel = activity.languages.length > 0 ? activity.languages.join(" · ") : "eval";

	function durationLabel(durationMs: number): string {
		if (durationMs < 1_000) return `${durationMs} ms`;
		return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
	}

	function requestDetail(event: Event): void {
		const disclosure = event.currentTarget;
		if (disclosure instanceof HTMLDetailsElement && disclosure.open && !activity.detailsLoaded && !loading) onLoad();
	}
</script>

<div class="eval-activity" aria-label="Eval activity">
	<div class="eval-meta">
		<span class="eval-language">{languageLabel}</span>
		{#if activity.title}<strong>{activity.title}</strong>{/if}
		<span>{activity.cellCount} {activity.cellCount === 1 ? "cell" : "cells"}</span>
		<span>{durationLabel(activity.durationMs)}</span>
		<span class="eval-state state-{status ?? "complete"}">{status ?? "complete"}</span>
	</div>
	{#if visibleCode.length > 0}
		<div class="eval-preview" aria-label="Eval code preview">
			<span>Code</span>
			<pre>{visibleCode.join("\n")}</pre>
		</div>
	{/if}
	{#if visibleOutput.length > 0}
		<div class="eval-preview" aria-label="Eval output preview">
			<span>Output</span>
			<pre>{visibleOutput.join("\n")}</pre>
		</div>
	{/if}
	{#if activity.omittedLineCount > 0 || activity.omittedImageCount > 0}
		<p class="eval-omitted">
			{#if activity.omittedLineCount > 0}{activity.omittedLineCount} more {activity.omittedLineCount === 1 ? "line" : "lines"}{/if}{#if activity.omittedLineCount > 0 && activity.omittedImageCount > 0} · {/if}{#if activity.omittedImageCount > 0}{activity.omittedImageCount} {activity.omittedImageCount === 1 ? "image" : "images"}{/if} in details
		</p>
	{/if}
	<details class="eval-detail" ontoggle={requestDetail}>
		<summary>Eval details</summary>
		{#if loading}
			<p role="status">Loading eval details…</p>
		{:else if error}
			<div class="eval-detail-error" role="alert">
				<span>{error}</span>
				<button type="button" class="secondary-button compact" onclick={onLoad}>Retry</button>
			</div>
		{:else if activity.detailsLoaded}
			<div class="eval-cells">
				{#each activity.cells ?? [] as cell (cell.index)}
					<section class="eval-cell" aria-label={`Eval cell ${cell.index + 1}`}>
						<header>
							<strong>{cell.title ?? `Cell ${cell.index + 1}`}</strong>
							<span>{cell.language ?? languageLabel}</span>
							<span>{cell.status}</span>
							{#if cell.durationMs !== undefined}<span>{durationLabel(cell.durationMs)}</span>{/if}
						</header>
						{#if cell.code}<div><span>Code</span><pre><code>{cell.code}</code></pre>{#if cell.omittedCodeLineCount}<small>{cell.omittedCodeLineCount} code lines omitted</small>{/if}</div>{/if}
						{#if cell.output}<div><span>Output</span><pre><code>{cell.output}</code></pre>{#if cell.omittedOutputLineCount}<small>{cell.omittedOutputLineCount} output lines omitted</small>{/if}</div>{/if}
						{#if cell.statusEvents?.length}<div><span>Status events</span><pre><code>{cell.statusEvents.join("\n")}</code></pre></div>{/if}
					</section>
				{/each}
				{#if activity.jsonOutputs?.length}<section class="eval-cell" aria-label="Eval JSON outputs"><header><strong>JSON outputs</strong></header><pre><code>{activity.jsonOutputs.join("\n\n")}</code></pre></section>{/if}
				{#if activity.statusEvents?.length}<section class="eval-cell" aria-label="Eval status events"><header><strong>Status events</strong></header><pre><code>{activity.statusEvents.join("\n")}</code></pre></section>{/if}
				{#if activity.images?.length}
					<div class="eval-images" aria-label="Eval image outputs">
						{#each activity.images as image, index (`${image.mimeType}:${index}`)}
							<figure><img src={`data:${image.mimeType};base64,${image.data}`} alt={`Eval output ${index + 1}`} loading="lazy" /><figcaption>{image.mimeType}</figcaption></figure>
						{/each}
					</div>
				{/if}
				{#if activity.omittedImageCount > 0}<p>{activity.omittedImageCount} additional image outputs omitted.</p>{/if}
			</div>
		{/if}
	</details>
</div>

<style>
	.eval-activity { display: grid; gap: 8px; }
	.eval-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--foreground-muted); font-size: 12px; }
	.eval-language, .eval-state { padding: 2px 6px; border: 1px solid var(--line); border-radius: 999px; font-family: var(--font-mono); text-transform: lowercase; }
	.eval-meta strong { color: var(--foreground); }
	.eval-state.state-error { color: var(--danger); border-color: var(--danger-boundary); }
	.eval-state.state-running { color: var(--warning); border-color: var(--warning-boundary); }
	.eval-preview { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; align-items: start; }
	.eval-preview > span, .eval-cell div > span { padding-top: 6px; color: var(--foreground-muted); font: 600 10px/1 var(--font-ui); text-transform: uppercase; letter-spacing: .05em; }
	pre { min-width: 0; max-width: 100%; margin: 0; padding: 6px 8px; overflow: auto; border: 1px solid var(--line-soft); border-radius: var(--radius-small); background: var(--code-surface); color: var(--foreground); font: 12px/1.5 var(--font-mono); white-space: pre; }
	.eval-omitted { margin: 0; color: var(--foreground-muted); font-size: 11px; }
	.eval-detail { border-top: 1px solid var(--line-soft); padding-top: 7px; }
	.eval-detail > summary { width: fit-content; min-height: 24px; color: var(--foreground-muted); cursor: pointer; }
	.eval-cells { display: grid; gap: 12px; padding-top: 9px; }
	.eval-cell { display: grid; gap: 8px; }
	.eval-cell header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; color: var(--foreground-muted); font-size: 11px; }
	.eval-cell header strong { color: var(--foreground); }
	.eval-cell div { display: grid; gap: 5px; }
	.eval-cell small { color: var(--foreground-muted); }
	.eval-detail-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 8px; color: var(--danger); }
	.eval-images { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
	.eval-images figure { margin: 0; }
	.eval-images img { display: block; width: 100%; max-height: 320px; object-fit: contain; border: 1px solid var(--line); border-radius: var(--radius-small); background: var(--code-surface); }
	.eval-images figcaption { margin-top: 4px; color: var(--foreground-muted); font-size: 11px; }
	@media (max-width: 760px) { .eval-preview { grid-template-columns: 1fr; } .eval-preview > span { padding-top: 0; } }
</style>

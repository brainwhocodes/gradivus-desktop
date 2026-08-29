<script lang="ts">
	import AddCircle from "@solar-icons/svelte/linear/add-circle";
	import ArrowRightUp from "@solar-icons/svelte/linear/arrow-right-up";
	import Diskette from "@solar-icons/svelte/linear/diskette";
	import DocumentText from "@solar-icons/svelte/linear/document-text";
	import Eye from "@solar-icons/svelte/linear/eye";
	import Gallery from "@solar-icons/svelte/linear/gallery";
	import Pen2 from "@solar-icons/svelte/linear/pen-2";
	import type {
		TurnFileDisposition,
		TurnFileSummary,
		TurnFileSummaryEntry,
	} from "../../turn-file-summary";

	interface Props {
		summary: TurnFileSummary;
		onreview: (path: string) => void;
		onopen: (path: string) => void;
		onimage: (path: string) => void;
	}

	interface FileGroup {
		disposition: TurnFileDisposition;
		label: "Created" | "Edited" | "Written";
		files: TurnFileSummaryEntry[];
	}

	const GROUPS: ReadonlyArray<Omit<FileGroup, "files">> = [
		{ disposition: "created", label: "Created" },
		{ disposition: "edited", label: "Edited" },
		{ disposition: "written", label: "Written" },
	];

	let { summary, onreview, onopen, onimage }: Props = $props();
	const groups = $derived(
		GROUPS.map(group => ({
			...group,
			files: summary.files.filter(file => file.disposition === group.disposition),
		})).filter(group => group.files.length > 0),
	);

	function primaryAction(file: TurnFileSummaryEntry): void {
		if (file.kind === "image") onimage(file.path);
		else onreview(file.path);
	}
</script>

{#if summary.files.length > 0}
	<section
		class="turn-file-summary"
		data-outcome={summary.outcome}
		aria-label={`${summary.files.length} file${summary.files.length === 1 ? "" : "s"} changed in this turn`}
	>
		<header class="turn-file-summary-header">
			<strong>Files changed</strong>
			<span class="turn-file-summary-total">{summary.files.length}</span>
		</header>

		{#each groups as group (group.disposition)}
			<div class="turn-file-group">
				<div class="turn-file-group-heading">
					<span class="turn-file-group-icon" aria-hidden="true">
						{#if group.disposition === "created"}
							<AddCircle size={16} />
						{:else if group.disposition === "edited"}
							<Pen2 size={16} />
						{:else}
							<Diskette size={16} />
						{/if}
					</span>
					<span>{group.label}</span>
					<span class="turn-file-group-count">{group.files.length}</span>
				</div>
				<ul aria-label={`${group.label} files`}>
					{#each group.files as file (file.path)}
						<li>
							<button
								type="button"
								class="turn-file-primary-action"
								title={file.path}
								aria-label={file.kind === "image" ? `Preview image ${file.path}` : `Review changes to ${file.path}`}
								onclick={() => primaryAction(file)}
							>
								<span class="turn-file-kind" aria-hidden="true">
									{#if file.kind === "image"}<Gallery size={15} />{:else}<DocumentText size={15} />{/if}
								</span>
								<code>{file.path}</code>
								<span class="turn-file-review-mark" aria-hidden="true"><Eye size={14} /></span>
							</button>
							<button
								type="button"
								class="turn-file-open-action"
								title={`Open ${file.path}`}
								aria-label={`Open ${file.path} in the workspace editor`}
								onclick={() => onopen(file.path)}
							>
								<ArrowRightUp size={14} aria-hidden="true" />
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/each}

		{#if summary.outcome === "error"}
			<p class="turn-file-outcome">The turn ended with an error. Completed file changes were kept.</p>
		{:else if summary.outcome === "cancelled"}
			<p class="turn-file-outcome">The turn was cancelled. Completed file changes were kept.</p>
		{/if}
	</section>
{/if}

<style>
	.turn-file-summary {
		width: min(100%, 620px);
		margin-top: 10px;
		margin-inline: auto;
		overflow: hidden;
		border: 1px solid var(--line-soft);
		border-radius: 10px;
		background: color-mix(in srgb, var(--shell-raised) 74%, transparent);
		color: var(--foreground);
	}

	.turn-file-summary-header {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 7px 11px;
		border-bottom: 1px solid var(--line-soft);
	}

	.turn-file-summary-header strong {
		font-size: 12px;
		font-weight: 650;
		letter-spacing: 0.01em;
	}

	.turn-file-summary-total,
	.turn-file-group-count {
		font-variant-numeric: tabular-nums;
		color: var(--foreground-muted);
		font-size: 11px;
	}

	.turn-file-summary-total {
		display: inline-grid;
		place-items: center;
		min-width: 20px;
		height: 20px;
		margin-left: auto;
		padding-inline: 5px;
		border-radius: 999px;
		background: var(--shell-hover);
	}

	.turn-file-group + .turn-file-group {
		border-top: 1px solid var(--line-soft);
	}

	.turn-file-group-heading {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 11px 4px;
		color: var(--foreground-muted);
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.025em;
		text-transform: uppercase;
	}

	.turn-file-group-icon,
	.turn-file-kind {
		display: inline-grid;
		place-items: center;
		flex: 0 0 auto;
	}

	.turn-file-group-icon {
		color: var(--accent);
	}

	.turn-file-group-count {
		margin-left: auto;
	}

	ul {
		margin: 0;
		padding: 0 5px 6px;
		list-style: none;
	}

	li {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
	}

	.turn-file-primary-action,
	.turn-file-open-action {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.turn-file-primary-action {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		min-height: 30px;
		flex: 1 1 auto;
		padding: 4px 6px;
		border-radius: 6px;
		text-align: left;
	}

	.turn-file-primary-action:hover,
	.turn-file-open-action:hover {
		background: var(--shell-hover);
	}

	.turn-file-primary-action:focus-visible,
	.turn-file-open-action:focus-visible {
		outline: 2px solid var(--focus-inner);
		box-shadow: 0 0 0 3px var(--focus-outer);
	}

	.turn-file-kind {
		color: var(--foreground-muted);
	}

	code {
		overflow: hidden;
		min-width: 0;
		color: var(--foreground);
		font-family: var(--font-mono, ui-monospace, "SFMono-Regular", Consolas, monospace);
		font-size: 11.5px;
		line-height: 1.35;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.turn-file-review-mark {
		flex: 0 0 auto;
		margin-left: auto;
		color: var(--foreground-muted);
		opacity: 0.48;
		transition: opacity 120ms ease;
	}

	.turn-file-primary-action:hover .turn-file-review-mark,
	.turn-file-primary-action:focus-visible .turn-file-review-mark {
		opacity: 1;
	}

	.turn-file-open-action {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		flex: 0 0 28px;
		padding: 0;
		border-radius: 6px;
		color: var(--foreground-muted);
	}

	.turn-file-outcome {
		margin: 0;
		padding: 7px 11px 8px;
		border-top: 1px solid var(--line-soft);
		color: var(--foreground-muted);
		font-size: 11px;
		line-height: 1.4;
	}

	@media (max-width: 520px) {
		.turn-file-summary {
			border-radius: 8px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.turn-file-review-mark {
			transition: none;
		}
	}

	@media (forced-colors: active) {
		.turn-file-summary,
		.turn-file-summary-header,
		.turn-file-group + .turn-file-group,
		.turn-file-outcome {
			border-color: CanvasText;
		}

		.turn-file-primary-action:focus-visible,
		.turn-file-open-action:focus-visible {
			outline-color: Highlight;
			box-shadow: none;
		}
	}
</style>

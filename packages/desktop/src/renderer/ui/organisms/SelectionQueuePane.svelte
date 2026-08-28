<script lang="ts">
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import type { QueuedElementTask } from "../../../shared/contracts";

	interface Props {
		tasks: QueuedElementTask[];
		running: boolean;
		onrun: () => void;
		onclear: () => void;
		onclose: () => void;
	}

	let { tasks, running, onrun, onclear, onclose }: Props = $props();
	const hasPendingTasks = $derived(tasks.some(task => task.status === "pending"));
	const queueLabel = $derived(`${tasks.length} ${tasks.length === 1 ? "item" : "items"}`);
</script>

<aside
	class="selection-queue-pane"
	aria-label="Selection queue and output"
	aria-live="polite"
	aria-busy={running}
>
	<header class="selection-queue-header">
		<div class="selection-queue-heading">
			<h2>Selection queue</h2>
			<span class="selection-queue-count">{queueLabel}</span>
		</div>
		<div class="selection-queue-controls">
			<button type="button" class="selection-queue-action is-primary" disabled={running || !hasPendingTasks} onclick={onrun}>
				Run All
			</button>
			<button type="button" class="selection-queue-action" disabled={running || tasks.length === 0} onclick={onclear}>
				Clear
			</button>
			<button type="button" class="selection-queue-close" aria-label="Close selection queue" title="Close selection queue" onclick={onclose}>
				<CloseCircle size={16} aria-hidden="true" />
			</button>
		</div>
	</header>

	<div class="selection-queue-list">
		{#if tasks.length === 0}
			<p class="selection-queue-empty">Select page elements to add work to this queue.</p>
		{:else}
			{#each tasks as task (task.id)}
				<article class="selection-queue-row" data-status={task.status} aria-label={`Queue item ${task.taskIndex}: ${task.status}`}>
					<header class="selection-queue-row-header">
						<span class="selection-queue-index">#{task.taskIndex}</span>
						<span class="selection-queue-agent">
							<span class="selection-queue-swatch" style={`--queue-agent-swatch: ${task.agentSwatch}`} aria-hidden="true"></span>
							<span>{task.targetAgentName}</span>
						</span>
						<span class="selection-queue-status">{task.status}</span>
					</header>

					<code class="selection-queue-selector">{task.selector}</code>
					<p class="selection-queue-instruction">{task.instruction}</p>
					<dl class="selection-queue-metadata">
						<div><dt>Capture</dt><dd>{task.captureMode ?? "dom"}</dd></div>
						<div><dt>Role</dt><dd>{task.agentType ?? "task"}</dd></div>
					</dl>

					{#if task.status === "error"}
						<p class="selection-queue-error" role="alert">{task.error ?? "Task failed"}</p>
					{:else if task.response}
						<div class="selection-queue-response">
							<span>Output</span>
							<p>{task.response}</p>
						</div>
					{/if}
				</article>
			{/each}
		{/if}
	</div>
</aside>

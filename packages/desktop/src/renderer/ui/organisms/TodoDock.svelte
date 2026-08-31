<script lang="ts">
	import AltArrowDown from "@solar-icons/svelte/linear/alt-arrow-down";
	import type { TodoPhase, TodoState } from "../../../shared/contracts";
	import type { TodoEditBuffer } from "../../todo-editing";
	import TodoInspector from "./TodoInspector.svelte";

	interface Props {
		sessionId: string;
		todoState: TodoState;
		buffer?: TodoEditBuffer;
		undoState?: TodoState;
		onBufferChange: (buffer: TodoEditBuffer | undefined) => void;
		onSave: (phases: TodoPhase[], expectedRevision: number, action: string) => Promise<TodoState>;
		onReload: () => Promise<TodoState>;
		onUndo: () => Promise<TodoState>;
	}

	let { sessionId, todoState, buffer, undoState, onBufferChange, onSave, onReload, onUndo }: Props = $props();
	let expanded = $state(false);
	let observedSessionId = $state("");

	const displayPhases = $derived(buffer?.phases ?? todoState.phases);
	const topLevelTasks = $derived(displayPhases.flatMap(phase => phase.tasks.filter(task => !task.parentId)));
	const completedTopLevelCount = $derived(topLevelTasks.filter(task => task.status === "completed").length);
	const activeTasks = $derived(displayPhases.flatMap(phase => phase.tasks.filter(task => task.status === "in_progress")));
	const panelId = $derived(`todo-dock-panel-${sessionId}`);

	$effect(() => {
		if (sessionId === observedSessionId) return;
		observedSessionId = sessionId;
		expanded = false;
	});
</script>

{#if topLevelTasks.length > 0}
	<section class="todo-dock" aria-label="Session todo progress" class:is-expanded={expanded}>
		<button
			type="button"
			class="todo-dock-toggle"
			aria-expanded={expanded}
			aria-label={`${expanded ? "Collapse" : "Expand"} session todos, ${completedTopLevelCount} of ${topLevelTasks.length} complete${activeTasks.length > 0 ? `, current: ${activeTasks.map(task => task.content).join("; ")}` : ""}`}
			aria-controls={panelId}
			onclick={() => expanded = !expanded}
		>
			<span class="todo-dock-progress" aria-label={`${completedTopLevelCount} of ${topLevelTasks.length} top-level todos complete`}>
				<strong>{completedTopLevelCount}/{topLevelTasks.length}</strong>
			</span>
			<span class="todo-dock-active-work">
				{#if activeTasks.length > 0}
					{#each activeTasks as task (task.id)}
						<span class="todo-dock-active-item"><span class="todo-dock-status-dot" aria-hidden="true"></span>{task.content}</span>
					{/each}
				{:else}
					<span class="todo-dock-idle">No todo is currently in progress</span>
				{/if}
			</span>
			<span class="todo-dock-chevron" class:is-expanded={expanded} aria-hidden="true"><AltArrowDown size={15} /></span>
		</button>
		{#if expanded}
			<div class="todo-dock-panel" id={panelId}>
				<TodoInspector
					{sessionId}
					{todoState}
					{buffer}
					{undoState}
					{onBufferChange}
					{onSave}
					{onReload}
					{onUndo}
				/>
			</div>
		{/if}
	</section>
{/if}

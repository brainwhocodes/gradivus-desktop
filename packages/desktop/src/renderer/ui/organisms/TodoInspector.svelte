<script lang="ts">
	import type { TodoPhase, TodoState, TodoStatus } from "../../../shared/contracts";
	import {
		createTodoEditBuffer,
		deleteTodoTask,
		indentTodoTask,
		moveTodoPhase,
		moveTodoTask,
		normalizeTodoDraft,
		outdentTodoTask,
		reorderTodoPhaseBefore,
		reorderTodoTaskBefore,
		todoTaskDepth,
		updateTodoSubtreeStatus,
		validateTodoDraft,
		type TodoEditBuffer,
	} from "../../todo-editing";
	import ModalShell from "../molecules/ModalShell.svelte";

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
	let phases = $state<TodoPhase[]>([]);
	let baseRevision = $state(0);
	let actions = $state<string[]>([]);
	let conflict = $state(false);
	let observedSessionId = $state("");
	let observedRevision = $state(-1);
	let busy = $state<"save" | "reload" | "undo" | "">("");
	let error = $state("");
	let notice = $state("");
	let draggedTaskId = $state("");
	let draggedPhaseId = $state("");
	let deleteTarget = $state<{ kind: "task" | "phase" | "all"; id: string; label: string }>();
	let showClosed = $state(false);
	let collapsedTaskIds = $state(new Set<string>());
	let blockerTargetId = $state("");
	let blockerDraft = $state("");

	const validationErrors = $derived(validateTodoDraft(phases));
	const dirty = $derived(actions.length > 0);
	const taskCount = $derived(phases.reduce((total, phase) => total + phase.tasks.length, 0));

	$effect(() => {
		if (sessionId === observedSessionId) return;
		observedSessionId = sessionId;
		observedRevision = todoState.revision;
		const initial = buffer ?? createTodoEditBuffer(todoState);
		phases = initial.phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task })) }));
		baseRevision = initial.baseRevision;
		actions = [...initial.actions];
		conflict = initial.conflict;
		error = "";
		notice = "";
	});

	$effect(() => {
		if (sessionId !== observedSessionId || todoState.revision === observedRevision) return;
		observedRevision = todoState.revision;
		if (dirty && todoState.revision !== baseRevision) {
			conflict = true;
			persistBuffer();
			return;
		}
		if (!dirty) resetTo(todoState);
	});

	function persistBuffer(): void {
		if (!dirty && !conflict) {
			onBufferChange(undefined);
			return;
		}
		onBufferChange({
			phases: phases.map(phase => ({ ...phase, tasks: phase.tasks.map(task => ({ ...task })) })),
			baseRevision,
			actions: [...actions],
			conflict,
		});
	}

	function mutate(next: TodoPhase[], action: string): void {
		phases = next;
		actions = [...actions, action].slice(-20);
		notice = "";
		error = "";
		persistBuffer();
	}

	function resetTo(latest: TodoState): void {
		const next = createTodoEditBuffer(latest);
		phases = next.phases;
		baseRevision = next.baseRevision;
		actions = [];
		conflict = false;
		observedRevision = latest.revision;
		onBufferChange(undefined);
	}

	function actionSummary(prefix = "Edited todos"): string {
		const detail = Array.from(new Set(actions)).slice(-8).join("; ");
		return `${prefix}${detail ? `: ${detail}` : ""}`.slice(0, 256);
	}

	function updatePhaseName(phaseId: string, value: string): void {
		mutate(
			phases.map(phase => (phase.id === phaseId ? { ...phase, name: value } : phase)),
			"renamed a phase",
		);
	}

	function updateTaskContent(taskId: string, value: string): void {
		mutate(
			phases.map(phase => ({
				...phase,
				tasks: phase.tasks.map(task => (task.id === taskId ? { ...task, content: value } : task)),
			})),
			"edited task text",
		);
	}


	function rememberEditorValue(event: FocusEvent): void {
		const input = event.currentTarget as HTMLInputElement;
		input.dataset.originalValue = input.value;
	}

	function handleEditorKeydown(event: KeyboardEvent, cancel: (value: string) => void): void {
		const input = event.currentTarget as HTMLInputElement;
		if (event.key === "Enter") {
			event.preventDefault();
			input.blur();
			return;
		}
		if (event.key !== "Escape") return;
		event.preventDefault();
		const original = input.dataset.originalValue ?? input.value;
		cancel(original);
		input.value = original;
		input.blur();
	}

	function addPhase(): void {
		let index = phases.length + 1;
		const names = new Set(phases.map(phase => phase.name));
		while (names.has(`Phase ${index}`)) index++;
		mutate(
			[...phases, { id: `phase-${crypto.randomUUID()}`, name: `Phase ${index}`, tasks: [] }],
			"added a phase",
		);
	}

	function uniqueTaskContent(): string {
		const contents = new Set(phases.flatMap(phase => phase.tasks.map(task => task.content)));
		let index = taskCount + 1;
		while (contents.has(`Task ${index}`)) index++;
		return `Task ${index}`;
	}

	function addTask(phaseId: string, parentId?: string): void {
		const task = {
			id: `todo-${crypto.randomUUID()}`,
			content: uniqueTaskContent(),
			status: "pending" as const,
			...(parentId ? { parentId } : {}),
		};
		const next = phases.map(phase => {
			if (phase.id !== phaseId) return phase;
			if (!parentId) return { ...phase, tasks: [...phase.tasks, task] };
			const parentIndex = phase.tasks.findIndex(candidate => candidate.id === parentId);
			if (parentIndex < 0) return phase;
			const parentDepth = todoTaskDepth(phase, parentId);
			let insertAt = parentIndex + 1;
			while (insertAt < phase.tasks.length && todoTaskDepth(phase, phase.tasks[insertAt].id) > parentDepth) insertAt++;
			return { ...phase, tasks: [...phase.tasks.slice(0, insertAt), task, ...phase.tasks.slice(insertAt)] };
		});
		mutate(next, parentId ? "added a subtask" : "added a task");
	}

	function addSibling(phaseId: string, taskId: string): void {
		const task: TodoPhase["tasks"][number] = {
			id: `todo-${crypto.randomUUID()}`,
			content: uniqueTaskContent(),
			status: "pending" as const,
		};
		const next = phases.map(phase => {
			if (phase.id !== phaseId) return phase;
			const sourceIndex = phase.tasks.findIndex(candidate => candidate.id === taskId);
			if (sourceIndex < 0) return phase;
			const source = phase.tasks[sourceIndex];
			if (source.parentId) task.parentId = source.parentId;
			const sourceDepth = todoTaskDepth(phase, taskId);
			let insertAt = sourceIndex + 1;
			while (insertAt < phase.tasks.length && todoTaskDepth(phase, phase.tasks[insertAt].id) > sourceDepth) insertAt++;
			return { ...phase, tasks: [...phase.tasks.slice(0, insertAt), task, ...phase.tasks.slice(insertAt)] };
		});
		mutate(next, "added a sibling task");
	}

	function requestStatus(taskId: string, status: TodoStatus): void {
		if (status === "blocked") {
			blockerTargetId = taskId;
			blockerDraft = "";
			return;
		}
		mutate(updateTodoSubtreeStatus(phases, taskId, status), `changed a task subtree to ${status}`);
	}

	function commitBlocker(): void {
		const reason = blockerDraft.trim();
		if (!blockerTargetId || !reason) return;
		mutate(updateTodoSubtreeStatus(phases, blockerTargetId, "blocked", reason), "blocked a task subtree");
		blockerTargetId = "";
		blockerDraft = "";
	}

	function indentTask(taskId: string): void {
		mutate(indentTodoTask(phases, taskId), "indented a task subtree");
	}

	function outdentTask(taskId: string): void {
		mutate(outdentTodoTask(phases, taskId), "outdented a task subtree");
	}

	function toggleTask(taskId: string): void {
		const next = new Set(collapsedTaskIds);
		if (next.has(taskId)) next.delete(taskId);
		else next.add(taskId);
		collapsedTaskIds = next;
	}

	function isClosed(status: TodoStatus): boolean {
		return status === "completed" || status === "abandoned";
	}

	function isTaskVisible(phase: TodoPhase, taskId: string, status: TodoStatus): boolean {
		if (!showClosed && isClosed(status)) return false;
		const byId = new Map(phase.tasks.map(task => [task.id, task]));
		let parentId = byId.get(taskId)?.parentId;
		while (parentId) {
			if (collapsedTaskIds.has(parentId)) return false;
			parentId = byId.get(parentId)?.parentId;
		}
		return true;
	}

	function subtreeLeafCount(phase: TodoPhase, taskId: string): number {
		const start = phase.tasks.findIndex(task => task.id === taskId);
		if (start < 0) return 0;
		const depth = todoTaskDepth(phase, taskId);
		let end = start + 1;
		while (end < phase.tasks.length && todoTaskDepth(phase, phase.tasks[end].id) > depth) end++;
		const parentIds = new Set(phase.tasks.flatMap(task => (task.parentId ? [task.parentId] : [])));
		return phase.tasks.slice(start, end).filter(task => !parentIds.has(task.id)).length;
	}


	function hasChildren(phase: TodoPhase, taskId: string): boolean {
		return phase.tasks.some(task => task.parentId === taskId);
	}

	function moveTask(taskId: string, direction: "up" | "down"): void {
		mutate(moveTodoTask(phases, taskId, direction), `moved a task ${direction}`);
	}

	function movePhase(phaseId: string, direction: "up" | "down"): void {
		mutate(moveTodoPhase(phases, phaseId, direction), `moved a phase ${direction}`);
	}

	function dropTask(targetTaskId: string): void {
		if (!draggedTaskId) return;
		mutate(reorderTodoTaskBefore(phases, draggedTaskId, targetTaskId), "reordered tasks by pointer");
		draggedTaskId = "";
	}

	function dropPhase(targetPhaseId: string): void {
		if (!draggedPhaseId) return;
		mutate(reorderTodoPhaseBefore(phases, draggedPhaseId, targetPhaseId), "reordered phases by pointer");
		draggedPhaseId = "";
	}

	function requestDelete(kind: "task" | "phase", id: string, label: string): void {
		deleteTarget = { kind, id, label };
	}

	function confirmDelete(): void {
		if (!deleteTarget) return;
		if (deleteTarget.kind === "all") mutate([], "cleared all todos");
		else if (deleteTarget.kind === "phase") {
			mutate(phases.filter(phase => phase.id !== deleteTarget?.id), "deleted a phase");
		} else {
			mutate(deleteTodoTask(phases, deleteTarget.id), "deleted a task subtree");
		}
		deleteTarget = undefined;
	}

	async function save(): Promise<void> {
		if (!dirty || validationErrors.length > 0 || busy) return;
		busy = "save";
		error = "";
		notice = "";
		try {
			const updated = await onSave(normalizeTodoDraft(phases), baseRevision, actionSummary());
			resetTo(updated);
			notice = "Todo changes saved.";
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : String(caught);
			if (message.includes("todo list changed") || (caught instanceof Error && caught.name === "todo_conflict")) {
				conflict = true;
				persistBuffer();
			} else error = message;
		} finally {
			busy = "";
		}
	}

	async function reloadLatest(): Promise<void> {
		if (busy) return;
		busy = "reload";
		error = "";
		try {
			resetTo(await onReload());
			notice = "Loaded the latest todo list.";
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			busy = "";
		}
	}

	async function copyDraft(): Promise<void> {
		await window.gradivus.writeClipboardText(JSON.stringify({ baseRevision, phases }, null, 2));
		notice = "Todo draft copied.";
	}

	async function undo(): Promise<void> {
		if (!undoState || busy) return;
		busy = "undo";
		error = "";
		try {
			resetTo(await onUndo());
			notice = "Previous todo edit restored.";
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			busy = "";
		}
	}
</script>

<section class="todo-inspector" aria-label="Todo inspector">
	<div class="todo-inspector-summary">
		<div>
			<strong>{taskCount} {taskCount === 1 ? "task" : "tasks"}</strong>
			<span>Revision {baseRevision}</span>
		</div>
		<div class="todo-summary-actions">
			<button type="button" class="secondary-button" onclick={addPhase} disabled={Boolean(busy)}>Add phase</button>
			<button type="button" class="secondary-button" aria-pressed={showClosed} onclick={() => showClosed = !showClosed}>
				{showClosed ? "Hide closed" : "Show closed"}
			</button>
			{#if phases.length > 0}
				<button type="button" class="danger-link" onclick={() => deleteTarget = { kind: "all", id: "", label: "every phase and task" }} disabled={Boolean(busy)}>Clear all</button>
			{/if}
		</div>
	</div>

	{#if conflict}
		<div class="todo-conflict" role="alert">
			<strong>The todo list changed elsewhere.</strong>
			<p>Reload the latest version and discard this draft, or copy the draft before deciding how to apply it.</p>
			<div>
				<button type="button" class="secondary-button" onclick={() => void reloadLatest()} disabled={Boolean(busy)}>Reload latest</button>
				<button type="button" class="primary-button" onclick={() => void copyDraft()} disabled={Boolean(busy)}>Copy draft</button>
			</div>
		</div>
	{/if}
	{#if error}<p class="todo-error" role="alert">{error}</p>{/if}
	{#if notice}<p class="todo-notice" role="status">{notice}</p>{/if}
	{#if validationErrors.length > 0 && dirty}
		<div class="todo-validation" role="alert">
			{#each validationErrors as validationError}<p>{validationError}</p>{/each}
		</div>
	{/if}

	<div class="todo-phase-list" aria-label="Todo phases">
		{#if phases.length === 0}
			<div class="todo-empty">
				<strong>No todo phases</strong>
				<p>Add a phase to organize work for this session.</p>
				<button type="button" class="primary-button" onclick={addPhase}>Add first phase</button>
			</div>
		{/if}
		{#each phases as phase, phaseIndex (phase.id)}
			<section class="todo-phase" role="group" ondragover={(event) => event.preventDefault()} ondrop={() => dropPhase(phase.id)}>
				<header class="todo-phase-header">
					<button
						type="button"
						class="todo-drag-handle"
						draggable="true"
						aria-label={`Drag phase ${phase.name}`}
						ondragstart={() => draggedPhaseId = phase.id}
						ondragend={() => draggedPhaseId = ""}
					>⋮⋮</button>
					<input
						aria-label={`Phase ${phaseIndex + 1} name`}
						value={phase.name}
						onfocus={rememberEditorValue}
						oninput={(event) => updatePhaseName(phase.id, event.currentTarget.value)}
						onkeydown={(event) => handleEditorKeydown(event, value => updatePhaseName(phase.id, value))}
					/>
					<span class="todo-phase-count">{phase.tasks.length}</span>
					<button type="button" class="todo-mini-action" aria-label={`Move phase ${phase.name} up`} onclick={() => movePhase(phase.id, "up")} disabled={phaseIndex === 0}>↑</button>
					<button type="button" class="todo-mini-action" aria-label={`Move phase ${phase.name} down`} onclick={() => movePhase(phase.id, "down")} disabled={phaseIndex === phases.length - 1}>↓</button>
					<button type="button" class="todo-mini-action is-danger" aria-label={`Delete phase ${phase.name}`} onclick={() => requestDelete("phase", phase.id, `phase “${phase.name}” and its ${phase.tasks.length} tasks`)}>×</button>
				</header>
				<div class="todo-task-tree" role="tree" aria-label={`${phase.name} tasks`}>
					{#each phase.tasks as task (task.id)}
						{@const depth = todoTaskDepth(phase, task.id)}
						{@const container = hasChildren(phase, task.id)}
						{@const leafCount = subtreeLeafCount(phase, task.id)}
						{#if isTaskVisible(phase, task.id, task.status)}
							<div
								class="todo-task-row"
								class:is-container={container}
								role="treeitem"
								tabindex="0"
								aria-level={depth + 1}
								aria-selected="false"
								aria-expanded={container ? !collapsedTaskIds.has(task.id) : undefined}
								aria-label={`${task.content}, ${task.status.replace("_", " ")}`}
								style={`--todo-depth: ${depth}`}
								ondragover={(event) => event.preventDefault()}
								ondrop={(event) => { event.stopPropagation(); dropTask(task.id); }}
								onkeydown={(event) => {
									if (!event.altKey) return;
									if (event.key === "ArrowUp" || event.key === "ArrowDown") {
										event.preventDefault();
										moveTask(task.id, event.key === "ArrowUp" ? "up" : "down");
									} else if (event.key === "ArrowRight") {
										event.preventDefault();
										indentTask(task.id);
									} else if (event.key === "ArrowLeft") {
										event.preventDefault();
										outdentTask(task.id);
									}
								}}
							>
								<div class="todo-task-main">
									<div class="todo-row-leading">
										{#if container}
											<button
												type="button"
												class="todo-disclosure"
												aria-label={`${collapsedTaskIds.has(task.id) ? "Expand" : "Collapse"} ${task.content}`}
												onclick={() => toggleTask(task.id)}
											>{collapsedTaskIds.has(task.id) ? "›" : "⌄"}</button>
										{/if}
										<button
											type="button"
											class="todo-drag-handle"
											draggable="true"
											aria-label={`Drag task ${task.content}`}
											ondragstart={() => draggedTaskId = task.id}
											ondragend={() => draggedTaskId = ""}
										>⋮⋮</button>
									</div>
									<input
										class="todo-task-content"
										aria-label={`Task text for ${task.content}`}
										value={task.content}
										onfocus={rememberEditorValue}
										oninput={(event) => updateTaskContent(task.id, event.currentTarget.value)}
										onkeydown={(event) => handleEditorKeydown(event, value => updateTaskContent(task.id, value))}
									/>
									<span class={`todo-derived-status is-${task.status}`} title={container ? "Derived from child tasks" : undefined}>
										<span class="todo-status-dot" aria-hidden="true"></span>{task.status.replace("_", " ")}
									</span>
								</div>
								<div class="todo-task-actions">
									<button type="button" class="todo-text-action" onclick={() => addTask(phase.id, task.id)}>Add child</button>
									<button type="button" class="todo-text-action" onclick={() => addSibling(phase.id, task.id)}>Add sibling</button>
									{#if container}
										{#if task.status === "pending"}
											<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "in_progress")}>Start</button>
										{/if}
										{#if task.status !== "completed"}
											<button type="button" class="todo-text-action" aria-label={`Complete ${leafCount} subtasks`} onclick={() => requestStatus(task.id, "completed")}>Complete</button>
										{/if}
										{#if task.status === "blocked"}
											<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "pending")}>Unblock</button>
										{:else}
											<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "blocked")}>Block</button>
										{/if}
										{#if task.status !== "abandoned"}
											<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "abandoned")}>Abandon</button>
										{/if}
									{:else if task.status === "pending" || task.status === "in_progress"}
										{#if task.status === "pending"}
											<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "in_progress")}>Start</button>
										{/if}
										<button type="button" class="todo-text-action" aria-label={`Complete ${task.content}`} onclick={() => requestStatus(task.id, "completed")}>Complete</button>
										<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "blocked")}>Block</button>
										<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "abandoned")}>Abandon</button>
									{:else if task.status === "blocked"}
										<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "pending")}>Unblock</button>
									{:else}
										<button type="button" class="todo-text-action" onclick={() => requestStatus(task.id, "pending")}>Reopen</button>
									{/if}
									<button type="button" class="todo-text-action" onclick={() => indentTask(task.id)}>Indent</button>
									<button type="button" class="todo-text-action" onclick={() => outdentTask(task.id)}>Outdent</button>
									<button type="button" class="todo-mini-action" aria-label={`Move task ${task.content} up`} onclick={() => moveTask(task.id, "up")}>↑</button>
									<button type="button" class="todo-mini-action" aria-label={`Move task ${task.content} down`} onclick={() => moveTask(task.id, "down")}>↓</button>
									<button type="button" class="todo-text-action is-danger" onclick={() => requestDelete("task", task.id, container ? `task “${task.content}” and its ${leafCount} subtasks` : `task “${task.content}”`)}>Remove</button>
								</div>
								{#if blockerTargetId === task.id}
									<form class="todo-blocker-editor" onsubmit={(event) => { event.preventDefault(); commitBlocker(); }}>
										<input bind:value={blockerDraft} aria-label={`Blocker reason for ${task.content}`} placeholder="What is this waiting for?" />
										<button type="submit" class="primary-button" disabled={!blockerDraft.trim()}>Block {container ? `${leafCount} subtasks` : "task"}</button>
										<button type="button" class="secondary-button" onclick={() => { blockerTargetId = ""; blockerDraft = ""; }}>Cancel</button>
									</form>
								{:else if task.status === "blocked" && task.blocker}
									<p class="todo-blocker-note"><strong>Blocked:</strong> {task.blocker}</p>
								{/if}
							</div>
						{/if}
					{/each}
				</div>
				<footer class="todo-phase-footer">
					<button type="button" class="todo-text-action" onclick={() => addTask(phase.id)}>+ Add task</button>
				</footer>
			</section>
		{/each}
	</div>

	<footer class="todo-save-bar">
		<div>{#if dirty}<strong>Unsaved changes</strong>{:else}<span>Up to date</span>{/if}</div>
		{#if undoState && !dirty}
			<button type="button" class="secondary-button" onclick={() => void undo()} disabled={Boolean(busy)}>
				{busy === "undo" ? "Undoing…" : "Undo last save"}
			</button>
		{/if}
		<button type="button" class="primary-button" onclick={() => void save()} disabled={!dirty || validationErrors.length > 0 || Boolean(busy)}>
			{busy === "save" ? "Saving…" : "Save changes"}
		</button>
	</footer>
</section>

{#if deleteTarget}
	<ModalShell
		backdrop={true}
		backdropClass="todo-delete-backdrop"
		dialogClass="todo-delete-dialog"
		labelledbyId="todo-delete-title"
		onclose={() => deleteTarget = undefined}
		cancelable={true}
	>
		<h2 id="todo-delete-title">Delete {deleteTarget.kind === "all" ? "all todos" : deleteTarget.kind}?</h2>
		<p>This removes {deleteTarget.label}. The change is not applied until you save.</p>
		<div class="modal-actions">
			<button type="button" class="secondary-button" onclick={() => deleteTarget = undefined}>Cancel</button>
			<button type="button" class="danger-button" onclick={confirmDelete}>Delete</button>
		</div>
	</ModalShell>
{/if}

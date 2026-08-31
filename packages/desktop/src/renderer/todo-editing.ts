import type { TodoPhase, TodoState, TodoStatus } from "../shared/contracts";

export interface TodoEditBuffer {
	phases: TodoPhase[];
	baseRevision: number;
	actions: string[];
	conflict: boolean;
}

function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		...phase,
		tasks: phase.tasks.map(task => ({ ...task })),
	}));
}

export function createTodoEditBuffer(state: TodoState): TodoEditBuffer {
	return {
		phases: clonePhases(state.phases),
		baseRevision: state.revision,
		actions: [],
		conflict: false,
	};
}

export function todoTaskDepth(phase: TodoPhase, taskId: string): number {
	const byId = new Map(phase.tasks.map(task => [task.id, task]));
	let depth = 0;
	let parentId = byId.get(taskId)?.parentId;
	const seen = new Set<string>();
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) break;
		depth++;
		parentId = parent.parentId;
	}
	return depth;
}

function subtreeEnd(phase: TodoPhase, start: number): number {
	const depth = todoTaskDepth(phase, phase.tasks[start].id);
	let end = start + 1;
	while (end < phase.tasks.length && todoTaskDepth(phase, phase.tasks[end].id) > depth) end++;
	return end;
}

function deriveContainerStatuses(phases: TodoPhase[]): void {
	for (const phase of phases) {
		const children = new Map<string, TodoPhase["tasks"]>();
		for (const task of phase.tasks) {
			if (!task.parentId) continue;
			const current = children.get(task.parentId) ?? [];
			current.push(task);
			children.set(task.parentId, current);
		}
		for (let index = phase.tasks.length - 1; index >= 0; index--) {
			const task = phase.tasks[index];
			const directChildren = children.get(task.id);
			if (!directChildren?.length) continue;
			delete task.blocker;
			if (directChildren.some(child => child.status === "in_progress")) task.status = "in_progress";
			else if (directChildren.some(child => child.status === "pending")) task.status = "pending";
			else if (directChildren.some(child => child.status === "blocked")) task.status = "blocked";
			else if (directChildren.some(child => child.status === "completed")) task.status = "completed";
			else task.status = "abandoned";
		}
	}
}

export function updateTodoTaskStatus(
	phasesInput: readonly TodoPhase[],
	taskId: string,
	status: TodoStatus,
): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	if (status === "in_progress") {
		for (const phase of phases) {
			const parentIds = new Set(phase.tasks.flatMap(task => (task.parentId ? [task.parentId] : [])));
			for (const task of phase.tasks) {
				if (task.status === "in_progress" && !parentIds.has(task.id)) task.status = "pending";
			}
		}
	}
	for (const phase of phases) {
		const task = phase.tasks.find(candidate => candidate.id === taskId);
		if (!task) continue;
		task.status = status;
		if (status === "blocked") task.blocker ??= "";
		else delete task.blocker;
		break;
	}
	deriveContainerStatuses(phases);
	return phases;
}

export function updateTodoSubtreeStatus(
	phasesInput: readonly TodoPhase[],
	taskId: string,
	status: TodoStatus,
	blocker?: string,
): TodoPhase[] {
	if (status === "in_progress") {
		const phase = phasesInput.find(candidate => candidate.tasks.some(task => task.id === taskId));
		if (!phase) return clonePhases(phasesInput);
		const rootIndex = phase.tasks.findIndex(task => task.id === taskId);
		const descendants = phase.tasks.slice(rootIndex, subtreeEnd(phase, rootIndex));
		const parentIds = new Set(phase.tasks.flatMap(task => (task.parentId ? [task.parentId] : [])));
		const firstPendingLeaf = descendants.find(task => !parentIds.has(task.id) && task.status === "pending");
		return firstPendingLeaf
			? updateTodoTaskStatus(phasesInput, firstPendingLeaf.id, status)
			: clonePhases(phasesInput);
	}
	const phases = clonePhases(phasesInput);
	for (const phase of phases) {
		const rootIndex = phase.tasks.findIndex(task => task.id === taskId);
		if (rootIndex < 0) continue;
		const parentIds = new Set(phase.tasks.flatMap(task => (task.parentId ? [task.parentId] : [])));
		for (const task of phase.tasks.slice(rootIndex, subtreeEnd(phase, rootIndex))) {
			if (parentIds.has(task.id)) continue;
			task.status = status;
			if (status === "blocked") task.blocker = blocker;
			else delete task.blocker;
		}
		break;
	}
	deriveContainerStatuses(phases);
	return phases;
}

export function indentTodoTask(phasesInput: readonly TodoPhase[], taskId: string): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	const phase = phases.find(candidate => candidate.tasks.some(task => task.id === taskId));
	const task = phase?.tasks.find(candidate => candidate.id === taskId);
	if (!phase || !task) return phases;
	const siblings = phase.tasks.filter(candidate => candidate.parentId === task.parentId);
	const siblingIndex = siblings.findIndex(candidate => candidate.id === taskId);
	if (siblingIndex <= 0) return phases;
	const newParent = siblings[siblingIndex - 1];
	const sourceIndex = phase.tasks.findIndex(candidate => candidate.id === taskId);
	const moved = phase.tasks.splice(sourceIndex, subtreeEnd(phase, sourceIndex) - sourceIndex);
	const parentIndex = phase.tasks.findIndex(candidate => candidate.id === newParent.id);
	const insertAt = subtreeEnd(phase, parentIndex);
	const [root, ...descendants] = moved;
	phase.tasks.splice(insertAt, 0, { ...root, parentId: newParent.id }, ...descendants);
	deriveContainerStatuses(phases);
	return phases;
}

export function outdentTodoTask(phasesInput: readonly TodoPhase[], taskId: string): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	const phase = phases.find(candidate => candidate.tasks.some(task => task.id === taskId));
	const task = phase?.tasks.find(candidate => candidate.id === taskId);
	if (!phase || !task?.parentId) return phases;
	const parent = phase.tasks.find(candidate => candidate.id === task.parentId);
	if (!parent) return phases;
	const sourceIndex = phase.tasks.findIndex(candidate => candidate.id === taskId);
	const moved = phase.tasks.splice(sourceIndex, subtreeEnd(phase, sourceIndex) - sourceIndex);
	const parentIndex = phase.tasks.findIndex(candidate => candidate.id === parent.id);
	const insertAt = subtreeEnd(phase, parentIndex);
	const [root, ...descendants] = moved;
	const movedRoot = { ...root };
	if (parent.parentId) movedRoot.parentId = parent.parentId;
	else delete movedRoot.parentId;
	phase.tasks.splice(insertAt, 0, movedRoot, ...descendants);
	deriveContainerStatuses(phases);
	return phases;
}

export function deleteTodoTask(phasesInput: readonly TodoPhase[], taskId: string): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	for (const phase of phases) {
		const start = phase.tasks.findIndex(task => task.id === taskId);
		if (start < 0) continue;
		phase.tasks.splice(start, subtreeEnd(phase, start) - start);
		break;
	}
	deriveContainerStatuses(phases);
	return phases;
}

export function reorderTodoTaskBefore(
	phasesInput: readonly TodoPhase[],
	sourceTaskId: string,
	targetTaskId: string,
): TodoPhase[] {
	if (sourceTaskId === targetTaskId) return clonePhases(phasesInput);
	const phases = clonePhases(phasesInput);
	const sourcePhase = phases.find(phase => phase.tasks.some(task => task.id === sourceTaskId));
	const targetPhase = phases.find(phase => phase.tasks.some(task => task.id === targetTaskId));
	if (!sourcePhase || !targetPhase) return phases;
	const sourceIndex = sourcePhase.tasks.findIndex(task => task.id === sourceTaskId);
	const sourceEnd = subtreeEnd(sourcePhase, sourceIndex);
	const subtree = sourcePhase.tasks.slice(sourceIndex, sourceEnd);
	if (subtree.some(task => task.id === targetTaskId)) return phases;
	const targetParentId = targetPhase.tasks.find(task => task.id === targetTaskId)?.parentId;
	sourcePhase.tasks.splice(sourceIndex, sourceEnd - sourceIndex);
	const targetIndex = targetPhase.tasks.findIndex(task => task.id === targetTaskId);
	if (targetIndex < 0) return clonePhases(phasesInput);
	const [root, ...descendants] = subtree;
	const movedRoot = { ...root, ...(targetParentId ? { parentId: targetParentId } : {}) };
	if (!targetParentId) delete movedRoot.parentId;
	targetPhase.tasks.splice(targetIndex, 0, movedRoot, ...descendants);
	deriveContainerStatuses(phases);
	return phases;
}

export function moveTodoTask(phasesInput: readonly TodoPhase[], taskId: string, direction: "up" | "down"): TodoPhase[] {
	const phase = phasesInput.find(candidate => candidate.tasks.some(task => task.id === taskId));
	const task = phase?.tasks.find(candidate => candidate.id === taskId);
	if (!phase || !task) return clonePhases(phasesInput);
	const siblings = phase.tasks.filter(candidate => candidate.parentId === task.parentId);
	const index = siblings.findIndex(candidate => candidate.id === taskId);
	if (direction === "up" && index > 0) return reorderTodoTaskBefore(phasesInput, taskId, siblings[index - 1].id);
	if (direction === "down" && index >= 0 && index < siblings.length - 1) {
		return reorderTodoTaskBefore(phasesInput, siblings[index + 1].id, taskId);
	}
	return clonePhases(phasesInput);
}

export function moveTodoPhase(
	phasesInput: readonly TodoPhase[],
	phaseId: string,
	direction: "up" | "down",
): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	const index = phases.findIndex(phase => phase.id === phaseId);
	const target = direction === "up" ? index - 1 : index + 1;
	if (index < 0 || target < 0 || target >= phases.length) return phases;
	const [phase] = phases.splice(index, 1);
	phases.splice(target, 0, phase);
	return phases;
}

export function reorderTodoPhaseBefore(
	phasesInput: readonly TodoPhase[],
	sourcePhaseId: string,
	targetPhaseId: string,
): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	if (sourcePhaseId === targetPhaseId) return phases;
	const sourceIndex = phases.findIndex(phase => phase.id === sourcePhaseId);
	if (sourceIndex < 0) return phases;
	const [phase] = phases.splice(sourceIndex, 1);
	const targetIndex = phases.findIndex(candidate => candidate.id === targetPhaseId);
	if (targetIndex < 0) return clonePhases(phasesInput);
	phases.splice(targetIndex, 0, phase);
	return phases;
}

export function validateTodoDraft(phases: readonly TodoPhase[]): string[] {
	const errors: string[] = [];
	const phaseNames = new Set<string>();
	const taskContents = new Set<string>();
	for (const phase of phases) {
		const parentIds = new Set(phase.tasks.flatMap(task => (task.parentId ? [task.parentId] : [])));
		const name = phase.name.trim();
		if (!name) errors.push("Every phase needs a name.");
		else if (phaseNames.has(name)) errors.push(`Phase name “${name}” is duplicated.`);
		phaseNames.add(name);
		for (const task of phase.tasks) {
			const content = task.content.trim();
			if (!content) errors.push("Every task needs text.");
			else if (taskContents.has(content)) errors.push(`Task text “${content}” is duplicated.`);
			taskContents.add(content);
			if (!parentIds.has(task.id) && task.status === "blocked" && !task.blocker?.trim()) {
				errors.push(`Blocked task “${content || "Untitled task"}” needs a reason.`);
			}
		}
	}
	return Array.from(new Set(errors));
}

export function normalizeTodoDraft(phasesInput: readonly TodoPhase[]): TodoPhase[] {
	const phases = clonePhases(phasesInput);
	for (const phase of phases) {
		phase.name = phase.name.trim();
		for (const task of phase.tasks) {
			task.content = task.content.trim();
			if (task.status === "blocked" && task.blocker) task.blocker = task.blocker.trim();
			else if (task.status !== "blocked") delete task.blocker;
		}
	}
	deriveContainerStatuses(phases);
	return phases;
}

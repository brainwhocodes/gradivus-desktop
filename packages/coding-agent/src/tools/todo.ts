import {
	isClosedTodo,
	todoLeafTasks,
	todoTaskDepth,
	type TodoStatus,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
export { isClosedTodo } from "@oh-my-pi/pi-tui/tools/todo";
export type {
	TodoStatus,
	TodoOperation,
	TodoItem,
	TodoPhase,
	TodoCompletionTransition,
	TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

export interface TodoInputItem {
	content: string;
	parent?: string;
}

/** Accept canonical phases and legacy flat phases without IDs at the persistence boundary. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (
		!isRecord(value) ||
		(value.id !== undefined && typeof value.id !== "string") ||
		typeof value.name !== "string" ||
		!Array.isArray(value.tasks)
	)
		return false;
	return value.tasks.every(
		task =>
			isRecord(task) &&
			(task.id === undefined || typeof task.id === "string") &&
			typeof task.content === "string" &&
			(task.parentId === undefined || typeof task.parentId === "string") &&
			(task.blocker === undefined || typeof task.blocker === "string") &&
			(task.status === "pending" ||
				task.status === "in_progress" ||
				task.status === "completed" ||
				task.status === "abandoned" ||
				task.status === "blocked"),
	);
}

/**
 * Phases a successful, state-changing `todo` result committed, or undefined
 * for errors and pure `view` reads. A direct call lands these on the branch
 * through its own toolResult entry; a caller that produces no `todo`
 * toolResult (the eval bridge) must persist them itself or the next branch
 * rehydration (resume, rewind, fork, /btw) silently reverts the change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || !Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases;
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type(
	'"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "move" | "view"',
).describe("operation to apply");
const TodoInputItemSchema = type("string").or({
	content: type("string").describe("task content"),
	"parent?": type("string").describe("earlier parent task in the same phase"),
});
const InitListEntry = type({
	phase: type("string").describe("phase name"),
	items: TodoInputItemSchema.array().atLeastLength(1).describe("tasks for this phase"),
});
const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phased task list (init)"),
	"task?": type("string").describe("verbatim task content"),
	"phase?": type("string").describe("phase name"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": TodoInputItemSchema.array().describe("tasks for single-phase init or append"),
	"parent?": type("string").describe("destination parent task (move)"),
	"before?": type("string").describe("destination sibling anchor (move)"),
	"reason?": type("string").describe("blocker note for block"),
}).describe("apply a single todo operation");

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;
/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

// =============================================================================
// State helpers
// =============================================================================

function taskId(phaseIndex: number, taskIndex: number): string {
	return `todo-legacy-${phaseIndex}-${taskIndex}`;
}

function phaseId(phaseIndex: number): string {
	return `phase-legacy-${phaseIndex}`;
}

function cloneTask(task: TodoItem, phaseIndex: number, taskIndex: number): TodoItem {
	return {
		id: task.id || taskId(phaseIndex, taskIndex),
		content: task.content,
		status: task.status,
		...(task.blocker === undefined ? {} : { blocker: task.blocker }),
		...(task.parentId === undefined ? {} : { parentId: task.parentId }),
	};
}

function clonePhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map((phase, phaseIndex) => ({
		id: phase.id || phaseId(phaseIndex),
		name: phase.name,
		tasks: phase.tasks.map((task, taskIndex) => cloneTask(task, phaseIndex, taskIndex)),
	}));
}

export function isTodoContainer(phase: TodoPhase, task: TodoItem): boolean {
	return phase.tasks.some(candidate => candidate.parentId === task.id);
}

export function todoSubtreeTasks(phase: TodoPhase, root: TodoItem): TodoItem[] {
	const rootIndex = phase.tasks.findIndex(task => task.id === root.id);
	if (rootIndex < 0) return [];
	const rootDepth = todoTaskDepth(phase, root);
	let end = rootIndex + 1;
	while (end < phase.tasks.length && todoTaskDepth(phase, phase.tasks[end]) > rootDepth) end++;
	return phase.tasks.slice(rootIndex, end);
}

export function todoLeafSubtreeTasks(phase: TodoPhase, root: TodoItem): TodoItem[] {
	const subtreeIds = new Set(todoSubtreeTasks(phase, root).flatMap(task => (task.id ? [task.id] : [])));
	return todoLeafTasks(phase).filter(task => Boolean(task.id && subtreeIds.has(task.id)));
}

export function allTodoLeaves(phases: readonly TodoPhase[]): TodoItem[] {
	return phases.flatMap(phase => todoLeafTasks(phase));
}

export function countOpenTodoLeaves(phases: readonly TodoPhase[]): number {
	return allTodoLeaves(phases).filter(task => !isClosedTodo(task) && task.status !== "blocked").length;
}

function validateTodoPhases(phases: TodoPhase[]): string[] {
	const errors: string[] = [];
	const phaseIds = new Set<string>();
	const phaseNames = new Set<string>();
	const taskIds = new Set<string>();
	const taskContents = new Set<string>();
	for (const phase of phases) {
		if (!phase.id || phaseIds.has(phase.id)) errors.push(`Duplicate phase ID "${phase.id}"`);
		if (!phase.name || phaseNames.has(phase.name)) errors.push(`Duplicate phase "${phase.name}"`);
		if (phase.id) phaseIds.add(phase.id);
		phaseNames.add(phase.name);
		const earlier = new Set<string>();
		for (const task of phase.tasks) {
			if (!task.id || taskIds.has(task.id)) errors.push(`Duplicate task ID "${task.id}"`);
			if (!task.content || taskContents.has(task.content)) errors.push(`Duplicate task "${task.content}"`);
			if (task.parentId && !earlier.has(task.parentId)) {
				errors.push(`Task "${task.content}" references a missing or later parent`);
			}
			if (task.id) {
				taskIds.add(task.id);
				earlier.add(task.id);
			}
			taskContents.add(task.content);
		}
	}
	return errors;
}

function deriveContainerStates(phases: TodoPhase[]): void {
	for (const phase of phases) {
		const children = new Map<string, TodoItem[]>();
		for (const task of phase.tasks) {
			if (!task.parentId) continue;
			const siblings = children.get(task.parentId);
			if (siblings) siblings.push(task);
			else children.set(task.parentId, [task]);
		}
		for (let index = phase.tasks.length - 1; index >= 0; index--) {
			const task = phase.tasks[index];
			const directChildren = task.id ? children.get(task.id) : undefined;
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

function normalizeInProgressTask(phases: TodoPhase[]): void {
	const leaves = allTodoLeaves(phases);
	const inProgress = leaves.filter(task => task.status === "in_progress");
	for (const task of inProgress.slice(1)) task.status = "pending";
	if (inProgress.length === 0) {
		const firstPending = leaves.find(task => task.status === "pending");
		if (firstPending) firstPending.status = "in_progress";
	}
	deriveContainerStates(phases);
}

export function normalizeTodoPhases(phases: readonly TodoPhase[]): TodoPhase[] {
	const normalized = clonePhases(phases);
	const errors = validateTodoPhases(normalized);
	if (errors.length > 0) throw new Error(errors.join("\n"));
	normalizeInProgressTask(normalized);
	return normalized;
}

function findTaskByContent(phases: TodoPhase[], content: string): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find(candidate => candidate.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function todoTransitionKey(task: TodoItem): string {
	return task.id ?? task.content;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of todoLeafTasks(phase)) previousStatuses.set(todoTransitionKey(task), task.status);
	}
	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of todoLeafTasks(phase)) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(task));
			if (previousStatus && previousStatus !== "completed")
				transitions.push({ phase: phase.name, content: task.content });
		}
	}
	return transitions;
}

/** Return the active todo leaf, preferring in-progress work over the first pending leaf. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	const leaves = allTodoLeaves(phases);
	return leaves.find(task => task.status === "in_progress") ?? leaves.find(task => task.status === "pending");
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

export type TodoHudVisibility = "dismissed" | "revealed";

export interface TodoSnapshotIdentity {
	sourceEntryId: string;
	fingerprint: string;
}

export interface TodoHudStateEntryData extends TodoSnapshotIdentity {
	visibility: TodoHudVisibility;
}

function todoPhasesFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker === undefined
					? { content: task.content, status: task.status }
					: { content: task.content, status: task.status, blocker: task.blocker },
			),
		})),
	);
}

function canonicalTodoPhases(entry: SessionEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; phases?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view") return undefined;
	const phases = message.details?.phases;
	return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
}

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let sourceEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) {
			latest = phases;
			sourceEntryId = entries[i].id;
			break;
		}
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_HUD_STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TodoHudStateEntryData> | undefined;
		if (
			data?.sourceEntryId === snapshot.sourceEntryId &&
			data.fingerprint === snapshot.fingerprint &&
			(data.visibility === "dismissed" || data.visibility === "revealed")
		) {
			return data.visibility;
		}
	}
	return undefined;
}

/** Build persisted HUD metadata only for phases matching the latest durable canonical snapshot. */
export function createTodoHudStateData(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	visibility: TodoHudVisibility,
): TodoHudStateEntryData | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	return { ...snapshot, visibility };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) return clonePhases(phases);
	}
	return [];
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
		const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
		errors.push(`Task "${content}" not found${hint}`);
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function targetLeaves(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? todoLeafSubtreeTasks(hit.phase, hit.task) : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? todoLeafTasks(phase) : [];
	}
	return allTodoLeaves(phases);
}

function inputItem(value: string | TodoInputItem): TodoInputItem {
	return typeof value === "string" ? { content: value } : value;
}

function createTasks(
	items: Array<string | TodoInputItem>,
	phase: TodoPhase,
	globalContents: Set<string>,
	errors: string[],
): TodoItem[] {
	const created: TodoItem[] = [];
	const byContent = new Map(phase.tasks.map(task => [task.content, task]));
	for (const raw of items) {
		const input = inputItem(raw);
		if (!input.content || globalContents.has(input.content)) {
			errors.push(`Task "${input.content}" already exists`);
			continue;
		}
		const parent = input.parent ? byContent.get(input.parent) : undefined;
		if (input.parent && !parent) {
			errors.push(`Parent task "${input.parent}" must appear earlier in phase "${phase.name}"`);
			continue;
		}
		const task: TodoItem = {
			id: `todo-${crypto.randomUUID()}`,
			content: input.content,
			status: "pending",
			...(parent ? { parentId: parent.id } : {}),
		};
		created.push(task);
		byContent.set(task.content, task);
		globalContents.add(task.content);
	}
	return created;
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	const seenPhases = new Set<string>();
	const globalContents = new Set<string>();
	const phases: TodoPhase[] = [];
	for (const listEntry of list) {
		if (!listEntry.phase || seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
			continue;
		}
		seenPhases.add(listEntry.phase);
		const phase: TodoPhase = { id: `phase-${crypto.randomUUID()}`, name: listEntry.phase, tasks: [] };
		phase.tasks = createTasks(listEntry.items, phase, globalContents, errors);
		phases.push(phase);
	}
	return phases;
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}
	let phase = findPhaseByName(phases, entry.phase);
	if (!phase) {
		phase = { id: `phase-${crypto.randomUUID()}`, name: entry.phase, tasks: [] };
		phases.push(phase);
	}
	const globalContents = new Set(phases.flatMap(candidate => candidate.tasks.map(task => task.content)));
	const created = createTasks(entry.items, phase, globalContents, errors);
	if (errors.length > 0) return phases;
	for (const task of created) {
		if (!task.parentId) {
			phase.tasks.push(task);
			continue;
		}
		const parent = phase.tasks.find(candidate => candidate.id === task.parentId);
		if (!parent) {
			errors.push(`Parent for task "${task.content}" disappeared`);
			return phases;
		}
		const subtree = todoSubtreeTasks(phase, parent);
		const insertAt = phase.tasks.findIndex(candidate => candidate.id === subtree.at(-1)?.id) + 1;
		phase.tasks.splice(insertAt, 0, task);
	}
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		const ids = new Set(todoSubtreeTasks(hit.phase, hit.task).map(task => task.id));
		hit.phase.tasks = hit.phase.tasks.filter(task => !ids.has(task.id));
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (phase) phase.tasks = [];
		return phases;
	}
	for (const phase of phases) phase.tasks = [];
	return phases;
}

function moveTask(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	const hit = resolveTaskOrError(phases, entry.task, errors);
	const destination = resolvePhaseOrError(phases, entry.phase, errors);
	if (!hit || !destination) return phases;
	const subtree = todoSubtreeTasks(hit.phase, hit.task);
	const subtreeIds = new Set(subtree.map(task => task.id));
	const parent = entry.parent ? destination.tasks.find(task => task.content === entry.parent) : undefined;
	if (entry.parent && !parent) {
		errors.push(`Parent task "${entry.parent}" not found in phase "${destination.name}"`);
		return phases;
	}
	if (parent && subtreeIds.has(parent.id)) {
		errors.push(`Cannot move task "${hit.task.content}" beneath its own subtree`);
		return phases;
	}
	const destinationParentId = parent?.id;
	const before = entry.before ? destination.tasks.find(task => task.content === entry.before) : undefined;
	if (entry.before && !before) {
		errors.push(`Sibling anchor "${entry.before}" not found in phase "${destination.name}"`);
		return phases;
	}
	if (before && (before.parentId ?? undefined) !== destinationParentId) {
		errors.push(`Sibling anchor "${before.content}" does not share the destination parent`);
		return phases;
	}
	if (before && subtreeIds.has(before.id)) {
		errors.push(`Sibling anchor "${before.content}" is inside the moved subtree`);
		return phases;
	}

	hit.phase.tasks = hit.phase.tasks.filter(task => !subtreeIds.has(task.id));
	hit.task.parentId = destinationParentId;
	let insertAt: number;
	if (before) {
		insertAt = destination.tasks.findIndex(task => task.id === before.id);
	} else if (parent) {
		const parentSubtree = todoSubtreeTasks(destination, parent);
		insertAt = destination.tasks.findIndex(task => task.id === parentSubtree.at(-1)?.id) + 1;
	} else {
		insertAt = destination.tasks.length;
	}
	destination.tasks.splice(insertAt, 0, ...subtree);
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	const previousContainers = new Map<string, TodoStatus>();
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.id && isTodoContainer(phase, task)) previousContainers.set(task.id, task.status);
		}
	}
	let next = phases;
	switch (entry.op) {
		case "init":
			next = initPhases(entry, errors);
			break;
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) break;
			const target = todoLeafSubtreeTasks(hit.phase, hit.task).find(task => task.status === "pending");
			if (!target) {
				errors.push(`Task "${hit.task.content}" has no pending leaf to start`);
				break;
			}
			for (const leaf of allTodoLeaves(phases)) {
				if (leaf.status === "in_progress") leaf.status = "pending";
			}
			target.status = "in_progress";
			break;
		}
		case "done":
			for (const task of targetLeaves(phases, entry, errors)) task.status = "completed";
			break;
		case "drop":
			for (const task of targetLeaves(phases, entry, errors)) task.status = "abandoned";
			break;
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				break;
			}
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of targetLeaves(phases, entry, errors)) {
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			break;
		}
		case "unblock":
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				break;
			}
			for (const task of targetLeaves(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					delete task.blocker;
				}
			}
			break;
		case "rm":
			next = removeTasks(phases, entry, errors);
			break;
		case "append":
			next = appendItems(phases, entry, errors);
			break;
		case "move":
			next = moveTask(phases, entry, errors);
			break;
		case "view":
			return phases;
	}
	if (errors.length > 0) return next;
	for (const phase of next) {
		for (const task of phase.tasks) {
			const priorStatus = task.id ? previousContainers.get(task.id) : undefined;
			if (priorStatus === "blocked" && !isTodoContainer(phase, task) && task.blocker === undefined) {
				task.status = "pending";
			}
		}
	}
	normalizeInProgressTask(next);
	return next;
}

function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
	const direct = todoSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

function applyParams(phases: TodoPhase[], params: TodoOpEntryValue): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = normalizeTodoPhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors);
		if (errors.length > 0) break;
	}
	return { phases: next, errors };
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
		const phase = phases[phaseIndex];
		if (phaseIndex > 0) out.push("");
		out.push(`# ${phase.name}`);
		for (const task of phase.tasks) {
			const blockerNote = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
			const indent = "  ".repeat(todoTaskDepth(phase, task));
			out.push(`${indent}- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`);
		}
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

/** Parse an indented Markdown checklist back into deterministic preorder phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;
	let baseIndent: number | undefined;
	let indentUnit: number | undefined;
	let previousDepth = 0;
	let taskAtDepth: TodoItem[] = [];
	const seenContents = new Set<string>();

	const lines = md.split(/\r?\n/);
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const raw = lines[lineIndex];
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = {
				id: `phase-${crypto.randomUUID()}`,
				name: headingMatch[1].trim(),
				tasks: [],
			};
			phases.push(currentPhase);
			baseIndent = undefined;
			indentUnit = undefined;
			previousDepth = 0;
			taskAtDepth = [];
			continue;
		}

		const taskMatch = /^(\s*)[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(raw);
		if (!taskMatch) {
			errors.push(`Line ${lineIndex + 1}: unrecognized syntax "${trimmed}"`);
			continue;
		}
		if (!currentPhase) {
			currentPhase = { id: `phase-${crypto.randomUUID()}`, name: "Todos", tasks: [] };
			phases.push(currentPhase);
		}
		const marker = taskMatch[2];
		const status = MARKER_TO_STATUS[marker];
		if (!status) {
			errors.push(`Line ${lineIndex + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`);
			continue;
		}
		const indent = taskMatch[1].replaceAll("\t", "  ").length;
		baseIndent ??= indent;
		if (indent < baseIndent) {
			errors.push(`Line ${lineIndex + 1}: indentation is shallower than the first task`);
			continue;
		}
		if (indent > baseIndent && indentUnit === undefined) indentUnit = indent - baseIndent;
		const relativeIndent = indent - baseIndent;
		if (indentUnit && relativeIndent % indentUnit !== 0) {
			errors.push(`Line ${lineIndex + 1}: indentation does not match the established nesting width`);
			continue;
		}
		const depth = indentUnit ? relativeIndent / indentUnit : 0;
		if (depth > previousDepth + 1 || (depth > 0 && !taskAtDepth[depth - 1])) {
			errors.push(`Line ${lineIndex + 1}: indentation jumps to an unseen deeper level`);
			continue;
		}
		const rawContent = taskMatch[3].trim();
		const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
		const content = (blockerMatch?.[1] ?? rawContent).trim();
		if (!content || seenContents.has(content)) {
			errors.push(`Line ${lineIndex + 1}: duplicate or empty task "${content}"`);
			continue;
		}
		const parent = depth > 0 ? taskAtDepth[depth - 1] : undefined;
		const task: TodoItem = {
			id: `todo-${crypto.randomUUID()}`,
			content,
			status,
			...(status === "blocked" && blockerMatch?.[2] ? { blocker: blockerMatch[2].trim() } : {}),
			...(parent ? { parentId: parent.id } : {}),
		};
		currentPhase.tasks.push(task);
		seenContents.add(content);
		taskAtDepth[depth] = task;
		taskAtDepth.length = depth + 1;
		previousDepth = depth;
	}

	if (errors.length === 0) normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const tasks = allTodoLeaves(phases);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}
	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: todoLeafTasks(phase).filter(task => task.status === "pending" || task.status === "in_progress"),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));
	let currentIdx = phases.findIndex(phase =>
		todoLeafTasks(phase).some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const currentLeaves = todoLeafTasks(current);
	const done = currentLeaves.filter(isClosedTodo).length;

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
	}
	const closedAll = tasks.filter(isClosedTodo).length;
	const blockedAll = tasks.filter(task => task.status === "blocked").length;
	const workedAhead = phases.some((phase, index) => index > currentIdx && todoLeafTasks(phase).some(isClosedTodo));
	lines.push(
		`Overall: ${closedAll}/${tasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${done}/${currentLeaves.length})${
			workedAhead
				? " — earliest phase with open leaves; the in-progress pointer can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`${"  ".repeat(todoTaskDepth(phase, task) + 2)}- ${checkbox} ${task.content}${tag}`);
		}
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;

	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		if (typeof resolved === "string") {
			return {
				content: [{ type: "text", text: resolved }],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const entry = resolved;
		const op = entry.op;
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const details: TodoToolDetails = { op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		return {
			content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}
}

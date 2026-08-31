import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { isRecord, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";
import { framedBlock, renderStatusLine, renderTreeList } from "../tui";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { formatErrorDetail, formatMoreItems, PREVIEW_LIMITS, pluralize, replaceTabs } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation =
	| "init"
	| "start"
	| "done"
	| "rm"
	| "drop"
	| "block"
	| "unblock"
	| "append"
	| "move"
	| "view";

export interface TodoItem {
	/** Canonical states always carry an ID; legacy persisted entries omit it until normalized. */
	id?: string;
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
	/** Parent task in the same phase. Tasks remain stored in depth-first preorder. */
	parentId?: string;
}

export interface TodoPhase {
	/** Canonical states always carry an ID; legacy persisted entries omit it until normalized. */
	id?: string;
	name: string;
	tasks: TodoItem[];
}

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

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
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
	"task?": type("string").describe("task content"),
	"phase?": type("string").describe("phase name"),
	"items?": TodoInputItemSchema.array().describe("tasks for single-phase init or append"),
	"parent?": type("string").describe("destination parent task (move)"),
	"before?": type("string").describe("destination sibling anchor (move)"),
	"reason?": type("string").describe("blocker note (block op)"),
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

export function todoTaskDepth(phase: TodoPhase, task: TodoItem): number {
	const byId = new Map(phase.tasks.map(candidate => [candidate.id, candidate]));
	let depth = 0;
	let parentId = task.parentId;
	const seen = new Set<string>();
	while (parentId) {
		if (seen.has(parentId)) return depth;
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) return depth;
		depth++;
		parentId = parent.parentId;
	}
	return depth;
}

export function isTodoContainer(phase: TodoPhase, task: TodoItem): boolean {
	return phase.tasks.some(candidate => candidate.parentId === task.id);
}

export function todoLeafTasks(phase: TodoPhase): TodoItem[] {
	const parentIds = new Set(phase.tasks.flatMap(task => (task.parentId ? [task.parentId] : [])));
	return phase.tasks.filter(task => !task.id || !parentIds.has(task.id));
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

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		let phases: unknown;
		if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const data = entry.data as { phases?: unknown } | undefined;
			phases = data?.phases;
		} else if (entry.type === "message") {
			const message = entry.message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
			if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
			const details = message.details as { phases?: unknown } | undefined;
			phases = details?.phases;
		}
		if (!Array.isArray(phases) || !phases.every(isTodoPhase)) continue;
		try {
			return normalizeTodoPhases(phases);
		} catch {}
	}
	return [];
}

/** Minimum overlap (after normalization) required for a substring match.
 * Picked at six chars to admit single-word identifiers like "review" /
 * "Sonnet" without admitting tiny common substrings like "test" / "fix"
 * that would collide across unrelated todos. */
const TODO_DESCRIPTION_MIN_OVERLAP = 6;

function normalizeForTodoMatch(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * Report whether `content` likely names the same work as any entry in
 * `descriptions`. Used by the sticky todo panel to light up a pending todo
 * when an in-flight subagent is doing the work for it, without requiring
 * the caller to flip the todo's status.
 *
 * Matching is normalize-then-equal first (lowercased; punctuation and
 * whitespace runs both collapsed to a single space; trimmed), with a
 * substring fallback in either direction so minor wording drift
 * ("Sonnet #2: bug scan" vs "Sonnet #2") still links up. The substring
 * fallback requires at least {@link TODO_DESCRIPTION_MIN_OVERLAP} chars on
 * the contained side.
 */
export function todoMatchesAnyDescription(content: string, descriptions: readonly string[]): boolean {
	const target = normalizeForTodoMatch(content);
	if (!target) return false;
	for (const desc of descriptions) {
		const candidate = normalizeForTodoMatch(desc);
		if (!candidate) continue;
		if (target === candidate) return true;
		if (target.length >= TODO_DESCRIPTION_MIN_OVERLAP && candidate.includes(target)) return true;
		if (candidate.length >= TODO_DESCRIPTION_MIN_OVERLAP && target.includes(candidate)) return true;
	}
	return false;
}

/** Whether a todo is settled: completed or deliberately abandoned. Shared so
 *  the collapsed viewport, the HUD progress counters, and the HUD's closed-todo
 *  auto-clear can never disagree about what "done" hides. */
export function isClosedTodo<T extends { status: TodoStatus }>(task: T): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/**
 * A todo the collapsed viewport treats as current work: the literal
 * `in_progress` task or a pending task a live subagent is executing. Both
 * collapsed views (transient tool result + sticky HUD) run this same policy so
 * they can never disagree about what the agent is doing (#5873).
 */
function isActiveTodo<T extends { status: TodoStatus }>(task: T, isMatched: (task: T) => boolean): boolean {
	return task.status === "in_progress" || (task.status === "pending" && isMatched(task));
}

/** Result of {@link selectCollapsedTodos}: the rows to render plus an optional
 *  summary line (empty string ⇒ no summary row). */
export interface CollapsedTodoSelection<T> {
	items: T[];
	summary: string;
}

/**
 * Closed rows kept directly above the open window so finishing a task is
 * visible as it happens. Without this the collapsed viewport only ever renders
 * unchecked boxes while a phase has open work: every completion silently
 * removes a row, so a plan mid-flight looks untouched, and the card's
 * completion strike animation (`completedTasks` → {@link TODO_STRIKE_TOTAL_FRAMES})
 * animated a row that was never rendered.
 */
const COLLAPSED_CLOSED_CONTEXT = 1;

/**
 * Rows to show for a display base already reduced to the relevant tasks.
 *
 * 1. Every active task (in-progress, or pending matched to a live subagent) is
 *    placed at the head in stable todo order — never dropped for lying outside
 *    an ordinary window.
 * 2. Remaining rows up to `cap` are filled with the pending tasks that follow
 *    the first active one, in todo order (falling back to leading pending tasks
 *    when no active task exists), so a freshly-promoted task leads the preview.
 * 3. When active tasks alone exceed `cap`, only the first `cap` active tasks are
 *    shown and the summary counts the hidden *active* todos, never replacing
 *    them with unrelated pending rows.
 */
function selectWithinCap<T extends { status: TodoStatus }>(
	base: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	if (base.length <= cap) return { items: base, summary: "" };

	const active = base.filter(task => isActiveTodo(task, isMatched));
	// Only when active work strictly exceeds the cap do we drop pending rows and
	// count hidden *actives*. At exactly `cap` actives, fall through so the normal
	// branch still surfaces any following pending work in the summary.
	if (active.length > cap) {
		const hiddenActive = active.length - cap;
		return {
			items: active.slice(0, cap),
			summary: `… ${hiddenActive} more active ${pluralize("todo", hiddenActive)}`,
		};
	}

	// Fill trailing rows with tasks following the first active one, so the
	// promoted/current task leads and its successors follow in todo order.
	const firstActiveIdx = active.length > 0 ? base.indexOf(active[0]) : 0;
	const fill: T[] = [];
	for (let i = firstActiveIdx; i < base.length && active.length + fill.length < cap; i++) {
		const task = base[i];
		if (isActiveTodo(task, isMatched)) continue;
		fill.push(task);
	}
	const items = [...active, ...fill];
	const hidden = base.length - items.length;
	return { items, summary: hidden > 0 ? formatMoreItems(hidden, "todo") : "" };
}

/**
 * Walking-viewport selection for a phase's collapsed todo preview (#5873).
 *
 * Applied to `tasks` in todo order: the open tasks run through
 * {@link selectWithinCap}, led by the last {@link COLLAPSED_CLOSED_CONTEXT}
 * closed tasks in todo order so a checked row remains visible even when callers
 * complete work out of sequence. The lead is additive — it never costs an open
 * row — and a phase with no open work left falls back to its closed tasks so the
 * sticky HUD's closed-todo persistence still has something to render.
 *
 * `summary` counts the open tasks that did not fit; the closed lead is context,
 * not part of the budget.
 */
export function selectCollapsedTodos<T extends { status: TodoStatus }>(
	tasks: T[],
	isMatched: (task: T) => boolean,
	cap: number,
): CollapsedTodoSelection<T> {
	const open = tasks.filter(task => !isClosedTodo(task));
	// Closed tasks are never active, so a settled phase selects over itself.
	if (open.length === 0) return selectWithinCap(tasks, isMatched, cap);
	// `done` accepts any named task, so closed tasks are not necessarily a prefix.
	const lead = tasks.filter(isClosedTodo).slice(-COLLAPSED_CLOSED_CONTEXT);
	const selected = selectWithinCap(open, isMatched, cap);
	return { items: [...lead, ...selected.items], summary: selected.summary };
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

	readonly examples: readonly ToolExample<typeof todoSchema.infer>[] = [
		{
			caption: "Initial setup (multi-phase)",
			call: {
				op: "init",
				list: [
					{ phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
					{ phase: "Auth", items: ["Port credential store", "Wire OAuth providers"] },
					{ phase: "Verification", items: ["Run cargo test"] },
				],
			},
		},
		{
			caption: "View current state (read-only)",
			call: { op: "view" },
		},
		{
			caption: "Initial setup (single phase)",
			call: {
				op: "init",
				list: [{ phase: "Implementation", items: ["Apply fix", "Run tests"] }],
			},
		},
		{
			caption: "Complete one task",
			call: { op: "done", task: "Wire workspace" },
		},
		{
			caption: "Complete a whole phase",
			call: { op: "done", phase: "Auth" },
		},
		{
			caption: "Remove all tasks",
			call: { op: "rm" },
		},
		{
			caption: "Drop one task",
			call: { op: "drop", task: "Run cargo test" },
		},
		{
			caption: "Append tasks to a phase",
			call: { op: "append", phase: "Auth", items: ["Handle retries", "Run tests"] },
		},
	];
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

// =============================================================================
// TUI Renderer
// =============================================================================

type TodoRenderOp = {
	op?: string;
	task?: string;
	phase?: string;
	parent?: string;
	before?: string;
	items?: Array<string | TodoInputItem>;
};

/** New single-op shape `{op,...}`; legacy `{ops:[...]}` still seen in old transcripts. */
type TodoRenderArgs = TodoRenderOp & {
	ops?: TodoRenderOp[];
};

/**
 * Normalize streaming/legacy render args to a flat op list. Accepts the new
 * top-level `{op,...}` shape (returned as a one-element list), the legacy
 * `{ops:[...]}` batch from old transcripts/collab-web, and partially-parsed
 * streaming deltas (non-array `ops`, non-object entries) without crashing.
 */
function normalizeTodoArg(args: TodoRenderArgs | undefined): TodoRenderOp[] {
	if (!args || typeof args !== "object") return [];
	if (Array.isArray(args.ops)) {
		return args.ops.filter((entry): entry is TodoRenderOp => !!entry && typeof entry === "object");
	}
	return typeof args.op === "string" ? [args] : [];
}

// =============================================================================
// Phase numbering (display-only)
// =============================================================================

const ROMAN_PAIRS: Array<[number, string]> = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];

/** One-based ASCII roman numeral for display (I, II, III, IV, …). */
export function phaseRomanNumeral(oneBasedIndex: number): string {
	if (oneBasedIndex <= 0) return "";
	let out = "";
	let rem = oneBasedIndex;
	for (const [value, sym] of ROMAN_PAIRS) {
		while (rem >= value) {
			out += sym;
			rem -= value;
		}
	}
	return out;
}

/**
 * Every render boundary in this file funnels display text through here.
 *
 * `sanitizeText` strips ANSI/C0 sequences but deliberately preserves tabs, and
 * a raw tab punches holes in bordered TUI output, so both are needed. The raw
 * value stays untouched everywhere else: task content and phase names are the
 * identity keys the local list is looked up by, and what gets persisted.
 */
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/**
 * Display-only phase header: `I. Foundation`. State and prompts never see this.
 *
 * Sanitized for the same reason task labels are: this is a render boundary and
 * the name may carry provider or session text holding control sequences. The
 * raw `phase.name` stays the lookup key everywhere else.
 */
export function formatPhaseDisplayName(name: string, oneBasedIndex: number): string {
	return `${phaseRomanNumeral(oneBasedIndex)}. ${forDisplay(name)}`;
}

export const TODO_STRIKE_HOLD_FRAMES = 2;
export const TODO_STRIKE_REVEAL_FRAMES = 12;
export const TODO_STRIKE_TOTAL_FRAMES = TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;
const EMPTY_COMPLETION_KEYS = new Set<string>();
const STRIKE_START = "\x1b[9m";
const STRIKE_END = "\x1b[29m";

function strikethroughText(text: string): string {
	return `${STRIKE_START}${text}${STRIKE_END}`;
}

function partialStrikethrough(text: string, visibleChars: number): string {
	if (visibleChars <= 0) return text;
	const chars = [...text];
	if (visibleChars >= chars.length) return strikethroughText(text);
	return `${strikethroughText(chars.slice(0, visibleChars).join(""))}${chars.slice(visibleChars).join("")}`;
}

function strikeRevealCount(text: string, frame: number | undefined): number | undefined {
	if (frame === undefined) return undefined;
	if (frame <= TODO_STRIKE_HOLD_FRAMES) return 0;
	const chars = [...text];
	if (chars.length === 0) return undefined;
	const revealFrame = Math.min(frame - TODO_STRIKE_HOLD_FRAMES, TODO_STRIKE_REVEAL_FRAMES);
	return Math.ceil((chars.length * revealFrame) / TODO_STRIKE_REVEAL_FRAMES);
}

function formatTodoLine(
	item: TodoItem,
	uiTheme: Theme,
	prefix: string,
	completionKeys: Set<string>,
	frame: number | undefined,
	matched = false,
): string {
	const checkbox = uiTheme.checkbox;
	// Sanitize only for display. A mirrored Cursor snapshot carries provider text
	// verbatim, and a label holding ANSI/C0 sequences would otherwise rewrite the
	// terminal every time the list renders or replays. `item.content` stays raw
	// everywhere else: it is the identity key the local list is looked up by
	// (`findTaskByContent`) and what gets persisted.
	const label = forDisplay(item.content);
	switch (item.status) {
		case "completed": {
			const revealCount = completionKeys.has(item.content) ? strikeRevealCount(label, frame) : undefined;
			const content =
				revealCount === undefined ? strikethroughText(label) : partialStrikethrough(label, revealCount);
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${content}`);
		}
		case "in_progress":
			return uiTheme.fg("accent", `${prefix}${checkbox.unchecked} ${label}`);
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${strikethroughText(label)}`);
		case "blocked": {
			const note = item.blocker ? `blocked: ${forDisplay(item.blocker)}` : "blocked";
			return uiTheme.fg("warning", `${prefix}${checkbox.unchecked} ${label} (${note})`);
		}
		default:
			// A pending todo lit by a live subagent match renders accent, matching
			// the sticky HUD's convention (#5873).
			return uiTheme.fg(matched ? "accent" : "dim", `${prefix}${checkbox.unchecked} ${label}`);
	}
}

/**
 * Phases the latest update touched, plus the active (in_progress) phase.
 * Returns `null` when there is no usable signal, meaning "render every phase
 * fully" — this preserves the legacy view and the manual-expand path.
 */
function computeTouchedPhases(
	args: TodoRenderArgs | undefined,
	phases: TodoPhase[],
	completedTasks: TodoCompletionTransition[],
): Set<string> | null {
	const touched = new Set<string>();
	// The phase holding the in_progress task is where attention sits after the
	// auto-promotion that follows every completion.
	for (const phase of phases) {
		if (phase.tasks.some(task => task.status === "in_progress")) touched.add(phase.name);
	}
	// Phases with a task that just transitioned to completed in this update.
	for (const transition of completedTasks) touched.add(transition.phase);
	// Phases explicitly named by the ops that ran. `init` replaces the whole
	// list, so the entire plan is fresh and every phase counts as touched.
	const ops = normalizeTodoArg(args);
	for (const op of ops) {
		if (!op || typeof op !== "object") continue;
		if (op.op === "init") {
			for (const phase of phases) touched.add(phase.name);
			break;
		}
		if (typeof op.phase === "string" && op.phase) {
			const named = phases.find(phase => phase.name === op.phase);
			if (named) touched.add(named.name);
		}
		if (typeof op.task === "string" && op.task) {
			const located = findTaskByContent(phases, op.task);
			if (located) touched.add(located.phase.name);
		}
	}
	return touched.size > 0 ? touched : null;
}

/**
 * Dim `closed/total` suffix for a phase header. Counts closed tasks, not just
 * completed ones: the collapsed viewport hides both, so an abandoned task has to
 * move the counter or its phase reads as permanently stuck.
 */
function formatPhaseProgress(phase: TodoPhase, uiTheme: Theme): string {
	const leaves = todoLeafTasks(phase);
	const done = leaves.filter(isClosedTodo).length;
	return uiTheme.fg("dim", `  ${done}/${leaves.length}`);
}

/** One-line summary for a collapsed (untouched) phase: dim header + progress. */
function formatPhaseSummary(phase: TodoPhase, oneBasedIndex: number, uiTheme: Theme): string {
	const name = uiTheme.fg("dim", chalk.bold(formatPhaseDisplayName(phase.name, oneBasedIndex)));
	return `${name}${formatPhaseProgress(phase, uiTheme)}`;
}

/**
 * Live subagent descriptions the transient tool result uses to detect
 * pending todos being executed by an in-flight subagent, so its collapsed
 * viewport surfaces the same active work the sticky HUD does (#5873). Wired
 * once by interactive mode from its observer registry; returns `[]` outside an
 * interactive session (tests, SDK, transcript rebuilds), where only literal
 * `in_progress` counts as active.
 */
let activeTodoDescriptionsProvider: () => readonly string[] = () => [];

/** Wire the live-subagent description source for {@link todoToolRenderer}. */
export function setActiveTodoDescriptionsProvider(provider: () => readonly string[]): void {
	activeTodoDescriptionsProvider = provider;
}

export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// `args` is the raw partially-parsed JSON from the streaming tool-call
		// delta and may not satisfy `TodoRenderArgs` at runtime:
		// `parseStreamingJson` can hand back `{ op: 1 }` mid-delta, or a legacy
		// `{ ops: "[" }` shape before fields stream. `normalizeTodoArg` guards
		// both the new single-op and legacy batch shapes so a malformed delta
		// never breaks the TUI render loop (#2005).
		const opsList = normalizeTodoArg(args);
		// Model-authored, partially-streamed strings going straight into a header:
		// `renderStatusLine` only flattens CR/LF and leaves the rest to the caller.
		const ops =
			opsList.length === 0
				? ["update"]
				: opsList.map(e => {
						const parts = [forDisplay(e.op ?? "update")];
						if (e.task) parts.push(forDisplay(e.task));
						if (e.phase) parts.push(forDisplay(e.phase));
						if (Array.isArray(e.items) && e.items.length) {
							parts.push(`${e.items.length} item${e.items.length === 1 ? "" : "s"}`);
						}
						return parts.join(" ");
					});
		// No body worth boxing while the call streams — a lone status line reads
		// cleaner than an empty frame. The container renders it without chrome.
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Todo", meta: ops },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: TodoRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(content => content.type === "text")?.text ?? "Todo operation failed";
			const header = renderStatusLine({ icon: "error", title: "Todo" }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		const completedTasks = result.details?.completedTasks ?? [];
		const completionKeysByPhase = new Map<string, Set<string>>();
		for (const task of completedTasks) {
			let keys = completionKeysByPhase.get(task.phase);
			if (!keys) {
				keys = new Set<string>();
				completionKeysByPhase.set(task.phase, keys);
			}
			keys.add(task.content);
		}
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.todo", "accent"),
				title: "Todo",
				meta: [`${allTasks.length} tasks`],
			},
			uiTheme,
		);
		if (allTasks.length === 0) {
			// Provider text on the Cursor path (the todo summary or a refusal note),
			// so sanitize like every other label. The error branch above already
			// goes through `formatErrorDetail`.
			const fallback = forDisplay(result.content?.find(content => content.type === "text")?.text ?? "No todos");
			return new Text(`${header}\n  ${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const { expanded, spinnerFrame } = options;
			const multiPhase = phases.length > 1;
			const indent = multiPhase ? "  " : "";
			// Collapse phases this update didn't touch down to a one-line summary so
			// a single task flip doesn't redraw every phase's full task list. The
			// manual expand toggle (and the no-signal fallback) still shows all.
			const touched = expanded || !multiPhase ? null : computeTouchedPhases(args, phases, completedTasks);
			// A pending todo counts as active work when an in-flight subagent is
			// executing it — the transient result surfaces the same active set the
			// sticky HUD does (#5873). Empty outside an interactive session.
			const activeDescs = expanded ? [] : activeTodoDescriptionsProvider();
			const isMatched = (task: TodoItem): boolean =>
				activeDescs.length > 0 && todoMatchesAnyDescription(task.content, activeDescs);
			const bodyLines: string[] = [];
			for (let p = 0; p < phases.length; p++) {
				const phase = phases[p];
				if (touched && !touched.has(phase.name)) {
					bodyLines.push(formatPhaseSummary(phase, p + 1, uiTheme));
					continue;
				}
				if (multiPhase) {
					// Progress belongs on the expanded header too: the collapsed
					// viewport below hides closed rows, so without it the phase the
					// agent is actually working in is the one phase with no visible
					// completion signal at all.
					const name = uiTheme.fg("accent", chalk.bold(formatPhaseDisplayName(phase.name, p + 1)));
					bodyLines.push(`${name}${formatPhaseProgress(phase, uiTheme)}`);
				}
				const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_COMPLETION_KEYS;
				// Collapsed: walking viewport — the last closed task leads, then
				// active work (in-progress / subagent-matched), then following
				// pending tasks (#5873). Expanded: every task in order.
				const treeLines = expanded
					? renderTreeList(
							{
								items: phase.tasks,
								expanded,
								itemType: "todo",
								renderItem: todo =>
									formatTodoLine(
										todo,
										uiTheme,
										"  ".repeat(todoTaskDepth(phase, todo)),
										completionKeys,
										spinnerFrame,
									),
							},
							uiTheme,
						)
					: (() => {
							const selection = selectCollapsedTodos(
								todoLeafTasks(phase),
								isMatched,
								PREVIEW_LIMITS.COLLAPSED_ITEMS,
							);
							return renderTreeList(
								{
									items: selection.items,
									itemType: "todo",
									trailingSummary: selection.summary,
									renderItem: todo =>
										formatTodoLine(
											todo,
											uiTheme,
											"  ".repeat(todoTaskDepth(phase, todo)),
											completionKeys,
											spinnerFrame,
											isMatched(todo),
										),
								},
								uiTheme,
							);
						})();
				for (const line of treeLines) {
					bodyLines.push(`${indent}${line}`);
				}
			}
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
	mergeCallAndResult: true,
};

import { describe, expect, it } from "vitest";
import {
	deleteTodoTask,
	indentTodoTask,
	moveTodoTask,
	outdentTodoTask,
	reorderTodoTaskBefore,
	updateTodoSubtreeStatus,
	updateTodoTaskStatus,
	validateTodoDraft,
} from "../src/renderer/todo-editing";
import type { TodoPhase } from "../src/shared/contracts";

function fixture(): TodoPhase[] {
	return [
		{
			id: "phase-build",
			name: "Build",
			tasks: [
				{ id: "parent", content: "Parent", status: "in_progress" },
				{ id: "first", content: "First child", status: "in_progress", parentId: "parent" },
				{ id: "nested", content: "Nested child", status: "pending", parentId: "first" },
				{ id: "second", content: "Second child", status: "pending", parentId: "parent" },
				{ id: "root", content: "Root task", status: "pending" },
			],
		},
		{ id: "phase-check", name: "Check", tasks: [{ id: "verify", content: "Verify", status: "pending" }] },
	];
}

describe("todo editor hierarchy", () => {
	it("moves a sibling with its complete subtree", () => {
		const moved = moveTodoTask(fixture(), "first", "down");
		expect(moved[0].tasks.map(task => task.id)).toEqual(["parent", "second", "first", "nested", "root"]);
		expect(moved[0].tasks.find(task => task.id === "nested")?.parentId).toBe("first");
	});

	it("moves a subtree across phases without orphaning descendants", () => {
		const moved = reorderTodoTaskBefore(fixture(), "first", "verify");
		expect(moved[0].tasks.map(task => task.id)).toEqual(["parent", "second", "root"]);
		expect(moved[1].tasks.map(task => task.id)).toEqual(["first", "nested", "verify"]);
		expect(moved[1].tasks.find(task => task.id === "first")?.parentId).toBeUndefined();
		expect(moved[1].tasks.find(task => task.id === "nested")?.parentId).toBe("first");
	});

	it("deletes descendants and derives the parent state", () => {
		const deleted = deleteTodoTask(fixture(), "first");
		expect(deleted[0].tasks.map(task => task.id)).toEqual(["parent", "second", "root"]);
		expect(deleted[0].tasks[0].status).toBe("pending");
	});

	it("keeps one active leaf and derives ancestor states", () => {
		const updated = updateTodoTaskStatus(fixture(), "second", "in_progress");
		expect(updated[0].tasks.find(task => task.id === "first")?.status).toBe("pending");
		expect(updated[0].tasks.find(task => task.id === "second")?.status).toBe("in_progress");
		expect(updated[0].tasks.find(task => task.id === "parent")?.status).toBe("in_progress");
	});

	it("indents, outdents, and cascades subtree status by stable IDs", () => {
		const indented = indentTodoTask(fixture(), "root");
		expect(indented[0].tasks.find(task => task.id === "root")?.parentId).toBe("parent");
		const outdented = outdentTodoTask(fixture(), "second");
		expect(outdented[0].tasks.map(task => task.id)).toEqual(["parent", "first", "nested", "second", "root"]);
		expect(outdented[0].tasks.find(task => task.id === "second")?.parentId).toBeUndefined();
		const completed = updateTodoSubtreeStatus(fixture(), "parent", "completed");
		expect(
			completed[0].tasks.filter(task => task.id === "nested" || task.id === "second").map(task => task.status),
		).toEqual(["completed", "completed"]);
		expect(completed[0].tasks.find(task => task.id === "parent")?.status).toBe("completed");
	});
	it("does not require blockers on derived container states", () => {
		const phases = fixture();
		phases[0].tasks[0].status = "blocked";
		expect(validateTodoDraft(phases)).toEqual([]);
	});

	it("rejects empty blockers and duplicate task text before RPC", () => {
		const phases = fixture();
		phases[1].tasks[0].content = "Root task";
		phases[0].tasks[4].status = "blocked";
		phases[0].tasks[4].blocker = " ";
		expect(validateTodoDraft(phases)).toEqual([
			"Blocked task “Root task” needs a reason.",
			"Task text “Root task” is duplicated.",
		]);
	});
});

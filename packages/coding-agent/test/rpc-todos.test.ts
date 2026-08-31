import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, TodoConflictError } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

describe("revisioned RPC todo state", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true, "todo.reminders": false }),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
	});

	it("increments revisions and pushes every canonical mutation", () => {
		const initialRevision = session.getTodoRevision();
		const updates: Array<{ revision: number; contents: string[] }> = [];
		const unsubscribe = session.subscribeTodos((phases, revision) => {
			updates.push({ revision, contents: phases.flatMap(phase => phase.tasks.map(task => task.content)) });
		});
		try {
			session.setTodoPhases([{ name: "Work", tasks: [{ content: "first", status: "pending" }] }]);
			session.setTodoPhases([{ name: "Work", tasks: [{ content: "second", status: "pending" }] }]);
		} finally {
			unsubscribe();
		}

		expect(updates).toEqual([
			{ revision: initialRevision + 1, contents: ["first"] },
			{ revision: initialRevision + 2, contents: ["second"] },
		]);
		expect(session.getTodoRevision()).toBe(initialRevision + 2);
	});

	it("persists a hierarchical user edit and rejects a stale revision untouched", () => {
		session.setTodoPhases([
			{
				name: "Work",
				tasks: [
					{ content: "parent", status: "pending" },
					{ content: "child", status: "pending", parentId: "todo-legacy-0-0" },
				],
			},
		]);
		const baseline = session.getTodoPhases();
		const revision = session.getTodoRevision();
		const edited = baseline.map(phase => ({
			...phase,
			tasks: phase.tasks.map(task => (task.content === "child" ? { ...task, status: "completed" as const } : task)),
		}));
		const committed = session.commitUserTodoEdit(edited, revision, "desktop complete child");

		expect(committed.revision).toBe(revision + 1);
		expect(committed.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "completed"]);
		const branch = sessionManager.getBranch();
		expect(branch).toContainEqual(
			expect.objectContaining({
				type: "custom",
				customType: USER_TODO_EDIT_CUSTOM_TYPE,
				data: { phases: committed.phases },
			}),
		);
		const reminder = branch.findLast(entry => entry.type === "message");
		expect(JSON.stringify(reminder)).toContain("desktop complete child");
		expect(JSON.stringify(reminder)).toContain("authoritative");
		expect(JSON.stringify(reminder)).toContain("  - [x] child");

		const beforeConflict = session.getTodoPhases();
		expect(() => session.commitUserTodoEdit(baseline, revision, "stale overwrite")).toThrow(TodoConflictError);
		expect(session.getTodoPhases()).toEqual(beforeConflict);
		expect(session.getTodoRevision()).toBe(committed.revision);
	});
});

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentSwatch } from "../src/shared/agent-swatch";
import type {
	GradivusEvent,
	PlanReviewView,
	ProcessState,
	PromptCompositionPart,
	SessionRecordV1,
} from "../src/shared/contracts";

function composition(...parts: PromptCompositionPart[]) {
	return { parts };
}

const processHarness = vi.hoisted(() => ({
	instances: [] as Array<{
		sessionFile?: string;
		startCalls: number;
		stopCalls: number;
		state: ProcessState;
		emitEvent: (event: unknown) => void;
		emitExtension: (request: unknown) => void;
	}>,
	promptResolvers: new Map<string, () => void>(),
	promptCalls: [] as Array<{ text: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }>,
	requestCalls: [] as Array<Record<string, unknown>>,
	messages: [] as unknown[],
	branchedMessages: [] as unknown[],
	subagentViews: [] as unknown[],
	subagentMessages: { fromByte: 0, nextByte: 0, reset: false, entries: [], messages: [] } as Record<string, unknown>,
	agentHubAgents: [] as unknown[],
	branchMessages: [] as Array<{ entryId: string; text: string }>,
	branchData: { text: "", images: [] as unknown[], cancelled: false },
	statePatch: {} as Record<string, unknown>,
	branchedStatePatch: {} as Record<string, unknown>,
	todoState: { phases: [], revision: 0 } as { phases: unknown[]; revision: number },
	branched: false,
	failNextCommand: false,
	failNextPrompt: false,
	planReviewUpdateGate: undefined as Promise<void> | undefined,
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
	dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
	shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../src/main/rpc-process", () => ({
	RpcProcess: class {
		readonly options: {
			onState: (state: ProcessState, error?: string) => void;
			onEvent: (event: unknown, client: unknown, incarnation: string) => void;
			onExtension: (request: unknown) => void;
		};
		sessionFile?: string;
		startCalls = 0;
		stopCalls = 0;
		state: ProcessState = "stopped";
		incarnation = `incarnation-${processHarness.instances.length + 1}`;
		client:
			| {
					request: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
					prompt: (text: string, images?: unknown[], streamingBehavior?: "steer" | "followUp") => Promise<string>;
					onEvent: (listener: (event: unknown) => void) => () => void;
					sendExtensionResponse: () => void;
			  }
			| undefined;

		constructor(options: {
			onState: (state: ProcessState, error?: string) => void;
			onEvent: (event: unknown, client: unknown, incarnation: string) => void;
			onExtension: (request: unknown) => void;
		}) {
			this.options = options;
			processHarness.instances.push(this);
		}

		emitExtension(request: unknown): void {
			this.options.onExtension(request);
		}

		emitEvent(event: unknown): void {
			this.options.onEvent(event, this.client, this.incarnation);
		}

		async start(sessionFile?: string) {
			this.startCalls++;
			this.sessionFile = sessionFile;
			this.state = "starting";
			this.options.onState("starting");
			const eventListeners = new Set<(event: unknown) => void>();
			this.client = {
				request: async request => {
					processHarness.requestCalls.push({ ...request });
					if (processHarness.failNextCommand) {
						processHarness.failNextCommand = false;
						return { success: false, command: request.type, error: "command failed" };
					}
					switch (request.type) {
						case "get_state":
							return {
								success: true,
								command: "get_state",
								data: {
									sessionId: `omp-${this.sessionFile ?? "new"}`,
									sessionFile: this.sessionFile ?? "new-session.jsonl",
									fastModeEnabled: false,
									steeringMode: "all",
									followUpMode: "all",
									interruptMode: "immediate",
									autoCompactionEnabled: true,
									autoRetryEnabled: true,
									tokensPerSecond: null,
									queuedMessageCount: 0,
									todoState: processHarness.todoState,
									...(processHarness.branched ? processHarness.branchedStatePatch : processHarness.statePatch),
								},
							};
						case "get_messages_page":
							return {
								success: true,
								command: "get_messages_page",
								data: {
									messages: processHarness.branched
										? processHarness.branchedMessages
										: processHarness.messages,
								},
							};
						case "get_branch_messages":
							return {
								success: true,
								command: "get_branch_messages",
								data: { messages: processHarness.branchMessages },
							};
						case "branch":
							processHarness.branched = processHarness.branchData.cancelled !== true;
							return { success: true, command: "branch", data: processHarness.branchData };
						case "request_plan_review":
							return {
								success: true,
								command: "request_plan_review",
								data: { planReview: processHarness.statePatch.planReview },
							};
						case "update_plan_review": {
							await processHarness.planReviewUpdateGate;
							const current = processHarness.statePatch.planReview;
							const planReview =
								typeof current === "object" && current !== null
									? {
											...current,
											content: request.content,
											annotationState: request.annotationState,
											revision: "revision-updated",
										}
									: current;
							processHarness.statePatch = { ...processHarness.statePatch, planReview };
							return {
								success: true,
								command: "update_plan_review",
								data: { planReview },
							};
						}
						case "resolve_plan_review":
							return {
								success: true,
								command: "resolve_plan_review",
								data: { accepted: true, ...(request.decision && { awaitingRefinement: false }) },
							};
						case "get_settings":
							return {
								success: true,
								command: "get_settings",
								data: {
									settings: [
										{
											path: "read.defaultLimit",
											tab: "files",
											label: "Read limit",
											description: "Maximum lines",
											control: "select",
											value: 64,
											options: [{ value: 64, label: "64" }],
											apply: "next-session",
										},
										{
											path: "bash.enabled",
											tab: "shell",
											label: "Bash",
											description: "Enable Bash",
											control: "toggle",
											value: true,
											apply: "next-session",
										},
										{
											path: "auth.apiKey",
											tab: "providers",
											label: "API key",
											description: "Secret",
											control: "toggle",
											value: false,
											apply: "immediate",
										},
										{
											path: "memory.backend",
											tab: "memory",
											label: "Memory",
											description: "Backend",
											control: "toggle",
											value: false,
											apply: "immediate",
										},
										{
											path: "files.empty",
											tab: "files",
											label: "Empty",
											description: "Invalid select",
											control: "select",
											value: "none",
											options: [],
											apply: "next-session",
										},
									],
								},
							};
						case "get_subagents":
							return {
								success: true,
								command: "get_subagents",
								data: { subagents: processHarness.subagentViews },
							};
						case "get_subagent_messages":
							return {
								success: true,
								command: "get_subagent_messages",
								data: processHarness.subagentMessages,
							};
						case "get_agent_hub":
							return {
								success: true,
								command: "get_agent_hub",
								data: { agents: processHarness.agentHubAgents },
							};
						case "set_todos":
							if (request.expectedRevision !== processHarness.todoState.revision) {
								return {
									success: false,
									command: "set_todos",
									error: "todo conflict",
									code: "todo_conflict",
								};
							}
							processHarness.todoState = {
								phases: request.phases as unknown[],
								revision: processHarness.todoState.revision + 1,
							};
							this.options.onEvent({
								type: "todo_update",
								phases: processHarness.todoState.phases,
								revision: processHarness.todoState.revision,
							});
							return { success: true, command: "set_todos", data: { todoState: processHarness.todoState } };
						default:
							return { success: true, command: request.type, data: {} };
					}
				},
				prompt: (text, images, streamingBehavior) => {
					processHarness.promptCalls.push({ text, images, ...(streamingBehavior ? { streamingBehavior } : {}) });
					if (processHarness.failNextPrompt) {
						processHarness.failNextPrompt = false;
						return Promise.reject(new Error("prompt failed"));
					}
					if (text === "hold") {
						const pending = Promise.withResolvers<string>();
						processHarness.promptResolvers.set(this.sessionFile ?? "", () => pending.resolve("gradivus-test"));
						return pending.promise;
					}
					queueMicrotask(() => {
						for (const listener of eventListeners) {
							listener({
								type: "message_end",
								message: {
									role: "assistant",
									content: "Analysis for `button.submit`\n\nExplain element",
								},
							});
							listener({ type: "prompt_result", id: "gradivus-test", agentInvoked: true });
						}
					});
					return Promise.resolve("gradivus-test");
				},
				onEvent: listener => {
					eventListeners.add(listener);
					return () => eventListeners.delete(listener);
				},
				sendExtensionResponse: () => {},
			};
			this.state = "ready";
			this.options.onState("ready");
			return this.client;
		}

		async sample() {
			return { pid: 100 + processHarness.instances.indexOf(this), residentMemoryBytes: 1024 };
		}

		async stop() {
			this.stopCalls++;
			this.state = "stopping";
			this.options.onState("stopping");
			this.client = undefined;
			this.state = "stopped";
			this.options.onState("stopped");
		}
	},
}));

import { DesktopHost } from "../src/main/desktop-host";

const tempDirectories: string[] = [];
const hosts: DesktopHost[] = [];

afterEach(async () => {
	for (const resolve of processHarness.promptResolvers.values()) resolve();
	processHarness.promptResolvers.clear();
	await Promise.all(hosts.splice(0).map(host => host.close()));
	await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
	processHarness.instances.length = 0;
	processHarness.promptCalls.length = 0;
	processHarness.requestCalls.length = 0;
	processHarness.failNextCommand = false;
	processHarness.failNextPrompt = false;
	processHarness.messages = [];
	processHarness.branchedMessages = [];
	processHarness.subagentViews = [];
	processHarness.subagentMessages = { fromByte: 0, nextByte: 0, reset: false, entries: [], messages: [] };
	processHarness.agentHubAgents = [];
	processHarness.branchMessages = [];
	processHarness.branchData = { text: "", images: [], cancelled: false };
	processHarness.statePatch = {};
	processHarness.branchedStatePatch = {};
	processHarness.branched = false;
	processHarness.planReviewUpdateGate = undefined;
	processHarness.todoState = { phases: [], revision: 0 };
	vi.clearAllMocks();
});

function sessionRecord(id: string): SessionRecordV1 {
	return {
		id,
		kind: "code",
		cwd: `/workspace/${id}`,
		ompSessionId: `omp-${id}`,
		sessionFile: `${id}.jsonl`,
		title: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastOpenedAt: "2026-01-01T00:00:00.000Z",
	};
}
function planReviewFixture(overrides: Partial<PlanReviewView> = {}): PlanReviewView {
	return {
		id: "plan-019c0000-0000-7000-8000-000000000001",
		title: "FEATURE",
		planFilePath: "local://feature-plan.md",
		revision: "revision-ready",
		status: "ready",
		phase: "ready",
		content: "# Feature\\n\\nShip safely.\\n",
		annotationState: { annotations: [], deletedSections: [], additionalFeedback: "" },
		suggestedSaveName: "FEATURE_PLAN.md",
		contextUsage: { tokens: 2_000, contextWindow: 32_000, percent: 6.25 },
		keepContextDisabled: false,
		executionModels: [
			{ role: "default", provider: "mock", modelId: "default", label: "Default" },
			{ role: "slow", provider: "mock", modelId: "slow", label: "Slow" },
		],
		defaultExecutionRole: "default",
		...overrides,
	};
}

async function createHost(ids: string[]): Promise<DesktopHost> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-desktop-host-"));
	tempDirectories.push(directory);
	await writeFile(
		path.join(directory, "sessions-v1.json"),
		`${JSON.stringify({
			version: 1,
			sessions: ids.map(sessionRecord),
			activeByKind: { work: null, code: null },
		})}\n`,
		"utf8",
	);
	const host = new DesktopHost(directory);
	hosts.push(host);
	await host.load();
	return host;
}

it("transports files and shell agent settings while filtering unsupported categories", async () => {
	const host = await createHost(["one"]);
	const settings = await host.getAgentSettings("one");

	expect(settings.map(setting => setting.path)).toEqual(["read.defaultLimit", "bash.enabled"]);
	expect(settings[0]).toMatchObject({
		tab: "files",
		value: 64,
		options: [{ value: 64, label: "64" }],
	});
	expect(settings[1]).toMatchObject({
		tab: "shell",
		value: true,
	});
});

it("uses one-at-a-time queue defaults when an older state omits delivery modes", async () => {
	processHarness.statePatch = { steeringMode: undefined, followUpMode: undefined };
	const host = await createHost(["one"]);

	await expect(host.openSession("one")).resolves.toMatchObject({
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		interruptMode: "immediate",
	});
});
it("hydrates trusted plan review state and retains it across malformed pushes", async () => {
	const review = planReviewFixture();
	processHarness.statePatch = { capabilities: { planReview: 1 }, planReview: review };
	const host = await createHost(["one"]);
	const snapshot = await host.openSession("one");
	expect(snapshot).toMatchObject({ planReviewSupported: true, planReview: review });

	processHarness.instances[0]!.emitEvent({
		type: "plan_review_update",
		planReview: { ...review, status: "unknown" },
	});
	await expect(host.openSession("one")).resolves.toMatchObject({
		planReview: {
			id: review.id,
			content: review.content,
			error: expect.stringContaining("invalid"),
		},
	});
});

it("serializes plan updates before decisions on one runtime incarnation", async () => {
	const review = planReviewFixture();
	processHarness.statePatch = { capabilities: { planReview: 1 }, planReview: review };
	const host = await createHost(["one"]);
	await host.openSession("one");
	const gate = Promise.withResolvers<void>();
	processHarness.planReviewUpdateGate = gate.promise;

	const update = host.updatePlanReview("one", review.id, "# Feature\\n\\nShip with rollback.\\n", review.revision, {
		annotations: [],
		deletedSections: [],
		additionalFeedback: "Keep rollback explicit.",
	});
	await vi.waitFor(() =>
		expect(processHarness.requestCalls.some(call => call.type === "update_plan_review")).toBe(true),
	);
	const resolution = host.resolvePlanReview("one", review.id, "revision-updated", {
		kind: "approve",
		context: "keep",
	});
	await Promise.resolve();
	expect(processHarness.requestCalls.some(call => call.type === "resolve_plan_review")).toBe(false);

	gate.resolve();
	await expect(update).resolves.toMatchObject({ revision: "revision-updated" });
	await expect(resolution).resolves.toEqual({ accepted: true });
	expect(
		processHarness.requestCalls
			.filter(call => call.type === "update_plan_review" || call.type === "resolve_plan_review")
			.map(call => call.type),
	).toEqual(["update_plan_review", "resolve_plan_review"]);
});

it("replaces the renderer session atomically after a fresh approval reset", async () => {
	const review = planReviewFixture({ status: "applying", phase: "accepted" });
	processHarness.statePatch = { capabilities: { planReview: 1 }, planReview: review };
	const host = await createHost(["one"]);
	const send = vi.fn();
	host.setWindow({ webContents: { send } } as never);
	await host.openSession("one");
	send.mockClear();
	processHarness.statePatch = {
		capabilities: { planReview: 1 },
		sessionId: "omp-reset",
		sessionFile: "reset.jsonl",
		planReview: undefined,
	};

	processHarness.instances[0]!.emitEvent({
		type: "plan_review_update",
		planReview: review,
		sessionReset: { sessionId: "omp-reset", sessionFile: "reset.jsonl" },
	});
	await vi.waitFor(() =>
		expect(send.mock.calls.some(([, event]) => (event as GradivusEvent).type === "session_reset")).toBe(true),
	);
	const resetEvent = send.mock.calls.find(([, event]) => (event as GradivusEvent).type === "session_reset")?.[1] as
		| GradivusEvent
		| undefined;
	expect(resetEvent?.snapshot).toMatchObject({
		record: { ompSessionId: "omp-reset", sessionFile: "reset.jsonl" },
		planReviewSupported: true,
	});
	expect(resetEvent?.snapshot?.planReview).toBeUndefined();
	expect(send.mock.calls.map(([, event]) => (event as GradivusEvent).type)).toEqual(["session_reset"]);
});

it("refreshes the authoritative queued-message count after queue acknowledgements", async () => {
	const host = await createHost(["one"]);
	await host.openSession("one");
	processHarness.statePatch = { queuedMessageCount: 2 };

	await host.queueFollowUp("one", composition({ type: "text", text: "later" }));
	await expect(host.openSession("one")).resolves.toMatchObject({ queuedMessageCount: 2 });
	expect(processHarness.requestCalls.slice(-2).map(call => call.type)).toEqual(["follow_up", "get_state"]);

	processHarness.statePatch = { queuedMessageCount: 1 };
	await host.steerQueued("one", composition({ type: "text", text: "later" }));
	await expect(host.openSession("one")).resolves.toMatchObject({ queuedMessageCount: 1 });
	expect(processHarness.requestCalls.slice(-2).map(call => call.type)).toEqual(["steer_queued", "get_state"]);
});

describe("DesktopHost runtime supervision", () => {
	it("registers restored sessions without starting their processes", async () => {
		await createHost(["one", "two"]);

		expect(processHarness.instances).toHaveLength(2);

		expect(processHarness.instances.map(instance => instance.startCalls)).toEqual([0, 0]);
		expect(processHarness.instances.map(instance => instance.state)).toEqual(["stopped", "stopped"]);
	});
	it("accepts revision-checked hierarchical todo edits and rejects stale writes", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);
		await host.openSession("one");
		const phases = [
			{
				id: "phase-work",
				name: "Work",
				tasks: [
					{ id: "todo-parent", content: "parent", status: "pending" as const },
					{ id: "todo-child", content: "child", status: "in_progress" as const, parentId: "todo-parent" },
				],
			},
		];

		const updated = await host.setTodos("one", phases, 0, "desktop indent child");
		expect(updated).toEqual({ phases, revision: 1 });
		await vi.waitFor(() => expect(JSON.stringify(send.mock.calls)).toContain("todo_update"));
		await expect(host.openSession("one")).resolves.toMatchObject({ todoState: updated });

		await expect(host.setTodos("one", [], 0, "stale clear")).rejects.toThrow("todo conflict");
		await expect(host.openSession("one")).resolves.toMatchObject({ todoState: updated });
	});

	it("emits state-only runtime reports and includes the report in snapshots", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);

		const snapshot = await host.openSession("one");
		const events = send.mock.calls
			.filter(([channel]) => channel === "gradivus:event")
			.map(([, event]) => event as GradivusEvent);
		expect(processHarness.instances[0]?.sessionFile).toBe("one.jsonl");
		const stateOnly = events.find(event => event.type === "session" && event.runtime?.phase === "resident");

		expect(snapshot.runtime).toMatchObject({ id: "one", phase: "resident", processState: "ready" });
		expect(stateOnly).toMatchObject({
			sessionId: "one",
			type: "session",
			state: "ready",
			runtime: { id: "one", phase: "resident", processState: "ready" },
		});
		expect(stateOnly).not.toHaveProperty("record");
	});

	it("replays a backgrounded session's outstanding extension through snapshots until answered", async () => {
		const host = await createHost(["one", "two"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);

		processHarness.instances[0]?.emitExtension({
			type: "extension_ui_request",
			id: "ext-select-1",
			method: "select",
			title: "Pick a lane",
			message: "Choose one",
			options: ["alpha", "beta"],
		});

		const events = send.mock.calls
			.filter(([channel]) => channel === "gradivus:event")
			.map(([, event]) => event as GradivusEvent);
		expect(events.at(-1)).toMatchObject({
			sessionId: "one",
			type: "extension",
			extension: { id: "ext-select-1", method: "select" },
		});

		const replayed = await host.openSession("one");
		expect(replayed.pendingExtension).toMatchObject({
			id: "ext-select-1",
			method: "select",
			title: "Pick a lane",
			options: ["alpha", "beta"],
		});
		const other = await host.openSession("two");
		expect(other.pendingExtension).toBeUndefined();

		await expect(
			host.extensionResponse("one", { id: "ext-select-1", method: "confirm", value: "alpha" }),
		).rejects.toThrow("extension response method mismatch");
		await host.extensionResponse("one", { id: "ext-select-1", value: "alpha" });
		const cleared = await host.openSession("one");
		expect(cleared.pendingExtension).toBeUndefined();
	});

	it("projects an early prompt_result push with request correlation", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);
		await host.openSession("one");

		await expect(host.prompt("one", composition({ type: "text", text: "recover provider" }))).resolves.toBe(
			"gradivus-test",
		);
		processHarness.instances[0]?.emitEvent({
			type: "prompt_result",
			id: "gradivus-test",
			agentInvoked: false,
			error: { message: "account locked", code: "ACCOUNT_UNAVAILABLE" },
		});

		const events = send.mock.calls
			.filter(([channel]) => channel === "gradivus:event")
			.map(([, event]) => event as GradivusEvent);
		expect(events.at(-1)).toEqual({
			sessionId: "one",
			type: "prompt_result",
			requestId: "gradivus-test",
			agentInvoked: false,
			error: { message: "account locked", code: "ACCOUNT_UNAVAILABLE" },
		});
	});
	it("coalesces streaming timeline updates by item while preserving distinct order before an urgent result", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);
		await host.openSession("one");
		send.mockClear();

		vi.useFakeTimers();
		try {
			const process = processHarness.instances[0];
			process?.emitEvent({ type: "message_delta", delta: "hello" });
			process?.emitEvent({ type: "message_delta", delta: " world" });
			process?.emitEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
			expect(send).not.toHaveBeenCalled();

			vi.advanceTimersByTime(15);
			expect(send).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(send).toHaveBeenCalledTimes(2);
			const firstBatch = send.mock.calls.map(([, event]) => event as GradivusEvent);
			expect(firstBatch.map(event => event.type)).toEqual(["timeline", "timeline"]);
			expect(firstBatch[0]).toMatchObject({
				type: "timeline",
				item: { kind: "assistant", text: "hello world", status: "running" },
			});
			expect(firstBatch[1]).toMatchObject({
				type: "timeline",
				item: { kind: "tool", toolCallId: "tool-1", status: "running" },
			});
			expect(firstBatch[0]?.item?.id).not.toBe(firstBatch[1]?.item?.id);

			process?.emitEvent({ type: "message_delta", delta: "!" });
			process?.emitEvent({ type: "prompt_result", id: "final" });
			expect(send.mock.calls.slice(2).map(([, event]) => (event as GradivusEvent).type)).toEqual([
				"timeline",
				"prompt_result",
			]);
			expect(send.mock.calls[2]?.[1]).toMatchObject({
				type: "timeline",
				item: { id: firstBatch[0]?.item?.id, text: "hello world!" },
			});
		} finally {
			vi.useRealTimers();
		}
	});
	it("resolves one staged batch for prompt, steering, and queued follow-up", async () => {
		const host = await createHost(["one"]);
		const [file, image] = await host.stagePromptAttachments("one", [
			{ name: "notes.md", data: new TextEncoder().encode("host notes") },
			{
				name: "screen.dat",
				data: Uint8Array.from(
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
						"base64",
					),
				),
			},
		]);
		await host.openSession("one");
		const orderedComposition = composition(
			{ type: "text", text: "summarize " },
			{ type: "attachment", id: image!.id },
			{ type: "text", text: " then " },
			{ type: "attachment", id: file!.id },
		);
		await host.prompt("one", orderedComposition);
		expect(processHarness.promptCalls.at(-1)).toMatchObject({
			text: expect.stringContaining('File "notes.md": @"'),
			images: [{ type: "image", mimeType: "image/png" }],
			streamingBehavior: "steer",
		});
		const sentText = processHarness.promptCalls.at(-1)?.text ?? "";
		expect(sentText.indexOf(image!.reference)).toBeLessThan(sentText.indexOf(" then "));
		expect(sentText.indexOf(" then ")).toBeLessThan(sentText.indexOf(file!.reference));
		await host.steer("one", orderedComposition);
		await host.queueFollowUp("one", orderedComposition);
		expect(processHarness.requestCalls.filter(request => request.type === "steer")).toHaveLength(1);
		expect(processHarness.requestCalls.filter(request => request.type === "follow_up")).toHaveLength(1);
		expect(processHarness.requestCalls.findLast(request => request.type === "follow_up")).toMatchObject({
			type: "follow_up",
			message: expect.stringContaining('File "notes.md": @"'),
			images: [{ type: "image", mimeType: "image/png" }],
		});
		await host.steerQueued("one", orderedComposition);
		expect(processHarness.requestCalls.filter(request => request.type === "steer_queued")).toHaveLength(1);
	});

	it("rejects duplicate and cross-session attachment IDs without consuming the staged attachment", async () => {
		const host = await createHost(["one", "two"]);
		const [own] = await host.stagePromptAttachments("one", [
			{ name: "own.txt", data: new TextEncoder().encode("own") },
		]);
		const [foreign] = await host.stagePromptAttachments("two", [
			{ name: "foreign.txt", data: new TextEncoder().encode("foreign") },
		]);
		await host.openSession("one");

		await expect(host.prompt("one", composition({ type: "attachment", id: foreign!.id }))).rejects.toThrow(
			"unknown prompt attachment",
		);
		await expect(
			host.prompt("one", composition({ type: "attachment", id: own!.id }, { type: "attachment", id: own!.id })),
		).rejects.toThrow("duplicate prompt attachment ID");
		await expect(host.prompt("one", composition({ type: "attachment", id: own!.id }))).resolves.toBe("gradivus-test");
	});
	it("keeps staged IDs available after dispatch failure and removes them on host close", async () => {
		const host = await createHost(["one"]);
		const [file] = await host.stagePromptAttachments("one", [{ name: "retry.txt", data: new Uint8Array([1, 2, 3]) }]);
		await host.openSession("one");
		processHarness.failNextPrompt = true;
		const retryComposition = composition({ type: "text", text: "retry " }, { type: "attachment", id: file!.id });
		await expect(host.prompt("one", retryComposition)).rejects.toThrow("prompt failed");
		await host.prompt("one", retryComposition);
		const stagedPath = processHarness.promptCalls.at(-1)?.text.match(/@"([^"]+)"/)?.[1];
		expect(stagedPath).toBeDefined();
		await host.close();
		await expect(stat(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("holds admission for each complete client command", async () => {
		const host = await createHost(["one", "two", "three", "four"]);
		const hold = composition({ type: "text", text: "hold" });
		const held = [host.prompt("one", hold), host.prompt("two", hold), host.prompt("three", hold)];
		await vi.waitFor(() => expect(processHarness.promptResolvers.size).toBe(3));

		const fourth = host.prompt("four", composition({ type: "text", text: "quick" }));
		await Promise.resolve();
		expect(processHarness.instances[3]?.startCalls).toBe(0);
		expect(processHarness.instances.slice(0, 3).map(instance => instance.stopCalls)).toEqual([0, 0, 0]);

		processHarness.promptResolvers.get("one.jsonl")?.();
		await held[0];
		await fourth;
		expect(processHarness.instances[3]?.startCalls).toBe(1);
		expect(processHarness.instances[0]?.stopCalls).toBe(1);

		processHarness.promptResolvers.get("two.jsonl")?.();
		processHarness.promptResolvers.get("three.jsonl")?.();
		await Promise.all(held.slice(1));
	});

	it("delivers a selected element prompt with its JPEG screenshot as PromptImageContent", async () => {
		const host = await createHost(["one"]);
		await host.openSession("one");
		const jpegBase64 = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
			0x00, 0xff, 0xd9,
		]).toString("base64");
		await host.deliverElementPrompt("Inspect this button", "one", {
			selector: "#btn",
			captureMode: "screenshot",
			screenshot: { base64: jpegBase64, mimeType: "image/jpeg" },
		});
		expect(processHarness.instances[0]?.startCalls).toBe(1);
		expect(processHarness.promptCalls.at(-1)).toEqual({
			text: "Inspect this button",
			images: [{ type: "image", data: jpegBase64, mimeType: "image/jpeg" }],
		});
	});

	it("executes inline element prompt and forwards its JPEG screenshot", async () => {
		const host = await createHost(["one"]);
		await host.openSession("one");
		const jpegBase64 = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9,
		]).toString("base64");
		const response = await host.executeInlinePrompt("What does this button do?", "one", {
			selector: "button.submit",
			instruction: "Explain element",
			captureMode: "screenshot",
			screenshot: { base64: jpegBase64, mimeType: "image/jpeg" },
		});
		expect(response).toContain("Analysis for `button.submit`");
		expect(response).toContain("Explain element");
		expect(processHarness.promptCalls.at(-1)).toEqual({
			text: expect.stringContaining("What does this button do?"),
			images: [{ type: "image", data: jpegBase64, mimeType: "image/jpeg" }],
		});
	});
	it("rejects message edits while streaming or queued before requesting a branch", async () => {
		processHarness.messages = [{ id: "user-1", role: "user", content: "original" }];
		processHarness.branchMessages = [{ entryId: "entry-1", text: "original" }];
		const host = await createHost(["one"]);
		const snapshot = await host.openSession("one");
		const itemId = snapshot.timeline.find(item => item.role === "user")!.id;

		processHarness.statePatch = { isStreaming: true };
		await expect(host.editMessage("one", itemId, "edited")).rejects.toThrow("session is idle");
		processHarness.statePatch = { queuedMessageCount: 1 };
		await expect(host.editMessage("one", itemId, "edited")).rejects.toThrow("session is idle");
		expect(processHarness.requestCalls.filter(call => call.type === "branch")).toHaveLength(0);
	});

	it("does not prompt when branching an edited message is cancelled", async () => {
		processHarness.messages = [{ id: "user-1", role: "user", content: "original" }];
		processHarness.branchMessages = [{ entryId: "entry-1", text: "original" }];
		processHarness.branchData = { text: "original", images: [], cancelled: true };
		const host = await createHost(["one"]);
		const snapshot = await host.openSession("one");
		const itemId = snapshot.timeline.find(item => item.role === "user")!.id;

		await expect(host.editMessage("one", itemId, "edited")).resolves.toMatchObject({ cancelled: true });
		expect(processHarness.promptCalls).toHaveLength(0);
	});

	it("branches the correct duplicate, persists runtime metadata, preserves images, and returns a truncated base", async () => {
		processHarness.messages = [
			{ id: "user-1", role: "user", content: "repeat" },
			{ id: "assistant-1", role: "assistant", content: [{ type: "text", text: "first" }] },
			{ id: "user-2", role: "user", content: "repeat" },
		];
		processHarness.branchMessages = [
			{ entryId: "entry-1", text: "repeat" },
			{ entryId: "entry-2", text: "repeat" },
		];
		const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		processHarness.branchData = { text: "repeat", images: [image], cancelled: false };
		processHarness.branchedStatePatch = {
			sessionId: "omp-branched",
			sessionFile: "branched.jsonl",
			queuedMessageCount: 0,
		};
		processHarness.branchedMessages = Array.from({ length: 205 }, (_, index) => ({
			id: `branch-${index}`,
			role: "user",
			content: `message ${index}`,
		}));
		const host = await createHost(["one"]);
		const opened = await host.openSession("one");
		const itemId = opened.timeline.filter(item => item.role === "user").at(-1)!.id;

		const result = await host.editMessage("one", itemId, "edited duplicate");

		expect(processHarness.requestCalls).toContainEqual({ type: "branch", entryId: "entry-2" });
		expect(processHarness.promptCalls.at(-1)).toEqual({ text: "edited duplicate", images: [image] });
		expect(result).toMatchObject({
			cancelled: false,
			requestId: "gradivus-test",
			snapshot: {
				record: { ompSessionId: "omp-branched", sessionFile: "branched.jsonl" },
				timelineStart: 5,
				timelineTotal: 205,
			},
		});
		expect(result.snapshot.timeline).toHaveLength(200);
	});

	it("returns the committed branch snapshot when starting the edited prompt fails", async () => {
		processHarness.messages = [{ id: "user-1", role: "user", content: "original" }];
		processHarness.branchMessages = [{ entryId: "entry-1", text: "original" }];
		processHarness.branchData = { text: "original", images: [], cancelled: false };
		processHarness.branchedStatePatch = { sessionId: "omp-branched", sessionFile: "branched.jsonl" };
		processHarness.branchedMessages = [{ id: "user-1", role: "user", content: "original" }];
		const host = await createHost(["one"]);
		const opened = await host.openSession("one");
		processHarness.failNextPrompt = true;

		const result = await host.editMessage("one", opened.timeline[0]!.id, "edited");

		expect(result).toMatchObject({
			cancelled: false,
			error: "prompt failed",
			snapshot: { record: { ompSessionId: "omp-branched", sessionFile: "branched.jsonl" } },
		});
		expect(result.requestId).toBeUndefined();
		expect(processHarness.promptCalls).toHaveLength(1);
	});

	it("dehydrates eval activity on snapshots and live pushes, then loads bounded detail on demand", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);
		await host.openSession("one");
		const runtime = processHarness.instances[0]!;
		runtime.emitEvent({
			type: "tool_execution_start",
			toolCallId: "eval-detail",
			toolName: "eval",
			args: { language: "py", title: "bounded eval", code: "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh" },
		});
		runtime.emitEvent({
			type: "tool_execution_end",
			toolCallId: "eval-detail",
			result: {
				details: {
					languages: ["python"],
					cells: [
						{
							index: 0,
							title: "bounded eval",
							language: "python",
							code: "first\nsecond\nthird\nfourth\nfifth\nsixth\nFULL_CELL_TAIL_SENTINEL",
							output: "one\ntwo\nthree\nfour\nfive\nsix\nFULL_OUTPUT_TAIL_SENTINEL",
							status: "complete",
							durationMs: 42,
						},
					],
					jsonOutputs: [{ value: "RAW_JSON_SENTINEL" }],
					images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				},
			},
			isError: false,
		});

		await vi.waitFor(() => expect(JSON.stringify(send.mock.calls)).toContain("eval-detail"));
		const snapshot = await host.openSession("one");
		const item = snapshot.timeline.find(candidate => candidate.toolCallId === "eval-detail");
		expect(item).toMatchObject({
			toolName: "eval",
			toolActivity: {
				operation: "eval",
				title: "bounded eval",
				cellCount: 1,
				durationMs: 42,
				detailsLoaded: false,
				omittedImageCount: 1,
			},
		});
		expect(item).not.toHaveProperty("args");
		expect(item).not.toHaveProperty("result");
		expect(item).not.toHaveProperty("detail");
		expect(item).not.toHaveProperty("images");
		expect(JSON.stringify(item)).not.toContain("RAW_JSON_SENTINEL");
		expect(JSON.stringify(item)).not.toContain("FULL_CELL_TAIL_SENTINEL");
		expect(JSON.stringify(send.mock.calls)).not.toContain("RAW_JSON_SENTINEL");
		expect(JSON.stringify(send.mock.calls)).not.toContain("FULL_CELL_TAIL_SENTINEL");

		const detail = await host.loadTimelineToolDetail("one", item!.id);
		expect(detail).toMatchObject({ operation: "eval", detailsLoaded: true });
		expect(JSON.stringify(detail)).toContain("RAW_JSON_SENTINEL");
		expect(JSON.stringify(detail)).toContain("FULL_CELL_TAIL_SENTINEL");
	});

	it("preserves nested subagents across snapshots, events, and transcript retrieval", async () => {
		const now = Date.now();
		processHarness.subagentViews = [
			{ id: "parent", agent: "planner", status: "running", task: "Plan work" },
			{ id: "child", agent: "builder", status: "running", task: "Build feature", parentToolCallId: "parent" },
			{
				id: "grandchild",
				agent: "reviewer",
				status: "running",
				task: "Review feature",
				parentToolCallId: "child",
			},
			{ id: "parked", agent: "idle", status: "parked", task: "Paused work" },
		];
		processHarness.agentHubAgents = [
			{
				id: "parent",
				displayName: "Planner",
				kind: "sub",
				status: "running",
				createdAt: now,
				lastActivity: now,
				transcriptAvailable: true,
				readOnly: false,
			},
			{
				id: "child",
				displayName: "Builder",
				kind: "sub",
				parentId: "parent",
				status: "running",
				createdAt: now,
				lastActivity: now,
				transcriptAvailable: true,
				readOnly: false,
			},
			{
				id: "grandchild",
				displayName: "Reviewer",
				kind: "sub",
				parentId: "child",
				status: "running",
				createdAt: now,
				lastActivity: now,
				transcriptAvailable: true,
				readOnly: true,
			},
			{
				id: "parked",
				displayName: "Paused",
				kind: "sub",
				status: "parked",
				createdAt: now,
				lastActivity: now,
				transcriptAvailable: true,
				readOnly: false,
			},
		];
		processHarness.subagentMessages = {
			fromByte: 0,
			nextByte: 18,
			reset: false,
			entries: [],
			messages: [{ role: "assistant", content: "nested result" }],
		};
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);

		const snapshot = await host.openSession("one");
		expect(snapshot.subagents.map(agent => [agent.id, agent.parentToolCallId, agent.status])).toEqual([
			["parent", undefined, "running"],
			["child", "parent", "running"],
			["grandchild", "child", "running"],
			["parked", undefined, "parked"],
		]);
		expect(snapshot.agentHub?.agents.map(agent => [agent.id, agent.parentId, agent.status])).toEqual([
			["parent", undefined, "running"],
			["child", "parent", "running"],
			["grandchild", "child", "running"],
			["parked", undefined, "parked"],
		]);
		expect(snapshot.agentHub?.agents.filter(agent => agent.status === "running")).toHaveLength(3);

		await expect(host.getSubagentMessages("one", "grandchild", 4)).resolves.toEqual(processHarness.subagentMessages);

		send.mockClear();
		processHarness.instances[0]!.emitEvent({
			type: "subagent_progress",
			payload: { id: "grandchild", status: "running", progress: { currentTool: "read" } },
		});
		await vi.waitFor(() =>
			expect(send.mock.calls.some(([, event]) => (event as GradivusEvent).type === "subagents")).toBe(true),
		);
		const event = send.mock.calls.find(([, value]) => (value as GradivusEvent).type === "subagents")?.[1] as Extract<
			GradivusEvent,
			{ type: "subagents" }
		>;
		expect(event.subagents?.find(agent => agent.id === "grandchild")).toMatchObject({
			parentToolCallId: "child",
			progress: { currentTool: "read" },
		});
	});

	it("resolves only active same-workspace agent sessions for selection", async () => {
		const host = await createHost(["session-a", "session-b"]);
		const now = Date.now();
		const document = {
			version: 1,
			revision: 1,
			activeWorkspaceId: "workspace-a",
			workspaces: [{ id: "workspace-a", name: "Workspace A", locationId: "location-a", generation: 1 }],
			locations: [
				{
					id: "location-a",
					name: "Local",
					address: { kind: "local", path: "/tmp/workspace-a" },
					lifecycle: { status: "active", generation: 1, updatedAt: now },
				},
			],
			tabs: [
				{
					id: "tab-browser",
					workspaceId: "workspace-a",
					locationId: "location-a",
					generation: 1,
					name: "Browser",
					paneKind: "browser",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-browser"],
					activePaneId: "pane-browser",
				},
			],
			panes: [{ id: "pane-browser", tabId: "tab-browser", generation: 1, kind: "browser", entityId: "browser" }],
			terminals: [],
			browsers: [
				{
					id: "browser",
					locationId: "location-a",
					paneId: "pane-browser",
					generation: 1,
					url: "https://omp.sh",
					status: "open",
				},
			],
			previews: [],
			agentProfiles: [{ id: "profile-a", name: "Agent Alpha", config: {}, capabilityIds: [] }],
			agents: [
				{ id: "agent-a", profileId: "profile-a", sessionId: "session-a", status: "running" },
				{ id: "agent-b", profileId: "profile-a", sessionId: "session-b", status: "running" },
			],
			capabilities: [],
			sessions: [
				{
					id: "session-a",
					locationId: "location-a",
					actorId: "agent-a",
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: now,
					lastSeenAt: now,
				},
				{
					id: "session-b",
					locationId: "location-a",
					actorId: "agent-b",
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: now,
					lastSeenAt: now,
				},
			],
			sessionEvents: [],
			deliveryReceipts: [],
			services: [],
			worktrees: [],
			elementEdits: [],
			notifications: [],
			pendingCleanup: [],
			createdAt: now,
			updatedAt: now,
		} as unknown as WorkspaceDocumentV1;
		host.setWorkspaceAuthority({ kind: "user", id: "user-a" }, document);

		const resolved = host.resolveSelectionTarget("pane-browser", "agent-a", 1);
		expect(resolved).toMatchObject({
			scope: { agentId: "agent-a", sessionId: "session-a", workspaceId: "workspace-a" },
			target: { id: "agent-a", name: "Agent Alpha", swatch: getAgentSwatch("agent-a") },
		});

		host.setWorkspaceAuthority(
			{ kind: "user", id: "user-a" },
			{
				...document,
				agents: document.agents.map(agent => (agent.id === "agent-a" ? { ...agent, status: "stopped" } : agent)),
			},
		);
		expect(() => host.resolveSelectionTarget("pane-browser", "agent-a", 1)).toThrow(
			"No deliverable workspace agent is available for selection",
		);
	});
});

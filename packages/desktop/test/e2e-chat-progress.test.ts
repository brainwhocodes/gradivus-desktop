import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BrowserWindow, dialog } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	GradivusEvent,
	ProcessState,
	PromptCompositionPart,
	SessionRecordV1,
	TimelineItem,
} from "../src/shared/contracts";

function composition(...parts: PromptCompositionPart[]) {
	return { parts };
}

interface MockTurnMetrics {
	durationMs: number;
	elapsedSeconds: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	tokensPerSecond: number;
}

interface PromptSimulationOptions {
	promptText: string;
	toolCall?: {
		id: string;
		name: string;
		args: Record<string, unknown>;
		partialResult?: string;
		result: string;
		isError?: boolean;
	};
	assistantDeltas?: string[];
	thinkingText?: string;
	metrics?: MockTurnMetrics;
}

interface SimulateTurnSequenceResult {
	assembledDeltas: string;
	deltasReceived: string[];
	metricsEmitted: MockTurnMetrics;
}

interface MockRpcProcessInstance {
	readonly options: {
		cwd: string;
		onEvent: (event: unknown) => void;
		onExtension: (request: unknown) => void;
		onState: (state: ProcessState, error?: string) => void;
	};
	sessionFile?: string;
	startCalls: number;
	stopCalls: number;
	state: ProcessState;
	client:
		| {
				request: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
				prompt: (text: string) => Promise<void>;
				sendExtensionResponse: () => void;
				onEvent?: (listener: (event: unknown) => void) => () => void;
		  }
		| undefined;
	emitEvent(event: unknown): void;
	start(sessionFile?: string): Promise<unknown>;
	sample(): Promise<{ pid: number; residentMemoryBytes: number }>;
	stop(): Promise<void>;
}

const processHarness = vi.hoisted(() => ({
	instances: [] as MockRpcProcessInstance[],
	promptHandlers: new Map<string, (text: string) => Promise<void>>(),
	messageSequence: 0,
	failureCommands: new Set<string>(),
	throwCommands: new Set<string>(),
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getPath: vi.fn(() => "/tmp/userData") },
	dialog: {
		showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/tmp/default-workspace"] })),
	},
	shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../src/main/rpc-process", () => ({
	RpcProcess: class MockRpcProcess implements MockRpcProcessInstance {
		readonly options: {
			cwd: string;
			onEvent: (event: unknown) => void;
			onExtension: (request: unknown) => void;
			onState: (state: ProcessState, error?: string) => void;
		};
		sessionFile?: string;
		startCalls = 0;
		stopCalls = 0;
		state: ProcessState = "stopped";
		client:
			| {
					request: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
					prompt: (text: string) => Promise<void>;
					sendExtensionResponse: () => void;
					onEvent?: (listener: (event: unknown) => void) => () => void;
			  }
			| undefined;
		#eventListeners = new Set<(event: unknown) => void>();

		constructor(options: {
			cwd: string;
			onEvent: (event: unknown) => void;
			onExtension: (request: unknown) => void;
			onState: (state: ProcessState, error?: string) => void;
		}) {
			this.options = options;
			processHarness.instances.push(this);
		}

		emitEvent(event: unknown): void {
			for (const listener of this.#eventListeners) {
				try {
					listener(event);
				} catch {}
			}
			this.options.onEvent(event);
		}

		async start(sessionFile?: string) {
			this.startCalls++;
			this.sessionFile = sessionFile;
			this.state = "starting";
			this.options.onState("starting");
			this.client = {
				request: async request => {
					if (processHarness.failureCommands.has(request.type)) {
						return { success: false, command: request.type as string, error: "fixture command failure" };
					}
					if (processHarness.throwCommands.has(request.type)) {
						throw new Error("fixture command crash");
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
									tokensPerSecond: 42.5,
									queuedMessageCount: 0,
									todoPhases: [],
									contextUsage: { tokens: 1024, contextWindow: 200000 },
								},
							};
						case "get_messages_page":
							return { success: true, command: "get_messages_page", data: { messages: [] } };
						case "get_subagents":
							return { success: true, command: "get_subagents", data: { subagents: [] } };
						case "set_subagent_subscription":
							return { success: true, command: "set_subagent_subscription", data: {} };
						default:
							return { success: true, command: request.type as string, data: {} };
					}
				},
				prompt: async (text: string) => {
					const customHandler = processHarness.promptHandlers.get(this.sessionFile ?? "");
					if (customHandler) {
						await customHandler(text);
						return;
					}
				},
				sendExtensionResponse: () => {},
				onEvent: (listener: (event: unknown) => void) => {
					this.#eventListeners.add(listener);
					return () => this.#eventListeners.delete(listener);
				},
			};
			this.state = "ready";
			this.options.onState("ready");
			return this.client;
		}

		async sample() {
			return { pid: 200 + processHarness.instances.indexOf(this), residentMemoryBytes: 4096 };
		}

		async stop() {
			this.stopCalls++;
			this.state = "stopping";
			this.options.onState("stopping");
			this.client = undefined;
			this.#eventListeners.clear();
			this.state = "stopped";
			this.options.onState("stopped");
		}
	},
}));

import { DesktopHost } from "../src/main/desktop-host";

const tempDirectories: string[] = [];
const hosts: DesktopHost[] = [];

afterEach(async () => {
	processHarness.promptHandlers.clear();
	processHarness.failureCommands.clear();
	processHarness.throwCommands.clear();
	processHarness.messageSequence = 0;
	await Promise.all(hosts.splice(0).map(host => host.close()));
	await Promise.all(tempDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	processHarness.instances.length = 0;
	vi.clearAllMocks();
});

interface MockWindowHandle {
	window: BrowserWindow;
	events: GradivusEvent[];
	getTimelineItems: () => TimelineItem[];
	getSessionEvents: () => GradivusEvent[];
}

function createMockWindow(): MockWindowHandle {
	const events: GradivusEvent[] = [];
	const mockWindow = {
		isDestroyed: () => false,
		webContents: {
			isDestroyed: () => false,
			send: vi.fn((channel: string, event: GradivusEvent) => {
				if (channel === "gradivus:event") {
					events.push(event);
				}
			}),
		},
	} as unknown as BrowserWindow;

	return {
		window: mockWindow,
		events,
		getTimelineItems: () =>
			events.filter(e => e.type === "timeline" && e.item !== undefined).map(e => e.item as TimelineItem),
		getSessionEvents: () => events.filter(e => e.type === "session"),
	};
}

/** Last showOpenDialog call's options argument, regardless of Electron overload typing. */
function lastOpenDialogOptions(): { properties?: string[]; defaultPath?: string } | undefined {
	const call = vi.mocked(dialog.showOpenDialog).mock.calls.at(-1);
	return (call as unknown[] | undefined)?.[1] as { properties?: string[]; defaultPath?: string } | undefined;
}
async function bootHost(initialSessionIds: string[] = []): Promise<{ host: DesktopHost; directory: string }> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-e2e-chat-"));
	tempDirectories.push(directory);

	vi.mocked(dialog.showOpenDialog).mockResolvedValue({
		canceled: false,
		filePaths: [directory],
	});

	if (initialSessionIds.length > 0) {
		const sessions: SessionRecordV1[] = initialSessionIds.map(id => ({
			id,
			kind: "code",
			cwd: directory,
			ompSessionId: `omp-${id}`,
			sessionFile: `${id}.jsonl`,
			title: `Session ${id}`,
			createdAt: new Date().toISOString(),
			lastOpenedAt: new Date().toISOString(),
		}));
		await writeFile(
			path.join(directory, "sessions-v1.json"),
			`${JSON.stringify({
				version: 1,
				sessions,
				activeByKind: { code: initialSessionIds[0] ?? null, work: null },
			})}\n`,
			"utf8",
		);
	}

	const host = new DesktopHost(directory);
	hosts.push(host);
	await host.load();
	return { host, directory };
}

function simulateTurnSequence(
	processInstance: MockRpcProcessInstance,
	options: PromptSimulationOptions,
): SimulateTurnSequenceResult {
	const deltasReceived: string[] = [];
	const defaultMetrics: MockTurnMetrics = {
		durationMs: 850,
		elapsedSeconds: 0.85,
		inputTokens: 128,
		outputTokens: 48,
		totalTokens: 176,
		tokensPerSecond: 56.4,
	};
	const metrics = options.metrics ?? defaultMetrics;

	// 1. Turn start & agent running
	processInstance.state = "running";
	processInstance.options.onState("running");
	processInstance.emitEvent({ type: "agent_start" });

	// 2. User prompt recorded with guaranteed unique sequence ID
	const seq = ++processHarness.messageSequence;
	const userMessageId = `msg-user-${seq}-${Date.now()}`;
	processInstance.emitEvent({
		type: "message_start",
		message: {
			id: userMessageId,
			role: "user",
			content: [{ type: "text", text: options.promptText }],
			timestamp: new Date().toISOString(),
		},
	});
	processInstance.emitEvent({
		type: "message_end",
		message: {
			id: userMessageId,
			role: "user",
			content: [{ type: "text", text: options.promptText }],
			timestamp: new Date().toISOString(),
		},
	});

	processInstance.emitEvent({ type: "turn_start" });

	// 3. Optional thinking block
	const assistantMessageId = `msg-asst-${seq}-${Date.now()}`;
	if (options.thinkingText) {
		processInstance.emitEvent({
			type: "message_start",
			message: {
				id: assistantMessageId,
				role: "assistant",
				content: [{ type: "thinking", thinking: options.thinkingText }],
			},
		});
	}

	// 4. Tool execution lifecycle
	if (options.toolCall) {
		const tool = options.toolCall;
		// Tool start -> status "running"
		processInstance.emitEvent({
			type: "tool_execution_start",
			toolCallId: tool.id,
			toolName: tool.name,
			args: tool.args,
		});

		// Tool update -> partial result
		if (tool.partialResult) {
			processInstance.emitEvent({
				type: "tool_execution_update",
				toolCallId: tool.id,
				partialResult: tool.partialResult,
			});
		}

		// Tool end -> status "complete" / "error"
		processInstance.emitEvent({
			type: "tool_execution_end",
			toolCallId: tool.id,
			result: tool.result,
			isError: tool.isError ?? false,
		});
	}

	// 5. Assistant response streaming deltas
	const deltas = options.assistantDeltas ?? [
		"Analysis complete: ",
		"The requested file was inspected ",
		"and everything looks correct.",
	];

	let accumulatedText = "";
	for (const delta of deltas) {
		accumulatedText += delta;
		deltasReceived.push(delta);
		processInstance.emitEvent({
			type: "message_delta",
			delta,
		});
		processInstance.emitEvent({
			type: "message_update",
			message: {
				id: assistantMessageId,
				role: "assistant",
				content: [{ type: "text", text: accumulatedText }],
			},
		});
	}

	// 6. Message end with token usage
	processInstance.emitEvent({
		type: "message_end",
		message: {
			id: assistantMessageId,
			role: "assistant",
			content: [{ type: "text", text: accumulatedText }],
			usage: {
				inputTokens: metrics.inputTokens,
				outputTokens: metrics.outputTokens,
				totalTokens: metrics.totalTokens,
			},
		},
	});

	// 7. Turn end with turn metrics
	processInstance.emitEvent({
		type: "turn_end",
		message: {
			id: assistantMessageId,
			role: "assistant",
			content: [{ type: "text", text: accumulatedText }],
			usage: {
				inputTokens: metrics.inputTokens,
				outputTokens: metrics.outputTokens,
				totalTokens: metrics.totalTokens,
			},
		},
		toolResults: options.toolCall
			? [
					{
						role: "toolResult",
						toolCallId: options.toolCall.id,
						isError: options.toolCall.isError ?? false,
						content: [{ type: "text", text: options.toolCall.result }],
					},
				]
			: [],
	});

	// Notice / telemetry for clean turn metrics
	processInstance.emitEvent({
		type: "notice",
		message: `Turn finished in ${metrics.elapsedSeconds.toFixed(2)}s (${metrics.totalTokens} tokens, ${metrics.tokensPerSecond} tok/s)`,
	});

	// 8. Agent end & transition back to ready
	processInstance.emitEvent({
		type: "agent_end",
		isTerminal: true,
		messages: [],
		telemetry: {
			durationMs: metrics.durationMs,
			elapsedSeconds: metrics.elapsedSeconds,
			usage: {
				inputTokens: metrics.inputTokens,
				outputTokens: metrics.outputTokens,
				totalTokens: metrics.totalTokens,
			},
			tokensPerSecond: metrics.tokensPerSecond,
		},
	});

	processInstance.state = "ready";
	processInstance.options.onState("ready");

	return {
		assembledDeltas: accumulatedText,
		deltasReceived,
		metricsEmitted: metrics,
	};
}

describe("E2E Chat Progress & Lifecycle Integration", () => {
	it("boots DesktopHost in isolation, creates session, and runs complete prompt lifecycle", async () => {
		const { host, directory } = await bootHost();
		expect(directory).toBeDefined();

		const mock = createMockWindow();
		host.setWindow(mock.window);

		// 1. Create session
		const sessionSnapshot = await host.chooseAndCreate("code");
		expect(sessionSnapshot).not.toBeNull();
		if (!sessionSnapshot) throw new Error("Expected session snapshot");

		const dialogOptions = lastOpenDialogOptions();
		expect(dialogOptions).toMatchObject({ properties: ["openDirectory", "createDirectory"] });

		const sessionId = sessionSnapshot.record.id;
		expect(sessionSnapshot.record.kind).toBe("code");
		expect(sessionSnapshot.state).toBe("ready");

		const processInstance = processHarness.instances[0];
		expect(processInstance).toBeDefined();
		expect(processInstance.startCalls).toBe(1);

		// Configure prompt simulation on the mock process
		let simulationResult: SimulateTurnSequenceResult | undefined;
		processHarness.promptHandlers.set(processInstance.sessionFile ?? "", async promptText => {
			simulationResult = simulateTurnSequence(processInstance, {
				promptText,
				toolCall: {
					id: "tool-read-1",
					name: "read",
					args: { path: "packages/desktop/src/main.ts" },
					partialResult: "Reading lines 1-50...",
					result: "export class DesktopHost { ... }",
				},
				assistantDeltas: [
					"Inspected packages/desktop/src/main.ts. ",
					"The file defines DesktopHost ",
					"and coordinates RPC communication.",
				],
				metrics: {
					durationMs: 640,
					elapsedSeconds: 0.64,
					inputTokens: 140,
					outputTokens: 32,
					totalTokens: 172,
					tokensPerSecond: 50.0,
				},
			});
		});

		// 2. Dispatch user prompt
		const promptText = "Please inspect packages/desktop/src/main.ts and describe what it exports";
		await host.prompt(sessionId, composition({ type: "text", text: promptText }));

		expect(simulationResult).toBeDefined();
		expect(simulationResult?.assembledDeltas).toBe(
			"Inspected packages/desktop/src/main.ts. The file defines DesktopHost and coordinates RPC communication.",
		);

		// 3. Verify: Prompt is recorded in session timeline
		const page = await host.loadTimelinePage(sessionId, 100, 50);
		const userItem = page.items.find(item => item.kind === "user");
		expect(userItem).toBeDefined();
		expect(userItem?.text).toBe(promptText);

		// 4. Verify: Tool execution events update timeline items with status "running" -> "complete"
		const toolItem = page.items.find(item => item.kind === "tool" && item.toolCallId === "tool-read-1");
		expect(toolItem).toBeDefined();
		expect(toolItem?.toolName).toBe("read");
		expect(toolItem?.status).toBe("complete");
		expect(toolItem?.result).toBe("export class DesktopHost { ... }");

		// Check the window received both the "running" tool event and the "complete" tool event
		const toolEvents = mock.events.filter(
			e => e.type === "timeline" && e.item?.kind === "tool" && e.item?.toolCallId === "tool-read-1",
		);
		expect(toolEvents.length).toBeGreaterThanOrEqual(2);
		expect(toolEvents.some(e => e.item?.status === "running")).toBe(true);
		expect(toolEvents.some(e => e.item?.status === "complete")).toBe(true);

		// 5. Verify: Assistant response streaming deltas are received and assembled
		const assistantItem = page.items.find(item => item.kind === "assistant");
		expect(assistantItem).toBeDefined();
		expect(assistantItem?.text).toBe(simulationResult?.assembledDeltas);

		const assistantEvents = mock.events.filter(e => e.type === "timeline" && e.item?.kind === "assistant");
		expect(assistantEvents.length).toBeGreaterThanOrEqual(3);
		// Check that the streamed text progressed incrementally to the final assembled text
		const lastAssistantEvent = assistantEvents.at(-1);
		expect(lastAssistantEvent?.item?.text).toBe(simulationResult?.assembledDeltas);

		// 6. Verify: Session status transitions from "ready" -> "running" -> "ready"
		const sessionEvents = mock.getSessionEvents();
		const states = sessionEvents.map(e => e.state).filter(Boolean);
		expect(states).toContain("running");
		expect(states).toContain("ready");
		// Final state is ready
		expect(states.at(-1)).toBe("ready");

		// 7. Verify: Turn metrics (elapsed time, token counts) are emitted cleanly
		const noticeItem = page.items.find(
			item => item.kind === "special" && item.presentation?.type === "status" && item.text.includes("0.64s"),
		);
		expect(noticeItem).toBeDefined();
		expect(noticeItem?.text).toContain("0.64s");
		expect(noticeItem?.text).toContain("172 tokens");
		expect(noticeItem?.text).toContain("50 tok/s");

		expect(simulationResult?.metricsEmitted.durationMs).toBeGreaterThan(0);
		expect(simulationResult?.metricsEmitted.totalTokens).toBe(172);
		expect(simulationResult?.metricsEmitted.tokensPerSecond).toBe(50.0);
	});

	it("handles tool execution failure and sets status to error cleanly", async () => {
		const { host } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);

		const sessionSnapshot = await host.chooseAndCreate("code");
		if (!sessionSnapshot) throw new Error("Expected session snapshot");
		const sessionId = sessionSnapshot.record.id;
		const processInstance = processHarness.instances[0];

		processHarness.promptHandlers.set(processInstance.sessionFile ?? "", async promptText => {
			simulateTurnSequence(processInstance, {
				promptText,
				toolCall: {
					id: "tool-fail-1",
					name: "read",
					args: { path: "nonexistent.ts" },
					result: "ENOENT: no such file or directory",
					isError: true,
				},
				assistantDeltas: ["I encountered an error reading the file."],
			});
		});

		await host.prompt(sessionId, composition({ type: "text", text: "Read nonexistent.ts" }));

		const page = await host.loadTimelinePage(sessionId, 100, 50);
		const toolItem = page.items.find(item => item.toolCallId === "tool-fail-1");
		expect(toolItem).toBeDefined();
		expect(toolItem?.status).toBe("error");
		expect(toolItem?.isError).toBe(true);

		const toolEvents = mock.events.filter(
			e => e.type === "timeline" && e.item?.kind === "tool" && e.item?.toolCallId === "tool-fail-1",
		);
		expect(toolEvents.some(e => e.item?.status === "running")).toBe(true);
		expect(toolEvents.some(e => e.item?.status === "error")).toBe(true);
	});

	it("manages multi-turn conversations and preserves cumulative timeline order", async () => {
		const { host } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);

		const sessionSnapshot = await host.chooseAndCreate("code");
		if (!sessionSnapshot) throw new Error("Expected session snapshot");
		const sessionId = sessionSnapshot.record.id;
		const processInstance = processHarness.instances[0];

		let turnCount = 0;
		processHarness.promptHandlers.set(processInstance.sessionFile ?? "", async promptText => {
			turnCount++;
			simulateTurnSequence(processInstance, {
				promptText,
				assistantDeltas: [`Response to turn ${turnCount}: ${promptText}`],
				metrics: {
					durationMs: 400 * turnCount,
					elapsedSeconds: 0.4 * turnCount,
					inputTokens: 100 * turnCount,
					outputTokens: 20 * turnCount,
					totalTokens: 120 * turnCount,
					tokensPerSecond: 45.0,
				},
			});
		});

		// Turn 1
		await host.prompt(sessionId, composition({ type: "text", text: "First question" }));
		let page = await host.loadTimelinePage(sessionId, 100, 50);
		expect(page.items.filter(i => i.kind === "user")).toHaveLength(1);
		expect(page.items.filter(i => i.kind === "assistant")).toHaveLength(1);

		// Turn 2
		await host.prompt(sessionId, composition({ type: "text", text: "Second question" }));
		page = await host.loadTimelinePage(sessionId, 100, 50);
		expect(page.items.filter(i => i.kind === "user")).toHaveLength(2);
		expect(page.items.filter(i => i.kind === "assistant")).toHaveLength(2);

		const users = page.items.filter(i => i.kind === "user");
		expect(users[0]?.text).toBe("First question");
		expect(users[1]?.text).toBe("Second question");

		const assistants = page.items.filter(i => i.kind === "assistant");
		expect(assistants[0]?.text).toBe("Response to turn 1: First question");
		expect(assistants[1]?.text).toBe("Response to turn 2: Second question");
	});

	it("streams reasoning/thinking blocks with running -> complete status", async () => {
		const { host } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);

		const sessionSnapshot = await host.chooseAndCreate("code");
		if (!sessionSnapshot) throw new Error("Expected session snapshot");
		const sessionId = sessionSnapshot.record.id;
		const processInstance = processHarness.instances[0];

		processHarness.promptHandlers.set(processInstance.sessionFile ?? "", async promptText => {
			simulateTurnSequence(processInstance, {
				promptText,
				thinkingText: "1. Analyzing dependencies\n2. Inspecting imports",
				assistantDeltas: ["Here is the conclusion."],
			});
		});

		await host.prompt(sessionId, composition({ type: "text", text: "Think deeply about this" }));

		const page = await host.loadTimelinePage(sessionId, 100, 50);
		const thinkingItem = page.items.find(i => i.kind === "thinking");
		expect(thinkingItem).toBeDefined();
		expect(thinkingItem?.text).toContain("Analyzing dependencies");
		expect(thinkingItem?.status).toBe("complete");
	});

	it("ensures clean teardown without lingering locks or child processes", async () => {
		const { host, directory } = await bootHost(["session-alpha", "session-beta"]);
		const mock = createMockWindow();
		host.setWindow(mock.window);

		// Open session alpha
		await host.openSession("session-alpha");
		expect(processHarness.instances).toHaveLength(2);
		expect(processHarness.instances[0]?.state).toBe("ready");

		// Prompt session alpha
		const procAlpha = processHarness.instances[0];
		processHarness.promptHandlers.set(procAlpha.sessionFile ?? "", async promptText => {
			simulateTurnSequence(procAlpha, {
				promptText,
				assistantDeltas: ["Done"],
			});
		});
		await host.prompt("session-alpha", composition({ type: "text", text: "Ping" }));

		// Clean teardown
		await host.close();

		// Verify child processes stopped
		expect(processHarness.instances[0]?.stopCalls).toBeGreaterThanOrEqual(1);
		expect(processHarness.instances[0]?.state).toBe("stopped");
		expect(processHarness.instances[0]?.client).toBeUndefined();

		// Verify directory can be cleanly deleted without EBUSY / EPERM / locked files
		await expect(rm(directory, { recursive: true, force: true })).resolves.toBeUndefined();
	});
});

describe("chooseAndCreate default workspace path", () => {
	it("passes the validated saved defaultPath to the open dialog", async () => {
		const { host, directory } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);
		await writeFile(
			path.join(directory, "settings.json"),
			`${JSON.stringify({ workspace: { defaultPath: directory } })}\n`,
			"utf8",
		);

		await host.chooseAndCreate("code");

		expect(lastOpenDialogOptions()).toMatchObject({ defaultPath: directory });
	});

	it("omits defaultPath when the saved path does not exist", async () => {
		const { host, directory } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);
		await writeFile(
			path.join(directory, "settings.json"),
			`${JSON.stringify({ workspace: { defaultPath: path.join(directory, "missing-workspace") } })}\n`,
			"utf8",
		);

		await host.chooseAndCreate("code");

		expect(lastOpenDialogOptions()?.defaultPath).toBeUndefined();
	});

	it("omits defaultPath when the saved path is a file instead of a directory", async () => {
		const { host, directory } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);
		const filePath = path.join(directory, "not-a-directory.txt");
		await writeFile(filePath, "not a directory\n");
		await writeFile(
			path.join(directory, "settings.json"),
			`${JSON.stringify({ workspace: { defaultPath: filePath } })}\n`,
			"utf8",
		);

		await host.chooseAndCreate("code");

		expect(lastOpenDialogOptions()?.defaultPath).toBeUndefined();
	});
});

describe("auth provider discovery failures", () => {
	function authEventsFrom(mock: MockWindowHandle): unknown[] {
		const calls = vi.mocked(mock.window.webContents.send).mock.calls;
		return calls.filter(([channel]) => channel === "gradivus:auth").map(([, event]) => event);
	}

	it("returns no accounts and emits a discovery-failure event when the runtime reports failure", async () => {
		const { host } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);
		processHarness.failureCommands.add("get_login_providers");

		const accounts = await host.getAuthStatus();

		expect(accounts).toEqual([]);
		expect(authEventsFrom(mock)).toContainEqual(
			expect.objectContaining({
				type: "error",
				provider: "",
				message: expect.stringContaining("Provider status could not be loaded"),
			}),
		);
	});

	it("returns no accounts and emits a discovery-failure event when discovery throws", async () => {
		const { host } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);
		processHarness.throwCommands.add("get_login_providers");

		const accounts = await host.getAuthStatus();

		expect(accounts).toEqual([]);
		expect(authEventsFrom(mock)).toContainEqual(
			expect.objectContaining({
				type: "error",
				provider: "",
				message: expect.stringContaining("fixture command crash"),
			}),
		);
	});

	it("emits no discovery-failure event on a successful snapshot", async () => {
		const { host } = await bootHost();
		const mock = createMockWindow();
		host.setWindow(mock.window);

		const accounts = await host.getAuthStatus();

		expect(accounts).toEqual([]);
		expect(authEventsFrom(mock)).toEqual([]);
	});
});

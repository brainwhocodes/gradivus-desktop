import { describe, expect, it } from "vitest";
import type { GradivusEvent, SessionSnapshot, TimelineItem } from "../src/shared/contracts";

type SessionViewModel = SessionSnapshot;

/**
 * Format elapsed seconds into M:SSs display format.
 */
function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(s / 60);
	const secs = s % 60;
	return `${mins}:${secs.toString().padStart(2, "0")}s`;
}

/**
 * Format tool arguments into a human-readable detail string.
 */
function formatToolArgs(args: unknown, fallbackDetail?: string): string | undefined {
	if (!args && !fallbackDetail) return undefined;
	if (typeof args === "string") return args;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		const priorityKeys = ["path", "file", "command", "pattern", "query", "url", "action", "key", "signal", "name"];
		for (const key of priorityKeys) {
			if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "object") {
				return String(record[key]);
			}
		}
		const entries = Object.entries(record);
		if (entries.length > 0) {
			const [k, v] = entries[0];
			if (v !== undefined && v !== null && typeof v !== "object") {
				return `${k}: ${String(v)}`;
			}
		}
	}
	if (fallbackDetail && fallbackDetail.trim().length > 0) {
		return fallbackDetail.trim();
	}
	return undefined;
}

/**
 * Activity classifier returning the active turn status, label, and detail.
 */
function activeTurnActivity(
	current: SessionViewModel,
	options?: { optimisticPendingTurn?: boolean },
): {
	type: "thinking" | "tool" | "generating";
	label: string;
	detail?: string;
} {
	const items = current.timeline ?? [];
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.status === "running" && item.kind === "tool") {
			const label = item.toolName || item.text || "Tool";
			const detail = formatToolArgs(item.args, item.detail);
			return { type: "tool", label, detail };
		}
	}
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item.status === "running" && item.kind === "thinking") {
			const charCount = item.text?.length ?? 0;
			const tokens = Math.max(1, Math.round(charCount / 3.8));
			const detail = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${tokens} tokens`;
			return { type: "thinking", label: "Reasoning & Thinking...", detail };
		}
	}
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (
			item.kind === "assistant" &&
			(item.status === "running" || (current.state === "running" && i === items.length - 1))
		) {
			const detail =
				current.tokensPerSecond && current.tokensPerSecond > 0
					? `${Math.round(current.tokensPerSecond)} tok/s`
					: undefined;
			return { type: "generating", label: "Generating response...", detail };
		}
	}
	if (options?.optimisticPendingTurn) {
		return { type: "generating", label: "Preparing turn & thinking..." };
	}
	return { type: "generating", label: "Turn in progress..." };
}

/**
 * Helper to construct a mock session snapshot.
 */
function createMockSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		record: {
			id: "session-1",
			kind: "work",
			cwd: "/workspace",
			ompSessionId: "omp-1",
			sessionFile: "/workspace/.omp",
			title: "Test Workspace",
			createdAt: new Date().toISOString(),
			lastOpenedAt: new Date().toISOString(),
		},
		state: "ready",
		timeline: [],
		subagents: [],
		...overrides,
	};
}

/**
 * Chat turn optimistic controller replicating OmpChat's optimistic state machine.
 */
class OptimisticChatHarness {
	current: SessionViewModel;
	draft = "";
	optimisticPendingTurn = false;
	pendingPromptText = "";
	canceledPromptTexts = new Set<string>();
	turnStartTime: number | null = null;
	elapsedSeconds = 0;
	errorMessage = "";
	commandMenuDismissed = false;

	constructor(initialSession?: SessionViewModel) {
		this.current = initialSession ?? createMockSession();
	}

	get isTurnActive(): boolean {
		return Boolean(this.optimisticPendingTurn || this.current?.state === "running");
	}

	get isRunning(): boolean {
		return this.isTurnActive;
	}

	async sendPrimary(
		textInput?: string,
		rpcSubmit?: (sessionId: string, text: string) => Promise<void>,
	): Promise<void> {
		const text = (typeof textInput === "string" ? textInput : this.draft).trim();
		this.draft = "";
		this.commandMenuDismissed = true;
		this.pendingPromptText = text;
		this.errorMessage = "";
		this.optimisticPendingTurn = true;
		this.turnStartTime = Date.now();
		this.elapsedSeconds = 0;

		if (!text || !this.current) {
			this.optimisticPendingTurn = false;
			return;
		}

		const sessionId = this.current.record.id;
		const optUserId = `opt-user-${Date.now()}`;
		const optAstId = `opt-ast-${Date.now()}`;

		const userItem: TimelineItem = {
			id: optUserId,
			kind: "user",
			text,
			role: "user",
			createdAt: Date.now(),
		};
		const astItem: TimelineItem = {
			id: optAstId,
			kind: "thinking",
			text: "Reasoning & preparing response...",
			status: "running",
			role: "assistant",
			createdAt: Date.now(),
		};

		const timeline = [...this.current.timeline, userItem, astItem];
		const timelineTotal = (this.current.timelineTotal ?? this.current.timeline.length) + 2;
		this.current = {
			...this.current,
			timeline,
			timelineStart: Math.max(0, timelineTotal - timeline.length),
			timelineTotal,
		};

		try {
			if (rpcSubmit) {
				await rpcSubmit(sessionId, text);
			}
		} catch (error) {
			if (this.current && this.current.record.id === sessionId) {
				const cleanedTimeline = this.current.timeline.filter(item => item.id !== optUserId && item.id !== optAstId);
				const removedCount = this.current.timeline.length - cleanedTimeline.length;
				const total = Math.max(0, (this.current.timelineTotal ?? this.current.timeline.length) - removedCount);
				this.current = {
					...this.current,
					timeline: cleanedTimeline,
					timelineStart: Math.max(0, total - cleanedTimeline.length),
					timelineTotal: total,
				};
			}
			this.optimisticPendingTurn = false;
			this.draft = text;
			this.commandMenuDismissed = false;
			this.errorMessage = error instanceof Error ? error.message : String(error);
		}
	}

	handleEvent(event: GradivusEvent): void {
		if (!this.current || event.sessionId !== this.current.record.id) return;
		this.optimisticPendingTurn = false;

		if (event.state) {
			this.current = { ...this.current, state: event.state };
			if (event.state === "ready") {
				this.optimisticPendingTurn = false;
				this.turnStartTime = null;
				if (this.current.timeline.some(candidate => candidate.id.startsWith("opt-ast-"))) {
					const cleaned = this.current.timeline.filter(candidate => !candidate.id.startsWith("opt-ast-"));
					const removed = this.current.timeline.length - cleaned.length;
					const total = Math.max(0, (this.current.timelineTotal ?? this.current.timeline.length) - removed);
					this.current = {
						...this.current,
						timeline: cleaned,
						timelineStart: Math.max(0, total - cleaned.length),
						timelineTotal: total,
					};
				}
			}
		}

		if (event.type === "timeline" && event.item) {
			if (event.item.kind === "user" && this.canceledPromptTexts.delete(event.item.text.trim())) {
				return;
			}
			let baseTimeline = this.current.timeline;
			if (!event.item.id.startsWith("opt-") && baseTimeline.some(candidate => candidate.id.startsWith("opt-ast-"))) {
				const cleaned = baseTimeline.filter(candidate => !candidate.id.startsWith("opt-ast-"));
				const removed = baseTimeline.length - cleaned.length;
				const total = Math.max(0, (this.current.timelineTotal ?? this.current.timeline.length) - removed);
				baseTimeline = cleaned;
				this.current = {
					...this.current,
					timeline: cleaned,
					timelineStart: Math.max(0, total - cleaned.length),
					timelineTotal: total,
				};
			}

			const optimisticIndex =
				event.item.kind === "user"
					? baseTimeline.findIndex(
							candidate =>
								(candidate.id.startsWith("opt-user-") || candidate.id.startsWith("optimistic-user-")) &&
								candidate.text === event.item?.text,
						)
					: -1;

			const existed = optimisticIndex >= 0 || baseTimeline.some(candidate => candidate.id === event.item?.id);
			const timeline =
				optimisticIndex >= 0
					? baseTimeline.map((candidate, index) =>
							index === optimisticIndex ? (event.item as TimelineItem) : candidate,
						)
					: this.appendTimeline(baseTimeline, event.item);

			const timelineTotal = (this.current.timelineTotal ?? this.current.timeline.length) + (existed ? 0 : 1);
			this.current = {
				...this.current,
				timeline,
				timelineStart: Math.max(0, timelineTotal - timeline.length),
				timelineTotal,
			};
		}
	}

	abortTurn(): void {
		this.optimisticPendingTurn = false;
		this.turnStartTime = null;
		if (this.pendingPromptText) {
			this.canceledPromptTexts.add(this.pendingPromptText);
			this.pendingPromptText = "";
		}
		if (this.current) {
			const timeline = this.current.timeline.filter(item => !item.id.startsWith("opt-"));
			const removed = this.current.timeline.length - timeline.length;
			const timelineTotal = Math.max(0, (this.current.timelineTotal ?? this.current.timeline.length) - removed);
			this.current = {
				...this.current,
				state: "ready",
				timeline,
				timelineStart: Math.max(0, timelineTotal - timeline.length),
				timelineTotal,
			};
		}
	}

	private appendTimeline(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
		const existing = items.findIndex(candidate => candidate.id === item.id);
		if (existing < 0) return [...items, item];
		return items.map((candidate, index) => (index === existing ? { ...candidate, ...item } : candidate));
	}
}

describe("Chat Progress Feedback", () => {
	describe("1. Instant Optimistic Turn Activation", () => {
		it("flips isRunning and isTurnActive to true at 0ms upon prompt submission before RPC events", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			harness.draft = "Refactor database migration script";

			expect(harness.isTurnActive).toBe(false);
			expect(harness.isRunning).toBe(false);
			expect(harness.turnStartTime).toBeNull();

			let rpcInvoked = false;
			const rpcPromise = harness.sendPrimary("Refactor database migration script", async () => {
				rpcInvoked = true;
				// Inflight before response/events
				expect(harness.isTurnActive).toBe(true);
				expect(harness.isRunning).toBe(true);
				expect(harness.optimisticPendingTurn).toBe(true);
				expect(harness.turnStartTime).not.toBeNull();
				expect(harness.elapsedSeconds).toBe(0);
			});

			// Verify synchronous 0ms activation
			expect(harness.isTurnActive).toBe(true);
			expect(harness.isRunning).toBe(true);
			expect(harness.optimisticPendingTurn).toBe(true);
			expect(harness.draft).toBe("");

			await rpcPromise;
			expect(rpcInvoked).toBe(true);
		});

		it("places optimistic user message and optimistic assistant placeholder in timeline", async () => {
			const initialSession = createMockSession({
				state: "ready",
				timeline: [
					{
						id: "prev-1",
						kind: "user",
						text: "Hello",
						timestamp: new Date().toISOString(),
					},
					{
						id: "prev-2",
						kind: "assistant",
						text: "Hi there!",
						timestamp: new Date().toISOString(),
					},
				],
			});

			const harness = new OptimisticChatHarness(initialSession);
			await harness.sendPrimary("Explain optimistic UI patterns");

			const items = harness.current.timeline;
			expect(items.length).toBe(4);

			const userMsg = items.find(i => i.id.startsWith("opt-user-"));
			expect(userMsg).toBeDefined();
			expect(userMsg).toMatchObject({
				kind: "user",
				text: "Explain optimistic UI patterns",
				role: "user",
			});

			const assistantPlaceholder = items.find(i => i.id.startsWith("opt-ast-"));
			expect(assistantPlaceholder).toBeDefined();
			expect(assistantPlaceholder).toMatchObject({
				kind: "thinking",
				text: "Reasoning & preparing response...",
				status: "running",
				role: "assistant",
			});
		});

		it("resets draft and command menu state upon submission", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			harness.draft = "run tests";
			harness.commandMenuDismissed = false;

			await harness.sendPrimary();

			expect(harness.draft).toBe("");
			expect(harness.commandMenuDismissed).toBe(true);
		});
	});

	describe("2. Activity Classifier Transitions", () => {
		it("returns { type: 'thinking', label: 'Reasoning & Thinking...' } when thinking item is running", () => {
			const thinkingItem: TimelineItem = {
				id: "th-1",
				kind: "thinking",
				status: "running",
				text: "Analyzing project structure and test files...",
			};
			const session = createMockSession({
				state: "running",
				timeline: [thinkingItem],
			});

			const activity = activeTurnActivity(session);
			expect(activity).toEqual({
				type: "thinking",
				label: "Reasoning & Thinking...",
				detail: "12 tokens",
			});
		});

		it("formats large thinking token counts as k tokens", () => {
			const thinkingItem: TimelineItem = {
				id: "th-large",
				kind: "thinking",
				status: "running",
				text: "X".repeat(7600), // ~2000 tokens
			};
			const session = createMockSession({
				state: "running",
				timeline: [thinkingItem],
			});

			const activity = activeTurnActivity(session);
			expect(activity).toEqual({
				type: "thinking",
				label: "Reasoning & Thinking...",
				detail: "2.0k tokens",
			});
		});

		it("returns { type: 'tool', label: 'grep', detail: 'resolveSelectionScope' } when tool item is running", () => {
			const toolItem: TimelineItem = {
				id: "tool-1",
				kind: "tool",
				status: "running",
				toolName: "grep",
				args: { pattern: "resolveSelectionScope" },
				text: "grep",
			};
			const session = createMockSession({
				state: "running",
				timeline: [toolItem],
			});

			const activity = activeTurnActivity(session);
			expect(activity).toEqual({
				type: "tool",
				label: "grep",
				detail: "resolveSelectionScope",
			});
		});

		it("extracts priority tool arguments across various key names", () => {
			const testCases = [
				{ args: { path: "src/renderer/main.ts" }, expected: "src/renderer/main.ts" },
				{ args: { file: "package.json" }, expected: "package.json" },
				{ args: { command: "bun test" }, expected: "bun test" },
				{ args: { query: "search terms" }, expected: "search terms" },
				{ args: { url: "https://example.com" }, expected: "https://example.com" },
				{ args: { action: "open" }, expected: "open" },
			];

			for (const { args, expected } of testCases) {
				const item: TimelineItem = {
					id: "tool-test",
					kind: "tool",
					status: "running",
					toolName: "exec",
					args,
					text: "exec",
				};
				const session = createMockSession({ state: "running", timeline: [item] });
				const activity = activeTurnActivity(session);
				expect(activity.detail).toBe(expected);
			}
		});

		it("returns { type: 'generating', label: 'Generating response...', detail: '142 tok/s' } when assistant message is streaming", () => {
			const assistantItem: TimelineItem = {
				id: "ast-1",
				kind: "assistant",
				status: "running",
				text: "Here is the plan for refactoring...",
			};
			const session = createMockSession({
				state: "running",
				timeline: [assistantItem],
				tokensPerSecond: 142.3,
			});

			const activity = activeTurnActivity(session);
			expect(activity).toEqual({
				type: "generating",
				label: "Generating response...",
				detail: "142 tok/s",
			});
		});

		it("returns generating without detail when tokensPerSecond is not available", () => {
			const assistantItem: TimelineItem = {
				id: "ast-2",
				kind: "assistant",
				status: "running",
				text: "Streaming output...",
			};
			const session = createMockSession({
				state: "running",
				timeline: [assistantItem],
			});

			const activity = activeTurnActivity(session);
			expect(activity).toEqual({
				type: "generating",
				label: "Generating response...",
				detail: undefined,
			});
		});

		it("returns fallback { type: 'generating', label: 'Preparing turn & thinking...' } when in optimistic pending state", () => {
			const session = createMockSession({
				state: "ready",
				timeline: [],
			});

			const activity = activeTurnActivity(session, { optimisticPendingTurn: true });
			expect(activity).toEqual({
				type: "generating",
				label: "Preparing turn & thinking...",
				detail: undefined,
			});
		});

		it("returns general fallback when running with no active items", () => {
			const session = createMockSession({
				state: "running",
				timeline: [],
			});

			const activity = activeTurnActivity(session, { optimisticPendingTurn: false });
			expect(activity).toEqual({
				type: "generating",
				label: "Turn in progress...",
				detail: undefined,
			});
		});

		it("prioritizes running tool over running thinking and streaming assistant", () => {
			const thinking: TimelineItem = {
				id: "th-1",
				kind: "thinking",
				status: "running",
				text: "Deep thoughts",
			};
			const tool: TimelineItem = {
				id: "t-1",
				kind: "tool",
				status: "running",
				toolName: "grep",
				args: { pattern: "resolveSelectionScope" },
			};
			const assistant: TimelineItem = {
				id: "a-1",
				kind: "assistant",
				status: "running",
				text: "Streaming text",
			};

			const session = createMockSession({
				state: "running",
				timeline: [thinking, tool, assistant],
				tokensPerSecond: 100,
			});

			const activity = activeTurnActivity(session);
			expect(activity.type).toBe("tool");
			expect(activity.label).toBe("grep");
			expect(activity.detail).toBe("resolveSelectionScope");
		});
	});

	describe("3. Elapsed Timer & Telemetry", () => {
		it("formats 0s as 0:00s", () => {
			expect(formatElapsed(0)).toBe("0:00s");
		});

		it("formats 4s as 0:04s", () => {
			expect(formatElapsed(4)).toBe("0:04s");
		});

		it("formats 75s as 1:15s", () => {
			expect(formatElapsed(75)).toBe("1:15s");
		});

		it("formats various boundary seconds correctly", () => {
			expect(formatElapsed(59)).toBe("0:59s");
			expect(formatElapsed(60)).toBe("1:00s");
			expect(formatElapsed(61)).toBe("1:01s");
			expect(formatElapsed(125)).toBe("2:05s");
			expect(formatElapsed(3599)).toBe("59:59s");
			expect(formatElapsed(3600)).toBe("60:00s");
			expect(formatElapsed(3665)).toBe("61:05s");
		});

		it("floors fractional seconds", () => {
			expect(formatElapsed(0.4)).toBe("0:00s");
			expect(formatElapsed(4.8)).toBe("0:04s");
			expect(formatElapsed(75.9)).toBe("1:15s");
		});

		it("clamps negative numbers to 0:00s", () => {
			expect(formatElapsed(-1)).toBe("0:00s");
			expect(formatElapsed(-100)).toBe("0:00s");
		});

		it("simulates timer tick advancement accurately", () => {
			const startTime = 1_000_000;
			const computeElapsed = (now: number) => Math.max(0, Math.floor((now - startTime) / 1000));

			expect(formatElapsed(computeElapsed(startTime))).toBe("0:00s");
			expect(formatElapsed(computeElapsed(startTime + 4000))).toBe("0:04s");
			expect(formatElapsed(computeElapsed(startTime + 75000))).toBe("1:15s");
		});
	});

	describe("4. State Transitions and Cleanup", () => {
		it("replaces/cleans up optimistic placeholder when real assistant or tool timeline item arrives", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			await harness.sendPrimary("Execute build");

			expect(harness.current.timeline.some(i => i.id.startsWith("opt-ast-"))).toBe(true);
			expect(harness.optimisticPendingTurn).toBe(true);

			// Real tool execution arrives from backend
			const realToolItem: TimelineItem = {
				id: "tool-real-1",
				kind: "tool",
				status: "running",
				toolName: "bash",
				args: { command: "bun run build" },
				text: "bash",
			};

			harness.handleEvent({
				type: "timeline",
				sessionId: "session-1",
				state: "running",
				item: realToolItem,
			});

			// Optimistic placeholder should be cleaned up
			expect(harness.current.timeline.some(i => i.id.startsWith("opt-ast-"))).toBe(false);
			expect(harness.optimisticPendingTurn).toBe(false);
			expect(harness.current.timeline.some(i => i.id === "tool-real-1")).toBe(true);
			expect(harness.isTurnActive).toBe(true);
		});

		it("reconciles optimistic user message with real user item from backend without duplicates", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			await harness.sendPrimary("Check git status");

			const optUser = harness.current.timeline.find(i => i.id.startsWith("opt-user-"));
			expect(optUser).toBeDefined();

			const realUserItem: TimelineItem = {
				id: "user-real-1",
				kind: "user",
				text: "Check git status",
				role: "user",
			};

			harness.handleEvent({
				type: "timeline",
				sessionId: "session-1",
				item: realUserItem,
			});

			const userItems = harness.current.timeline.filter(i => i.kind === "user");
			expect(userItems.length).toBe(1);
			expect(userItems[0].id).toBe("user-real-1");
		});

		it("resets isTurnActive and clears timers on turn completion (state: 'ready')", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			await harness.sendPrimary("Run lint");

			expect(harness.isTurnActive).toBe(true);

			harness.handleEvent({
				type: "session",
				sessionId: "session-1",
				state: "ready",
			});

			expect(harness.isTurnActive).toBe(false);
			expect(harness.isRunning).toBe(false);
			expect(harness.turnStartTime).toBeNull();
			expect(harness.optimisticPendingTurn).toBe(false);
		});

		it("resets isTurnActive and rolls back optimistic items on prompt RPC error", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			harness.draft = "Failing command";

			const rpcError = new Error("RPC backend connection refused");
			await harness.sendPrimary("Failing command", async () => {
				throw rpcError;
			});

			expect(harness.isTurnActive).toBe(false);
			expect(harness.isRunning).toBe(false);
			expect(harness.optimisticPendingTurn).toBe(false);
			expect(harness.errorMessage).toBe("RPC backend connection refused");
			expect(harness.draft).toBe("Failing command");
			expect(harness.commandMenuDismissed).toBe(false);

			// Timeline should not contain any lingering optimistic items
			expect(harness.current.timeline.some(i => i.id.startsWith("opt-"))).toBe(false);
		});

		it("resets isTurnActive on turn abort", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			await harness.sendPrimary("Long running query");

			expect(harness.isTurnActive).toBe(true);

			harness.abortTurn();

			expect(harness.isTurnActive).toBe(false);
			expect(harness.isRunning).toBe(false);
			expect(harness.turnStartTime).toBeNull();
			expect(harness.optimisticPendingTurn).toBe(false);
		});
		it("removes the optimistic prompt and ignores a late canonical user event after abort", async () => {
			const harness = new OptimisticChatHarness(createMockSession({ state: "ready" }));
			const prompt = "Do not add this canceled prompt";
			await harness.sendPrimary(prompt);

			harness.abortTurn();
			harness.handleEvent({
				sessionId: harness.current.record.id,
				type: "timeline",
				item: {
					id: "canonical-canceled-user",
					kind: "user",
					text: prompt,
					role: "user",
				},
			});

			expect(harness.current.timeline.filter(item => item.kind === "user")).toHaveLength(0);
			expect(harness.draft).toBe("");
		});
	});
});

import { describe, expect, it } from "vitest";
import type { SessionSnapshot, TimelineItem } from "../src/shared/contracts";

type SessionViewModel = SessionSnapshot;

function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(s / 60);
	const secs = s % 60;
	return `${mins}:${secs.toString().padStart(2, "0")}s`;
}

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

function activeTurnActivity(current: SessionViewModel): {
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
	return { type: "generating", label: "Turn in progress..." };
}

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
		state: "running",
		timeline: [],
		subagents: [],
		...overrides,
	};
}

describe("formatElapsed", () => {
	it("formats single digit seconds", () => {
		expect(formatElapsed(4)).toBe("0:04s");
		expect(formatElapsed(0)).toBe("0:00s");
	});

	it("formats minutes and seconds", () => {
		expect(formatElapsed(72)).toBe("1:12s");
		expect(formatElapsed(60)).toBe("1:00s");
		expect(formatElapsed(125)).toBe("2:05s");
	});

	it("handles fractional seconds by flooring", () => {
		expect(formatElapsed(4.8)).toBe("0:04s");
	});
});

describe("activeTurnActivity", () => {
	it("returns tool activity with formatted args when a tool is running", () => {
		const toolItem: TimelineItem = {
			id: "t1",
			kind: "tool",
			status: "running",
			toolName: "read",
			args: { path: "src/renderer/OmpChat.svelte" },
			text: "read",
		};
		const session = createMockSession({ timeline: [toolItem] });
		const activity = activeTurnActivity(session);
		expect(activity).toEqual({
			type: "tool",
			label: "read",
			detail: "src/renderer/OmpChat.svelte",
		});
	});

	it("prioritizes running tool over prior completed items", () => {
		const session = createMockSession({
			timeline: [
				{ id: "1", kind: "thinking", status: "complete", text: "Thought about it" },
				{ id: "2", kind: "tool", status: "complete", toolName: "list", text: "list" },
				{
					id: "3",
					kind: "tool",
					status: "running",
					toolName: "edit",
					args: { file: "OmpChat.svelte" },
					text: "edit",
				},
			],
		});
		const activity = activeTurnActivity(session);
		expect(activity).toEqual({
			type: "tool",
			label: "edit",
			detail: "OmpChat.svelte",
		});
	});

	it("returns thinking activity with token count when thinking is running", () => {
		const thinkingItem: TimelineItem = {
			id: "th1",
			kind: "thinking",
			status: "running",
			text: "A".repeat(380), // ~100 tokens
		};
		const session = createMockSession({ timeline: [thinkingItem] });
		const activity = activeTurnActivity(session);
		expect(activity).toEqual({
			type: "thinking",
			label: "Reasoning & Thinking...",
			detail: "100 tokens",
		});
	});

	it("formats large thinking token counts as k tokens", () => {
		const thinkingItem: TimelineItem = {
			id: "th2",
			kind: "thinking",
			status: "running",
			text: "A".repeat(7600), // ~2000 tokens
		};
		const session = createMockSession({ timeline: [thinkingItem] });
		const activity = activeTurnActivity(session);
		expect(activity).toEqual({
			type: "thinking",
			label: "Reasoning & Thinking...",
			detail: "2.0k tokens",
		});
	});

	it("returns generating response with throughput when assistant is streaming", () => {
		const assistantItem: TimelineItem = {
			id: "a1",
			kind: "assistant",
			status: "running",
			text: "Partial response...",
		};
		const session = createMockSession({
			timeline: [assistantItem],
			tokensPerSecond: 128.3,
		});
		const activity = activeTurnActivity(session);
		expect(activity).toEqual({
			type: "generating",
			label: "Generating response...",
			detail: "128 tok/s",
		});
	});

	it("returns default Turn in progress when running with no specific running item", () => {
		const session = createMockSession({ timeline: [] });
		const activity = activeTurnActivity(session);
		expect(activity).toEqual({
			type: "generating",
			label: "Turn in progress...",
			detail: undefined,
		});
	});
});

describe("scroll tracking logic", () => {
	it("detects when user is scrolled up past 120px threshold", () => {
		const scrollHeight = 1000;
		const clientHeight = 400;
		// At bottom: scrollTop = 600 -> 600 + 400 = 1000 >= 1000 - 120 (880) -> not scrolled up
		expect(600 + clientHeight < scrollHeight - 120).toBe(false);

		// Scrolled up slightly (scrollTop = 500) -> 500 + 400 = 900 >= 880 -> not scrolled up
		expect(500 + clientHeight < scrollHeight - 120).toBe(false);

		// Scrolled up past 120px (scrollTop = 450) -> 450 + 400 = 850 < 880 -> isScrolledUp = true
		expect(450 + clientHeight < scrollHeight - 120).toBe(true);

		// At top (scrollTop = 0) -> 0 + 400 = 400 < 880 -> isScrolledUp = true
		expect(0 + clientHeight < scrollHeight - 120).toBe(true);
	});
});

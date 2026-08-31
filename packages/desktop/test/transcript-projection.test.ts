import { describe, expect, it } from "vitest";
import { TranscriptStore } from "../src/main/transcript-store";
import type { TimelineItem } from "../src/shared/contracts";
import { changedFiles, projectTimeline } from "../src/shared/projection";

describe("TranscriptStore", () => {
	it("pairs tool results with streamed tool calls and preserves unknown events", () => {
		const store = new TranscriptStore();
		store.load([
			{
				id: "assistant-1",
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.md" } }],
			},
		]);
		store.apply({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: "partial" });
		store.apply({ type: "tool_execution_end", toolCallId: "tool-1", result: "complete", isError: false });
		store.apply({ type: "future_event", payload: { stable: true } });

		const items = store.snapshot;
		const tool = items.find(item => item.toolCallId === "tool-1");
		expect(tool).toMatchObject({ toolName: "read", status: "complete", detail: "complete" });
		expect(items.at(-1)).toMatchObject({ kind: "raw", detail: expect.stringContaining("future_event") });
	});
	it("keeps image progress readable and surfaces generated images without duplicating base64 in details", () => {
		const store = new TranscriptStore();
		const image = { data: "aGVsbG8=", mimeType: "image/png" };
		store.apply({ type: "tool_execution_start", toolCallId: "image-1", toolName: "generate_image", args: {} });
		const progress = store.apply({
			type: "tool_execution_update",
			toolCallId: "image-1",
			partialResult: { details: { images: [image] } },
		});
		expect(progress).toMatchObject({
			status: "running",
			images: [image],
		});
		const progressDetail = progress?.detail;
		expect(typeof progressDetail === "string" && progressDetail.includes("[inline image omitted]")).toBe(true);
		expect(typeof progressDetail === "string" && progressDetail.includes(image.data)).toBe(false);
		if (!progress) throw new Error("expected image progress timeline item");
		const projectedDetail = projectTimeline("work", [progress])[0]?.detail;
		expect(typeof projectedDetail === "string" && projectedDetail.includes("[inline image omitted]")).toBe(true);

		const complete = store.apply({
			type: "tool_execution_end",
			toolCallId: "image-1",
			result: { content: [{ type: "text", text: "Generated image." }], details: { images: [image] } },
			isError: false,
		});
		expect(complete).toMatchObject({ status: "complete", images: [image], detail: "Generated image." });
	});
	it("projects successful native xdev image results as image generation", () => {
		const store = new TranscriptStore();
		const image = { data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml", type: "image" };
		store.apply({
			type: "tool_execution_start",
			toolCallId: "xdev-image",
			toolName: "write",
			args: { path: "xd://generate_image" },
		});

		const complete = store.apply({
			type: "tool_execution_end",
			toolCallId: "xdev-image",
			result: {
				content: [{ type: "text", text: "[Image: image/svg+xml]" }],
				details: { xdev: { inner: { rawContent: [image] } } },
			},
			isError: false,
		});

		expect(complete).toMatchObject({
			status: "complete",
			isError: false,
			toolName: "generate_image",
			images: [{ data: image.data, mimeType: image.mimeType }],
		});
		const completeDetail = complete?.detail;
		expect(typeof completeDetail === "string" && completeDetail.includes(image.data)).toBe(false);
	});
	it("labels proposal writes without exposing review payloads in Work projection", () => {
		const store = new TranscriptStore();
		const proposal = store.apply({
			type: "tool_execution_start",
			toolCallId: "proposal-1",
			toolName: "write",
			args: { path: "xd://propose", content: "Approve the full internal plan payload" },
		});
		expect(proposal?.toolName).toBe("Plan proposed");
		const projected = proposal ? projectTimeline("work", [proposal])[0] : undefined;
		expect(projected?.toolName).toBe("Plan proposed");
		expect(JSON.stringify(projected)).not.toContain("Approve the full internal plan payload");
	});

	it("keeps raw hashline edit grammar out of activity previews and projects structured diffs", () => {
		const store = new TranscriptStore();
		const write = store.apply({
			type: "tool_execution_start",
			toolCallId: "write-1",
			toolName: "write",
			args: { path: "result.txt" },
		});
		const edit = store.apply({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: {
				input: "*** Begin Patch\n[src/one.ts#A1B2]\nPUT 1.=1:\n+one\n[src/two.ts#C3D4]\nPUT 1.=1:\n+two\n[src/one.ts#A1B2]\nPUT 2.=2:\n+again\n*** End Patch",
				patch: "*** Begin Patch\n[raw-patch.ts#A1B2]\nPUT 1.=1:\n+raw\n*** End Patch",
				diff: "--- a/raw-arg.ts\n+++ b/raw-arg.ts\n@@ -1 +1 @@\n-old\n+raw",
			},
		});
		const firstDiff = "--- a/src/one.ts\n+++ b/src/one.ts\n@@ -1 +1 @@\n-old\n+one";
		const secondDiff = "--- a/src/two.ts\n+++ b/src/two.ts\n@@ -1 +1 @@\n-old\n+two";
		const aggregateProgress = store.apply({
			type: "tool_execution_update",
			toolCallId: "edit-1",
			partialResult: {
				details: {
					diff: firstDiff,
					perFileResults: [{ path: "src/two.ts", diff: secondDiff }],
				},
			},
		});
		const completedEdit = store.apply({
			type: "tool_execution_end",
			toolCallId: "edit-1",
			result: {
				details: {
					diff: "",
					perFileResults: [
						{ path: "src/one.ts", diff: firstDiff },
						{ path: "src/two.ts", diff: secondDiff },
						{ path: "src/one.ts", diff: firstDiff },
					],
				},
			},
			isError: false,
		});
		const virtualWrite = store.apply({
			type: "tool_execution_start",
			toolCallId: "write-virtual",
			toolName: "write",
			args: { path: "xd://browser" },
		});

		expect(write?.files).toEqual([{ path: "result.txt", operation: "write" }]);
		expect(edit?.files).toEqual([
			{ path: "src/one.ts", operation: "edit" },
			{ path: "src/two.ts", operation: "edit" },
		]);
		expect(edit?.toolActivity).toEqual({
			operation: "edit",
			paths: ["src/one.ts", "src/two.ts"],
			diff: [],
		});
		expect(JSON.stringify(edit?.toolActivity)).not.toContain("*** Begin Patch");
		expect(JSON.stringify(edit?.toolActivity)).not.toContain("PUT");
		expect(aggregateProgress?.toolActivity).toEqual({
			operation: "edit",
			paths: ["src/one.ts", "src/two.ts"],
			diff: firstDiff.split("\n"),
		});
		expect(completedEdit?.toolActivity).toEqual({
			operation: "edit",
			paths: ["src/one.ts", "src/two.ts"],
			diff: `${firstDiff}\n${secondDiff}`.split("\n"),
		});
		expect(JSON.stringify(completedEdit?.toolActivity)).not.toContain("*** Begin Patch");
		expect(JSON.stringify(completedEdit?.toolActivity)).not.toContain("PUT");
		expect(virtualWrite?.files).toBeUndefined();
	});
	it("projects eval cells into bounded semantic previews with lazy-loadable details", () => {
		const store = new TranscriptStore();
		const longLine = "x".repeat(700);
		store.apply({
			type: "tool_execution_start",
			toolCallId: "eval-1",
			toolName: "eval",
			args: { language: "py", title: "analysis", code: "seed = 1" },
		});
		const completed = store.apply({
			type: "tool_execution_end",
			toolCallId: "eval-1",
			result: {
				details: {
					languages: ["python", "js"],
					cells: [
						{
							index: 0,
							title: "imports",
							language: "python",
							code: `import json\n${longLine}\nprint("ready")`,
							output: "ready\nline 2\nline 3\nline 4",
							status: "complete",
							durationMs: 125,
							statusEvents: [{ op: "phase", title: "imports" }],
						},
						{
							index: 1,
							title: "use",
							language: "js",
							code: "console.log('next')",
							output: "next",
							status: "error",
							durationMs: 75,
							exitCode: 1,
						},
					],
					jsonOutputs: [{ ok: true }],
					images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				},
			},
			isError: true,
		});

		expect(completed?.toolActivity).toMatchObject({
			operation: "eval",
			languages: ["python", "js"],
			title: "analysis",
			cellCount: 2,
			durationMs: 200,
			detailsLoaded: true,
		});
		if (completed?.toolActivity?.operation !== "eval") throw new Error("eval activity missing");
		expect(completed.toolActivity.codePreview.length).toBeLessThanOrEqual(6);
		expect(completed.toolActivity.outputPreview.length).toBeLessThanOrEqual(6);
		expect(completed.toolActivity.codePreview.every(line => line.length <= 512)).toBe(true);
		expect(completed.toolActivity.cells?.[0]?.code).toContain("print");
		expect(completed.toolActivity.cells?.[0]?.statusEvents?.[0]).toContain('"phase"');
		expect(completed.toolActivity.jsonOutputs?.[0]).toContain('"ok": true');
		expect(completed.toolActivity.images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
	});

	it("streams one stable reasoning item before the assistant answer", () => {
		const store = new TranscriptStore();
		expect(
			store.applyChanges({
				type: "message_start",
				message: { id: "reasoned-message", role: "assistant", content: [] },
			}),
		).toEqual([]);

		const first = store.applyChanges({
			type: "message_update",
			message: {
				id: "reasoned-message",
				role: "assistant",
				content: [{ type: "thinking", thinking: "Inspecting the failure." }],
			},
		});
		const second = store.applyChanges({
			type: "message_update",
			message: {
				id: "reasoned-message",
				role: "assistant",
				content: [{ type: "thinking", thinking: "Inspecting the failure.\nTracing the event." }],
			},
		});
		const complete = store.applyChanges({
			type: "message_end",
			message: {
				id: "reasoned-message",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspecting the failure.\nTracing the event." },
					{ type: "text", text: "The event is now projected." },
				],
			},
		});

		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ kind: "thinking", status: "running", text: "Inspecting the failure." });
		expect(second[0]?.id).toBe(first[0]?.id);
		expect(complete).toEqual([
			expect.objectContaining({ id: first[0]?.id, kind: "thinking", status: "complete" }),
			expect.objectContaining({ kind: "assistant", text: "The event is now projected." }),
		]);
		expect(store.snapshot.map(item => item.kind)).toEqual(["thinking", "assistant"]);
	});
	it("hides internal replay and live messages while preserving visible custom and status events", () => {
		const store = new TranscriptStore();
		store.load([
			{
				id: "replay-developer",
				role: "developer",
				content: [{ type: "text", text: "HIDDEN_REPLAY_DEVELOPER" }],
			},
			{
				id: "replay-custom",
				role: "custom",
				content: [{ type: "text", text: "HIDDEN_REPLAY_CUSTOM" }],
			},
			{
				id: "replay-hook",
				role: "hookMessage",
				content: [{ type: "text", text: "HIDDEN_REPLAY_HOOK" }],
			},
			{
				id: "replay-visible-custom",
				role: "custom",
				display: true,
				content: [{ type: "text", text: "VISIBLE_REPLAY_CUSTOM" }],
			},
		]);

		const replayText = store.snapshot.map(item => item.text ?? "").join("\n");
		expect(replayText).not.toContain("HIDDEN_REPLAY_DEVELOPER");
		expect(replayText).not.toContain("HIDDEN_REPLAY_CUSTOM");
		expect(replayText).not.toContain("HIDDEN_REPLAY_HOOK");
		expect(replayText).toContain("VISIBLE_REPLAY_CUSTOM");

		expect(
			store.applyChanges({
				type: "message_start",
				message: { id: "live-developer", role: "developer", content: "HIDDEN_LIVE_DEVELOPER" },
			}),
		).toEqual([]);
		expect(
			store.applyChanges({
				type: "message_update",
				message: { id: "live-custom", role: "custom", content: "HIDDEN_LIVE_CUSTOM" },
			}),
		).toEqual([]);
		expect(
			store.applyChanges({
				type: "message_end",
				message: { id: "live-hook", role: "hookMessage", content: "HIDDEN_LIVE_HOOK" },
			}),
		).toEqual([]);
		expect(
			store.applyChanges({
				type: "message_end",
				message: { id: "live-visible-custom", role: "custom", display: true, content: "VISIBLE_LIVE_CUSTOM" },
			}),
		).toMatchObject([{ kind: "special", text: "VISIBLE_LIVE_CUSTOM", presentation: { type: "custom" } }]);

		expect(store.applyChanges({ type: "todo_reminder", todos: ["internal"] })).toEqual([]);
		expect(store.applyChanges({ type: "todo_auto_clear", todos: [] })).toMatchObject([
			{ kind: "special", text: "Todos cleared", presentation: { type: "status", category: "todo" } },
		]);
		expect(store.applyChanges({ type: "future_event", payload: { stable: true } })).toMatchObject([
			{ kind: "raw", text: "Unrecognized event" },
		]);
		const liveText = store.snapshot.map(item => item.text ?? "").join("\n");
		expect(liveText).not.toContain("HIDDEN_LIVE_DEVELOPER");
		expect(liveText).not.toContain("HIDDEN_LIVE_CUSTOM");
		expect(liveText).not.toContain("HIDDEN_LIVE_HOOK");
		expect(liveText).toContain("VISIBLE_LIVE_CUSTOM");
		expect(liveText).not.toContain("Todo progress updated");
	});

	it("surfaces slash command output as a completed notice", () => {
		const store = new TranscriptStore();
		const item = store.apply({ type: "command_output", text: "Fixture status: ready" });

		expect(item).toMatchObject({
			kind: "special",
			status: "complete",
			text: "Fixture status: ready",
			presentation: { type: "status", category: "command" },
		});
		expect(store.snapshot).toContainEqual(item);
	});

	it("updates message text without duplicating the message item", () => {
		const store = new TranscriptStore();
		store.apply({ type: "message_start", message: { id: "m-1", role: "assistant", content: "one" } });
		store.apply({ type: "message_update", message: { id: "m-1", role: "assistant", content: "two" } });
		expect(store.snapshot.filter(item => item.kind === "assistant")).toHaveLength(1);
		expect(store.snapshot.find(item => item.kind === "assistant")?.text).toBe("two");
	});

	it("resolves duplicate user messages to chronological branch entries", () => {
		const store = new TranscriptStore();
		store.load([
			{ id: "user-a", role: "user", content: "repeat" },
			{ id: "assistant-a", role: "assistant", content: [{ type: "text", text: "first" }] },
			{ id: "user-b", role: "user", content: "repeat" },
		]);
		const selected = store.snapshot.findLast(item => item.role === "user");
		expect(selected).toBeDefined();
		expect(
			store.resolveBranchEntry(selected!.id, [
				{ entryId: "entry-a", text: "repeat" },
				{ entryId: "entry-b", text: "repeat" },
			]),
		).toEqual({ entryId: "entry-b", text: "repeat" });
	});
});

describe("semantic transcript projection", () => {
	it("uses IRC details for directional cards and converges live observations with message events", () => {
		const store = new TranscriptStore();
		const message = {
			role: "custom",
			customType: "irc:incoming",
			display: true,
			timestamp: 123,
			content: "<irc>MODEL_INSTRUCTION_SENTINEL</irc>",
			details: { id: "irc-1", from: "agent-a", message: "Actual IRC body\nwith a second line", replyTo: "root-1" },
		};

		const observed = store.apply({ type: "irc_message", message });
		const started = store.apply({ type: "message_start", message });
		const item = store.snapshot[0];

		expect(observed?.id).toBe(started?.id);
		expect(store.snapshot).toHaveLength(1);
		expect(item).toMatchObject({
			kind: "special",
			text: "Actual IRC body\nwith a second line",
			presentation: {
				type: "irc",
				direction: "incoming",
				from: "agent-a",
				reply: "root-1",
				previewLines: ["Actual IRC body", "with a second line"],
			},
		});
		expect(JSON.stringify(item)).not.toContain("MODEL_INSTRUCTION_SENTINEL");
	});

	it("unwraps whole system envelopes only for custom or synthetic messages", () => {
		const store = new TranscriptStore();
		store.load([
			{ role: "user", content: "Literal <system-notice>keep this tag</system-notice>" },
			{ role: "assistant", content: [{ type: "text", text: "Literal <irc>keep this tag</irc>" }] },
			{
				role: "user",
				synthetic: true,
				timestamp: 1,
				content: "<system-notice>Injected system body</system-notice>",
			},
			{
				role: "custom",
				customType: "extension-note",
				display: true,
				timestamp: 2,
				content: "<system-reminder>Visible custom body</system-reminder>",
			},
		]);

		const items = store.snapshot;
		expect(items[0]).toMatchObject({ kind: "user", text: "Literal <system-notice>keep this tag</system-notice>" });
		expect(items[0]?.presentation).toBeUndefined();
		expect(items[1]).toMatchObject({ kind: "assistant", text: "Literal <irc>keep this tag</irc>" });
		expect(items[1]?.presentation).toBeUndefined();
		expect(items[2]).toMatchObject({
			kind: "special",
			text: "Injected system body",
			presentation: { type: "custom", variant: "system" },
		});
		expect(items[3]).toMatchObject({
			kind: "special",
			text: "Visible custom body",
			presentation: { type: "custom", variant: "system" },
		});
	});

	it("preserves severity, source, activity metadata, and bounded omitted counts", () => {
		const store = new TranscriptStore();
		const notice = store.apply({
			type: "notice",
			level: "warning",
			source: "fixture-host",
			message: "Host needs attention",
		});
		const asyncResult = store.apply({
			type: "message_end",
			message: {
				role: "custom",
				customType: "async-result",
				display: true,
				timestamp: 10,
				content: "job output",
				details: {
					jobs: Array.from({ length: 14 }, (_, index) => ({
						jobId: `job-${index}`,
						type: "task",
						durationMs: index * 10,
					})),
				},
			},
		});
		const diagnostics = store.apply({
			type: "message_end",
			message: {
				role: "custom",
				customType: "lsp-late-diagnostic",
				display: true,
				timestamp: 11,
				content: "diagnostic output",
				details: {
					files: [{ path: "src/app.ts", summary: "Unused import", errored: false, messages: ["Unused import"] }],
				},
			},
		});
		const launch = store.apply({
			type: "message_end",
			message: {
				role: "custom",
				customType: "launch-completion",
				display: true,
				timestamp: 12,
				content: "server exited",
				details: { daemons: [{ name: "web", state: "exited", exitCode: 1 }] },
			},
		});
		const failedLaunch = store.apply({
			type: "message_end",
			message: {
				role: "custom",
				customType: "launch-completion",
				display: true,
				timestamp: 13,
				content: "server failed",
				details: { daemons: [{ name: "worker", state: "failed" }] },
			},
		});

		const fileMention = store.apply({
			type: "message_end",
			message: {
				role: "fileMention",
				timestamp: 13,
				files: [
					{ path: "src/app.ts", lineCount: 42 },
					{ path: "assets/icon.bin", skippedReason: "binary", byteSize: 8 },
				],
			},
		});

		expect(notice).toMatchObject({
			presentation: { type: "status", category: "notice", tone: "warning", source: "fixture-host" },
		});
		expect(asyncResult).toMatchObject({
			presentation: { type: "activity", category: "job", omittedCount: 2 },
		});
		expect(diagnostics).toMatchObject({
			presentation: {
				type: "activity",
				category: "diagnostics",
				entries: [{ label: "src/app.ts", status: "updated" }],
			},
		});
		expect(launch).toMatchObject({
			presentation: {
				type: "activity",
				category: "process",
				tone: "error",
				entries: [{ label: "web", status: "error" }],
			},
		});
		expect(failedLaunch).toMatchObject({
			presentation: {
				type: "activity",
				category: "process",
				tone: "error",
				entries: [{ label: "worker", status: "error" }],
			},
		});
		expect(fileMention?.presentation).toMatchObject({ type: "activity", category: "files" });
		expect(fileMention?.presentation?.type === "activity" ? fileMention.presentation.entries : []).toContainEqual(
			expect.objectContaining({ label: "src/app.ts", value: "42 lines", status: "read" }),
		);
	});

	it("projects context, execution, and file mentions as semantic replay items", () => {
		const store = new TranscriptStore();
		store.load([
			{ role: "branchSummary", summary: "Branch returned to main", fromId: "user-1", timestamp: 20 },
			{
				role: "compactionSummary",
				summary: "Old context was compacted",
				tokensBefore: 4_096,
				warning: "Progress guard",
				timestamp: 21,
			},
			{
				role: "custom",
				customType: "handoff",
				display: true,
				timestamp: 22,
				content: "<handoff-context>Carry this context forward</handoff-context>",
			},
			{
				role: "bashExecution",
				command: "printf ok",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 23,
			},
			{
				role: "pythonExecution",
				code: "print(1)",
				output: "1",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 24,
			},
			{ role: "fileMention", files: [{ path: "README.md", lineCount: 12, content: "body" }], timestamp: 25 },
		]);

		expect(store.snapshot.map(item => item.presentation?.type)).toEqual([
			"context",
			"context",
			"context",
			"execution",
			"execution",
			"activity",
		]);
		expect(store.snapshot[0]).toMatchObject({
			text: "Branch returned to main",
			createdAt: 20,
			presentation: { transition: "branch" },
		});
		expect(store.snapshot[1]).toMatchObject({
			text: "Old context was compacted",
			presentation: { transition: "compaction", tokenCount: 4_096, warning: "Progress guard" },
		});
		expect(store.snapshot[2]).toMatchObject({
			text: "Carry this context forward",
			presentation: { transition: "handoff" },
		});
		expect(store.snapshot[3]).toMatchObject({
			text: "ok",
			presentation: { type: "execution", engine: "bash", state: "complete" },
		});
		expect(store.snapshot[5]).toMatchObject({ text: "README.md", presentation: { category: "files" } });
	});

	it("surfaces provider errors, keeps recovered retries subdued, and hides superseded or aborted turns", () => {
		const store = new TranscriptStore();
		const error = store.apply({
			type: "message_end",
			message: {
				id: "error-turn",
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "Provider rejected the request",
				timestamp: 30,
			},
		});
		const recovered = store.apply({
			type: "message_end",
			message: {
				id: "recovered-turn",
				role: "assistant",
				content: [],
				stopReason: "stop",
				retryRecovery: {
					kind: "auto-retry",
					status: "recovered",
					attempt: 2,
					recoveredAt: "now",
					recovery: "wait",
					note: "Recovered after waiting",
				},
				timestamp: 31,
			},
		});
		const before = store.snapshot.length;
		const superseded = store.apply({
			type: "message_end",
			message: {
				id: "superseded-turn",
				role: "assistant",
				content: [],
				stopReason: "error",
				retryRecovery: {
					kind: "auto-retry",
					status: "superseded",
					attempt: 1,
					recovery: "plain",
					note: "Superseded",
				},
				timestamp: 32,
			},
		});
		const aborted = store.apply({
			type: "message_end",
			message: { id: "aborted-turn", role: "assistant", content: [], stopReason: "aborted", timestamp: 33 },
		});

		expect(error).toMatchObject({
			kind: "assistant",
			isError: true,
			presentation: { type: "assistant-outcome", mode: "error" },
			detail: "Provider rejected the request",
		});
		expect(recovered).toMatchObject({
			kind: "assistant",
			presentation: { type: "assistant-outcome", mode: "recovered" },
		});
		expect(superseded).toEqual(undefined);
		expect(aborted).toEqual(undefined);
		expect(store.snapshot).toHaveLength(before);
	});

	it("drops known control events while retaining an explicit raw row for unknown events", () => {
		const store = new TranscriptStore();
		expect(
			store.applyChanges({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 2,
				delayMs: 50,
				errorMessage: "retry",
			}),
		).toEqual([]);
		expect(store.applyChanges({ type: "auto_compaction_start", reason: "threshold", action: "handoff" })).toEqual([]);
		expect(store.applyChanges({ type: "auto_compaction_end", aborted: false, willRetry: false })).toEqual([]);
		expect(store.applyChanges({ type: "todo_reminder", todos: [] })).toEqual([]);
		expect(store.applyChanges({ type: "goal_updated", goal: null })).toEqual([]);
		expect(store.applyChanges({ type: "future_event", payload: { stable: true } })).toMatchObject([
			{ kind: "raw", text: "Unrecognized event" },
		]);
	});
});

describe("audience projections", () => {
	const items: TimelineItem[] = [
		{
			id: "write-ok",
			kind: "tool",
			text: "write",
			toolName: "write",
			args: { path: "result.txt" },
			files: [{ path: "result.txt", operation: "write" }],
			status: "complete",
		},
		{
			id: "edit-ok",
			kind: "tool",
			text: "edit",
			toolName: "edit",
			files: [
				{ path: "src/one.ts", operation: "edit" },
				{ path: "result.txt", operation: "edit" },
			],
			status: "complete",
		},
		{
			id: "edit-error",
			kind: "tool",
			text: "edit",
			toolName: "edit",
			files: [{ path: "bad.txt", operation: "edit" }],
			status: "error",
			isError: true,
		},
		{
			id: "bash",
			kind: "tool",
			text: "bash",
			toolName: "bash",
			args: { path: "not-an-artifact" },
			status: "complete",
		},
	];

	it("lists each successfully changed workspace file once, newest first", () => {
		expect(changedFiles(items)).toEqual([
			{ path: "result.txt", operation: "edit" },
			{ path: "src/one.ts", operation: "edit" },
		]);
	});

	it("removes tool payloads from Work projection but keeps file metadata and Code details", () => {
		expect(projectTimeline("work", items)[0]).toMatchObject({
			id: "write-ok",
			args: undefined,
			result: undefined,
			files: [{ path: "result.txt", operation: "write" }],
		});
		expect(projectTimeline("code", items)[0].args).toEqual({ path: "result.txt" });
	});

	it("preserves semantic presentation in both Work and Code projections", () => {
		const semantic: TimelineItem = {
			id: "semantic",
			kind: "special",
			text: "Notice body",
			presentation: { type: "status", category: "notice", tone: "warning", title: "Notice" },
		};
		expect(projectTimeline("work", [semantic])).toEqual([semantic]);
		expect(projectTimeline("code", [semantic])).toEqual([semantic]);
	});
});

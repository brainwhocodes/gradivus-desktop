import { describe, expect, it } from "vitest";
import { projectTurnFileSummaries, turnFileKind } from "../src/renderer/turn-file-summary";
import type { TimelineItem } from "../src/shared/contracts";

describe("turn file summary projection", () => {
	it("deduplicates repeated changes and keeps the most truthful turn-level disposition", () => {
		const summaries = projectTurnFileSummaries([
			{ id: "user-1", kind: "user", text: "Build it" },
			{
				id: "write-1",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "src/new-panel.ts", operation: "write", disposition: "created" }],
			},
			{
				id: "edit-1",
				kind: "tool",
				text: "edit",
				status: "complete",
				files: [{ path: "src/new-panel.ts", operation: "edit", disposition: "edited" }],
			},
			{
				id: "write-2",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "src/new-panel.ts", operation: "write" }],
			},
			{ id: "assistant-1", kind: "assistant", text: "Done", status: "complete" },
		]);

		expect(summaries.get("assistant-1")).toEqual({
			assistantItemId: "assistant-1",
			outcome: "complete",
			files: [{ path: "src/new-panel.ts", disposition: "created", kind: "document" }],
		});
	});

	it("keys independent summaries to each completed assistant item in timeline order", () => {
		const summaries = projectTurnFileSummaries([
			{ id: "user-1", kind: "user", text: "First" },
			{ id: "assistant-tool-call", kind: "assistant", text: "", status: "complete" },
			{
				id: "edit-1",
				kind: "tool",
				text: "edit",
				status: "complete",
				files: [{ path: "src/shared.ts", operation: "edit" }],
			},
			{ id: "assistant-1", kind: "assistant", text: "First done", status: "complete" },
			{ id: "user-2", kind: "user", text: "Second" },
			{
				id: "write-2",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "src/shared.ts", operation: "write", disposition: "edited" }],
			},
			{ id: "assistant-2", kind: "assistant", text: "Second done", status: "complete" },
		]);

		expect(Array.from(summaries.keys())).toEqual(["assistant-1", "assistant-2"]);
		expect(summaries.get("assistant-1")?.files).toEqual([
			{ path: "src/shared.ts", disposition: "edited", kind: "document" },
		]);
		expect(summaries.get("assistant-2")?.files).toEqual([
			{ path: "src/shared.ts", disposition: "edited", kind: "document" },
		]);
	});

	it("excludes failed and running file changes", () => {
		const summaries = projectTurnFileSummaries([
			{ id: "user", kind: "user", text: "Change files" },
			{
				id: "failed",
				kind: "tool",
				text: "edit",
				status: "error",
				isError: true,
				files: [{ path: "failed.ts", operation: "edit" }],
			},
			{
				id: "running",
				kind: "tool",
				text: "write",
				status: "running",
				files: [{ path: "running.ts", operation: "write", disposition: "created" }],
			},
			{
				id: "complete-error",
				kind: "tool",
				text: "write",
				status: "complete",
				isError: true,
				files: [{ path: "also-failed.ts", operation: "write" }],
			},
			{ id: "assistant", kind: "assistant", text: "Could not change them", status: "complete" },
		]);

		expect(summaries.size).toBe(0);
	});

	it("labels historical writes without disposition as Written", () => {
		const summaries = projectTurnFileSummaries([
			{
				id: "historical-write",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "public/preview.PNG", operation: "write" }],
			},
			{ id: "historical-assistant", kind: "assistant", text: "Done" },
		]);

		expect(summaries.get("historical-assistant")?.files).toEqual([
			{ path: "public/preview.PNG", disposition: "written", kind: "image" },
		]);
	});

	it("keeps durable changes visible when a turn ends in an error or cancellation", () => {
		const cancelledAssistant = {
			id: "assistant-cancelled",
			kind: "assistant",
			text: "",
			status: "cancelled",
		} as unknown as TimelineItem;
		const summaries = projectTurnFileSummaries([
			{
				id: "write-before-error",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "kept-error.txt", operation: "write", disposition: "created" }],
			},
			{
				id: "assistant-error",
				kind: "assistant",
				text: "",
				status: "complete",
				isError: true,
				presentation: {
					type: "assistant-outcome",
					mode: "error",
					tone: "error",
					label: "Provider error",
					previewLines: [],
				},
			},
			{ id: "user-2", kind: "user", text: "Try another" },
			{
				id: "write-before-cancel",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "kept-cancelled.txt", operation: "write" }],
			},
			cancelledAssistant,
		]);

		expect(summaries.get("assistant-error")?.outcome).toBe("error");
		expect(summaries.get("assistant-error")?.files[0]?.path).toBe("kept-error.txt");
		expect(summaries.get("assistant-cancelled")?.outcome).toBe("cancelled");
		expect(summaries.get("assistant-cancelled")?.files[0]?.path).toBe("kept-cancelled.txt");
	});

	it("does not emit empty, running, or abandoned turn summaries", () => {
		const summaries = projectTurnFileSummaries([
			{ id: "user-1", kind: "user", text: "No change" },
			{ id: "assistant-1", kind: "assistant", text: "No files", status: "complete" },
			{ id: "user-2", kind: "user", text: "Start one" },
			{
				id: "write",
				kind: "tool",
				text: "write",
				status: "complete",
				files: [{ path: "not-yet-summarized.txt", operation: "write" }],
			},
			{ id: "assistant-running", kind: "assistant", text: "Working", status: "running" },
			{ id: "user-3", kind: "user", text: "Cancel and move on" },
			{ id: "assistant-3", kind: "assistant", text: "No files", status: "complete" },
		]);

		expect(summaries.size).toBe(0);
	});
});

describe("turn file kind", () => {
	it("uses broad image and document categories", () => {
		expect(turnFileKind("screens/hero.webp")).toBe("image");
		expect(turnFileKind("screens\\hero.JPEG")).toBe("image");
		expect(turnFileKind("src/image-component.ts")).toBe("document");
	});
});

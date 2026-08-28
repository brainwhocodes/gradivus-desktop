import type { TimelineFileChange, TimelineItem } from "../shared/contracts";

export type TurnFileDisposition = "created" | "edited" | "written";
export type TurnFileKind = "document" | "image";
export type TurnFileSummaryOutcome = "complete" | "error" | "cancelled";

export interface TurnFileSummaryEntry {
	path: string;
	disposition: TurnFileDisposition;
	kind: TurnFileKind;
}

export interface TurnFileSummary {
	assistantItemId: string;
	outcome: TurnFileSummaryOutcome;
	files: TurnFileSummaryEntry[];
}

type FileChangeWithDisposition = TimelineFileChange & {
	disposition?: "created" | "edited";
};

type TimelineItemWithFileDisposition = Omit<TimelineItem, "files"> & {
	files?: FileChangeWithDisposition[];
};

const IMAGE_EXTENSIONS: Record<string, true> = {
	gif: true,
	jpeg: true,
	jpg: true,
	png: true,
	webp: true,
};
const DISPOSITION_PRIORITY: Record<TurnFileDisposition, number> = {
	written: 0,
	edited: 1,
	created: 2,
};

export function turnFileKind(path: string): TurnFileKind {
	const basename = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
	const extension = basename.includes(".") ? (basename.split(".").at(-1) ?? "").toLowerCase() : "";
	return IMAGE_EXTENSIONS[extension] === true ? "image" : "document";
}

function dispositionFor(change: FileChangeWithDisposition): TurnFileDisposition {
	if (change.disposition === "created") return "created";
	if (change.disposition === "edited" || change.operation === "edit") return "edited";
	return "written";
}

function terminalAssistantOutcome(item: TimelineItem): TurnFileSummaryOutcome | undefined {
	if (item.kind !== "assistant") return undefined;
	const status: string | undefined = item.status;
	if (status === "running") return undefined;
	if (status === "cancelled") return "cancelled";
	if (
		status === "error" ||
		item.isError === true ||
		(item.presentation?.type === "assistant-outcome" && item.presentation.mode === "error")
	) {
		return "error";
	}
	return "complete";
}

function recordSuccessfulChanges(
	pending: Map<string, TurnFileSummaryEntry>,
	item: TimelineItemWithFileDisposition,
): void {
	if (item.status !== "complete" || item.isError === true || !item.files) return;
	for (const change of item.files) {
		const disposition = dispositionFor(change);
		const existing = pending.get(change.path);
		if (!existing) {
			pending.set(change.path, {
				path: change.path,
				disposition,
				kind: turnFileKind(change.path),
			});
			continue;
		}
		if (DISPOSITION_PRIORITY[disposition] > DISPOSITION_PRIORITY[existing.disposition]) {
			existing.disposition = disposition;
		}
	}
}

/**
 * Projects successful file changes onto the terminal assistant item for each turn.
 * Entries remain in first-change timeline order while their disposition is upgraded
 * when later changes provide more specific information.
 */
export function projectTurnFileSummaries(
	items: readonly TimelineItemWithFileDisposition[],
): ReadonlyMap<string, TurnFileSummary> {
	const summaries = new Map<string, TurnFileSummary>();
	const pending = new Map<string, TurnFileSummaryEntry>();

	for (const item of items) {
		if (item.kind === "user") pending.clear();
		recordSuccessfulChanges(pending, item);

		const outcome = terminalAssistantOutcome(item);
		if (!outcome) continue;
		if (pending.size > 0) {
			summaries.set(item.id, {
				assistantItemId: item.id,
				outcome,
				files: Array.from(pending.values(), file => ({ ...file })),
			});
		}
		pending.clear();
	}

	return summaries;
}

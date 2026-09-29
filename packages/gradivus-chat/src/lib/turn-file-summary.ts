import type { HostedTimelineFileChange as TimelineFileChange } from "./contracts";
import { workspaceFileKind, type WorkspaceFileKind } from "./workspace-file-types";

export type TurnFileDisposition = "created" | "edited" | "written" | "generated";
export type TurnFileSummaryOutcome = "complete" | "error" | "cancelled";

export interface TurnFileSummaryEntry {
	path: string;
	disposition: TurnFileDisposition;
	kind: WorkspaceFileKind;
}

export interface TurnFileSummary {
	assistantItemId: string;
	outcome: TurnFileSummaryOutcome;
	files: TurnFileSummaryEntry[];
}

type FileChangeWithDisposition = TimelineFileChange & {
	disposition?: "created" | "edited";
};

interface TimelineItemWithFileDisposition {
	id: string;
	kind: string;
	status?: string;
	isError?: boolean;
	presentation?: { type: string; mode?: string };
	files?: FileChangeWithDisposition[];
}

function timelineProjectionInput(value: unknown): TimelineItemWithFileDisposition | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.id !== "string" || typeof record.kind !== "string") return undefined;
	const files = Array.isArray(record.files)
		? record.files.flatMap((file): FileChangeWithDisposition[] => {
				if (typeof file !== "object" || file === null) return [];
				const candidate = file as Record<string, unknown>;
				if (
					typeof candidate.path !== "string" ||
					(candidate.operation !== "write" && candidate.operation !== "edit" && candidate.operation !== "generate")
				) {
					return [];
				}
				return [
					{
						path: candidate.path,
						operation: candidate.operation,
						disposition:
							candidate.disposition === "created" || candidate.disposition === "edited"
								? candidate.disposition
								: undefined,
					},
				];
			})
		: undefined;
	const rawPresentation =
		typeof record.presentation === "object" && record.presentation !== null
			? (record.presentation as Record<string, unknown>)
			: undefined;
	return {
		id: record.id,
		kind: record.kind,
		status: typeof record.status === "string" ? record.status : undefined,
		isError: typeof record.isError === "boolean" ? record.isError : undefined,
		presentation:
			rawPresentation && typeof rawPresentation.type === "string"
				? {
						type: rawPresentation.type,
						mode: typeof rawPresentation.mode === "string" ? rawPresentation.mode : undefined,
					}
				: undefined,
		files,
	};
}

const DISPOSITION_PRIORITY: Record<TurnFileDisposition, number> = {
	written: 0,
	edited: 1,
	created: 2,
	generated: 3,
};

function dispositionFor(change: FileChangeWithDisposition): TurnFileDisposition {
	if (change.operation === "generate") return "generated";
	if (change.disposition === "created") return "created";
	if (change.disposition === "edited" || change.operation === "edit") return "edited";
	return "written";
}

function terminalAssistantOutcome(item: TimelineItemWithFileDisposition): TurnFileSummaryOutcome | undefined {
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
				kind: workspaceFileKind(change.path),
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
export function projectTurnFileSummaries(items: readonly unknown[]): ReadonlyMap<string, TurnFileSummary> {
	const summaries = new Map<string, TurnFileSummary>();
	const pending = new Map<string, TurnFileSummaryEntry>();
	for (const candidate of items) {
		const item = timelineProjectionInput(candidate);
		if (!item) continue;
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

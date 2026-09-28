import type { HostedSessionKind as SessionKind, HostedTimelineFileChange as TimelineFileChange } from "./contracts";

interface TimelineProjectionItem {
	kind: string;
	toolName?: string;
	detail?: string;
	args?: unknown;
	result?: unknown;
}

interface FileProjectionItem {
	status?: string;
	isError?: boolean;
	files?: TimelineFileChange[];
}

export function projectTimeline<Item extends TimelineProjectionItem>(
	kind: SessionKind,
	items: readonly Item[],
): Item[] {
	if (kind === "code") return [...items];
	return items.map(item => {
		if (item.kind !== "tool") return item;
		return {
			...item,
			args: undefined,
			result: undefined,
			detail: item.toolName === "generate_image" ? item.detail : undefined,
		} as Item;
	});
}

export function changedFiles<Item extends FileProjectionItem>(items: readonly Item[]): TimelineFileChange[] {
	const latestByPath = new Map<string, TimelineFileChange>();
	for (const item of items) {
		if (item.status !== "complete" || item.isError === true || !item.files) continue;
		for (const file of item.files) {
			latestByPath.delete(file.path);
			latestByPath.set(file.path, file);
		}
	}
	return Array.from(latestByPath.values()).reverse();
}

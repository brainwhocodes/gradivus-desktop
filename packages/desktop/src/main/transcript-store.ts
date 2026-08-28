import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type {
	FileChangeDisposition,
	TimelineFileChange,
	TimelineImage,
	TimelineItem,
	TimelineToolActivity,
} from "../shared/contracts";
import { promptAttachmentDisplayText } from "./prompt-attachments";
import { presentAssistantOutcome, presentEvent, presentMessage, stableMessageKey } from "./transcript-presentation";

export class TranscriptStore {
	#items: TimelineItem[] = [];
	#toolById = new Map<string, TimelineItem>();
	#messageById = new Map<string, TimelineItem>();
	#thinkingByMessage = new Map<string, TimelineItem>();
	#sequence = 0;

	load(messages: readonly unknown[]): void {
		this.#items = [];
		this.#toolById.clear();
		this.#messageById.clear();
		this.#thinkingByMessage.clear();
		for (const message of messages) this.#appendMessage(message);
	}

	get size(): number {
		return this.#items.length;
	}
	get snapshot(): TimelineItem[] {
		return this.#items.map(item => ({ ...item }));
	}

	page(start: number, limit: number): TimelineItem[] {
		return this.#items.slice(start, start + limit);
	}

	find(id: string): TimelineItem | undefined {
		const item = this.#items.find(candidate => candidate.id === id);
		return item ? { ...item } : undefined;
	}

	setWriteDisposition(toolCallId: string, disposition: FileChangeDisposition): TimelineItem | undefined {
		const item = this.#toolById.get(toolCallId);
		if (!item?.files) return undefined;
		let changed = false;
		const files = item.files.map(file => {
			if (file.operation !== "write" || file.disposition === disposition) return file;
			changed = true;
			return { ...file, disposition };
		});
		if (!changed) return { ...item };
		item.files = files;
		return { ...item };
	}

	apply(event: unknown): TimelineItem | undefined {
		return this.applyChanges(event).at(-1);
	}

	applyChanges(event: unknown): TimelineItem[] {
		if (typeof event !== "object" || event === null || !("type" in event)) return [this.#appendRaw(event)];
		const frame = event as Record<string, unknown>;
		const type = typeof frame.type === "string" ? frame.type : "unknown";
		if (type === "irc_message" && frame.message !== undefined) {
			return this.#upsertMessage(frame.message, true);
		}
		if (
			(type === "message_start" || type === "message_update" || type === "message_end") &&
			frame.message !== undefined
		) {
			return this.#upsertMessage(frame.message, type === "message_end");
		}
		if (type === "message_delta" || type === "text_delta" || type === "delta") {
			const deltaText =
				typeof frame.delta === "string" ? frame.delta : typeof frame.text === "string" ? frame.text : "";
			if (deltaText) {
				let last = this.#items.findLast(item => item.role === "assistant" || item.kind === "assistant");
				if (!last || last.status === "complete") {
					last = {
						id: this.#nextId(),
						kind: "assistant",
						role: "assistant",
						text: deltaText,
						status: "running",
						createdAt: Date.now(),
					};
					this.#items.push(last);
				} else {
					last.text = (last.text || "") + deltaText;
					last.status = "running";
				}
				return [{ ...last }];
			}
		}
		if (type === "thinking" || type === "thinking_delta") {
			const deltaText =
				typeof frame.delta === "string"
					? frame.delta
					: typeof frame.text === "string"
						? frame.text
						: typeof frame.thinking === "string"
							? frame.thinking
							: "";
			if (deltaText) {
				let last = this.#items.findLast(item => item.kind === "thinking" && item.status === "running");
				if (!last) {
					last = {
						id: this.#nextId(),
						kind: "thinking",
						role: "assistant",
						text: deltaText,
						status: "running",
						createdAt: Date.now(),
					};
					this.#items.push(last);
				} else {
					last.text = (last.text || "") + deltaText;
				}
				return [{ ...last }];
			}
		}
		if (type === "tool_execution_start") {
			const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
			const toolName = normalizeToolName(frame.toolName, frame.args);
			let item = toolCallId ? this.#toolById.get(toolCallId) : undefined;
			if (!item) {
				item = {
					id: this.#nextId(),
					kind: "tool",
					text: toolName ?? "Tool",
					toolName,
					toolCallId,
					args: frame.args,
					files: extractFileChanges(toolName, frame.args),
					toolActivity: extractToolActivity(toolName, frame.args),
					status: "running",
				};
				this.#items.push(item);
				if (toolCallId) this.#toolById.set(toolCallId, item);
			} else {
				item.text = toolName ?? item.text;
				item.toolName = toolName ?? item.toolName;
				item.args = frame.args;
				item.files = extractFileChanges(item.toolName, frame.args);
				item.toolActivity = extractToolActivity(item.toolName, frame.args);
				item.status = "running";
				delete item.isError;
			}
			return [{ ...item }];
		}
		if (type === "tool_execution_update") {
			const toolId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
			const item = toolId ? this.#toolById.get(toolId) : undefined;
			if (item) {
				const images = extractImages(frame.partialResult);
				if (images.length > 0) item.images = images;
				item.detail = formatToolDetail(item.toolName, frame.partialResult);
				item.result = frame.partialResult;
				const activity = extractToolActivity(item.toolName, item.args, frame.partialResult);
				if (activity) item.toolActivity = activity;
				return [{ ...item }];
			}
		}
		if (type === "tool_execution_end") {
			const toolId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
			const item = toolId ? this.#toolById.get(toolId) : undefined;
			if (item) {
				item.status = frame.isError === true ? "error" : "complete";
				item.isError = frame.isError === true;
				item.result = frame.result;
				const images = extractImages(frame.result);
				if (images.length > 0) item.images = images;
				item.detail = formatToolDetail(item.toolName, frame.result);
				const activity = extractToolActivity(item.toolName, item.args, frame.result);
				if (activity) item.toolActivity = activity;
				return [{ ...item }];
			}
		}
		const eventPresentation = presentEvent(event);
		if (eventPresentation?.hidden) return [];
		if (eventPresentation) {
			const item: TimelineItem = {
				id: this.#nextId(),
				kind: eventPresentation.kind ?? "special",
				text: eventPresentation.text,
				...(eventPresentation.status ? { status: eventPresentation.status } : {}),
				...(eventPresentation.isError ? { isError: true } : {}),
				...(eventPresentation.detail ? { detail: eventPresentation.detail } : {}),
				...(eventPresentation.presentation ? { presentation: eventPresentation.presentation } : {}),
			};
			this.#items.push(item);
			return [item];
		}
		if (type === "todo_reminder") return [];
		if (
			type === "agent_start" ||
			type === "agent_end" ||
			type === "turn_start" ||
			type === "turn_end" ||
			type === "prompt_result"
		)
			return [];
		return [this.#appendRaw(event)];
	}

	#appendMessage(value: unknown): TimelineItem | undefined {
		if (typeof value !== "object" || value === null) return undefined;
		const message = value as Record<string, unknown>;
		if (message.role === "toolResult") {
			const toolId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
			const item = toolId ? this.#toolById.get(toolId) : undefined;
			if (item) {
				item.status = message.isError === true ? "error" : "complete";
				item.isError = message.isError === true;
				item.result = message;
				const images = extractImages(message);
				if (images.length > 0) item.images = images;
				item.detail = formatToolDetail(item.toolName, message.content);
				const activity = extractToolActivity(item.toolName, item.args, message);
				if (activity) item.toolActivity = activity;
			}
			return item;
		}
		return this.#upsertMessage(value, true).at(-1);
	}

	#upsertMessage(value: unknown, complete: boolean): TimelineItem[] {
		if (!isVisibleMessage(value)) return [];
		if (typeof value !== "object" || value === null) return [];
		const message = value as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "unknown";
		if (role === "toolResult") {
			const result = this.#appendMessage(value);
			return result ? [{ ...result }] : [];
		}
		const projection = presentMessage(message);
		if (projection.hidden) return [];
		const key = stableMessageKey(message);
		const text = role === "user" ? promptAttachmentDisplayText(projection.text) : projection.text;
		const content = Array.isArray(message.content) ? message.content : [];
		const thinkingParts: string[] = [];
		const toolCalls: Record<string, unknown>[] = [];
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
				thinkingParts.push(block.thinking);
			}
			if (block.type === "toolCall" && typeof block.id === "string") toolCalls.push(block);
		}

		const changes: TimelineItem[] = [];
		const thinkingText = thinkingParts.join("\n\n");
		let thinking = this.#thinkingByMessage.get(key);
		if (thinkingText.length > 0) {
			if (!thinking) {
				thinking = {
					id: this.#nextId(),
					kind: "thinking",
					text: thinkingText,
					status: complete ? "complete" : "running",
				};
				this.#items.push(thinking);
				this.#thinkingByMessage.set(key, thinking);
			} else {
				thinking.text = thinkingText;
				thinking.status = complete ? "complete" : "running";
			}
			changes.push({ ...thinking });
		} else if (complete && thinking) {
			thinking.status = "complete";
			changes.push({ ...thinking });
		}

		const outcome = role === "assistant" ? presentAssistantOutcome(message) : undefined;
		const shouldCreate = role !== "assistant" || text.length > 0 || outcome !== undefined;
		let item = this.#messageById.get(key);
		if (!item && shouldCreate) {
			if (role === "assistant") {
				const running = this.#items.findLast(i => i.role === "assistant" && i.status === "running");
				if (running) {
					item = running;
					this.#messageById.set(key, item);
				}
			}
			if (!item) {
				item = {
					id: this.#nextId(),
					kind: projection.kind,
					text,
					role,
					...(typeof message.timestamp === "string" ? { timestamp: message.timestamp } : {}),
					...(typeof message.timestamp === "number" ? { createdAt: message.timestamp } : {}),
					...(role === "assistant" ? { status: complete ? "complete" : "running" } : {}),
					...(projection.presentation ? { presentation: projection.presentation } : {}),
				};
				this.#items.push(item);
				this.#messageById.set(key, item);
			}
		}
		if (item) {
			item.kind = projection.kind;
			if (text.length > 0 || item.text.length === 0) item.text = text;
			item.role = role;
			if (typeof message.timestamp === "string") item.timestamp = message.timestamp;
			if (typeof message.timestamp === "number") item.createdAt = message.timestamp;
			if (role === "assistant") {
				item.status = complete ? "complete" : "running";
				if (outcome?.type === "assistant-outcome" && outcome.mode === "error") {
					item.isError = true;
					item.detail = typeof message.errorMessage === "string" ? message.errorMessage : item.detail;
				} else {
					delete item.isError;
					if (outcome === undefined) delete item.detail;
				}
			}
			if (projection.presentation) item.presentation = projection.presentation;
			else if (role === "assistant" && outcome === undefined) delete item.presentation;
			if (outcome) item.presentation = outcome;
			changes.push({ ...item });
		}

		for (const candidate of toolCalls) {
			const toolCallId = candidate.id as string;
			const toolName = normalizeToolName(candidate.name, candidate.arguments);
			let tool = this.#toolById.get(toolCallId);
			if (!tool) {
				tool = {
					id: this.#nextId(),
					kind: "tool",
					text: toolName ?? "Tool",
					toolName,
					toolCallId,
					args: candidate.arguments,
					files: extractFileChanges(toolName, candidate.arguments),
					toolActivity: extractToolActivity(toolName, candidate.arguments),
					status: "running",
				};
				this.#items.push(tool);
				this.#toolById.set(toolCallId, tool);
			} else {
				tool.text = toolName ?? tool.text;
				tool.toolName = toolName ?? tool.toolName;
				tool.args = candidate.arguments;
				tool.files = extractFileChanges(tool.toolName, candidate.arguments);
				tool.toolActivity = extractToolActivity(tool.toolName, candidate.arguments);
			}
			changes.push({ ...tool });
		}
		return changes;
	}

	#appendRaw(value: unknown): TimelineItem {
		const item: TimelineItem = {
			id: this.#nextId(),
			kind: "raw",
			text: "Unrecognized event",
			detail: formatValue(value),
		};
		this.#items.push(item);
		return item;
	}

	#nextId(): string {
		this.#sequence += 1;
		return `timeline-${this.#sequence}`;
	}
}

function isVisibleMessage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.role === "developer") return false;
	return (value.role !== "custom" && value.role !== "hookMessage") || value.display === true;
}

function extractText(value: unknown): string {
	const record = isRecord(value) ? value : undefined;
	const blocks = Array.isArray(value) ? value : record && "content" in record ? record.content : undefined;
	if (!Array.isArray(blocks)) return typeof value === "string" ? value : "";
	return blocks
		.map(block => {
			if (!isRecord(block)) return "";
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}
function normalizeToolName(value: unknown, args: unknown): string | undefined {
	const name = typeof value === "string" ? value : undefined;
	if (name !== "write" || !isRecord(args) || args.path !== "xd://generate_image") return name;
	return "generate_image";
}
function extractFileChanges(toolName: string | undefined, args: unknown): TimelineFileChange[] | undefined {
	if (!isRecord(args)) return undefined;
	if (toolName === "write") {
		const target = workspacePath(args.path);
		return target ? [{ path: target, operation: "write" }] : undefined;
	}
	if (toolName !== "edit" || typeof args.input !== "string") return undefined;

	const files: TimelineFileChange[] = [];
	const seen = new Set<string>();
	for (const match of args.input.matchAll(/^\[([^#\r\n]+)#[0-9A-F]{4}\]$/gim)) {
		const target = workspacePath(match[1]);
		if (!target || seen.has(target)) continue;
		seen.add(target);
		files.push({ path: target, operation: "edit" });
	}
	return files.length > 0 ? files : undefined;
}

function workspacePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const target = value.trim();
	if (
		!target ||
		target.length > MAX_ACTIVITY_PATH ||
		/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ||
		/^(?:data|file|blob|mailto|http|https|ftp|memory|skill|artifact|xd):/i.test(target)
	)
		return undefined;
	return target;
}
function formatToolDetail(toolName: string | undefined, value: unknown): string {
	if (toolName === "generate_image") return extractText(value) || formatValue(value);
	return formatValue(value);
}
const MAX_ACTIVITY_PATH = 1_024;
const MAX_ACTIVITY_LINE = 512;
const MAX_READ_PREVIEW_LINES = 12;
const MAX_EDIT_DIFF_LINES = 40;

function extractToolActivity(
	toolName: string | undefined,
	args: unknown,
	result?: unknown,
): TimelineToolActivity | undefined {
	if (toolName === "read" && isRecord(args)) {
		const readTarget = splitReadPath(args.path);
		if (!readTarget) return undefined;
		const previewText = readPreviewText(result);
		const expandedPreview = boundedLines(previewText, MAX_READ_PREVIEW_LINES);
		const range = boundedScalar(args.range ?? args.selector, 128) ?? readTarget.range ?? readRange(args);
		const count = boundedCount(args.count ?? args.lineCount ?? args.lines) ?? readResultCount(result);
		return {
			operation: "read",
			path: readTarget.path,
			...(range ? { range } : {}),
			...(count === undefined ? {} : { count }),
			preview: expandedPreview.slice(0, 3),
			expandedPreview,
		};
	}
	if (toolName === "write" && isRecord(args)) {
		const path = workspacePath(args.path);
		if (!path) return undefined;
		return {
			operation: "write",
			path,
			preview: boundedLines(typeof args.content === "string" ? args.content : "", MAX_READ_PREVIEW_LINES),
		};
	}
	if (toolName === "edit" && isRecord(args)) {
		const files = extractFileChanges(toolName, args);
		const paths = files?.slice(0, MAX_EDIT_DIFF_LINES).map(file => file.path) ?? extractLocalPaths(args.paths);
		if (paths.length === 0) return undefined;
		const source =
			typeof args.input === "string"
				? args.input
				: typeof args.patch === "string"
					? args.patch
					: typeof args.diff === "string"
						? args.diff
						: "";
		return { operation: "edit", paths, diff: boundedLines(source, MAX_EDIT_DIFF_LINES) };
	}
	if (toolName === "hub" && isRecord(args)) {
		const operationName = boundedScalar(args.op, 64);
		if (!operationName) return undefined;
		const target = boundedScalar(args.to ?? args.name, 256);
		return { operation: "hub", operationName, ...(target ? { target } : {}) };
	}
	return undefined;
}

function splitReadPath(value: unknown): { path: string; range?: string } | undefined {
	if (typeof value !== "string") return undefined;
	const target = value.trim();
	const selector = target.match(/^(.+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
	const path = workspacePath(selector?.[1] ?? target);
	if (!path) return undefined;
	return selector ? { path, range: selector[2] } : { path };
}

function readPreviewText(value: unknown): string {
	if (!isRecord(value)) return typeof value === "string" ? value : "";
	const details = isRecord(value.details) ? value.details : undefined;
	const displayContent = details && isRecord(details.displayContent) ? details.displayContent : undefined;
	if (displayContent && typeof displayContent.text === "string") return displayContent.text;
	if (isRecord(value.displayContent) && typeof value.displayContent.text === "string")
		return value.displayContent.text;
	if (typeof value.text === "string") return value.text;
	return extractText(value.content);
}

function boundedLines(value: string, maxLines: number): string[] {
	if (!value) return [];
	return value
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.slice(0, maxLines)
		.map(line => (line.length > MAX_ACTIVITY_LINE ? `${line.slice(0, MAX_ACTIVITY_LINE - 1)}…` : line));
}

function boundedScalar(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function boundedCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100_000, Math.floor(value)));
}

function readResultCount(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const details = isRecord(value.details) ? value.details : undefined;
	const displayContent = details && isRecord(details.displayContent) ? details.displayContent : undefined;
	if (displayContent && Array.isArray(displayContent.lineNumbers))
		return boundedCount(displayContent.lineNumbers.length);
	const summary = details && isRecord(details.summary) ? details.summary : undefined;
	return summary ? boundedCount(summary.lines) : undefined;
}

function readRange(args: Record<string, unknown>): string | undefined {
	const start = boundedCount(args.startLine ?? args.start);
	const end = boundedCount(args.endLine ?? args.end);
	if (start === undefined && end === undefined) return undefined;
	return boundedScalar(`${start ?? ""}-${end ?? ""}`, 128);
}

function extractLocalPaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const candidate of value) {
		const target = workspacePath(candidate);
		if (!target || seen.has(target)) continue;
		seen.add(target);
		paths.push(target);
		if (paths.length >= MAX_EDIT_DIFF_LINES) break;
	}
	return paths;
}

function extractImages(value: unknown): TimelineImage[] {
	const seenImages = new Set<string>();
	const visited = new Set<object>();
	const images: TimelineImage[] = [];

	const visit = (candidate: unknown): void => {
		if (isInlineImage(candidate)) {
			const key = `${candidate.mimeType}:${candidate.data}`;
			if (!seenImages.has(key)) {
				seenImages.add(key);
				images.push({ data: candidate.data, mimeType: candidate.mimeType });
			}
			return;
		}
		if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) return;
		visited.add(candidate);
		if (Array.isArray(candidate)) {
			for (const nested of candidate) visit(nested);
			return;
		}
		const record = candidate as Record<string, unknown>;
		visit(record.content);
		visit(record.details);
		visit(record.images);
		visit(record.rawContent);
		visit(record.xdev);
		visit(record.inner);
	};

	visit(value);
	return images;
}

function isInlineImage(value: unknown): value is TimelineImage {
	if (!isRecord(value)) return false;
	return (
		typeof value.data === "string" &&
		typeof value.mimeType === "string" &&
		value.mimeType.startsWith("image/") &&
		value.data.length > 0
	);
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return (
			JSON.stringify(
				value,
				(_key, nestedValue) =>
					isInlineImage(nestedValue) ? { ...nestedValue, data: "[inline image omitted]" } : nestedValue,
				2,
			) ?? ""
		);
	} catch {
		return "[unserializable]";
	}
}

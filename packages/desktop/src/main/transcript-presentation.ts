import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { TimelineItem, TimelinePresentation, TimelineTone } from "../shared/contracts";

export { TRANSCRIPT_PRESENTATION_LIMITS } from "../shared/transcript-limits";

import { TRANSCRIPT_PRESENTATION_LIMITS } from "../shared/transcript-limits";

type MessageProjection = {
	text: string;
	kind: TimelineItem["kind"];
	presentation?: TimelinePresentation;
	hidden?: boolean;
};

export type EventProjection = {
	text: string;
	kind?: TimelineItem["kind"];
	status?: TimelineItem["status"];
	isError?: boolean;
	detail?: string;
	presentation?: TimelinePresentation;
	hidden?: boolean;
};

type BoundedLines = {
	lines: string[];
	omittedCount?: number;
};

type Envelope = {
	tag: "system-notice" | "system-reminder" | "irc" | "advisory";
	label?: string;
	body: string;
	severity?: "nit" | "concern" | "blocker";
};

const ENVELOPE_PATTERN = /^\s*<(system-notice|system-reminder|irc|advisory)([^>]*)>([\s\S]*)<\/\1>\s*$/i;
const HANDOFF_PATTERN = /^\s*<handoff-context>([\s\S]*)<\/handoff-context>\s*$/i;
const HIDDEN_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"prompt_result",
	"todo_reminder",
	"auto_retry_start",
	"auto_retry_end",
	"ttsr_triggered",
	"goal_updated",
]);

export function stableMessageKey(value: unknown): string {
	if (!isRecord(value)) return "unknown::";
	if (typeof value.id === "string" && value.id.trim()) return value.id;
	const role = typeof value.role === "string" ? value.role : "unknown";
	const customType = typeof value.customType === "string" ? value.customType : "";
	const details = isRecord(value.details) ? value.details : undefined;
	if (
		(customType === "irc:incoming" || customType === "irc:autoreply" || customType === "irc:relay") &&
		typeof details?.id === "string"
	) {
		return `${role}:${customType}:${details.id}`;
	}
	return `${role}:${customType}:${String(value.timestamp ?? "")}`;
}

export function extractMessageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return "";
	if (value.role === "compactionSummary" || value.role === "branchSummary")
		return typeof value.summary === "string" ? value.summary : "";
	if (value.role === "bashExecution")
		return typeof value.output === "string" && value.output ? value.output : scalarText(value.command);
	if (value.role === "pythonExecution")
		return typeof value.output === "string" && value.output ? value.output : scalarText(value.code);
	if (value.role === "fileMention") {
		const files = Array.isArray(value.files) ? value.files : [];
		return files
			.map(file => (isRecord(file) && typeof file.path === "string" ? file.path : ""))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value.text === "string") return value.text;
	return extractContentText(value.content);
}

export function presentMessage(value: unknown): MessageProjection {
	if (!isRecord(value)) return { text: "", kind: "special", hidden: true };
	const role = typeof value.role === "string" ? value.role : "unknown";
	const text = extractMessageText(value);
	if (role === "developer") return { text: "", kind: "special", hidden: true };
	if ((role === "custom" || role === "hookMessage") && value.display !== true) {
		return { text: "", kind: "special", hidden: true };
	}
	if (role === "user") {
		if (value.synthetic === true) {
			const envelope = unwrapEnvelope(text);
			if (envelope) {
				const bounded = boundedLines(envelope.body, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
				return {
					text: envelope.body,
					kind: "special",
					presentation: {
						type: "custom",
						variant: "system",
						title: envelope.label ?? humanize(envelope.tag),
						previewLines: bounded.lines,
						...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
						collapsed: true,
					},
				};
			}
		}
		return { text, kind: "user" };
	}
	if (role === "assistant") return { text, kind: "assistant" };
	if (role === "toolResult") return { text: "", kind: "special", hidden: true };
	return presentSpecialMessage(value, role, text);
}

export function presentAssistantOutcome(value: unknown): TimelinePresentation | undefined {
	if (!isRecord(value)) return undefined;
	const recovery = isRecord(value.retryRecovery) ? value.retryRecovery : undefined;
	if (recovery?.status === "superseded") return undefined;
	if (recovery?.status === "recovered") {
		const note = scalarText(recovery.note) || "Retry recovered";
		const bounded = boundedLines(note, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
		return {
			type: "assistant-outcome",
			mode: "recovered",
			tone: "neutral",
			label: "Recovered retry",
			previewLines: bounded.lines,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		};
	}
	if (value.stopReason !== "error") return undefined;
	const message = scalarText(value.errorMessage) || "Provider returned an error";
	const bounded = boundedLines(message, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	return {
		type: "assistant-outcome",
		mode: "error",
		tone: "error",
		label: "Provider error",
		previewLines: bounded.lines,
		...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
	};
}

export function presentEvent(event: unknown): EventProjection | undefined {
	if (!isRecord(event) || typeof event.type !== "string") return undefined;
	const type = event.type;
	if (HIDDEN_EVENT_TYPES.has(type)) return { text: "", hidden: true };
	if (type === "irc_message") return { text: "", hidden: true };
	if (type === "command_output") {
		const text = scalarText(event.text);
		if (!text) return { text: "", hidden: true };
		return {
			text,
			kind: "special",
			status: "complete",
			presentation: statusPresentation("command", "neutral", "Command output"),
		};
	}
	if (type === "notice") {
		const text = scalarText(event.message) || "Notice";
		const level =
			event.level === "error" || event.level === "warning" || event.level === "info" ? event.level : "info";
		const tone: TimelineTone = level;
		const source = boundedScalar(event.source, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth);
		return {
			text,
			kind: "special",
			status: level === "error" ? "error" : "complete",
			isError: level === "error",
			presentation: statusPresentation(
				"notice",
				tone,
				"Notice",
				source ? [{ label: "Source", value: source }] : undefined,
				source,
			),
		};
	}
	if (type === "thinking_level_changed") {
		const level = boundedScalar(event.thinkingLevel, 64) ?? "off";
		const entries = [
			{ label: "Level", value: level },
			...(typeof event.configured === "string"
				? [{ label: "Configured", value: boundedScalar(event.configured, 64) ?? event.configured }]
				: []),
			...(typeof event.resolved === "string"
				? [{ label: "Resolved", value: boundedScalar(event.resolved, 64) ?? event.resolved }]
				: []),
		];
		return {
			text: `Thinking level: ${level}`,
			kind: "special",
			status: "complete",
			presentation: statusPresentation("thinking", "info", "Thinking level", entries),
		};
	}
	if (type === "model_changed") {
		return {
			text: "Model changed",
			kind: "special",
			status: "complete",
			presentation: statusPresentation("model", "info", "Model changed"),
		};
	}
	if (type === "retry_fallback_applied") {
		const from = boundedScalar(event.from, 128) ?? "model";
		const to = boundedScalar(event.to, 128) ?? "fallback";
		return {
			text: `Retry fallback: ${from} → ${to}`,
			kind: "special",
			status: "complete",
			presentation: statusPresentation("fallback", "warning", "Retry fallback", [
				{ label: "Route", value: `${from} → ${to}` },
			]),
		};
	}
	if (type === "retry_fallback_succeeded") {
		const model = boundedScalar(event.model, 128);
		return {
			text: model ? `Retry fallback succeeded: ${model}` : "Retry fallback succeeded",
			kind: "special",
			status: "complete",
			presentation: statusPresentation(
				"fallback",
				"success",
				"Retry fallback succeeded",
				model ? [{ label: "Model", value: model }] : undefined,
			),
		};
	}
	if (type === "auto_compaction_start") return { text: "", hidden: true };
	if (type === "auto_compaction_end") {
		const failed = event.aborted === true || event.skipped === true || Boolean(event.errorMessage);
		if (!failed) return { text: "", hidden: true };
		const message =
			event.aborted === true
				? "Context compaction aborted"
				: event.skipped === true
					? "Context compaction skipped"
					: scalarText(event.errorMessage) || "Context compaction failed";
		const tone: TimelineTone = event.aborted === true || event.errorMessage ? "error" : "warning";
		return {
			text: message,
			kind: "special",
			status: tone === "error" ? "error" : "complete",
			isError: tone === "error",
			presentation: statusPresentation("compaction", tone, "Context compaction", [
				{ label: "State", value: message },
			]),
		};
	}
	if (type === "todo_auto_clear") {
		return {
			text: "Todos cleared",
			kind: "special",
			status: "complete",
			presentation: statusPresentation("todo", "success", "Todos cleared"),
		};
	}
	return undefined;
}

function presentSpecialMessage(value: Record<string, unknown>, role: string, rawText: string): MessageProjection {
	const customType = typeof value.customType === "string" ? value.customType : "";
	const details = isRecord(value.details) ? value.details : undefined;
	const attribution = boundedScalar(value.attribution, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth);
	if (role === "compactionSummary") {
		const text = scalarText(value.summary) || rawText;
		const bounded = boundedLines(text, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
		return {
			text,
			kind: "special",
			presentation: {
				type: "context",
				transition: "compaction",
				title: "Context compacted",
				tokenCount: boundedNumber(value.tokensBefore),
				frameCount: arrayLength(value.images),
				warning: boundedScalar(value.warning, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth),
				previewLines: bounded.lines,
				...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
			},
		};
	}
	if (role === "branchSummary") {
		const text = scalarText(value.summary) || rawText;
		const bounded = boundedLines(text, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
		return {
			text,
			kind: "special",
			presentation: {
				type: "context",
				transition: "branch",
				title: "Branch summary",
				previewLines: bounded.lines,
				...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
			},
		};
	}
	if (role === "bashExecution" || role === "pythonExecution")
		return executionPresentation(value, role === "bashExecution" ? "bash" : "python", rawText);
	if (role === "fileMention") return fileMentionPresentation(value, rawText);
	if (customType === "irc:incoming" || customType === "irc:autoreply" || customType === "irc:relay")
		return ircPresentation(value, customType, rawText);
	if (customType === "advisor") return advisorPresentation(details, rawText);
	if (customType === "async-result") return asyncPresentation(details, rawText);
	if (customType === "lsp-late-diagnostic") return diagnosticsPresentation(details, rawText);
	if (customType === "background-tan-dispatch") return tangentPresentation(details, rawText);
	if (customType === "launch-completion") return launchPresentation(details, rawText);
	if (customType === "collab-prompt") return collabPresentation(details, rawText, attribution);
	if (customType === "skill-prompt") return skillPresentation(details, rawText, attribution);
	if (customType === "handoff") return handoffPresentation(rawText);
	const envelope = unwrapEnvelope(rawText);
	if (envelope) {
		if (envelope.tag === "irc") {
			const bounded = boundedLines(envelope.body, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
			return {
				text: envelope.body,
				kind: "special",
				presentation: {
					type: "irc",
					direction: "incoming",
					previewLines: bounded.lines,
					...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
				},
			};
		}
		if (envelope.tag === "advisory") {
			return advisorPresentation(
				{ notes: [{ note: envelope.body, severity: envelope.severity ?? "nit" }] },
				envelope.body,
			);
		}
		const bounded = boundedLines(envelope.body, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
		return {
			text: envelope.body,
			kind: "special",
			presentation: {
				type: "custom",
				variant: "system",
				title: envelope.label ?? humanize(envelope.tag),
				...(attribution ? { attribution } : {}),
				previewLines: bounded.lines,
				...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
				collapsed: true,
			},
		};
	}
	const bounded = boundedLines(rawText, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	return {
		text: rawText,
		kind: "special",
		presentation: {
			type: "custom",
			variant: role === "hookMessage" ? "hook" : "extension",
			title: customType ? humanize(customType) : humanize(role),
			...(attribution ? { attribution } : {}),
			previewLines: bounded.lines,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		},
	};
}

function executionPresentation(
	value: Record<string, unknown>,
	engine: "bash" | "python",
	text: string,
): MessageProjection {
	const input = scalarText(engine === "bash" ? value.command : value.code);
	const output = scalarText(value.output);
	const bounded = boundedLines(output, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	const exitCode = boundedNumber(value.exitCode);
	const cancelled = value.cancelled === true;
	const state = cancelled ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? "error" : "complete";
	return {
		text: output || text || input,
		kind: "special",
		presentation: {
			type: "execution",
			engine,
			input: boundedScalar(input, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth) ?? "",
			outputPreview: bounded.lines,
			state,
			...(exitCode === undefined ? {} : { exitCode }),
			truncated: value.truncated === true,
			excludedFromContext: value.excludeFromContext === true,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		},
	};
}

function fileMentionPresentation(value: Record<string, unknown>, rawText: string): MessageProjection {
	const files = Array.isArray(value.files) ? value.files : [];
	const entries: Array<{ label: string; value?: string; status?: string }> = [];
	for (const file of files) {
		if (!isRecord(file)) continue;
		const path = boundedScalar(file.path, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth);
		if (!path) continue;
		const skipped =
			file.skippedReason === "binary" ? "binary" : file.skippedReason === "tooLarge" ? "too large" : undefined;
		const lines = boundedNumber(file.lineCount);
		entries.push({
			label: path,
			value: skipped ? `skipped · ${skipped}` : lines === undefined ? "read" : `${lines} lines`,
			status: skipped ? "skipped" : "read",
		});
	}
	const omittedCount = Math.max(0, files.length - entries.length);
	return {
		text: rawText || entries.map(entry => entry.label).join("\n"),
		kind: "special",
		presentation: {
			type: "activity",
			category: "files",
			tone: "neutral",
			title: "Files mentioned",
			entries: entries.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.activityEntries),
			...(omittedCount || files.length > TRANSCRIPT_PRESENTATION_LIMITS.activityEntries
				? { omittedCount: Math.max(omittedCount, files.length - TRANSCRIPT_PRESENTATION_LIMITS.activityEntries) }
				: {}),
		},
	};
}

function ircPresentation(value: Record<string, unknown>, customType: string, rawText: string): MessageProjection {
	const details = isRecord(value.details) ? value.details : undefined;
	const incoming = customType === "irc:incoming";
	const autoreply = customType === "irc:autoreply";
	const body = scalarText(incoming ? details?.message : details?.body) || rawText;
	const bounded = boundedLines(body, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	return {
		text: body,
		kind: "special",
		presentation: {
			type: "irc",
			direction: incoming ? "incoming" : autoreply ? "autoreply" : "relay",
			from: boundedScalar(details?.from, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth),
			to: boundedScalar(details?.to, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth),
			reply: boundedScalar(details?.replyTo, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth),
			previewLines: bounded.lines,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		},
	};
}

function advisorPresentation(details: Record<string, unknown> | undefined, rawText: string): MessageProjection {
	const source = Array.isArray(details?.notes) ? details.notes : [];
	const notes: Array<{ note: string; severity: "nit" | "concern" | "blocker"; advisor?: string }> = [];
	for (const candidate of source) {
		if (!isRecord(candidate)) continue;
		const note = boundedScalar(candidate.note, TRANSCRIPT_PRESENTATION_LIMITS.lineWidth);
		if (!note) continue;
		const severity =
			candidate.severity === "blocker" || candidate.severity === "concern" ? candidate.severity : "nit";
		notes.push({
			note,
			severity,
			...(boundedScalar(candidate.advisor, 128) ? { advisor: boundedScalar(candidate.advisor, 128) } : {}),
		});
	}
	if (notes.length === 0 && rawText.trim())
		notes.push({
			note: boundedScalar(rawText, TRANSCRIPT_PRESENTATION_LIMITS.lineWidth) ?? rawText,
			severity: "nit",
		});
	const retainedNotes = notes.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.advisorNotes);
	const blockerCount = notes.filter(note => note.severity === "blocker").length;
	const total = source.length || notes.length;
	const omittedCount = Math.max(0, total - retainedNotes.length);
	return {
		text: notes.map(note => note.note).join("\n") || rawText,
		kind: "special",
		presentation: {
			type: "advisor",
			notes: retainedNotes,
			total,
			blockerCount,
			...(omittedCount ? { omittedCount } : {}),
		},
	};
}

function asyncPresentation(details: Record<string, unknown> | undefined, rawText: string): MessageProjection {
	const source = Array.isArray(details?.jobs) ? details.jobs : [];
	const entries: Array<{ label: string; value?: string; status?: string }> = [];
	for (const candidate of source) {
		if (!isRecord(candidate)) continue;
		const label = boundedScalar(candidate.label ?? candidate.jobId, 128);
		if (!label) continue;
		const type = boundedScalar(candidate.type, 32);
		const duration = boundedNumber(candidate.durationMs);
		entries.push({
			label,
			value: [type, duration === undefined ? undefined : `${duration} ms`].filter(Boolean).join(" · ") || undefined,
			status: "complete",
		});
	}
	return {
		text: rawText || entries.map(entry => entry.label).join("\n"),
		kind: "special",
		presentation: {
			type: "activity",
			category: "job",
			tone: "success",
			title: "Background job completed",
			entries: entries.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.activityEntries),
			...(source.length > TRANSCRIPT_PRESENTATION_LIMITS.activityEntries
				? { omittedCount: source.length - TRANSCRIPT_PRESENTATION_LIMITS.activityEntries }
				: {}),
		},
	};
}

function diagnosticsPresentation(details: Record<string, unknown> | undefined, rawText: string): MessageProjection {
	const source = Array.isArray(details?.files) ? details.files : [];
	const entries: Array<{ label: string; value?: string; status?: string }> = [];
	for (const candidate of source) {
		if (!isRecord(candidate)) continue;
		const path = boundedScalar(candidate.path, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth);
		if (!path) continue;
		entries.push({
			label: path,
			value: boundedScalar(candidate.summary, TRANSCRIPT_PRESENTATION_LIMITS.lineWidth),
			status: candidate.errored === true ? "error" : "updated",
		});
	}
	return {
		text: rawText || entries.map(entry => `${entry.label}${entry.value ? `: ${entry.value}` : ""}`).join("\n"),
		kind: "special",
		presentation: {
			type: "activity",
			category: "diagnostics",
			tone: entries.some(entry => entry.status === "error") ? "error" : "info",
			title: "Late diagnostics",
			entries: entries.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.activityEntries),
			...(source.length > TRANSCRIPT_PRESENTATION_LIMITS.activityEntries
				? { omittedCount: source.length - TRANSCRIPT_PRESENTATION_LIMITS.activityEntries }
				: {}),
		},
	};
}

function tangentPresentation(details: Record<string, unknown> | undefined, rawText: string): MessageProjection {
	const jobId = boundedScalar(details?.jobId, 128);
	const work = boundedScalar(details?.work, TRANSCRIPT_PRESENTATION_LIMITS.lineWidth);
	const entry = { label: jobId ?? "background task", value: work, status: "dispatched" };
	return {
		text: rawText || work || jobId || "Background task dispatched",
		kind: "special",
		presentation: {
			type: "activity",
			category: "tangent",
			tone: "info",
			title: "Background task dispatched",
			entries: [entry],
		},
	};
}

function launchPresentation(details: Record<string, unknown> | undefined, rawText: string): MessageProjection {
	const source = Array.isArray(details?.daemons) ? details.daemons : [];
	const entries: Array<{ label: string; value?: string; status?: string }> = [];
	for (const candidate of source) {
		if (!isRecord(candidate)) continue;
		const name = boundedScalar(candidate.name, 128);
		if (!name) continue;
		const state = boundedScalar(candidate.state, 64);
		const exitCode = boundedNumber(candidate.exitCode);
		entries.push({
			label: name,
			value:
				[state, exitCode === undefined ? undefined : `exit ${exitCode}`].filter(Boolean).join(" · ") || undefined,
			status:
				state === "failed" || (state === "exited" && exitCode !== undefined && exitCode !== 0)
					? "error"
					: "complete",
		});
	}
	return {
		text: rawText || entries.map(entry => `${entry.label}${entry.value ? `: ${entry.value}` : ""}`).join("\n"),
		kind: "special",
		presentation: {
			type: "activity",
			category: "process",
			tone: entries.some(entry => entry.status === "error") ? "error" : "success",
			title: "Process completed",
			entries: entries.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.activityEntries),
			...(source.length > TRANSCRIPT_PRESENTATION_LIMITS.activityEntries
				? { omittedCount: source.length - TRANSCRIPT_PRESENTATION_LIMITS.activityEntries }
				: {}),
		},
	};
}

function collabPresentation(
	details: Record<string, unknown> | undefined,
	rawText: string,
	attribution: string | undefined,
): MessageProjection {
	const from = boundedScalar(details?.from, 128);
	const bounded = boundedLines(rawText, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	return {
		text: rawText,
		kind: "special",
		presentation: {
			type: "custom",
			variant: "collab",
			title: from ? `Collaboration prompt from ${from}` : "Collaboration prompt",
			...(attribution ? { attribution } : {}),
			...(from ? { meta: [{ label: "Participant", value: from }] } : {}),
			previewLines: bounded.lines,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		},
	};
}

function skillPresentation(
	details: Record<string, unknown> | undefined,
	rawText: string,
	attribution: string | undefined,
): MessageProjection {
	const name = boundedScalar(details?.name, 128) ?? "Skill invocation";
	const meta = boundedMetadata([
		["Path", boundedScalar(details?.path, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth)],
		["Arguments", boundedScalar(details?.args, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth)],
		["Lines", boundedNumber(details?.lineCount)?.toLocaleString()],
	]);
	const bounded = boundedLines(rawText, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	return {
		text: rawText,
		kind: "special",
		presentation: {
			type: "custom",
			variant: "skill",
			title: name,
			...(attribution ? { attribution } : {}),
			...(meta.length ? { meta } : {}),
			previewLines: bounded.lines,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		},
	};
}

function handoffPresentation(rawText: string): MessageProjection {
	const body = rawText.match(HANDOFF_PATTERN)?.[1].trim() ?? rawText;
	const bounded = boundedLines(body, TRANSCRIPT_PRESENTATION_LIMITS.previewLines);
	return {
		text: body,
		kind: "special",
		presentation: {
			type: "context",
			transition: "handoff",
			title: "Handoff context",
			previewLines: bounded.lines,
			...(bounded.omittedCount ? { omittedCount: bounded.omittedCount } : {}),
		},
	};
}

function statusPresentation(
	category: "notice" | "command" | "model" | "thinking" | "fallback" | "compaction" | "todo" | "retry",
	tone: TimelineTone,
	title: string,
	entries?: Array<{ label: string; value: string; tone?: TimelineTone }>,
	source?: string,
): TimelinePresentation {
	return {
		type: "status",
		category,
		tone,
		title,
		...(source ? { source } : {}),
		...(entries?.length ? { entries } : {}),
	};
}

function boundedMetadata(values: Array<[string, string | undefined]>): Array<{ label: string; value: string }> {
	return values
		.filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
		.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.metadataEntries)
		.map(([label, value]) => ({ label, value }));
}

function extractContentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return isRecord(value) && typeof value.text === "string" ? value.text : "";
	return value
		.map(block => {
			if (!isRecord(block)) return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function unwrapEnvelope(value: string): Envelope | undefined {
	const match = value.match(ENVELOPE_PATTERN);
	if (!match) return undefined;
	const tag = match[1].toLowerCase() as Envelope["tag"];
	const attributes = match[2] ?? "";
	const body = match[3].trim();
	if (!body) return undefined;
	const label = attributes.match(/(?:title|label)\s*=\s*["']([^"']{1,256})["']/i)?.[1];
	const severityValue = attributes.match(/severity\s*=\s*["'](nit|concern|blocker)["']/i)?.[1].toLowerCase();
	const severity = severityValue === "concern" || severityValue === "blocker" ? severityValue : "nit";
	return {
		tag,
		body,
		...(label ? { label: boundedScalar(label, TRANSCRIPT_PRESENTATION_LIMITS.scalarWidth) } : {}),
		...(tag === "advisory" ? { severity } : {}),
	};
}

function humanize(value: string): string {
	const words = value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[:._-]+/g)
		.map(word => word.trim())
		.filter(Boolean);
	return words.length === 0
		? "System message"
		: words.map(word => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function scalarText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function boundedScalar(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function boundedLines(value: string, maxLines: number): BoundedLines {
	if (!value) return { lines: [] };
	const all = value.replace(/\r\n?/g, "\n").split("\n");
	const lines = all
		.slice(0, maxLines)
		.map(line =>
			line.length > TRANSCRIPT_PRESENTATION_LIMITS.lineWidth
				? `${line.slice(0, TRANSCRIPT_PRESENTATION_LIMITS.lineWidth - 1)}…`
				: line,
		);
	return { lines, ...(all.length > lines.length ? { omittedCount: all.length - lines.length } : {}) };
}

function boundedNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(TRANSCRIPT_PRESENTATION_LIMITS.count, Math.floor(value)));
}

function arrayLength(value: unknown): number | undefined {
	return Array.isArray(value) && value.length > 0
		? Math.min(value.length, TRANSCRIPT_PRESENTATION_LIMITS.count)
		: undefined;
}

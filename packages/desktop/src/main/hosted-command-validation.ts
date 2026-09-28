import {
	type HostedAgentSettingValue,
	type HostedPlanReviewDecision,
	type HostedPromptComposition,
	MAX_INLINE_PROMPT_BYTES,
	MAX_PROMPT_ATTACHMENT_COUNT,
} from "@gradivus/chat/contracts";
import type { HostedChatCommand, HostedChatOperation, HostedRawCommandEnvelope } from "@gradivus/chat/protocol";
import { isAgentSettingValue } from "../shared/contracts";

const encoder = new TextEncoder();

export class HostedPayloadValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostedPayloadValidationError";
	}
}

function exact(payload: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(payload);
	const missing = required.find(key => !Object.hasOwn(payload, key));
	if (missing) throw new HostedPayloadValidationError(`${missing} is required.`);
	const unknown = keys.find(key => !allowed.has(key));
	if (unknown) throw new HostedPayloadValidationError(`Unknown payload field: ${unknown}`);
}

function text(value: unknown, name: string, maximum = 16 * 1024, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0) || encoder.encode(value).byteLength > maximum) {
		throw new HostedPayloadValidationError(`${name} is invalid.`);
	}
	return value;
}

function optionalText(value: unknown, name: string, maximum = 16 * 1024): void {
	if (value !== undefined) text(value, name, maximum, true);
}

function boolean(value: unknown, name: string): void {
	if (typeof value !== "boolean") throw new HostedPayloadValidationError(`${name} must be boolean.`);
}

function integer(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new HostedPayloadValidationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
	}
}

function stringArray(value: unknown, name: string, maximumItems: number): string[] {
	if (!Array.isArray(value) || value.length > maximumItems || value.some(item => typeof item !== "string" || !item)) {
		throw new HostedPayloadValidationError(`${name} is invalid.`);
	}
	return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedPayloadValidationError(`${name} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function sessionId(payload: Record<string, unknown>): void {
	text(payload.sessionId, "sessionId", 128);
}

function relativeTarget(value: unknown): void {
	const target = text(value, "target", 4 * 1024);
	const normalized = target.replaceAll("\\", "/");
	if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw new HostedPayloadValidationError("target must be workspace-relative.");
	}
}

function composition(value: unknown): asserts value is HostedPromptComposition {
	const input = record(value, "composition");
	exact(input, ["parts"]);
	if (!Array.isArray(input.parts) || input.parts.length === 0 || input.parts.length > 64) {
		throw new HostedPayloadValidationError("composition.parts is invalid.");
	}
	for (const [index, rawPart] of input.parts.entries()) {
		const part = record(rawPart, `composition.parts[${index}]`);
		if (part.type === "text") {
			exact(part, ["type", "text"]);
			text(part.text, `composition.parts[${index}].text`, MAX_INLINE_PROMPT_BYTES, true);
		} else if (part.type === "attachment") {
			exact(part, ["type", "id"]);
			text(part.id, `composition.parts[${index}].id`, 128);
		} else {
			throw new HostedPayloadValidationError(`composition.parts[${index}].type is invalid.`);
		}
	}
}

function planDecision(value: unknown): asserts value is HostedPlanReviewDecision {
	const decision = record(value, "decision");
	if (decision.kind === "approve") {
		exact(decision, ["kind", "context"], ["executionRole"]);
		if (decision.context !== "fresh" && decision.context !== "compact" && decision.context !== "keep") {
			throw new HostedPayloadValidationError("decision.context is invalid.");
		}
		optionalText(decision.executionRole, "decision.executionRole", 128);
		return;
	}
	if (decision.kind === "refine") {
		exact(decision, ["kind", "feedback"], ["composition"]);
		text(decision.feedback, "decision.feedback", MAX_INLINE_PROMPT_BYTES, true);
		if (decision.composition !== undefined) composition(decision.composition);
		return;
	}
	if (decision.kind === "save") {
		exact(decision, ["kind"]);
		return;
	}
	throw new HostedPayloadValidationError("decision.kind is invalid.");
}

function agentSettingValue(value: unknown): asserts value is HostedAgentSettingValue {
	if (!isAgentSettingValue(value)) {
		throw new HostedPayloadValidationError("value is not a supported agent setting value.");
	}
}

function validateSessionOnly(payload: Record<string, unknown>): void {
	exact(payload, ["sessionId"]);
	sessionId(payload);
}

export function validateHostedCommandPayload(envelope: HostedRawCommandEnvelope): HostedChatCommand {
	const { operation, payload } = envelope;
	switch (operation) {
		case "bootstrap":
		case "reconnectRuntime":
		case "openDesktopAccounts":
			exact(payload, []);
			break;
		case "createInWorkspace":
			exact(payload, ["workspaceId", "kind"]);
			text(payload.workspaceId, "workspaceId", 128);
			if (payload.kind !== "work" && payload.kind !== "code")
				throw new HostedPayloadValidationError("kind is invalid.");
			break;
		case "chooseWorkspaceAndCreate":
			exact(payload, ["kind"]);
			if (payload.kind !== "work" && payload.kind !== "code")
				throw new HostedPayloadValidationError("kind is invalid.");
			break;
		case "openSession":
		case "resume":
		case "stop":
		case "restart":
		case "abort":
		case "retry":
		case "abortRetry":
		case "getSessionStats":
		case "exportHtml":
		case "requestPlanReview":
		case "getAvailableCommands":
		case "getAvailableModels":
		case "getAgentHub":
			validateSessionOnly(payload);
			break;
		case "rename":
			exact(payload, ["sessionId", "title"]);
			sessionId(payload);
			text(payload.title, "title", 512);
			break;
		case "deleteSession": {
			exact(payload, ["sessionId", "confirmation"]);
			sessionId(payload);
			const confirmation = record(payload.confirmation, "confirmation");
			exact(confirmation, ["sessionId", "title"]);
			text(confirmation.sessionId, "confirmation.sessionId", 128);
			text(confirmation.title, "confirmation.title", 512);
			break;
		}
		case "loadTimelinePage":
			exact(payload, ["sessionId", "before", "limit"]);
			sessionId(payload);
			integer(payload.before, "before");
			integer(payload.limit, "limit", 1, 200);
			break;
		case "loadTimelineItem":
		case "loadTimelineToolDetail":
			exact(payload, ["sessionId", "itemId"]);
			sessionId(payload);
			text(payload.itemId, "itemId", 256);
			break;
		case "stagePromptText":
			exact(payload, ["sessionId", "text"]);
			sessionId(payload);
			text(payload.text, "text", 16 * 1024 * 1024);
			break;
		case "stagePromptAttachments":
			exact(payload, ["sessionId", "metadata"]);
			sessionId(payload);
			if (!Array.isArray(payload.metadata) || payload.metadata.length > MAX_PROMPT_ATTACHMENT_COUNT) {
				throw new HostedPayloadValidationError("metadata is invalid.");
			}
			for (const metadata of payload.metadata) {
				const item = record(metadata, "metadata item");
				exact(item, ["name", "size"], ["mimeType"]);
				text(item.name, "metadata.name", 1024);
				optionalText(item.mimeType, "metadata.mimeType", 256);
				integer(item.size, "metadata.size", 0, 25 * 1024 * 1024);
			}
			break;
		case "releasePromptAttachments":
			exact(payload, ["sessionId", "attachmentIds"]);
			sessionId(payload);
			stringArray(payload.attachmentIds, "attachmentIds", MAX_PROMPT_ATTACHMENT_COUNT);
			break;
		case "prompt":
		case "steer":
		case "steerQueued":
		case "queueFollowUp":
			exact(payload, ["sessionId", "composition"]);
			sessionId(payload);
			composition(payload.composition);
			break;
		case "editMessage":
			exact(payload, ["sessionId", "timelineItemId", "text"]);
			sessionId(payload);
			text(payload.timelineItemId, "timelineItemId", 256);
			text(payload.text, "text", MAX_INLINE_PROMPT_BYTES);
			break;
		case "getOpenRouterModelRouting":
			exact(payload, ["sessionId", "modelId"]);
			sessionId(payload);
			text(payload.modelId, "modelId", 512);
			break;
		case "setOpenRouterProviderEnabled":
			exact(payload, ["sessionId", "modelId", "providerId", "enabled"]);
			sessionId(payload);
			text(payload.modelId, "modelId", 512);
			text(payload.providerId, "providerId", 256);
			boolean(payload.enabled, "enabled");
			break;
		case "compact":
		case "handoff":
			exact(payload, ["sessionId"], ["instructions"]);
			sessionId(payload);
			optionalText(payload.instructions, "instructions", MAX_INLINE_PROMPT_BYTES);
			break;
		case "updatePlanReview":
			exact(payload, ["sessionId", "reviewId", "content", "expectedRevision", "annotationState"]);
			sessionId(payload);
			text(payload.reviewId, "reviewId", 256);
			text(payload.content, "content", 2 * 1024 * 1024, true);
			text(payload.expectedRevision, "expectedRevision", 256);
			record(payload.annotationState, "annotationState");
			break;
		case "resolvePlanReview":
			exact(payload, ["sessionId", "reviewId", "expectedRevision", "decision"]);
			sessionId(payload);
			text(payload.reviewId, "reviewId", 256);
			text(payload.expectedRevision, "expectedRevision", 256);
			planDecision(payload.decision);
			break;
		case "setTodos":
			exact(payload, ["sessionId", "phases", "expectedRevision", "action"]);
			sessionId(payload);
			if (!Array.isArray(payload.phases)) throw new HostedPayloadValidationError("phases must be an array.");
			integer(payload.expectedRevision, "expectedRevision");
			text(payload.action, "action", 256);
			break;
		case "setModel":
			exact(payload, ["sessionId", "provider", "modelId"]);
			sessionId(payload);
			text(payload.provider, "provider", 256);
			text(payload.modelId, "modelId", 512);
			break;
		case "setThinking":
			exact(payload, ["sessionId", "level"]);
			sessionId(payload);
			if (!["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(payload.level))) {
				throw new HostedPayloadValidationError("level is invalid.");
			}
			break;
		case "setFastMode":
		case "setAutoCompaction":
		case "setAutoRetry":
			exact(payload, ["sessionId", "enabled"]);
			sessionId(payload);
			boolean(payload.enabled, "enabled");
			break;
		case "togglePlanMode":
			exact(payload, ["sessionId"], ["enabled"]);
			sessionId(payload);
			if (payload.enabled !== undefined) boolean(payload.enabled, "enabled");
			break;
		case "setQueueMode":
			exact(payload, ["sessionId", "kind", "mode"]);
			sessionId(payload);
			if (payload.kind !== "steering" && payload.kind !== "follow-up")
				throw new HostedPayloadValidationError("kind is invalid.");
			if (payload.mode !== "all" && payload.mode !== "one-at-a-time")
				throw new HostedPayloadValidationError("mode is invalid.");
			break;
		case "setInterruptMode":
			exact(payload, ["sessionId", "mode"]);
			sessionId(payload);
			if (payload.mode !== "immediate" && payload.mode !== "wait")
				throw new HostedPayloadValidationError("mode is invalid.");
			break;
		case "getSubagentMessages":
			exact(payload, ["sessionId", "subagentId", "fromByte"]);
			sessionId(payload);
			text(payload.subagentId, "subagentId", 256);
			integer(payload.fromByte, "fromByte");
			break;
		case "getAgentHubMessages":
			exact(payload, ["sessionId", "agentId"], ["fromByte"]);
			sessionId(payload);
			text(payload.agentId, "agentId", 256);
			if (payload.fromByte !== undefined) integer(payload.fromByte, "fromByte");
			break;
		case "agentHubMessage":
			exact(payload, ["sessionId", "agentId", "message"]);
			sessionId(payload);
			text(payload.agentId, "agentId", 256);
			text(payload.message, "message", MAX_INLINE_PROMPT_BYTES);
			break;
		case "agentHubKill":
		case "agentHubClear":
		case "agentHubRevive":
			exact(payload, ["sessionId", "agentId"]);
			sessionId(payload);
			text(payload.agentId, "agentId", 256);
			break;
		case "loadFileDiff":
		case "openWorkspaceFile":
			exact(payload, ["sessionId", "target"]);
			sessionId(payload);
			relativeTarget(payload.target);
			break;
		case "loadWorkspaceImage":
			exact(payload, ["sessionId", "target", "maxDimension"]);
			sessionId(payload);
			relativeTarget(payload.target);
			integer(payload.maxDimension, "maxDimension", 1, 8192);
			break;
		case "getAgentSettings":
		case "getAgentPrompts":
			exact(payload, [], ["sessionId"]);
			if (payload.sessionId !== undefined) text(payload.sessionId, "sessionId", 128);
			break;
		case "setAgentSetting":
			exact(payload, ["path", "value"], ["sessionId"]);
			if (payload.sessionId !== undefined) text(payload.sessionId, "sessionId", 128);
			text(payload.path, "path", 512);
			agentSettingValue(payload.value);
			break;
		case "saveAgentPrompt":
			exact(payload, ["name", "scope", "systemPrompt", "expectedRevision"], ["sessionId"]);
			if (payload.sessionId !== undefined) text(payload.sessionId, "sessionId", 128);
			text(payload.name, "name", 256);
			if (payload.scope !== "project" && payload.scope !== "user")
				throw new HostedPayloadValidationError("scope is invalid.");
			text(payload.systemPrompt, "systemPrompt", 1024 * 1024, true);
			if (payload.expectedRevision !== null) text(payload.expectedRevision, "expectedRevision", 256);
			break;
		case "resetAgentPrompt":
			exact(payload, ["name", "scope", "expectedRevision"], ["sessionId"]);
			if (payload.sessionId !== undefined) text(payload.sessionId, "sessionId", 128);
			text(payload.name, "name", 256);
			if (payload.scope !== "project" && payload.scope !== "user")
				throw new HostedPayloadValidationError("scope is invalid.");
			text(payload.expectedRevision, "expectedRevision", 256);
			break;
		default:
			operation satisfies never;
	}
	return envelope as unknown as HostedChatCommand;
}

export function operationSessionId(command: HostedChatCommand): string | undefined {
	return "sessionId" in command.payload && typeof command.payload.sessionId === "string"
		? command.payload.sessionId
		: undefined;
}

export function operationName(command: HostedChatCommand): HostedChatOperation {
	return command.operation;
}

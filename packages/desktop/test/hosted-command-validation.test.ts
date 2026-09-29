import {
	GRADIVUS_CHAT_PROTOCOL_VERSION,
	HOSTED_CHAT_OPERATION_NAMES,
	type HostedChatOperation,
	type HostedChatPayload,
	type HostedRawCommandEnvelope,
} from "@gradivus/chat/protocol";
import { describe, expect, it } from "vitest";
import { HostedPayloadValidationError, validateHostedCommandPayload } from "../src/main/hosted-command-validation";

const sessionId = "session-1";
const composition = { parts: [{ type: "text", text: "Continue" }] } as const;
const validPayloads = {
	bootstrap: {},
	createInWorkspace: { workspaceId: "workspace-1", kind: "code" },
	chooseWorkspaceAndCreate: { kind: "work" },
	openSession: { sessionId },
	resume: { sessionId },
	stop: { sessionId },
	restart: { sessionId },
	rename: { sessionId, title: "Renamed" },
	deleteSession: { sessionId, confirmation: { sessionId, title: "Current title" } },
	loadTimelinePage: { sessionId, before: 10, limit: 50 },
	loadTimelineItem: { sessionId, itemId: "item-1" },
	loadTimelineToolDetail: { sessionId, itemId: "item-1" },
	stagePromptText: { sessionId, text: "Notes" },
	stagePromptAttachments: { sessionId, metadata: [{ name: "notes.txt", mimeType: "text/plain", size: 5 }] },
	releasePromptAttachments: { sessionId, attachmentIds: ["attachment-1"] },
	prompt: { sessionId, composition },
	editMessage: { sessionId, timelineItemId: "item-1", text: "Revised" },
	abort: { sessionId },
	steer: { sessionId, composition },
	steerQueued: { sessionId, composition },
	queueFollowUp: { sessionId, composition },
	getAvailableCommands: { sessionId },
	getAvailableModels: { sessionId },
	getOpenRouterModelRouting: { sessionId, modelId: "provider/model" },
	setOpenRouterProviderEnabled: { sessionId, modelId: "provider/model", providerId: "provider", enabled: true },
	compact: { sessionId, instructions: "Preserve decisions" },
	handoff: { sessionId },
	retry: { sessionId },
	abortRetry: { sessionId },
	getSessionStats: { sessionId },
	exportHtml: { sessionId },
	requestPlanReview: { sessionId },
	updatePlanReview: {
		sessionId,
		reviewId: "review-1",
		content: "Plan",
		expectedRevision: "revision-1",
		annotationState: { annotations: [], deletedSections: [], additionalFeedback: "" },
	},
	resolvePlanReview: {
		sessionId,
		reviewId: "review-1",
		expectedRevision: "revision-1",
		decision: { kind: "approve", context: "fresh" },
	},
	setTodos: { sessionId, phases: [], expectedRevision: 0, action: "Replace todos" },
	setModel: { sessionId, provider: "provider", modelId: "model" },
	setThinking: { sessionId, level: "high" },
	setFastMode: { sessionId, enabled: true },
	togglePlanMode: { sessionId, enabled: true },
	setQueueMode: { sessionId, kind: "steering", mode: "all" },
	setInterruptMode: { sessionId, mode: "wait" },
	setAutoCompaction: { sessionId, enabled: true },
	setAutoRetry: { sessionId, enabled: true },
	getSubagentMessages: { sessionId, subagentId: "subagent-1", fromByte: 0 },
	getAgentHub: { sessionId },
	getAgentHubMessages: { sessionId, agentId: "agent-1", fromByte: 0 },
	agentHubMessage: { sessionId, agentId: "agent-1", message: "Status?" },
	agentHubKill: { sessionId, agentId: "agent-1" },
	agentHubClear: { sessionId, agentId: "agent-1" },
	agentHubRevive: { sessionId, agentId: "agent-1" },
	loadFileDiff: { sessionId, target: "src/main.ts" },
	loadWorkspaceFilePreview: { sessionId, target: "assets/logo.png", maxDimension: 1024 },
	openWorkspaceFile: { sessionId, target: "src/main.ts" },
	getAgentSettings: { sessionId },
	setAgentSetting: { sessionId, path: "ui.density", value: "compact" },
	getAgentPrompts: { sessionId },
	saveAgentPrompt: {
		sessionId,
		name: "reviewer",
		scope: "project",
		systemPrompt: "Review carefully",
		expectedRevision: null,
	},
	resetAgentPrompt: { sessionId, name: "reviewer", scope: "project", expectedRevision: "revision-1" },
	reconnectRuntime: {},
	openDesktopAccounts: {},
} satisfies { [Operation in HostedChatOperation]: HostedChatPayload<Operation> };

function envelope<Operation extends HostedChatOperation>(
	operation: Operation,
	payload: Record<string, unknown>,
): HostedRawCommandEnvelope {
	return { protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION, id: `command-${operation}`, operation, payload };
}

describe("validateHostedCommandPayload", () => {
	it("accepts one exact payload for every closed operation", () => {
		for (const operation of Object.keys(HOSTED_CHAT_OPERATION_NAMES) as HostedChatOperation[]) {
			expect(validateHostedCommandPayload(envelope(operation, validPayloads[operation]))).toMatchObject({
				operation,
			});
		}
	});

	it("accepts JSON setting maps and rejects non-finite nested values", () => {
		const value = { "openrouter/model": { enabled: false, reasons: ["budget", null] } };
		expect(
			validateHostedCommandPayload(
				envelope("setAgentSetting", { path: "providers.openrouterIgnoredProviders", value }),
			),
		).toMatchObject({
			operation: "setAgentSetting",
			payload: { path: "providers.openrouterIgnoredProviders", value },
		});
		expect(() =>
			validateHostedCommandPayload(
				envelope("setAgentSetting", {
					path: "providers.openrouterIgnoredProviders",
					value: { "openrouter/model": Number.NaN },
				}),
			),
		).toThrow(HostedPayloadValidationError);
	});

	it("rejects unknown payload fields for every closed operation", () => {
		for (const operation of Object.keys(HOSTED_CHAT_OPERATION_NAMES) as HostedChatOperation[]) {
			expect(() =>
				validateHostedCommandPayload(envelope(operation, { ...validPayloads[operation], unexpected: true })),
			).toThrow(HostedPayloadValidationError);
		}
	});

	it("rejects raw local path authority in hosted file and create commands", () => {
		for (const [operation, payload] of [
			["loadFileDiff", { sessionId, target: "C:\\Users\\owner\\secret.txt" }],
			["openWorkspaceFile", { sessionId, target: "../outside.txt" }],
			["createInWorkspace", { workspaceId: "workspace-1", kind: "code", cwd: "C:\\workspace" }],
			["exportHtml", { sessionId, outputPath: "C:\\export.html" }],
		] as const) {
			expect(() => validateHostedCommandPayload(envelope(operation, payload))).toThrow(HostedPayloadValidationError);
		}
	});
});

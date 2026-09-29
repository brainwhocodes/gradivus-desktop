import type {
	DesktopActionEvent,
	HostedAgentHubMessagePage,
	HostedAgentHubSnapshot,
	HostedAgentPrompt,
	HostedAgentPromptScope,
	HostedAgentSetting,
	HostedAgentSettingValue,
	HostedBootstrapSnapshot,
	HostedChatEvent,
	HostedCommandError,
	HostedContextMutationResult,
	HostedEditMessageResult,
	HostedFileView,
	HostedModelOption,
	HostedOpenRouterModelRouting,
	HostedPlanReview,
	HostedPlanReviewAnnotationState,
	HostedPlanReviewDecision,
	HostedPlanReviewResolution,
	HostedProcessState,
	HostedPromptAttachmentView,
	HostedPromptComposition,
	HostedQueueMode,
	HostedScope,
	HostedSessionKind,
	HostedSessionSnapshot,
	HostedSessionStats,
	HostedSlashCommand,
	HostedThinkingLevel,
	HostedTimelineItem,
	HostedTimelinePage,
	HostedTimelineToolActivity,
	HostedTodoPhase,
	HostedTodoState,
	HostedWorkspaceFilePreview,
} from "./contracts";

export const GRADIVUS_CHAT_PROTOCOL_VERSION = 1 as const;
export const GRADIVUS_CHAT_LOCAL_ORIGIN = "http://127.0.0.1:47832" as const;
export const GRADIVUS_CHAT_CLIENT_ID = "gradivus-chat-web" as const;
export const GRADIVUS_CHAT_ORIGIN = "https://gradivus.brainwhocodes.rocks" as const;
export const GRADIVUS_CHAT_CALLBACK_PATH = "/auth/callback" as const;
export const GRADIVUS_CHAT_REDIRECT_URI = `${GRADIVUS_CHAT_ORIGIN}${GRADIVUS_CHAT_CALLBACK_PATH}` as const;
export const GRADIVUS_CHAT_DEV_CLIENT_ID = "gradivus-chat-web-dev" as const;
export const GRADIVUS_CHAT_DEV_ORIGIN = "http://127.0.0.1:5190" as const;
export const GRADIVUS_CHAT_DEV_REDIRECT_URI = `${GRADIVUS_CHAT_DEV_ORIGIN}${GRADIVUS_CHAT_CALLBACK_PATH}` as const;
export const GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE = "gradivus-chat-api" as const;
export const GRADIVUS_CHAT_INITIAL_SCOPES = [
	"chat.read",
	"agent.execute",
	"sessions.manage",
	"files.read",
] as const satisfies readonly HostedScope[];
export const GRADIVUS_CHAT_EXPANDED_SCOPES = [
	...GRADIVUS_CHAT_INITIAL_SCOPES,
	"desktop.present",
] as const satisfies readonly HostedScope[];

export interface HostedNativeActionResult {
	action: DesktopActionEvent;
	snapshot?: HostedSessionSnapshot;
	bootstrap?: HostedBootstrapSnapshot;
}

export interface HostedExportResult {
	action: DesktopActionEvent;
	cancelled: boolean;
}

export interface HostedChatOperationMap {
	bootstrap: { payload: Record<string, never>; result: HostedBootstrapSnapshot };
	createInWorkspace: {
		payload: { workspaceId: string; kind: HostedSessionKind };
		result: HostedSessionSnapshot;
	};
	chooseWorkspaceAndCreate: { payload: { kind: HostedSessionKind }; result: HostedNativeActionResult };
	openSession: { payload: { sessionId: string }; result: HostedSessionSnapshot };
	resume: { payload: { sessionId: string }; result: HostedSessionSnapshot };
	stop: { payload: { sessionId: string }; result: HostedSessionSnapshot };
	restart: { payload: { sessionId: string }; result: HostedSessionSnapshot };
	rename: { payload: { sessionId: string; title: string }; result: HostedSessionSnapshot };
	deleteSession: {
		payload: { sessionId: string; confirmation: { sessionId: string; title: string } };
		result: HostedBootstrapSnapshot;
	};
	loadTimelinePage: {
		payload: { sessionId: string; before: number; limit: number };
		result: HostedTimelinePage;
	};
	loadTimelineItem: { payload: { sessionId: string; itemId: string }; result: HostedTimelineItem };
	loadTimelineToolDetail: {
		payload: { sessionId: string; itemId: string };
		result: HostedTimelineToolActivity;
	};
	stagePromptText: { payload: { sessionId: string; text: string }; result: HostedPromptAttachmentView };
	stagePromptAttachments: {
		payload: { sessionId: string; metadata: Array<{ name: string; mimeType?: string; size: number }> };
		result: HostedPromptAttachmentView[];
	};
	releasePromptAttachments: {
		payload: { sessionId: string; attachmentIds: string[] };
		result: null;
	};
	prompt: { payload: { sessionId: string; composition: HostedPromptComposition }; result: { requestId: string } };
	editMessage: {
		payload: { sessionId: string; timelineItemId: string; text: string };
		result: HostedEditMessageResult;
	};
	abort: { payload: { sessionId: string }; result: null };
	steer: { payload: { sessionId: string; composition: HostedPromptComposition }; result: null };
	steerQueued: { payload: { sessionId: string; composition: HostedPromptComposition }; result: null };
	queueFollowUp: { payload: { sessionId: string; composition: HostedPromptComposition }; result: null };
	getAvailableCommands: { payload: { sessionId: string }; result: HostedSlashCommand[] };
	getAvailableModels: { payload: { sessionId: string }; result: HostedModelOption[] };
	getOpenRouterModelRouting: {
		payload: { sessionId: string; modelId: string };
		result: HostedOpenRouterModelRouting;
	};
	setOpenRouterProviderEnabled: {
		payload: { sessionId: string; modelId: string; providerId: string; enabled: boolean };
		result: HostedOpenRouterModelRouting;
	};
	compact: { payload: { sessionId: string; instructions?: string }; result: HostedContextMutationResult };
	handoff: { payload: { sessionId: string; instructions?: string }; result: HostedContextMutationResult };
	retry: { payload: { sessionId: string }; result: { started: boolean } };
	abortRetry: { payload: { sessionId: string }; result: null };
	getSessionStats: { payload: { sessionId: string }; result: HostedSessionStats };
	exportHtml: { payload: { sessionId: string }; result: HostedExportResult };
	requestPlanReview: { payload: { sessionId: string }; result: HostedPlanReview };
	updatePlanReview: {
		payload: {
			sessionId: string;
			reviewId: string;
			content: string;
			expectedRevision: string;
			annotationState: HostedPlanReviewAnnotationState;
		};
		result: HostedPlanReview;
	};
	resolvePlanReview: {
		payload: {
			sessionId: string;
			reviewId: string;
			expectedRevision: string;
			decision: HostedPlanReviewDecision;
		};
		result: HostedPlanReviewResolution;
	};
	setTodos: {
		payload: { sessionId: string; phases: HostedTodoPhase[]; expectedRevision: number; action: string };
		result: HostedTodoState;
	};
	setModel: { payload: { sessionId: string; provider: string; modelId: string }; result: null };
	setThinking: { payload: { sessionId: string; level: HostedThinkingLevel }; result: null };
	setFastMode: { payload: { sessionId: string; enabled: boolean }; result: null };
	togglePlanMode: {
		payload: { sessionId: string; enabled?: boolean };
		result: { enabled: boolean; planFilePath?: string } | null;
	};
	setQueueMode: {
		payload: { sessionId: string; kind: "steering" | "follow-up"; mode: HostedQueueMode };
		result: null;
	};
	setInterruptMode: {
		payload: { sessionId: string; mode: "immediate" | "wait" };
		result: null;
	};
	setAutoCompaction: { payload: { sessionId: string; enabled: boolean }; result: null };
	setAutoRetry: { payload: { sessionId: string; enabled: boolean }; result: null };
	getSubagentMessages: {
		payload: { sessionId: string; subagentId: string; fromByte: number };
		result: HostedAgentHubMessagePage;
	};
	getAgentHub: { payload: { sessionId: string }; result: HostedAgentHubSnapshot };
	getAgentHubMessages: {
		payload: { sessionId: string; agentId: string; fromByte?: number };
		result: HostedAgentHubMessagePage;
	};
	agentHubMessage: { payload: { sessionId: string; agentId: string; message: string }; result: null };
	agentHubKill: { payload: { sessionId: string; agentId: string }; result: null };
	agentHubClear: { payload: { sessionId: string; agentId: string }; result: null };
	agentHubRevive: { payload: { sessionId: string; agentId: string }; result: null };
	loadFileDiff: { payload: { sessionId: string; target: string }; result: HostedFileView };
	loadWorkspaceFilePreview: {
		payload: { sessionId: string; target: string; maxDimension: number };
		result: HostedWorkspaceFilePreview;
	};
	openWorkspaceFile: { payload: { sessionId: string; target: string }; result: HostedNativeActionResult };
	getAgentSettings: { payload: { sessionId?: string }; result: HostedAgentSetting[] };
	setAgentSetting: {
		payload: { sessionId?: string; path: string; value: HostedAgentSettingValue };
		result: HostedAgentSetting;
	};
	getAgentPrompts: { payload: { sessionId?: string }; result: HostedAgentPrompt[] };
	saveAgentPrompt: {
		payload: {
			sessionId?: string;
			name: string;
			scope: HostedAgentPromptScope;
			systemPrompt: string;
			expectedRevision: string | null;
		};
		result: HostedAgentPrompt;
	};
	resetAgentPrompt: {
		payload: {
			sessionId?: string;
			name: string;
			scope: HostedAgentPromptScope;
			expectedRevision: string;
		};
		result: HostedAgentPrompt;
	};
	reconnectRuntime: { payload: Record<string, never>; result: HostedNativeActionResult };
	openDesktopAccounts: { payload: Record<string, never>; result: HostedNativeActionResult };
}

export type HostedChatOperation = keyof HostedChatOperationMap;
export type HostedChatPayload<Operation extends HostedChatOperation> = HostedChatOperationMap[Operation]["payload"];
export type HostedChatValue<Operation extends HostedChatOperation> = HostedChatOperationMap[Operation]["result"];

export type HostedChatCommand = {
	[Operation in HostedChatOperation]: {
		protocolVersion: typeof GRADIVUS_CHAT_PROTOCOL_VERSION;
		id: string;
		operation: Operation;
		payload: HostedChatPayload<Operation>;
	};
}[HostedChatOperation];

export type HostedChatSuccessResult<Operation extends HostedChatOperation = HostedChatOperation> = {
	protocolVersion: typeof GRADIVUS_CHAT_PROTOCOL_VERSION;
	id: string;
	ok: true;
	atSequence: number;
	value: HostedChatValue<Operation>;
};

export interface HostedChatFailureResult {
	protocolVersion: typeof GRADIVUS_CHAT_PROTOCOL_VERSION;
	id: string;
	ok: false;
	atSequence: number;
	error: HostedCommandError;
}

export type HostedChatResult<Operation extends HostedChatOperation = HostedChatOperation> =
	| HostedChatSuccessResult<Operation>
	| HostedChatFailureResult;

export const HOSTED_CHAT_OPERATION_NAMES = {
	bootstrap: true,
	createInWorkspace: true,
	chooseWorkspaceAndCreate: true,
	openSession: true,
	resume: true,
	stop: true,
	restart: true,
	rename: true,
	deleteSession: true,
	loadTimelinePage: true,
	loadTimelineItem: true,
	loadTimelineToolDetail: true,
	stagePromptText: true,
	stagePromptAttachments: true,
	releasePromptAttachments: true,
	prompt: true,
	editMessage: true,
	abort: true,
	steer: true,
	steerQueued: true,
	queueFollowUp: true,
	getAvailableCommands: true,
	getAvailableModels: true,
	getOpenRouterModelRouting: true,
	setOpenRouterProviderEnabled: true,
	compact: true,
	handoff: true,
	retry: true,
	abortRetry: true,
	getSessionStats: true,
	exportHtml: true,
	requestPlanReview: true,
	updatePlanReview: true,
	resolvePlanReview: true,
	setTodos: true,
	setModel: true,
	setThinking: true,
	setFastMode: true,
	togglePlanMode: true,
	setQueueMode: true,
	setInterruptMode: true,
	setAutoCompaction: true,
	setAutoRetry: true,
	getSubagentMessages: true,
	getAgentHub: true,
	getAgentHubMessages: true,
	agentHubMessage: true,
	agentHubKill: true,
	agentHubClear: true,
	agentHubRevive: true,
	loadFileDiff: true,
	loadWorkspaceFilePreview: true,
	openWorkspaceFile: true,
	getAgentSettings: true,
	setAgentSetting: true,
	getAgentPrompts: true,
	saveAgentPrompt: true,
	resetAgentPrompt: true,
	reconnectRuntime: true,
	openDesktopAccounts: true,
} as const satisfies Record<HostedChatOperation, true>;

export interface HostedRawCommandEnvelope {
	protocolVersion: typeof GRADIVUS_CHAT_PROTOCOL_VERSION;
	id: string;
	operation: HostedChatOperation;
	payload: Record<string, unknown>;
}

export type HostedCommandEnvelopeValidation =
	| { ok: true; value: HostedRawCommandEnvelope }
	| { ok: false; error: HostedCommandError };

function commandValidationError(code: "protocol_mismatch" | "validation_error", message: string): HostedCommandError {
	return { code, message, retryable: false };
}

export function isHostedChatOperation(value: unknown): value is HostedChatOperation {
	return typeof value === "string" && Object.hasOwn(HOSTED_CHAT_OPERATION_NAMES, value);
}

export function validateHostedCommandEnvelope(value: unknown): HostedCommandEnvelopeValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: commandValidationError("validation_error", "Command must be a JSON object.") };
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (
		keys.length !== 4 ||
		!Object.hasOwn(record, "protocolVersion") ||
		!Object.hasOwn(record, "id") ||
		!Object.hasOwn(record, "operation") ||
		!Object.hasOwn(record, "payload")
	) {
		return {
			ok: false,
			error: commandValidationError(
				"validation_error",
				"Command must contain only protocolVersion, id, operation, and payload.",
			),
		};
	}
	if (record.protocolVersion !== GRADIVUS_CHAT_PROTOCOL_VERSION) {
		return {
			ok: false,
			error: commandValidationError(
				"protocol_mismatch",
				`Gradivus Chat protocol ${GRADIVUS_CHAT_PROTOCOL_VERSION} is required.`,
			),
		};
	}
	if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) {
		return { ok: false, error: commandValidationError("validation_error", "Command id is invalid.") };
	}
	if (!isHostedChatOperation(record.operation)) {
		return { ok: false, error: commandValidationError("validation_error", "Command operation is unknown.") };
	}
	if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
		return { ok: false, error: commandValidationError("validation_error", "Command payload must be an object.") };
	}
	return {
		ok: true,
		value: {
			protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
			id: record.id,
			operation: record.operation,
			payload: record.payload as Record<string, unknown>,
		},
	};
}

export function hostedChatSuccess<Operation extends HostedChatOperation>(
	id: string,
	atSequence: number,
	value: HostedChatValue<Operation>,
): HostedChatSuccessResult<Operation> {
	return { protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION, id, ok: true, atSequence, value };
}

export function hostedChatFailure(id: string, atSequence: number, error: HostedCommandError): HostedChatFailureResult {
	return { protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION, id, ok: false, atSequence, error };
}

export interface HostedAuthorizationServerMetadata {
	issuer: typeof GRADIVUS_CHAT_LOCAL_ORIGIN;
	authorization_endpoint: `${typeof GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/authorize`;
	token_endpoint: `${typeof GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/token`;
	revocation_endpoint: `${typeof GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/revoke`;
	response_types_supported: ["code"];
	grant_types_supported: ["authorization_code"];
	code_challenge_methods_supported: ["S256"];
	scopes_supported: HostedScope[];
	protocol_versions_supported: [typeof GRADIVUS_CHAT_PROTOCOL_VERSION];
	client_id: string;
	desktop_version: string;
}

export interface HostedOAuthTokenResponse {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	scope: string;
}

export type HostedStreamMessage =
	| { type: "stream_ready"; epoch: string; currentSequence: number }
	| { type: "chat_event"; epoch: string; sequence: number; event: HostedChatEvent }
	| { type: "reset_required"; epoch: string; currentSequence: number }
	| { type: "heartbeat"; epoch: string; currentSequence: number };

export interface HostedCommandPolicy {
	requiredScopes: readonly HostedScope[];
	requiresActiveGrant: true;
	requiresDesktopPresent: boolean;
	requiresSession: boolean;
	surface: "chat" | null;
	allowedStates: readonly HostedProcessState[];
	confirmation: "none" | "object-delete" | "desktop";
	payloadType: string;
	resultType: string;
	validator: string;
	projector: string;
}

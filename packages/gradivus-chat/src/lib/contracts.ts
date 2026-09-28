export const MAX_INLINE_PROMPT_BYTES = 512 * 1024;
export const MAX_TEMP_PROMPT_BYTES = 16 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BATCH_BYTES = 32 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_COUNT = 12;

export type HostedScope = "chat.read" | "agent.execute" | "sessions.manage" | "files.read" | "desktop.present";
export type HostedSessionKind = "work" | "code";
export type HostedModelInputModality = "text" | "image";
export type HostedProcessState = "stopped" | "starting" | "ready" | "running" | "stopping" | "error";
export type HostedThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type HostedQueueMode = "all" | "one-at-a-time";
export type HostedInterruptMode = "immediate" | "wait";
export type HostedTimelineTone = "neutral" | "info" | "success" | "warning" | "error";
export type HostedTodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type HostedAgentPromptScope = "project" | "user";

export interface HostedWorkspaceView {
	id: string;
	name: string;
}

export interface HostedSessionRuntimeConfig {
	model?: string;
	thinkingLevel?: HostedThinkingLevel;
	fastMode?: boolean;
	planMode?: { enabled: boolean; planFilePath?: string; workflow?: string };
	steeringMode?: HostedQueueMode;
	followUpMode?: HostedQueueMode;
	interruptMode?: HostedInterruptMode;
	autoCompactionEnabled?: boolean;
	autoRetryEnabled?: boolean;
}

export interface HostedSessionRecord {
	id: string;
	kind: HostedSessionKind;
	workspace: HostedWorkspaceView;
	title: string | null;
	createdAt: string;
	lastOpenedAt: string;
}

export interface HostedPromptAttachmentView {
	id: string;
	name: string;
	size: number;
	kind: "file" | "image" | "prompt";
	reference: string;
}

export type HostedPromptCompositionPart = { type: "text"; text: string } | { type: "attachment"; id: string };

export interface HostedPromptComposition {
	parts: HostedPromptCompositionPart[];
}

export interface HostedTimelineImage {
	data: string;
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface HostedTimelineFileChange {
	path: string;
	operation: "write" | "edit";
	disposition?: "created" | "edited";
}

export interface HostedTimelineEvalCellDetail {
	index: number;
	title?: string;
	language?: string;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	code: string;
	output: string;
	omittedCodeLineCount?: number;
	omittedOutputLineCount?: number;
	statusEvents?: string[];
}

export type HostedTimelineToolActivity =
	| {
			operation: "read";
			path: string;
			range?: string;
			count?: number;
			preview: string[];
			expandedPreview: string[];
	  }
	| { operation: "write"; path: string; preview: string[] }
	| { operation: "edit"; paths: string[]; diff: string[] }
	| { operation: "hub"; operationName: string; target?: string }
	| {
			operation: "eval";
			languages: string[];
			title?: string;
			cellCount: number;
			durationMs: number;
			codePreview: string[];
			outputPreview: string[];
			omittedLineCount: number;
			omittedImageCount: number;
			detailsLoaded: boolean;
			cells?: HostedTimelineEvalCellDetail[];
			jsonOutputs?: string[];
			images?: HostedTimelineImage[];
			statusEvents?: string[];
	  };

export type HostedTimelinePresentationMeta = Array<{ label: string; value: string }>;

export type HostedTimelinePresentation =
	| {
			type: "status";
			category: "notice" | "command" | "model" | "thinking" | "fallback" | "compaction" | "todo" | "retry";
			tone: HostedTimelineTone;
			title: string;
			source?: string;
			meta?: HostedTimelinePresentationMeta;
			entries?: Array<{ label: string; value: string; tone?: HostedTimelineTone }>;
			omittedCount?: number;
	  }
	| {
			type: "activity";
			category: "job" | "tangent" | "process" | "diagnostics" | "files";
			tone: HostedTimelineTone;
			title: string;
			entries: Array<{ label: string; value?: string; status?: string }>;
			omittedCount?: number;
	  }
	| {
			type: "irc";
			direction: "incoming" | "autoreply" | "relay";
			from?: string;
			to?: string;
			reply?: string;
			previewLines: string[];
			omittedCount?: number;
	  }
	| {
			type: "advisor";
			notes: Array<{ note: string; severity: "nit" | "concern" | "blocker"; advisor?: string }>;
			total: number;
			blockerCount: number;
			omittedCount?: number;
	  }
	| {
			type: "custom";
			variant: "system" | "collab" | "skill" | "extension" | "hook";
			title: string;
			attribution?: string;
			meta?: HostedTimelinePresentationMeta;
			previewLines: string[];
			omittedCount?: number;
			collapsed?: boolean;
	  }
	| {
			type: "context";
			transition: "compaction" | "branch" | "handoff";
			title: string;
			tokenCount?: number;
			frameCount?: number;
			warning?: string;
			previewLines: string[];
			omittedCount?: number;
	  }
	| {
			type: "execution";
			engine: "bash" | "python";
			input: string;
			outputPreview: string[];
			state: "running" | "complete" | "cancelled" | "error";
			exitCode?: number;
			truncated: boolean;
			excludedFromContext: boolean;
			omittedCount?: number;
	  }
	| {
			type: "assistant-outcome";
			mode: "recovered" | "error";
			tone: HostedTimelineTone;
			label: string;
			previewLines: string[];
			omittedCount?: number;
	  };

export interface HostedTimelineItem {
	id: string;
	kind: "user" | "assistant" | "thinking" | "tool" | "special" | "raw";
	text: string;
	textLoaded?: boolean;
	detail?: string;
	toolName?: string;
	toolCallId?: string;
	status?: "running" | "complete" | "error";
	images?: HostedTimelineImage[];
	files?: HostedTimelineFileChange[];
	toolActivity?: HostedTimelineToolActivity;
	isError?: boolean;
	timestamp?: string;
	role?: string;
	createdAt?: number;
	presentation?: HostedTimelinePresentation;
}

export interface HostedTimelinePage {
	items: HostedTimelineItem[];
	start: number;
	total: number;
}

export interface HostedSubagentView {
	id: string;
	agent: string;
	status: string;
	task?: string;
	assignment?: string;
	progress?: {
		currentTool?: string;
		lastIntent?: string;
		tokens?: number;
		contextTokens?: number;
		contextWindow?: number;
		cost?: number;
		durationMs?: number;
		recentOutput?: string[];
		resolvedModel?: string;
		requests?: number;
	};
}

export interface HostedAgentHubMetrics {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	contextTokens?: number;
	contextWindow?: number;
}

export interface HostedAgentHubAgent {
	id: string;
	displayName: string;
	kind: "sub" | "advisor";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	activity?: string;
	createdAt: number;
	lastActivity: number;
	transcriptAvailable: boolean;
	readOnly: boolean;
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	metrics?: HostedAgentHubMetrics;
	progress?: HostedSubagentView["progress"];
}

export interface HostedAgentHubSnapshot {
	agents: HostedAgentHubAgent[];
}

export interface HostedAgentHubTranscriptEntry {
	id: string;
	kind: "user" | "assistant" | "thinking" | "tool" | "status";
	text: string;
	createdAt?: number;
}

export interface HostedAgentHubMessagePage {
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: HostedAgentHubTranscriptEntry[];
}

export interface HostedTodoItem {
	id: string;
	content: string;
	status: HostedTodoStatus;
	blocker?: string;
	parentId?: string;
}

export interface HostedTodoPhase {
	id: string;
	name: string;
	tasks: HostedTodoItem[];
}

export interface HostedTodoState {
	phases: HostedTodoPhase[];
	revision: number;
}

export interface HostedPlanReviewAnnotationState {
	annotations: Array<{
		section: { index: number; title: string; path?: string[]; contentHash?: string };
		target: { kind: "section" } | { kind: "line"; row: number; context: string; contextTruncated?: boolean };
		note: string;
	}>;
	deletedSections: string[];
	additionalFeedback: string;
}

export interface HostedPlanReviewExecutionModel {
	role: string;
	provider: string;
	modelId: string;
	label: string;
	thinkingLevel?: string;
}

export interface HostedPlanReview {
	id: string;
	title: string;
	planFilePath: string;
	revision: string;
	status: "ready" | "awaiting_refinement" | "applying" | "failed";
	phase:
		| "ready"
		| "awaiting_refinement"
		| "accepted"
		| "mode_exited"
		| "session_reset"
		| "compaction_finished"
		| "prompt_admitted"
		| "failed";
	content: string;
	annotationState: HostedPlanReviewAnnotationState;
	suggestedSaveName: string;
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	keepContextDisabled: boolean;
	executionModels: HostedPlanReviewExecutionModel[];
	defaultExecutionRole?: string;
	error?: string;
}

export type HostedPlanReviewDecision =
	| { kind: "approve"; context: "fresh" | "compact" | "keep"; executionRole?: string }
	| { kind: "refine"; feedback: string; composition?: HostedPromptComposition }
	| { kind: "save" };

export type HostedPlanReviewResolution =
	| {
			accepted: true;
			awaitingRefinement?: true;
			savedPath?: string;
			createdSession?: HostedSessionSnapshot;
	  }
	| { accepted: false; cancelled: true };

export interface HostedRuntimeState {
	phase: "dormant" | "queued" | "starting" | "resident" | "stopping";
	processState: HostedProcessState;
	healthy: boolean;
	lastUsedAt: number;
	sampledAt?: number;
	queuedAt?: number;
	error?: string;
}

export interface HostedSessionRetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
}

export interface HostedSessionSnapshot extends HostedSessionRuntimeConfig {
	record: HostedSessionRecord;
	state: HostedProcessState;
	timeline: HostedTimelineItem[];
	timelineStart?: number;
	timelineTotal?: number;
	subagents: HostedSubagentView[];
	agentHub?: HostedAgentHubSnapshot;
	commands?: HostedSlashCommand[];
	contextTokens?: number;
	contextWindow?: number;
	tokensPerSecond?: number | null;
	queuedMessageCount?: number;
	todoState: HostedTodoState;
	isStreaming?: boolean;
	isCompacting?: boolean;
	retryState?: HostedSessionRetryState;
	warning?: string;
	runtime?: HostedRuntimeState;
	planReviewSupported: boolean;
	planReview?: HostedPlanReview;
}

export interface HostedBootstrapSnapshot {
	workspaces: HostedWorkspaceView[];
	sessions: HostedSessionRecord[];
	activeSessionId: string | null;
	warning?: string;
}

export interface HostedSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
}

export interface HostedModelOption {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: HostedModelInputModality[];
	contextWindow?: number;
}

export interface HostedOpenRouterProviderOption {
	id: string;
	name: string;
	enabled: boolean;
}

export interface HostedOpenRouterModelRouting {
	modelId: string;
	providers: HostedOpenRouterProviderOption[];
}

export type HostedAgentSettingJsonValue =
	| null
	| boolean
	| number
	| string
	| HostedAgentSettingJsonValue[]
	| { [key: string]: HostedAgentSettingJsonValue };

export type HostedAgentSettingValue =
	| boolean
	| string
	| number
	| string[]
	| Record<string, HostedAgentSettingJsonValue>;
export type HostedAgentSettingTab =
	| "appearance"
	| "model"
	| "interaction"
	| "context"
	| "memory"
	| "files"
	| "shell"
	| "tools"
	| "tasks"
	| "providers";

export type HostedAgentSettingOptionValue = string | number;

export interface HostedAgentSettingOption {
	value: HostedAgentSettingOptionValue;
	label: string;
	description?: string;
}

export interface HostedAgentSetting {
	path: string;
	tab: HostedAgentSettingTab;
	group?: string;
	label: string;
	description: string;
	warning?: string;
	control: "toggle" | "select" | "multiselect" | "text" | "json" | "provider-limits";
	value: HostedAgentSettingValue;
	options?: HostedAgentSettingOption[];
	ordered?: boolean;
}

export interface HostedAgentPromptOverride {
	systemPrompt: string;
	revision: string;
}

export interface HostedAgentPrompt {
	name: string;
	description: string;
	effectiveSource: "project" | "user" | "bundled";
	systemPrompt: string;
	project?: HostedAgentPromptOverride;
	user?: HostedAgentPromptOverride;
	apply: "next-spawn";
}

export interface HostedSessionStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: { tokens: number; contextWindow: number; percentage?: number };
}

export interface HostedContextMutationResult {
	beforeTokens: number;
	afterTokens: number;
	changed: boolean;
	savedPath?: string;
}

export interface HostedEditMessageResult {
	cancelled: boolean;
	snapshot: HostedSessionSnapshot;
	requestId?: string;
	error?: string;
}

export type HostedFileView =
	| {
			kind: "diff";
			path: string;
			diff: string;
			status: "modified" | "added" | "deleted" | "renamed" | "clean" | "binary" | "unavailable";
			additions: number;
			deletions: number;
			truncated: boolean;
			message?: string;
	  }
	| { kind: "image"; path: string; dataUrl: string; width: number; height: number };

export interface HostedAppearanceSettings {
	theme: "dark" | "light" | "system";
	density: "comfortable" | "compact";
	reduceMotion: boolean;
	showToolDetails: boolean;
}

export type DesktopActionKind =
	| "choose_workspace"
	| "save_export"
	| "open_file"
	| "open_accounts"
	| "extension_attention";
export type DesktopActionState = "pending" | "completed" | "cancelled" | "failed";

export interface DesktopActionEvent {
	actionId: string;
	kind: DesktopActionKind;
	state: DesktopActionState;
	message?: string;
}

export type HostedChatEvent =
	| {
			type: "session";
			sessionId: string;
			state?: HostedProcessState;
			record?: HostedSessionRecord;
			runtime?: HostedRuntimeState;
			isStreaming?: boolean;
			isCompacting?: boolean;
			retryState?: HostedSessionRetryState;
	  }
	| { type: "timeline"; sessionId: string; item: HostedTimelineItem }
	| { type: "subagents"; sessionId: string; subagents: HostedSubagentView[] }
	| { type: "agent_hub_update"; sessionId: string; agentHub: HostedAgentHubSnapshot }
	| { type: "commands"; sessionId: string; commands: HostedSlashCommand[] }
	| { type: "config"; sessionId: string; config: HostedSessionRuntimeConfig }
	| {
			type: "prompt_result";
			sessionId: string;
			requestId?: string;
			agentInvoked?: boolean;
			error?: HostedCommandError;
	  }
	| { type: "todo_update"; sessionId: string; todoState: HostedTodoState }
	| { type: "warning"; sessionId: string; message: string }
	| { type: "plan_review"; sessionId: string; planReview?: HostedPlanReview }
	| { type: "session_reset"; sessionId: string; snapshot: HostedSessionSnapshot }
	| { type: "desktop_action"; action: DesktopActionEvent }
	| { type: "extension_attention"; sessionId: string; action: DesktopActionEvent };

export type HostedCommandErrorCode =
	| "protocol_mismatch"
	| "unauthorized"
	| "grant_expired"
	| "grant_revoked"
	| "scope_denied"
	| "validation_error"
	| "session_not_found"
	| "runtime_unavailable"
	| "provider_auth_required"
	| "conflict"
	| "desktop_action_cancelled"
	| "desktop_action_failed"
	| "attachment_too_large"
	| "attachment_count_exceeded"
	| "attachment_type_unsupported";

export type HostedErrorDetailValue = string | number | boolean | null;

export interface HostedCommandError {
	code: HostedCommandErrorCode;
	message: string;
	retryable: boolean;
	details?: Record<string, HostedErrorDetailValue>;
}

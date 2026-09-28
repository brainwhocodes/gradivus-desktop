/**
 * Application payload types carried by the headless gRPC API.
 *
 * Transport framing metadata is represented by `@oh-my-pi/pi-grpc`; these
 * objects retain the existing command and event shapes used by the dispatcher.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { PlanReviewAnnotationState } from "@oh-my-pi/pi-utils/plan-review";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { PlanReviewDecision } from "../../plan-mode/review-controller";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { FileEntry, SessionEntry, SessionTreeNode } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { SubagentEventPayload, SubagentLifecyclePayload, SubagentProgressPayload } from "../../task";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { BrowserTabInventory } from "../../tools/browser/tab-supervisor";
import type { AgentPromptScope, RpcAgentPromptView } from "./rpc-agents";
import type { RpcFileDiffResult } from "./rpc-file-diff";
import type { RpcMessagesPage } from "./rpc-messages";
import type { RpcOpenRouterModelRouting } from "./rpc-openrouter-routing";

// ============================================================================
// RPC Commands
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "steer_queued"; message: string }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "open_session"; sessionDir: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| {
			id?: string;
			type: "set_plan_mode";
			enabled: boolean;
			planFilePath?: string;
			workflow?: "parallel" | "iterative";
	  }
	| { id?: string; type: "request_plan_review" }
	| {
			id?: string;
			type: "update_plan_review";
			reviewId: string;
			content: string;
			expectedRevision: string;
			annotationState: PlanReviewAnnotationState;
	  }
	| {
			id?: string;
			type: "resolve_plan_review";
			reviewId: string;
			expectedRevision: string;
			decision: PlanReviewDecision;
	  }
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_setting"; path: string; value: RpcSettingValue }
	| { id?: string; type: "get_agent_prompts" }
	| {
			id?: string;
			type: "save_agent_prompt";
			name: string;
			scope: AgentPromptScope;
			systemPrompt: string;
			expectedRevision: string | null;
	  }
	| {
			id?: string;
			type: "reset_agent_prompt";
			name: string;
			scope: AgentPromptScope;
			expectedRevision: string;
	  }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[]; expectedRevision: number; action: string }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "set_event_filter"; events: string[] | null }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "get_agent_hub" }
	| { id?: string; type: "get_agent_hub_messages"; agentId: string; fromByte?: number }
	| { id?: string; type: "agent_hub_message"; agentId: string; message: string }
	| { id?: string; type: "agent_hub_kill"; agentId: string }
	| { id?: string; type: "agent_hub_clear"; agentId: string }
	| { id?: string; type: "agent_hub_revive"; agentId: string }
	| { id?: string; type: "get_oauth_accounts" }
	| { id?: string; type: "set_oauth_account_lock"; providerId: string; credentialId?: number }
	| { id?: string; type: "set_oauth_account_failover"; enabled: boolean }
	| { id?: string; type: "remove_oauth_account"; providerId: string; credentialId: number }
	| { id?: string; type: "get_file_diff"; path: string }
	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "get_openrouter_model_routing"; modelId: string }
	| { id?: string; type: "set_openrouter_provider_enabled"; modelId: string; providerId: string; enabled: boolean }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "close_browser_tab"; name: string; confirm?: boolean }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "logout"; providerId: string };

// ============================================================================
// RPC State
// ============================================================================

export type RpcSettingJsonValue =
	| null
	| boolean
	| string
	| number
	| RpcSettingJsonValue[]
	| { [key: string]: RpcSettingJsonValue };
export type RpcSettingValue = RpcSettingJsonValue;
export type RpcSettingTab =
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

export interface RpcSettingOption {
	value: string | number;
	label: string;
	description?: string;
}

export interface RpcTodoState {
	phases: TodoPhase[];
	revision: number;
}

export interface RpcSettingView {
	path: string;
	tab: RpcSettingTab;
	group?: string;
	label: string;
	description: string;
	warning?: string;
	control: "toggle" | "select" | "multiselect" | "text" | "json" | "provider-limits";
	value: RpcSettingValue;
	options?: RpcSettingOption[];
	ordered?: boolean;
}
export interface RpcRuntimeMetrics {
	pid: number;
	uptimeMs: number;
	residentMemoryBytes: number;
	heapUsedBytes: number;
	heapTotalBytes: number;
	externalMemoryBytes: number;
}
export interface RpcPlanReviewExecutionModel {
	role: string;
	provider: string;
	modelId: string;
	label: string;
	thinkingLevel?: string;
}

export interface RpcPlanReviewState {
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
	annotationState: PlanReviewAnnotationState;
	suggestedSaveName: string;
	contextUsage?: ContextUsage;
	keepContextDisabled: boolean;
	executionModels: RpcPlanReviewExecutionModel[];
	defaultExecutionRole?: string;
	error?: string;
}

export interface RpcPlanReviewUpdateFrame {
	type: "plan_review_update";
	planReview?: RpcPlanReviewState;
	sessionReset?: { sessionId: string; sessionFile?: string; sessionName?: string };
}

export interface RpcSessionState {
	capabilities: { planReview: 1 };
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	todoState: RpcTodoState;
	runtime: RpcRuntimeMetrics;
	/** Background jobs or deliveries can still inject a follow-up and wake the session. */
	hasPendingAsyncWork: boolean;
	/** Same predicate as `session_settled`: idle with nothing queued or pending. */
	isSettled: boolean;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	/** Current plan mode state. */
	planMode?: { enabled: boolean; planFilePath?: string; workflow?: "parallel" | "iterative" };
	planReview?: RpcPlanReviewState;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}
export interface RpcConfigUpdateFrame {
	type: "config_update";
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	planMode?: { enabled: boolean; planFilePath?: string; workflow?: "parallel" | "iterative" };
}

/** How a prompt's work ended, as reported by its {@link RpcPromptResultFrame}. */
export type RpcPromptStatus = "completed" | "aborted" | "error";

/**
 * Failure detail for a `prompt_result` with `status: "error"`. `message` is the
 * provider's error text without OMP-local diagnostics (e.g. request dump paths).
 */
export interface RpcPromptError {
	message: string;
	provider?: string;
	model?: string;
	/** HTTP status reported by the provider, when the failure came from a request. */
	httpStatus?: number;
	/** The failure is classified transient: resubmitting later may succeed. OMP's own retries are already exhausted. */
	retryable: boolean;
}

/**
 * Terminal frame emitted exactly once per accepted `prompt`/`abort_and_prompt`,
 * after all work the prompt caused has settled. Correlate on `id`.
 */
export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	/** False when the prompt completed locally (slash command) or failed before reaching the agent. */
	agentInvoked: boolean;
	error?: RpcPromptError & { code?: string };
	status: RpcPromptStatus;
	/**
	 * The agent yielded and nothing will wake the session again: no run is live and no
	 * queued message or background job (async bash/task/eval) will inject a follow-up.
	 * When false, a {@link RpcSessionSettledFrame} follows once that work is done.
	 */
	sessionSettled: boolean;
}

/**
 * Emitted when the session goes quiet after agent activity: the last run yielded
 * and no background work remains that could inject messages and wake it again.
 * Distinct from a terminal `agent_end`, which only means one run yielded.
 */
export interface RpcSessionSettledFrame {
	type: "session_settled";
}

/** `open_session` result: `resumed` is false when a fresh session was started in the directory. */
export interface RpcOpenSessionResult {
	cancelled: boolean;
	resumed: boolean;
	sessionId: string;
	sessionFile?: string;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

export type RpcAgentHubAgentKind = "sub" | "advisor";
export type RpcAgentHubAgentStatus = "running" | "idle" | "parked" | "aborted";

export interface RpcAgentHubMetrics {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	contextTokens?: number;
	contextWindow?: number;
}

/** Safe, stable roster row for the retained Agent Hub. */
export interface RpcAgentHubAgent {
	id: string;
	displayName: string;
	kind: RpcAgentHubAgentKind;
	parentId?: string;
	status: RpcAgentHubAgentStatus;
	activity?: string;
	createdAt: number;
	lastActivity: number;
	transcriptAvailable: boolean;
	readOnly: boolean;
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	metrics?: RpcAgentHubMetrics;
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

export interface RpcAgentHubSnapshot {
	agents: RpcAgentHubAgent[];
}

/** Incremental transcript page addressed by agent id, never by a renderer path. */
export interface RpcAgentHubMessagePage {
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

export interface RpcAgentHubActionResult {
	agentId: string;
}

export interface RpcAgentHubUpdateFrame extends RpcAgentHubSnapshot {
	type: "agent_hub_update";
}

export interface RpcOAuthAccount {
	credentialId: number;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	projectId?: string;
	active: boolean;
	locked: boolean;
	lockable: boolean;
}

export interface RpcOAuthProvider {
	id: string;
	name: string;
	available: boolean;
	failover: boolean;
	lockedCredentialId?: number;
	accounts: RpcOAuthAccount[];
}

export interface RpcOAuthAccounts {
	providers: RpcOAuthProvider[];
}

// ============================================================================
// RPC Responses
// ============================================================================

// Success responses with data
export type RpcResponse =
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "steer_queued"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "open_session"; success: true; data: RpcOpenSessionResult }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_file_diff"; success: true; data: RpcFileDiffResult }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_plan_mode";
			success: true;
			data: { planMode?: { enabled: boolean; planFilePath?: string; workflow?: "parallel" | "iterative" } };
	  }
	| {
			id?: string;
			type: "response";
			command: "request_plan_review" | "update_plan_review";
			success: true;
			data: { planReview: RpcPlanReviewState };
	  }
	| {
			id?: string;
			type: "response";
			command: "resolve_plan_review";
			success: true;
			data: { accepted: true; awaitingRefinement?: true };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_settings";
			success: true;
			data: { settings: RpcSettingView[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_setting";
			success: true;
			data: { setting: RpcSettingView };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_agent_prompts";
			success: true;
			data: { agents: RpcAgentPromptView[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "save_agent_prompt" | "reset_agent_prompt";
			success: true;
			data: { agent: RpcAgentPromptView };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoState: RpcTodoState } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| { id?: string; type: "response"; command: "set_event_filter"; success: true; data: { events: string[] | null } }
	| {
			id?: string;
			type: "response";
			command: "close_browser_tab";
			success: true;
			data: {
				closed: boolean;
				requiresConfirmation?: boolean;
				tab?: BrowserTabInventory;
				inventory: readonly BrowserTabInventory[];
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "get_agent_hub";
			success: true;
			data: RpcAgentHubSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_agent_hub_messages";
			success: true;
			data: RpcAgentHubMessagePage;
	  }
	| {
			id?: string;
			type: "response";
			command: "agent_hub_message";
			success: true;
			data: RpcAgentHubActionResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "agent_hub_kill";
			success: true;
			data: RpcAgentHubActionResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "agent_hub_revive";
			success: true;
			data: RpcAgentHubActionResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "agent_hub_clear";
			success: true;
			data: RpcAgentHubActionResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_openrouter_model_routing";
			success: true;
			data: RpcOpenRouterModelRouting;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_openrouter_provider_enabled";
			success: true;
			data: RpcOpenRouterModelRouting;
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }
	// OAuth accounts
	| {
			id?: string;
			type: "response";
			command:
				| "get_oauth_accounts"
				| "set_oauth_account_lock"
				| "set_oauth_account_failover"
				| "remove_oauth_account";
			success: true;
			data: RpcOAuthAccounts;
	  }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }
	| { id?: string; type: "response"; command: "logout"; success: true; data: { providerId: string } }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ============================================================================
// Subagent Events
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export interface RpcBrowserInventoryUpdateFrame {
	type: "browser_inventory_update";
	inventory: readonly BrowserTabInventory[];
}
export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

/** Message lifecycle event kinds that RPC mode stamps with a `messageId`. */
export type RpcMessageEventType = "message_start" | "message_update" | "message_end";

/**
 * Message lifecycle frame as written by RPC mode. `messageId` is shared by the
 * `message_start`, every `message_update`, and the `message_end` of one message;
 * it is unique within the RPC process.
 */
export type RpcMessageEventFrame = Extract<AgentSessionEvent, { type: RpcMessageEventType }> & { messageId: string };

/** Session event as written to stdout: message lifecycle events carry a `messageId`. */
export type RpcAgentSessionEventFrame =
	| Exclude<AgentSessionEvent, { type: RpcMessageEventType }>
	| RpcMessageEventFrame;

export type RpcSessionEventFrame =
	| RpcAgentSessionEventFrame
	| RpcSubagentFrame
	| RpcPromptResultFrame
	| RpcAgentHubUpdateFrame
	| RpcBrowserInventoryUpdateFrame
	| RpcPlanReviewUpdateFrame;

// ============================================================================
// Extension UI Events
// ============================================================================
/** Positional presentation metadata for an RPC select option. */
export interface RpcExtensionUISelectOptionDetail {
	description?: string;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			optionDetails?: RpcExtensionUISelectOptionDetail[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			sensitive?: boolean;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Messages
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
	/** Whether this host tool can read `skill://` instruction content. */
	readsSkillUris?: boolean;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Messages
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Responses
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
/** Chunk envelope used by the v2 frame reassembler. */
export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

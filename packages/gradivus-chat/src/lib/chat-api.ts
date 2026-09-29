import type {
	HostedAgentHubMessagePage,
	HostedAgentHubSnapshot,
	HostedAgentPrompt,
	HostedAgentPromptScope,
	HostedAgentSetting,
	HostedAgentSettingValue,
	HostedBootstrapSnapshot,
	HostedChatEvent,
	HostedContextMutationResult,
	HostedEditMessageResult,
	HostedFileView,
	HostedModelOption,
	HostedOpenRouterModelRouting,
	HostedPlanReview,
	HostedPlanReviewAnnotationState,
	HostedPlanReviewDecision,
	HostedPlanReviewResolution,
	HostedPromptAttachmentView,
	HostedPromptComposition,
	HostedQueueMode,
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
import type { HostedExportResult, HostedNativeActionResult } from "./protocol";

export interface ChatApi {
	bootstrap(): Promise<HostedBootstrapSnapshot>;
	createInWorkspace(workspaceId: string, kind: HostedSessionKind): Promise<HostedSessionSnapshot>;
	chooseWorkspaceAndCreate(kind: HostedSessionKind): Promise<HostedNativeActionResult>;
	openSession(sessionId: string): Promise<HostedSessionSnapshot>;
	resume(sessionId: string): Promise<HostedSessionSnapshot>;
	stop(sessionId: string): Promise<HostedSessionSnapshot>;
	restart(sessionId: string): Promise<HostedSessionSnapshot>;
	rename(sessionId: string, title: string): Promise<HostedSessionSnapshot>;
	deleteSession(
		sessionId: string,
		confirmation: { sessionId: string; title: string },
	): Promise<HostedBootstrapSnapshot>;
	loadTimelinePage(sessionId: string, before: number, limit: number): Promise<HostedTimelinePage>;
	loadTimelineItem(sessionId: string, itemId: string): Promise<HostedTimelineItem>;
	loadTimelineToolDetail(sessionId: string, itemId: string): Promise<HostedTimelineToolActivity>;
	stagePromptText(sessionId: string, text: string): Promise<HostedPromptAttachmentView>;
	stagePromptAttachments(sessionId: string, files: readonly File[]): Promise<HostedPromptAttachmentView[]>;
	releasePromptAttachments(sessionId: string, attachmentIds: string[]): Promise<void>;
	prompt(sessionId: string, composition: HostedPromptComposition): Promise<string>;
	editMessage(sessionId: string, timelineItemId: string, text: string): Promise<HostedEditMessageResult>;
	abort(sessionId: string): Promise<void>;
	steer(sessionId: string, composition: HostedPromptComposition): Promise<void>;
	steerQueued(sessionId: string, composition: HostedPromptComposition): Promise<void>;
	queueFollowUp(sessionId: string, composition: HostedPromptComposition): Promise<void>;
	getAvailableCommands(sessionId: string): Promise<HostedSlashCommand[]>;
	getAvailableModels(sessionId: string): Promise<HostedModelOption[]>;
	getOpenRouterModelRouting(sessionId: string, modelId: string): Promise<HostedOpenRouterModelRouting>;
	setOpenRouterProviderEnabled(
		sessionId: string,
		modelId: string,
		providerId: string,
		enabled: boolean,
	): Promise<HostedOpenRouterModelRouting>;
	compact(sessionId: string, instructions?: string): Promise<HostedContextMutationResult>;
	handoff(sessionId: string, instructions?: string): Promise<HostedContextMutationResult>;
	retry(sessionId: string): Promise<{ started: boolean }>;
	abortRetry(sessionId: string): Promise<void>;
	getSessionStats(sessionId: string): Promise<HostedSessionStats>;
	exportHtml(sessionId: string): Promise<HostedExportResult>;
	requestPlanReview(sessionId: string): Promise<HostedPlanReview>;
	updatePlanReview(
		sessionId: string,
		reviewId: string,
		content: string,
		expectedRevision: string,
		annotationState: HostedPlanReviewAnnotationState,
	): Promise<HostedPlanReview>;
	resolvePlanReview(
		sessionId: string,
		reviewId: string,
		expectedRevision: string,
		decision: HostedPlanReviewDecision,
	): Promise<HostedPlanReviewResolution>;
	setTodos(
		sessionId: string,
		phases: HostedTodoPhase[],
		expectedRevision: number,
		action: string,
	): Promise<HostedTodoState>;
	setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
	setThinking(sessionId: string, level: HostedThinkingLevel): Promise<void>;
	setFastMode(sessionId: string, enabled: boolean): Promise<void>;
	togglePlanMode(
		sessionId: string,
		enabled?: boolean,
	): Promise<{ enabled: boolean; planFilePath?: string } | undefined>;
	setQueueMode(sessionId: string, kind: "steering" | "follow-up", mode: HostedQueueMode): Promise<void>;
	setInterruptMode(sessionId: string, mode: "immediate" | "wait"): Promise<void>;
	setAutoCompaction(sessionId: string, enabled: boolean): Promise<void>;
	setAutoRetry(sessionId: string, enabled: boolean): Promise<void>;
	getSubagentMessages(sessionId: string, subagentId: string, fromByte: number): Promise<HostedAgentHubMessagePage>;
	getAgentHub(sessionId: string): Promise<HostedAgentHubSnapshot>;
	getAgentHubMessages(sessionId: string, agentId: string, fromByte?: number): Promise<HostedAgentHubMessagePage>;
	agentHubMessage(sessionId: string, agentId: string, message: string): Promise<void>;
	agentHubKill(sessionId: string, agentId: string): Promise<void>;
	agentHubClear(sessionId: string, agentId: string): Promise<void>;
	agentHubRevive(sessionId: string, agentId: string): Promise<void>;
	loadFileDiff(sessionId: string, target: string): Promise<HostedFileView>;
	loadWorkspaceFilePreview(sessionId: string, target: string, maxDimension: number): Promise<HostedWorkspaceFilePreview>;
	openWorkspaceFile(sessionId: string, target: string): Promise<HostedNativeActionResult>;
	getAgentSettings(sessionId?: string): Promise<HostedAgentSetting[]>;
	setAgentSetting(
		sessionId: string | undefined,
		path: string,
		value: HostedAgentSettingValue,
	): Promise<HostedAgentSetting>;
	getAgentPrompts(sessionId?: string): Promise<HostedAgentPrompt[]>;
	saveAgentPrompt(
		sessionId: string | undefined,
		name: string,
		scope: HostedAgentPromptScope,
		systemPrompt: string,
		expectedRevision: string | null,
	): Promise<HostedAgentPrompt>;
	resetAgentPrompt(
		sessionId: string | undefined,
		name: string,
		scope: HostedAgentPromptScope,
		expectedRevision: string,
	): Promise<HostedAgentPrompt>;
	reconnectRuntime(): Promise<HostedNativeActionResult>;
	openDesktopAccounts(): Promise<HostedNativeActionResult>;
	onEvent(listener: (event: HostedChatEvent) => void): () => void;
	/** Authoritative bootstrap after a browser transport reconnect; existing drafts may be retained. */
	onReconnect?(listener: (snapshot: HostedBootstrapSnapshot) => void): () => void;
}

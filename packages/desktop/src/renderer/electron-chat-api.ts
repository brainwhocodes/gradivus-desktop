import type {
	ChatApi,
	DesktopActionEvent,
	HostedAgentHubMessagePage,
	HostedBootstrapSnapshot,
	HostedChatEvent,
	HostedFileView,
	HostedPlanReviewResolution,
	HostedSessionRecord,
	HostedSessionSnapshot,
	HostedSessionStats,
	HostedTimelineImage,
	HostedTimelineItem,
	HostedTimelineToolActivity,
} from "@gradivus/chat";
import type {
	AgentHubMessagePage,
	BootstrapSnapshot,
	GradivusApi,
	GradivusEvent,
	PlanReviewResolutionResult,
	SessionRecordV1,
	SessionSnapshot,
	SessionStatsView,
	TimelineImage,
	TimelineItem,
	TimelineToolActivity,
} from "../shared/contracts";

export interface ElectronChatApiOptions {
	openAccounts: () => void;
}

function workspaceName(cwd: string): string {
	const segments = cwd.replaceAll("\\", "/").split("/").filter(Boolean);
	return segments.at(-1) ?? "Workspace";
}

function projectRecord(record: SessionRecordV1): HostedSessionRecord {
	return {
		id: record.id,
		kind: record.kind,
		workspace: { id: record.cwd, name: workspaceName(record.cwd) },
		title: record.title,
		createdAt: record.createdAt,
		lastOpenedAt: record.lastOpenedAt,
	};
}

function projectImage(image: TimelineImage): HostedTimelineImage | undefined {
	if (
		image.mimeType !== "image/png" &&
		image.mimeType !== "image/jpeg" &&
		image.mimeType !== "image/gif" &&
		image.mimeType !== "image/webp"
	) {
		return undefined;
	}
	return { data: image.data, mimeType: image.mimeType };
}

function projectToolActivity(activity: TimelineToolActivity): HostedTimelineToolActivity {
	switch (activity.operation) {
		case "read":
			return {
				operation: "read",
				path: activity.path,
				range: activity.range,
				count: activity.count,
				preview: activity.preview,
				expandedPreview: activity.expandedPreview,
			};
		case "write":
			return { operation: "write", path: activity.path, preview: activity.preview };
		case "edit":
			return { operation: "edit", paths: activity.paths, diff: activity.diff };
		case "hub":
			return { operation: "hub", operationName: activity.operationName, target: activity.target };
		case "eval":
			return {
				operation: "eval",
				languages: activity.languages,
				title: activity.title,
				cellCount: activity.cellCount,
				durationMs: activity.durationMs,
				codePreview: activity.codePreview,
				outputPreview: activity.outputPreview,
				omittedLineCount: activity.omittedLineCount,
				omittedImageCount: activity.omittedImageCount,
				detailsLoaded: activity.detailsLoaded,
				cells: activity.cells,
				jsonOutputs: activity.jsonOutputs,
				images: activity.images?.flatMap(image => {
					const projected = projectImage(image);
					return projected ? [projected] : [];
				}),
				statusEvents: activity.statusEvents,
			};
	}
}

function projectTimelineItem(item: TimelineItem): HostedTimelineItem {
	return {
		id: item.id,
		kind: item.kind,
		text: item.text,
		textLoaded: item.textLoaded,
		detail: item.detail,
		toolName: item.toolName,
		toolCallId: item.toolCallId,
		status: item.status,
		images: item.images?.flatMap(image => {
			const projected = projectImage(image);
			return projected ? [projected] : [];
		}),
		files: item.files,
		toolActivity: item.toolActivity ? projectToolActivity(item.toolActivity) : undefined,
		isError: item.isError,
		timestamp: item.timestamp,
		role: item.role,
		createdAt: item.createdAt,
		presentation: item.presentation,
	};
}

function projectSnapshot(snapshot: SessionSnapshot): HostedSessionSnapshot {
	return {
		record: projectRecord(snapshot.record),
		state: snapshot.state,
		timeline: snapshot.timeline.map(projectTimelineItem),
		timelineStart: snapshot.timelineStart,
		timelineTotal: snapshot.timelineTotal,
		subagents: snapshot.subagents,
		agentHub: snapshot.agentHub,
		commands: snapshot.commands,
		contextTokens: snapshot.contextTokens,
		contextWindow: snapshot.contextWindow,
		tokensPerSecond: snapshot.tokensPerSecond,
		queuedMessageCount: snapshot.queuedMessageCount,
		todoState: snapshot.todoState,
		isStreaming: snapshot.isStreaming,
		isCompacting: snapshot.isCompacting,
		retryState: snapshot.retryState,
		warning: snapshot.warning,
		runtime: snapshot.runtime
			? {
					phase: snapshot.runtime.phase,
					processState: snapshot.runtime.processState,
					healthy: snapshot.runtime.healthy,
					lastUsedAt: snapshot.runtime.lastUsedAt,
					sampledAt: snapshot.runtime.sampledAt,
					queuedAt: snapshot.runtime.queuedAt,
					error: snapshot.runtime.error,
				}
			: undefined,
		planReviewSupported: snapshot.planReviewSupported,
		planReview: snapshot.planReview,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		fastMode: snapshot.fastMode,
		planMode: snapshot.planMode,
		steeringMode: snapshot.steeringMode,
		followUpMode: snapshot.followUpMode,
		interruptMode: snapshot.interruptMode,
		autoCompactionEnabled: snapshot.autoCompactionEnabled,
		autoRetryEnabled: snapshot.autoRetryEnabled,
	};
}

function projectBootstrap(snapshot: BootstrapSnapshot): HostedBootstrapSnapshot {
	const visible = snapshot.registry.sessions.filter(record => record.surface !== "browser-selection");
	const sessions = visible.map(projectRecord);
	const workspaces = [...new Map(sessions.map(record => [record.workspace.id, record.workspace])).values()];
	const visibleIds = new Set(sessions.map(record => record.id));
	const activeSessionId = [snapshot.registry.activeByKind.work, snapshot.registry.activeByKind.code].find(
		id => id !== null && visibleIds.has(id),
	);
	return { workspaces, sessions, activeSessionId: activeSessionId ?? null, warning: snapshot.warning };
}

function projectStats(stats: SessionStatsView): HostedSessionStats {
	return {
		userMessages: stats.userMessages,
		assistantMessages: stats.assistantMessages,
		toolCalls: stats.toolCalls,
		toolResults: stats.toolResults,
		totalMessages: stats.totalMessages,
		tokens: stats.tokens,
		premiumRequests: stats.premiumRequests,
		cost: stats.cost,
		contextUsage: stats.contextUsage,
	};
}

function projectPlanResolution(result: PlanReviewResolutionResult): HostedPlanReviewResolution {
	if (!result.accepted) return { accepted: false, cancelled: true };
	return {
		accepted: true,
		awaitingRefinement: result.awaitingRefinement,
		savedPath: result.savedPath,
		createdSession: result.createdSession ? projectSnapshot(result.createdSession) : undefined,
	};
}

function transcriptPage(value: AgentHubMessagePage | unknown): HostedAgentHubMessagePage {
	if (typeof value !== "object" || value === null) return { fromByte: 0, nextByte: 0, reset: false, entries: [] };
	const record = value as Record<string, unknown>;
	const source = [
		...(Array.isArray(record.entries) ? record.entries : []),
		...(Array.isArray(record.messages) ? record.messages : []),
	];
	return {
		fromByte: typeof record.fromByte === "number" ? record.fromByte : 0,
		nextByte: typeof record.nextByte === "number" ? record.nextByte : 0,
		reset: record.reset === true,
		entries: source.map((entry, index) => {
			const candidate = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
			const role =
				typeof candidate.role === "string"
					? candidate.role
					: typeof candidate.type === "string"
						? candidate.type
						: "status";
			const kind =
				role === "user" || role === "assistant" || role === "thinking" || role === "tool" ? role : "status";
			const text =
				typeof candidate.text === "string"
					? candidate.text
					: typeof candidate.content === "string"
						? candidate.content
						: JSON.stringify(entry);
			return {
				id: typeof candidate.id === "string" ? candidate.id : `${record.fromByte ?? 0}:${index}`,
				kind,
				text,
				createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : undefined,
			};
		}),
	};
}

function action(kind: DesktopActionEvent["kind"], state: DesktopActionEvent["state"]): DesktopActionEvent {
	return { actionId: crypto.randomUUID(), kind, state };
}

function projectEvent(event: GradivusEvent): HostedChatEvent | undefined {
	switch (event.type) {
		case "session":
			return {
				type: "session",
				sessionId: event.sessionId,
				state: event.state,
				record: event.record ? projectRecord(event.record) : undefined,
				runtime: event.runtime
					? {
							phase: event.runtime.phase,
							processState: event.runtime.processState,
							healthy: event.runtime.healthy,
							lastUsedAt: event.runtime.lastUsedAt,
							sampledAt: event.runtime.sampledAt,
							queuedAt: event.runtime.queuedAt,
							error: event.runtime.error,
						}
					: undefined,
				isStreaming: event.isStreaming,
				isCompacting: event.isCompacting,
				retryState: event.retryState,
			};
		case "timeline":
			return event.item
				? { type: "timeline", sessionId: event.sessionId, item: projectTimelineItem(event.item) }
				: undefined;
		case "subagents":
			return event.subagents
				? { type: "subagents", sessionId: event.sessionId, subagents: event.subagents }
				: undefined;
		case "agent_hub_update":
			return event.agentHub
				? { type: "agent_hub_update", sessionId: event.sessionId, agentHub: event.agentHub }
				: undefined;
		case "commands":
			return event.commands ? { type: "commands", sessionId: event.sessionId, commands: event.commands } : undefined;
		case "config":
			return event.config ? { type: "config", sessionId: event.sessionId, config: event.config } : undefined;
		case "prompt_result":
			return {
				type: "prompt_result",
				sessionId: event.sessionId,
				requestId: event.requestId,
				agentInvoked: event.agentInvoked,
				error: event.error
					? { code: "runtime_unavailable", message: event.error.message, retryable: true }
					: undefined,
			};
		case "todo_update":
			return event.todoState
				? { type: "todo_update", sessionId: event.sessionId, todoState: event.todoState }
				: undefined;
		case "warning":
			return event.message ? { type: "warning", sessionId: event.sessionId, message: event.message } : undefined;
		case "plan_review":
			return { type: "plan_review", sessionId: event.sessionId, planReview: event.planReview };
		case "session_reset":
			return event.snapshot
				? { type: "session_reset", sessionId: event.sessionId, snapshot: projectSnapshot(event.snapshot) }
				: undefined;
		case "extension":
			return {
				type: "extension_attention",
				sessionId: event.sessionId,
				action: action("extension_attention", event.extension ? "pending" : "completed"),
			};
		case "browser_inventory":
			return undefined;
	}
}

export function createElectronChatApi(source: GradivusApi, options: ElectronChatApiOptions): ChatApi {
	return {
		bootstrap: async () => projectBootstrap(await source.bootstrap()),
		createInWorkspace: async (workspaceId, kind) => {
			const snapshot = await source.chooseAndCreate(kind, workspaceId);
			if (!snapshot) throw new Error("No workspace selected");
			return projectSnapshot(snapshot);
		},
		chooseWorkspaceAndCreate: async kind => {
			const snapshot = await source.chooseAndCreate(kind);
			return {
				action: action("choose_workspace", snapshot ? "completed" : "cancelled"),
				snapshot: snapshot ? projectSnapshot(snapshot) : undefined,
			};
		},
		openSession: async sessionId => projectSnapshot(await source.openSession(sessionId)),
		resume: async sessionId => projectSnapshot(await source.resume(sessionId)),
		stop: async sessionId => projectSnapshot(await source.stop(sessionId)),
		restart: async sessionId => projectSnapshot(await source.restart(sessionId)),
		rename: async (sessionId, title) => projectSnapshot(await source.rename(sessionId, title)),
		deleteSession: async sessionId => projectBootstrap(await source.deleteSession(sessionId)),
		loadTimelinePage: async (sessionId, before, limit) => {
			const page = await source.loadTimelinePage(sessionId, before, limit);
			return { items: page.items.map(projectTimelineItem), start: page.start, total: page.total };
		},
		loadTimelineItem: async (sessionId, itemId) =>
			projectTimelineItem(await source.loadTimelineItem(sessionId, itemId)),
		loadTimelineToolDetail: async (sessionId, itemId) =>
			projectToolActivity(await source.loadTimelineToolDetail(sessionId, itemId)),
		stagePromptText: (sessionId, text) => source.stagePromptText(sessionId, text),
		stagePromptAttachments: async (sessionId, files) =>
			source.stagePromptAttachments(
				sessionId,
				await Promise.all(
					files.map(async file => ({
						name: file.name,
						mimeType: file.type || undefined,
						data: new Uint8Array(await file.arrayBuffer()),
					})),
				),
			),
		releasePromptAttachments: (sessionId, attachmentIds) => source.releasePromptAttachments(sessionId, attachmentIds),
		prompt: (sessionId, composition) => source.prompt(sessionId, composition),
		editMessage: async (sessionId, timelineItemId, text) => {
			const result = await source.editMessage(sessionId, timelineItemId, text);
			return { ...result, snapshot: projectSnapshot(result.snapshot) };
		},
		abort: sessionId => source.abort(sessionId),
		steer: (sessionId, composition) => source.steer(sessionId, composition),
		steerQueued: (sessionId, composition) => source.steerQueued(sessionId, composition),
		queueFollowUp: (sessionId, composition) => source.queueFollowUp(sessionId, composition),
		getAvailableCommands: sessionId => source.getAvailableCommands(sessionId),
		getAvailableModels: sessionId => source.getAvailableModels(sessionId),
		getOpenRouterModelRouting: (sessionId, modelId) => source.getOpenRouterModelRouting(sessionId, modelId),
		setOpenRouterProviderEnabled: (sessionId, modelId, providerId, enabled) =>
			source.setOpenRouterProviderEnabled(sessionId, modelId, providerId, enabled),
		compact: async (sessionId, instructions) => {
			const result = await source.compact(sessionId, instructions);
			return {
				beforeTokens: result.beforeTokens,
				afterTokens: result.afterTokens,
				changed: result.changed,
				savedPath: result.savedPath,
			};
		},
		handoff: async (sessionId, instructions) => {
			const result = await source.handoff(sessionId, instructions);
			return {
				beforeTokens: result.beforeTokens,
				afterTokens: result.afterTokens,
				changed: result.changed,
				savedPath: result.savedPath,
			};
		},
		retry: sessionId => source.retry(sessionId),
		abortRetry: sessionId => source.abortRetry(sessionId),
		getSessionStats: async sessionId => projectStats(await source.getSessionStats(sessionId)),
		exportHtml: async sessionId => {
			const result = await source.exportHtml(sessionId);
			return {
				action: action("save_export", result.cancelled ? "cancelled" : "completed"),
				cancelled: result.cancelled,
			};
		},
		requestPlanReview: sessionId => source.requestPlanReview(sessionId),
		updatePlanReview: (sessionId, reviewId, content, expectedRevision, annotationState) =>
			source.updatePlanReview(sessionId, reviewId, content, expectedRevision, annotationState),
		resolvePlanReview: async (sessionId, reviewId, expectedRevision, decision) =>
			projectPlanResolution(await source.resolvePlanReview(sessionId, reviewId, expectedRevision, decision)),
		setTodos: (sessionId, phases, expectedRevision, summary) =>
			source.setTodos(sessionId, phases, expectedRevision, summary),
		setModel: (sessionId, provider, modelId) => source.setModel(sessionId, provider, modelId),
		setThinking: (sessionId, level) => source.setThinking(sessionId, level),
		setFastMode: (sessionId, enabled) => source.setFastMode(sessionId, enabled),
		togglePlanMode: async (sessionId, enabled) => (await source.togglePlanMode(sessionId, enabled)) ?? undefined,
		setQueueMode: (sessionId, kind, mode) => source.setQueueMode(sessionId, kind, mode),
		setInterruptMode: (sessionId, mode) => source.setInterruptMode(sessionId, mode),
		setAutoCompaction: (sessionId, enabled) => source.setAutoCompaction(sessionId, enabled),
		setAutoRetry: (sessionId, enabled) => source.setAutoRetry(sessionId, enabled),
		getSubagentMessages: async (sessionId, subagentId, fromByte) =>
			transcriptPage(await source.getSubagentMessages(sessionId, subagentId, fromByte)),
		getAgentHub: sessionId => source.getAgentHub(sessionId),
		getAgentHubMessages: async (sessionId, agentId, fromByte) =>
			transcriptPage(await source.getAgentHubMessages(sessionId, agentId, fromByte)),
		agentHubMessage: (sessionId, agentId, message) => source.agentHubMessage(sessionId, agentId, message),
		agentHubKill: (sessionId, agentId) => source.agentHubKill(sessionId, agentId),
		agentHubClear: (sessionId, agentId) => source.agentHubClear(sessionId, agentId),
		agentHubRevive: (sessionId, agentId) => source.agentHubRevive(sessionId, agentId),
		loadFileDiff: async (sessionId, target): Promise<HostedFileView> => ({
			kind: "diff",
			...(await source.loadFileDiff(sessionId, target)),
		}),
		loadWorkspaceImage: async (sessionId, target, maxDimension): Promise<HostedFileView> => ({
			kind: "image",
			...(await source.loadWorkspaceImage(sessionId, target, maxDimension)),
		}),
		openWorkspaceFile: async (sessionId, target) => {
			await source.openWorkspaceFile(sessionId, target);
			return { action: action("open_file", "completed") };
		},
		getAgentSettings: sessionId => source.getAgentSettings(sessionId),
		setAgentSetting: (sessionId, path, value) => source.setAgentSetting(sessionId, path, value),
		getAgentPrompts: sessionId => source.getAgentPrompts(sessionId),
		saveAgentPrompt: (sessionId, name, scope, systemPrompt, expectedRevision) =>
			source.saveAgentPrompt(sessionId, name, scope, systemPrompt, expectedRevision),
		resetAgentPrompt: (sessionId, name, scope, expectedRevision) =>
			source.resetAgentPrompt(sessionId, name, scope, expectedRevision),
		reconnectRuntime: async () => {
			await source.reconnectRuntime();
			return { action: action("open_accounts", "completed") };
		},
		openDesktopAccounts: async () => {
			options.openAccounts();
			return { action: action("open_accounts", "completed") };
		},
		onEvent: listener =>
			source.onEvent(event => {
				const projected = projectEvent(event);
				if (projected) listener(projected);
			}),
	};
}

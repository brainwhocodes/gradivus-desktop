import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	DesktopActionEvent,
	HostedAgentHubAgent,
	HostedAgentHubMessagePage,
	HostedAgentHubSnapshot,
	HostedAgentPrompt,
	HostedAgentSetting,
	HostedBootstrapSnapshot,
	HostedChatEvent,
	HostedContextMutationResult,
	HostedEditMessageResult,
	HostedFileView,
	HostedModelOption,
	HostedOpenRouterModelRouting,
	HostedPlanReview,
	HostedPlanReviewResolution,
	HostedPromptAttachmentView,
	HostedRuntimeState,
	HostedSessionRecord,
	HostedSessionRuntimeConfig,
	HostedSessionSnapshot,
	HostedSessionStats,
	HostedSlashCommand,
	HostedSubagentView,
	HostedTimelineImage,
	HostedTimelineItem,
	HostedTimelinePage,
	HostedTimelinePresentation,
	HostedTimelineToolActivity,
	HostedTodoState,
	HostedWorkspaceView,
	HostedWorkspaceFilePreview,
} from "@gradivus/chat/contracts";
import type {
	AgentHubAgent,
	AgentHubMessagePage,
	AgentHubSnapshot,
	AgentPromptView,
	AgentSettingView,
	BootstrapSnapshot,
	ContextMutationResult,
	EditMessageResult,
	FileDiffView,
	GradivusEvent,
	ModelOption,
	OpenRouterModelRouting,
	PlanReviewResolutionResult,
	PlanReviewView,
	PromptAttachmentView,
	RuntimeReportView,
	SessionRecordV1,
	SessionRuntimeConfig,
	SessionSnapshot,
	SessionStatsView,
	SlashCommand,
	SubagentView,
	TimelineImage,
	TimelineItem,
	TimelinePage,
	TimelinePresentation,
	TimelineToolActivity,
	TodoState,
} from "../shared/contracts";

interface ProjectedWorkspace {
	root: string;
	view: HostedWorkspaceView;
}

const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s<>"'`]+/g;
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=])\/(?:Users|home|tmp|var|private|opt|etc|mnt|workspace)\/[^\s<>"'`)]+/g;

function normalizeSlashes(value: string): string {
	return value.replaceAll("\\", "/");
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function relativeDisplayPath(root: string, target: string): string | undefined {
	const resolved = path.resolve(root, target);
	if (!isWithin(root, resolved)) return undefined;
	const relative = normalizeSlashes(path.relative(root, resolved));
	return relative || ".";
}

function sanitizeText(value: string, workspaceRoot: string, sensitiveValues: readonly string[] = []): string {
	let sanitized = value;
	const replacements = [
		workspaceRoot,
		normalizeSlashes(workspaceRoot),
		os.homedir(),
		normalizeSlashes(os.homedir()),
		...sensitiveValues,
	]
		.filter(candidate => candidate.length > 0)
		.sort((left, right) => right.length - left.length);
	for (const candidate of replacements)
		sanitized = sanitized.replaceAll(candidate, candidate === workspaceRoot ? "." : "[local value hidden]");
	sanitized = sanitized.replace(WINDOWS_ABSOLUTE_PATH, "[local path hidden]");
	sanitized = sanitized.replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}[local path hidden]`);
	return sanitized;
}

function projectTimelineImage(image: TimelineImage): HostedTimelineImage | undefined {
	if (!image.mimeType.match(/^image\/(png|jpeg|gif|webp)$/)) return undefined;
	return {
		data: image.data,
		mimeType: image.mimeType as HostedTimelineImage["mimeType"],
	};
}

function projectTimelinePresentation(
	presentation: TimelinePresentation,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedTimelinePresentation {
	const clean = (value: string): string => sanitizeText(value, workspaceRoot, sensitiveValues);
	switch (presentation.type) {
		case "status":
			return {
				type: "status",
				category: presentation.category,
				tone: presentation.tone,
				title: clean(presentation.title),
				source: presentation.source ? clean(presentation.source) : undefined,
				meta: presentation.meta?.map(item => ({ label: clean(item.label), value: clean(item.value) })),
				entries: presentation.entries?.map(item => ({
					label: clean(item.label),
					value: clean(item.value),
					tone: item.tone,
				})),
				omittedCount: presentation.omittedCount,
			};
		case "activity":
			return {
				type: "activity",
				category: presentation.category,
				tone: presentation.tone,
				title: clean(presentation.title),
				entries: presentation.entries.map(item => ({
					label: clean(item.label),
					value: item.value ? clean(item.value) : undefined,
					status: item.status ? clean(item.status) : undefined,
				})),
				omittedCount: presentation.omittedCount,
			};
		case "irc":
			return {
				type: "irc",
				direction: presentation.direction,
				from: presentation.from ? clean(presentation.from) : undefined,
				to: presentation.to ? clean(presentation.to) : undefined,
				reply: presentation.reply ? clean(presentation.reply) : undefined,
				previewLines: presentation.previewLines.map(clean),
				omittedCount: presentation.omittedCount,
			};
		case "advisor":
			return {
				type: "advisor",
				notes: presentation.notes.map(note => ({
					note: clean(note.note),
					severity: note.severity,
					advisor: note.advisor ? clean(note.advisor) : undefined,
				})),
				total: presentation.total,
				blockerCount: presentation.blockerCount,
				omittedCount: presentation.omittedCount,
			};
		case "custom":
			return {
				type: "custom",
				variant: presentation.variant,
				title: clean(presentation.title),
				attribution: presentation.attribution ? clean(presentation.attribution) : undefined,
				meta: presentation.meta?.map(item => ({ label: clean(item.label), value: clean(item.value) })),
				previewLines: presentation.previewLines.map(clean),
				omittedCount: presentation.omittedCount,
				collapsed: presentation.collapsed,
			};
		case "context":
			return {
				type: "context",
				transition: presentation.transition,
				title: clean(presentation.title),
				tokenCount: presentation.tokenCount,
				frameCount: presentation.frameCount,
				warning: presentation.warning ? clean(presentation.warning) : undefined,
				previewLines: presentation.previewLines.map(clean),
				omittedCount: presentation.omittedCount,
			};
		case "execution":
			return {
				type: "execution",
				engine: presentation.engine,
				input: clean(presentation.input),
				outputPreview: presentation.outputPreview.map(clean),
				state: presentation.state,
				exitCode: presentation.exitCode,
				truncated: presentation.truncated,
				excludedFromContext: presentation.excludedFromContext,
				omittedCount: presentation.omittedCount,
			};
		case "assistant-outcome":
			return {
				type: "assistant-outcome",
				mode: presentation.mode,
				tone: presentation.tone,
				label: clean(presentation.label),
				previewLines: presentation.previewLines.map(clean),
				omittedCount: presentation.omittedCount,
			};
	}
}

function projectToolActivity(
	activity: TimelineToolActivity,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedTimelineToolActivity | undefined {
	const clean = (value: string): string => sanitizeText(value, workspaceRoot, sensitiveValues);
	switch (activity.operation) {
		case "read": {
			const target = relativeDisplayPath(workspaceRoot, activity.path);
			if (!target) return undefined;
			return {
				operation: "read",
				path: target,
				range: activity.range,
				count: activity.count,
				preview: activity.preview.map(clean),
				expandedPreview: activity.expandedPreview.map(clean),
			};
		}
		case "write": {
			const target = relativeDisplayPath(workspaceRoot, activity.path);
			if (!target) return undefined;
			return { operation: "write", path: target, preview: activity.preview.map(clean) };
		}
		case "edit": {
			const paths = activity.paths
				.map(target => relativeDisplayPath(workspaceRoot, target))
				.filter((target): target is string => target !== undefined);
			if (paths.length === 0) return undefined;
			return { operation: "edit", paths, diff: activity.diff.map(clean) };
		}
		case "hub":
			return {
				operation: "hub",
				operationName: clean(activity.operationName),
				target: activity.target ? clean(activity.target) : undefined,
			};
		case "eval":
			return {
				operation: "eval",
				languages: activity.languages.map(clean),
				title: activity.title ? clean(activity.title) : undefined,
				cellCount: activity.cellCount,
				durationMs: activity.durationMs,
				codePreview: activity.codePreview.map(clean),
				outputPreview: activity.outputPreview.map(clean),
				omittedLineCount: activity.omittedLineCount,
				omittedImageCount: activity.omittedImageCount,
				detailsLoaded: activity.detailsLoaded,
				cells: activity.cells?.map(cell => ({
					index: cell.index,
					title: cell.title ? clean(cell.title) : undefined,
					language: cell.language ? clean(cell.language) : undefined,
					status: cell.status,
					durationMs: cell.durationMs,
					exitCode: cell.exitCode,
					code: clean(cell.code),
					output: clean(cell.output),
					omittedCodeLineCount: cell.omittedCodeLineCount,
					omittedOutputLineCount: cell.omittedOutputLineCount,
					statusEvents: cell.statusEvents?.map(clean),
				})),
				jsonOutputs: activity.jsonOutputs?.map(clean),
				images: activity.images
					?.map(projectTimelineImage)
					.filter((image): image is HostedTimelineImage => image !== undefined),
				statusEvents: activity.statusEvents?.map(clean),
			};
	}
}

function projectSubagent(
	subagent: SubagentView,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedSubagentView {
	const clean = (value: string): string => sanitizeText(value, workspaceRoot, sensitiveValues);
	return {
		id: subagent.id,
		agent: clean(subagent.agent),
		status: clean(subagent.status),
		task: subagent.task ? clean(subagent.task) : undefined,
		assignment: subagent.assignment ? clean(subagent.assignment) : undefined,
		progress: subagent.progress
			? {
					currentTool: subagent.progress.currentTool ? clean(subagent.progress.currentTool) : undefined,
					lastIntent: subagent.progress.lastIntent ? clean(subagent.progress.lastIntent) : undefined,
					tokens: subagent.progress.tokens,
					contextTokens: subagent.progress.contextTokens,
					contextWindow: subagent.progress.contextWindow,
					cost: subagent.progress.cost,
					durationMs: subagent.progress.durationMs,
					recentOutput: subagent.progress.recentOutput?.map(clean),
					resolvedModel: subagent.progress.resolvedModel ? clean(subagent.progress.resolvedModel) : undefined,
					requests: subagent.progress.requests,
				}
			: undefined,
	};
}

function projectAgentHubAgent(
	agent: AgentHubAgent,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedAgentHubAgent {
	const clean = (value: string): string => sanitizeText(value, workspaceRoot, sensitiveValues);
	return {
		id: agent.id,
		displayName: clean(agent.displayName),
		kind: agent.kind,
		parentId: agent.parentId,
		status: agent.status,
		activity: agent.activity ? clean(agent.activity) : undefined,
		createdAt: agent.createdAt,
		lastActivity: agent.lastActivity,
		transcriptAvailable: agent.transcriptAvailable,
		readOnly: agent.readOnly,
		agent: agent.agent ? clean(agent.agent) : undefined,
		modelRole: agent.modelRole ? clean(agent.modelRole) : undefined,
		resolvedModel: agent.resolvedModel ? clean(agent.resolvedModel) : undefined,
		metrics: agent.metrics
			? {
					tokens: agent.metrics.tokens,
					requests: agent.metrics.requests,
					tools: agent.metrics.tools,
					cost: agent.metrics.cost,
					durationMs: agent.metrics.durationMs,
					contextTokens: agent.metrics.contextTokens,
					contextWindow: agent.metrics.contextWindow,
				}
			: undefined,
		progress: agent.progress
			? {
					currentTool: agent.progress.currentTool ? clean(agent.progress.currentTool) : undefined,
					lastIntent: agent.progress.lastIntent ? clean(agent.progress.lastIntent) : undefined,
					tokens: agent.progress.tokens,
					contextTokens: agent.progress.contextTokens,
					contextWindow: agent.progress.contextWindow,
					cost: agent.progress.cost,
					durationMs: agent.progress.durationMs,
					recentOutput: agent.progress.recentOutput?.map(clean),
					resolvedModel: agent.progress.resolvedModel ? clean(agent.progress.resolvedModel) : undefined,
					requests: agent.progress.requests,
				}
			: undefined,
	};
}

function projectTodoState(
	todoState: TodoState,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedTodoState {
	const clean = (value: string): string => sanitizeText(value, workspaceRoot, sensitiveValues);
	return {
		revision: todoState.revision,
		phases: todoState.phases.map(phase => ({
			id: phase.id,
			name: clean(phase.name),
			tasks: phase.tasks.map(task => ({
				id: task.id,
				content: clean(task.content),
				status: task.status,
				blocker: task.blocker ? clean(task.blocker) : undefined,
				parentId: task.parentId,
			})),
		})),
	};
}

function projectPlanReview(
	review: PlanReviewView,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedPlanReview {
	const clean = (value: string): string => sanitizeText(value, workspaceRoot, sensitiveValues);
	return {
		id: review.id,
		title: clean(review.title),
		planFilePath: relativeDisplayPath(workspaceRoot, review.planFilePath) ?? path.basename(review.planFilePath),
		revision: review.revision,
		status: review.status,
		phase: review.phase,
		content: clean(review.content),
		annotationState: {
			annotations: review.annotationState.annotations.map(annotation => ({
				section: {
					index: annotation.section.index,
					title: clean(annotation.section.title),
					path: annotation.section.path?.map(clean),
					contentHash: annotation.section.contentHash,
				},
				target:
					annotation.target.kind === "section"
						? { kind: "section" }
						: {
								kind: "line",
								row: annotation.target.row,
								context: clean(annotation.target.context),
								contextTruncated: annotation.target.contextTruncated,
							},
				note: clean(annotation.note),
			})),
			deletedSections: review.annotationState.deletedSections.map(clean),
			additionalFeedback: clean(review.annotationState.additionalFeedback),
		},
		suggestedSaveName: clean(review.suggestedSaveName),
		contextUsage: review.contextUsage,
		keepContextDisabled: review.keepContextDisabled,
		executionModels: review.executionModels.map(model => ({
			role: clean(model.role),
			provider: clean(model.provider),
			modelId: clean(model.modelId),
			label: clean(model.label),
			thinkingLevel: model.thinkingLevel ? clean(model.thinkingLevel) : undefined,
		})),
		defaultExecutionRole: review.defaultExecutionRole ? clean(review.defaultExecutionRole) : undefined,
		error: review.error ? clean(review.error) : undefined,
	};
}

function projectRuntime(
	runtime: RuntimeReportView,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedRuntimeState {
	return {
		phase: runtime.phase,
		processState: runtime.processState,
		healthy: runtime.healthy,
		lastUsedAt: runtime.lastUsedAt,
		sampledAt: runtime.sampledAt,
		queuedAt: runtime.queuedAt,
		error: runtime.error ? sanitizeText(runtime.error, workspaceRoot, sensitiveValues) : undefined,
	};
}

function projectSessionConfig(
	config: SessionRuntimeConfig,
	workspaceRoot: string,
	sensitiveValues: readonly string[],
): HostedSessionRuntimeConfig {
	return {
		model: config.model,
		thinkingLevel: config.thinkingLevel,
		fastMode: config.fastMode,
		planMode: config.planMode
			? {
					enabled: config.planMode.enabled,
					planFilePath: config.planMode.planFilePath
						? relativeDisplayPath(workspaceRoot, config.planMode.planFilePath)
						: undefined,
					workflow: config.planMode.workflow
						? sanitizeText(config.planMode.workflow, workspaceRoot, sensitiveValues)
						: undefined,
				}
			: undefined,
		steeringMode: config.steeringMode,
		followUpMode: config.followUpMode,
		interruptMode: config.interruptMode,
		autoCompactionEnabled: config.autoCompactionEnabled,
		autoRetryEnabled: config.autoRetryEnabled,
	};
}

export class HostedProjection {
	#key: CryptoKey;
	#workspaceByInput = new Map<string, Promise<ProjectedWorkspace>>();
	#workspaceRootById = new Map<string, string>();

	constructor(key: CryptoKey) {
		this.#key = key;
	}

	static async create(): Promise<HostedProjection> {
		const keyBytes = crypto.getRandomValues(new Uint8Array(32));
		const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		return new HostedProjection(key);
	}

	async #workspace(cwd: string): Promise<ProjectedWorkspace> {
		const input = path.resolve(cwd);
		let projected = this.#workspaceByInput.get(input);
		if (!projected) {
			projected = (async () => {
				const root = await fs.realpath(input).catch(() => input);
				const signature = await crypto.subtle.sign("HMAC", this.#key, new TextEncoder().encode(root));
				const id = Buffer.from(signature).toString("base64url").slice(0, 32);
				const view = { id, name: path.basename(root) || "Workspace" } satisfies HostedWorkspaceView;
				this.#workspaceRootById.set(id, root);
				return { root, view };
			})();
			this.#workspaceByInput.set(input, projected);
		}
		return projected;
	}

	workspaceRoot(id: string): string | undefined {
		return this.#workspaceRootById.get(id);
	}

	async projectHostedWorkspace(cwd: string): Promise<HostedWorkspaceView> {
		return (await this.#workspace(cwd)).view;
	}

	async projectHostedSessionRecord(record: SessionRecordV1): Promise<HostedSessionRecord> {
		const workspace = await this.#workspace(record.cwd);
		return {
			id: record.id,
			kind: record.kind,
			workspace: workspace.view,
			title: record.title
				? sanitizeText(record.title, workspace.root, [record.ompSessionId, record.sessionFile])
				: null,
			createdAt: record.createdAt,
			lastOpenedAt: record.lastOpenedAt,
		};
	}

	async projectHostedCommands(record: SessionRecordV1, commands: SlashCommand[]): Promise<HostedSlashCommand[]> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const clean = (value: string): string => sanitizeText(value, workspace.root, sensitive);
		return commands.map(command => ({
			name: clean(command.name),
			aliases: command.aliases?.map(clean),
			description: command.description ? clean(command.description) : undefined,
			input: command.input?.hint ? { hint: clean(command.input.hint) } : command.input,
			subcommands: command.subcommands?.map(subcommand => ({
				name: clean(subcommand.name),
				description: subcommand.description ? clean(subcommand.description) : undefined,
				usage: subcommand.usage ? clean(subcommand.usage) : undefined,
			})),
			source: command.source,
		}));
	}

	async projectHostedModels(record: SessionRecordV1, models: ModelOption[]): Promise<HostedModelOption[]> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const clean = (value: string): string => sanitizeText(value, workspace.root, sensitive);
		return models.map(model => ({
			provider: clean(model.provider),
			id: clean(model.id),
			name: clean(model.name),
			reasoning: model.reasoning,
			input: [...model.input],
			contextWindow: model.contextWindow,
		}));
	}

	async projectHostedOpenRouterRouting(
		record: SessionRecordV1,
		routing: OpenRouterModelRouting,
	): Promise<HostedOpenRouterModelRouting> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const clean = (value: string): string => sanitizeText(value, workspace.root, sensitive);
		return {
			modelId: clean(routing.modelId),
			providers: routing.providers.map(provider => ({
				id: clean(provider.id),
				name: clean(provider.name),
				enabled: provider.enabled,
			})),
		};
	}

	async projectHostedAgentSettings(
		record: SessionRecordV1,
		settings: AgentSettingView[],
	): Promise<HostedAgentSetting[]> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const clean = (value: string): string => sanitizeText(value, workspace.root, sensitive);
		return settings.map(setting => ({
			path: clean(setting.path),
			tab: setting.tab,
			group: setting.group ? clean(setting.group) : undefined,
			label: clean(setting.label),
			description: clean(setting.description),
			control: setting.control,
			value: Array.isArray(setting.value) ? setting.value.map(clean) : setting.value,
			options: setting.options?.map(option => ({
				value: option.value,
				label: clean(option.label),
				description: option.description ? clean(option.description) : undefined,
			})),
			ordered: setting.ordered,
		}));
	}

	async projectHostedAgentPrompts(record: SessionRecordV1, prompts: AgentPromptView[]): Promise<HostedAgentPrompt[]> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const clean = (value: string): string => sanitizeText(value, workspace.root, sensitive);
		return prompts.map(prompt => ({
			name: clean(prompt.name),
			description: clean(prompt.description),
			effectiveSource: prompt.effectiveSource,
			systemPrompt: clean(prompt.systemPrompt),
			project: prompt.project
				? { systemPrompt: clean(prompt.project.systemPrompt), revision: prompt.project.revision }
				: undefined,
			user: prompt.user
				? { systemPrompt: clean(prompt.user.systemPrompt), revision: prompt.user.revision }
				: undefined,
			apply: prompt.apply,
		}));
	}

	async projectHostedPromptAttachment(
		record: SessionRecordV1,
		attachment: PromptAttachmentView,
	): Promise<HostedPromptAttachmentView> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		return {
			id: attachment.id,
			name: sanitizeText(attachment.name, workspace.root, sensitive),
			size: attachment.size,
			kind: attachment.kind,
			reference: sanitizeText(attachment.reference, workspace.root, sensitive),
		};
	}

	async projectHostedPromptAttachments(
		record: SessionRecordV1,
		attachments: PromptAttachmentView[],
	): Promise<HostedPromptAttachmentView[]> {
		return Promise.all(attachments.map(attachment => this.projectHostedPromptAttachment(record, attachment)));
	}

	async projectHostedTodoState(record: SessionRecordV1, state: TodoState): Promise<HostedTodoState> {
		const workspace = await this.#workspace(record.cwd);
		return projectTodoState(state, workspace.root, [record.ompSessionId, record.sessionFile]);
	}

	async projectHostedTimelineToolDetail(
		record: SessionRecordV1,
		activity: TimelineToolActivity,
	): Promise<HostedTimelineToolActivity> {
		const workspace = await this.#workspace(record.cwd);
		const projected = projectToolActivity(activity, workspace.root, [record.ompSessionId, record.sessionFile]);
		if (!projected) throw new Error("Tool detail is outside the hosted workspace");
		return projected;
	}

	async projectHostedEditMessage(
		record: SessionRecordV1,
		result: EditMessageResult,
	): Promise<HostedEditMessageResult> {
		const workspace = await this.#workspace(record.cwd);
		return {
			cancelled: result.cancelled,
			snapshot: await this.projectHostedSession(result.snapshot),
			requestId: result.requestId,
			error: result.error
				? sanitizeText(result.error, workspace.root, [record.ompSessionId, record.sessionFile])
				: undefined,
		};
	}

	async projectHostedPlanMode(
		record: SessionRecordV1,
		result: { enabled: boolean; planFilePath?: string } | undefined,
	): Promise<{ enabled: boolean; planFilePath?: string } | null> {
		if (!result) return null;
		const workspace = await this.#workspace(record.cwd);
		return {
			enabled: result.enabled,
			planFilePath: result.planFilePath ? relativeDisplayPath(workspace.root, result.planFilePath) : undefined,
		};
	}

	async projectHostedTimelineItem(record: SessionRecordV1, item: TimelineItem): Promise<HostedTimelineItem> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const clean = (value: string): string => sanitizeText(value, workspace.root, sensitive);
		return {
			id: item.id,
			kind: item.kind,
			text: clean(item.text),
			textLoaded: item.textLoaded,
			detail: item.detail ? clean(item.detail) : undefined,
			toolName: item.toolName ? clean(item.toolName) : undefined,
			toolCallId: item.toolCallId,
			status: item.status,
			images: item.images
				?.map(projectTimelineImage)
				.filter((image): image is HostedTimelineImage => image !== undefined),
			files: item.files
				?.map(file => {
					const target = relativeDisplayPath(workspace.root, file.path);
					return target ? { path: target, operation: file.operation, disposition: file.disposition } : undefined;
				})
				.filter(file => file !== undefined),
			toolActivity: item.toolActivity
				? projectToolActivity(item.toolActivity, workspace.root, sensitive)
				: undefined,
			isError: item.isError,
			timestamp: item.timestamp,
			role: item.role ? clean(item.role) : undefined,
			createdAt: item.createdAt,
			presentation: item.presentation
				? projectTimelinePresentation(item.presentation, workspace.root, sensitive)
				: undefined,
		};
	}

	async projectHostedTimelinePage(record: SessionRecordV1, page: TimelinePage): Promise<HostedTimelinePage> {
		return {
			items: await Promise.all(page.items.map(item => this.projectHostedTimelineItem(record, item))),
			start: page.start,
			total: page.total,
		};
	}

	async projectHostedAgentHub(record: SessionRecordV1, hub: AgentHubSnapshot): Promise<HostedAgentHubSnapshot> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		return { agents: hub.agents.map(agent => projectAgentHubAgent(agent, workspace.root, sensitive)) };
	}

	async projectHostedAgentHubMessages(
		record: SessionRecordV1,
		page: AgentHubMessagePage,
	): Promise<HostedAgentHubMessagePage> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		const rawEntries = [...page.entries, ...page.messages];
		return {
			fromByte: page.fromByte,
			nextByte: page.nextByte,
			reset: page.reset,
			entries: rawEntries.map((entry, index) => {
				const source = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
				const role =
					typeof source.role === "string" ? source.role : typeof source.type === "string" ? source.type : "status";
				const textValue =
					typeof source.text === "string"
						? source.text
						: typeof source.content === "string"
							? source.content
							: JSON.stringify(source);
				const kind =
					role === "user" || role === "assistant" || role === "thinking" || role === "tool" ? role : "status";
				return {
					id: typeof source.id === "string" ? source.id : `${page.fromByte}:${index}`,
					kind,
					text: sanitizeText(textValue, workspace.root, sensitive),
					createdAt: typeof source.createdAt === "number" ? source.createdAt : undefined,
				};
			}),
		};
	}

	async projectHostedPlanReview(record: SessionRecordV1, review: PlanReviewView): Promise<HostedPlanReview> {
		const workspace = await this.#workspace(record.cwd);
		return projectPlanReview(review, workspace.root, [record.ompSessionId, record.sessionFile]);
	}

	async projectHostedSession(snapshot: SessionSnapshot): Promise<HostedSessionSnapshot> {
		const workspace = await this.#workspace(snapshot.record.cwd);
		const sensitive = [snapshot.record.ompSessionId, snapshot.record.sessionFile];
		return {
			...projectSessionConfig(snapshot, workspace.root, sensitive),
			record: await this.projectHostedSessionRecord(snapshot.record),
			state: snapshot.state,
			timeline: await Promise.all(
				snapshot.timeline.map(item => this.projectHostedTimelineItem(snapshot.record, item)),
			),
			timelineStart: snapshot.timelineStart,
			timelineTotal: snapshot.timelineTotal,
			subagents: snapshot.subagents.map(subagent => projectSubagent(subagent, workspace.root, sensitive)),
			agentHub: snapshot.agentHub
				? { agents: snapshot.agentHub.agents.map(agent => projectAgentHubAgent(agent, workspace.root, sensitive)) }
				: undefined,
			commands: snapshot.commands?.map(command => ({
				name: sanitizeText(command.name, workspace.root, sensitive),
				aliases: command.aliases?.map(alias => sanitizeText(alias, workspace.root, sensitive)),
				description: command.description ? sanitizeText(command.description, workspace.root, sensitive) : undefined,
				input: command.input?.hint
					? { hint: sanitizeText(command.input.hint, workspace.root, sensitive) }
					: command.input,
				subcommands: command.subcommands?.map(subcommand => ({
					name: sanitizeText(subcommand.name, workspace.root, sensitive),
					description: subcommand.description
						? sanitizeText(subcommand.description, workspace.root, sensitive)
						: undefined,
					usage: subcommand.usage ? sanitizeText(subcommand.usage, workspace.root, sensitive) : undefined,
				})),
				source: command.source,
			})),
			contextTokens: snapshot.contextTokens,
			contextWindow: snapshot.contextWindow,
			tokensPerSecond: snapshot.tokensPerSecond,
			queuedMessageCount: snapshot.queuedMessageCount,
			todoState: projectTodoState(snapshot.todoState, workspace.root, sensitive),
			isStreaming: snapshot.isStreaming,
			isCompacting: snapshot.isCompacting,
			retryState: snapshot.retryState,
			warning: snapshot.warning ? sanitizeText(snapshot.warning, workspace.root, sensitive) : undefined,
			runtime: snapshot.runtime ? projectRuntime(snapshot.runtime, workspace.root, sensitive) : undefined,
			planReviewSupported: snapshot.planReviewSupported,
			planReview: snapshot.planReview
				? projectPlanReview(snapshot.planReview, workspace.root, sensitive)
				: undefined,
		};
	}

	async projectHostedBootstrap(snapshot: BootstrapSnapshot): Promise<HostedBootstrapSnapshot> {
		const visible = snapshot.registry.sessions.filter(record => record.surface !== "browser-selection");
		const sessions = await Promise.all(visible.map(record => this.projectHostedSessionRecord(record)));
		const workspaces = [...new Map(sessions.map(record => [record.workspace.id, record.workspace])).values()];
		const visibleIds = new Set(sessions.map(record => record.id));
		const activeSessionId = [snapshot.registry.activeByKind.work, snapshot.registry.activeByKind.code].find(
			id => id !== null && visibleIds.has(id),
		);
		return {
			workspaces,
			sessions,
			activeSessionId: activeSessionId ?? null,
			warning: snapshot.warning ? sanitizeText(snapshot.warning, process.cwd()) : undefined,
		};
	}

	async projectHostedFileDiff(record: SessionRecordV1, view: FileDiffView): Promise<HostedFileView> {
		const workspace = await this.#workspace(record.cwd);
		const target = relativeDisplayPath(workspace.root, view.path);
		if (!target) throw new Error("File is outside the hosted workspace");
		const sensitive = [record.ompSessionId, record.sessionFile];
		return {
			kind: "diff",
			path: target,
			diff: sanitizeText(view.diff, workspace.root, sensitive),
			status: view.status,
			additions: view.additions,
			deletions: view.deletions,
			truncated: view.truncated,
			message: view.message ? sanitizeText(view.message, workspace.root, sensitive) : undefined,
		};
	}

	async projectHostedFilePreview(record: SessionRecordV1, view: HostedWorkspaceFilePreview): Promise<HostedWorkspaceFilePreview> {
		const workspace = await this.#workspace(record.cwd);
		const relative = relativeDisplayPath(workspace.root, view.path);
		if (!relative) throw new Error("File is outside the hosted workspace");
		const target = path.isAbsolute(view.path) ? relative : view.path;
		const sensitive = [record.ompSessionId, record.sessionFile];
		if (view.kind === "text") return { ...view, path: target, text: sanitizeText(view.text, workspace.root, sensitive) };
		if (view.kind === "unavailable") return { ...view, path: target, message: sanitizeText(view.message, workspace.root, sensitive) };
		return { ...view, path: target };
	}

	projectHostedStats(view: SessionStatsView): HostedSessionStats {
		return {
			userMessages: view.userMessages,
			assistantMessages: view.assistantMessages,
			toolCalls: view.toolCalls,
			toolResults: view.toolResults,
			totalMessages: view.totalMessages,
			tokens: {
				input: view.tokens.input,
				output: view.tokens.output,
				reasoning: view.tokens.reasoning,
				cacheRead: view.tokens.cacheRead,
				cacheWrite: view.tokens.cacheWrite,
				total: view.tokens.total,
			},
			premiumRequests: view.premiumRequests,
			cost: view.cost,
			contextUsage: view.contextUsage,
		};
	}

	async projectHostedContextMutation(
		record: SessionRecordV1,
		view: ContextMutationResult,
	): Promise<HostedContextMutationResult> {
		const workspace = await this.#workspace(record.cwd);
		return {
			beforeTokens: view.beforeTokens,
			afterTokens: view.afterTokens,
			changed: view.changed,
			savedPath: view.savedPath
				? (relativeDisplayPath(workspace.root, view.savedPath) ?? path.basename(view.savedPath))
				: undefined,
		};
	}

	async projectHostedPlanResolution(
		record: SessionRecordV1,
		view: PlanReviewResolutionResult,
	): Promise<HostedPlanReviewResolution> {
		if (!view.accepted) return { accepted: false, cancelled: true };
		const workspace = await this.#workspace(record.cwd);
		return {
			accepted: true,
			awaitingRefinement: view.awaitingRefinement,
			savedPath: view.savedPath
				? (relativeDisplayPath(workspace.root, view.savedPath) ?? path.basename(view.savedPath))
				: undefined,
			createdSession: view.createdSession ? await this.projectHostedSession(view.createdSession) : undefined,
		};
	}

	async projectHostedEvent(record: SessionRecordV1, event: GradivusEvent): Promise<HostedChatEvent | undefined> {
		const workspace = await this.#workspace(record.cwd);
		const sensitive = [record.ompSessionId, record.sessionFile];
		switch (event.type) {
			case "session":
				return {
					type: "session",
					sessionId: record.id,
					state: event.state,
					record: event.record ? await this.projectHostedSessionRecord(event.record) : undefined,
					runtime: event.runtime ? projectRuntime(event.runtime, workspace.root, sensitive) : undefined,
					isStreaming: event.isStreaming,
					isCompacting: event.isCompacting,
					retryState: event.retryState,
				};
			case "timeline":
				return event.item
					? {
							type: "timeline",
							sessionId: record.id,
							item: await this.projectHostedTimelineItem(record, event.item),
						}
					: undefined;
			case "subagents":
				return event.subagents
					? {
							type: "subagents",
							sessionId: record.id,
							subagents: event.subagents.map(subagent => projectSubagent(subagent, workspace.root, sensitive)),
						}
					: undefined;
			case "agent_hub_update":
				return event.agentHub
					? {
							type: "agent_hub_update",
							sessionId: record.id,
							agentHub: {
								agents: event.agentHub.agents.map(agent =>
									projectAgentHubAgent(agent, workspace.root, sensitive),
								),
							},
						}
					: undefined;
			case "commands":
				return event.commands
					? {
							type: "commands",
							sessionId: record.id,
							commands: event.commands.map(command => ({
								name: sanitizeText(command.name, workspace.root, sensitive),
								aliases: command.aliases?.map(alias => sanitizeText(alias, workspace.root, sensitive)),
								description: command.description
									? sanitizeText(command.description, workspace.root, sensitive)
									: undefined,
								input: command.input?.hint
									? { hint: sanitizeText(command.input.hint, workspace.root, sensitive) }
									: command.input,
								subcommands: command.subcommands?.map(subcommand => ({
									name: sanitizeText(subcommand.name, workspace.root, sensitive),
									description: subcommand.description
										? sanitizeText(subcommand.description, workspace.root, sensitive)
										: undefined,
									usage: subcommand.usage
										? sanitizeText(subcommand.usage, workspace.root, sensitive)
										: undefined,
								})),
								source: command.source,
							})),
						}
					: undefined;
			case "config":
				return event.config
					? {
							type: "config",
							sessionId: record.id,
							config: projectSessionConfig(event.config, workspace.root, sensitive),
						}
					: undefined;
			case "prompt_result":
				return {
					type: "prompt_result",
					sessionId: record.id,
					requestId: event.requestId,
					agentInvoked: event.agentInvoked,
					error: event.error
						? {
								code:
									event.error.code === "provider_auth_required"
										? "provider_auth_required"
										: "runtime_unavailable",
								message: sanitizeText(event.error.message, workspace.root, sensitive),
								retryable: true,
							}
						: undefined,
				};
			case "todo_update":
				return event.todoState
					? {
							type: "todo_update",
							sessionId: record.id,
							todoState: projectTodoState(event.todoState, workspace.root, sensitive),
						}
					: undefined;
			case "warning":
				return event.message
					? {
							type: "warning",
							sessionId: record.id,
							message: sanitizeText(event.message, workspace.root, sensitive),
						}
					: undefined;
			case "plan_review":
				return {
					type: "plan_review",
					sessionId: record.id,
					planReview: event.planReview
						? projectPlanReview(event.planReview, workspace.root, sensitive)
						: undefined,
				};
			case "session_reset":
				return event.snapshot
					? {
							type: "session_reset",
							sessionId: record.id,
							snapshot: await this.projectHostedSession(event.snapshot),
						}
					: undefined;
			case "extension":
				return {
					type: "extension_attention",
					sessionId: record.id,
					action: {
						actionId: event.extension?.id ?? crypto.randomUUID(),
						kind: "extension_attention",
						state: event.extension ? "pending" : "completed",
					},
				};
			case "browser_inventory":
				return undefined;
		}
	}

	projectHostedDesktopAction(action: DesktopActionEvent, sessionId?: string): HostedChatEvent {
		if (action.kind === "extension_attention") {
			return {
				type: "extension_attention",
				sessionId: sessionId ?? "",
				action: { actionId: action.actionId, kind: action.kind, state: action.state },
			};
		}
		return { type: "desktop_action", action };
	}
}

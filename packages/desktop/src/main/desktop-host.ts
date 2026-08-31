import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { parseImageMetadata } from "@oh-my-pi/pi-utils/mime";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { WorkspaceDocumentV1, WorkspacePrincipalV1 } from "@oh-my-pi/pi-wire";
import type { SelectionAuthScope, SelectionTargetAgent } from "@oh-my-pi/pi-workspace-runtime/selection";
import { type BrowserWindow, dialog, nativeImage, shell } from "electron";
import { getAgentSwatch } from "../shared/agent-swatch";
import { AUTH_DISCOVERY_PROVIDER } from "../shared/auth-events";
import type {
	AgentHubAgent,
	AgentHubMessagePage,
	AgentHubMetrics,
	AgentHubSnapshot,
	AgentPromptScope,
	AgentPromptView,
	AgentSettingOption,
	AgentSettingValue,
	AgentSettingView,
	AuthAccountView,
	AuthEvent,
	BootstrapSnapshot,
	BrowserTabInventoryView,
	ContextMutationResult,
	EditMessageResult,
	ExportHtmlResult,
	ExtensionView,
	FileChangeDisposition,
	FileDiffView,
	GradivusEvent,
	InterruptMode,
	ModelOption,
	OAuthAccountSummaryView,
	OAuthAccountsView,
	OAuthProviderAccountsView,
	OpenRouterModelRouting,
	PlanReviewResolutionResult,
	PlanReviewView,
	ProcessState,
	PromptAttachmentView,
	PromptImageContent,
	QueueMode,
	RuntimeReportView,
	SessionRecordV1,
	SessionRetryState,
	SessionSnapshot,
	SessionStatsView,
	SlashCommand,
	SubagentView,
	ThinkingLevel,
	TimelineItem,
	TimelinePage,
	TimelineToolActivity,
	TodoPhase,
	TodoState,
	WorkspaceImagePreview,
} from "../shared/contracts";
import {
	MAX_INLINE_PROMPT_BYTES,
	MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
	MAX_PROMPT_ATTACHMENT_COUNT,
	MAX_PROMPT_IMAGE_BYTES,
} from "../shared/contracts";
import type {
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolResultBody,
} from "../shared/rpc-wire";
import { loadPersistedGradivusSettings } from "./app-settings";
import {
	assertBoundedText,
	assertSessionKind,
	assertSessionName,
	resolveWorkspaceTarget,
	safeExternalUrl,
} from "./guards";
import type { PaneBroker } from "./pane-broker";
import { PromptAttachmentStore, type ResolvedPromptComposition } from "./prompt-attachments";
import type { RpcClient } from "./rpc-client";
import { RpcProcess } from "./rpc-process";
import { RuntimeSupervisor } from "./runtime-supervisor";
import { SessionRegistry } from "./session-registry";
import { TranscriptStore } from "./transcript-store";

type SelectionPromptMetadata = {
	paneId?: string;
	selector?: string;
	tagName?: string;
	instruction?: string;
	url?: string;
	agentType?: string;
	captureMode?: "dom" | "screenshot";
	screenshot?: {
		base64?: string;
		dataUrl?: string;
		mimeType?: string;
	};
};

function selectionPromptImage(metadata?: Record<string, unknown>): PromptImageContent | undefined {
	const screenshot = metadata?.screenshot;
	if (!isRecord(screenshot)) return undefined;
	const base64 = typeof screenshot.base64 === "string" ? screenshot.base64 : undefined;
	const dataUrl = typeof screenshot.dataUrl === "string" ? screenshot.dataUrl : undefined;
	const data = base64 ?? (dataUrl?.split(",", 2)[1] || undefined);
	if (!data) return undefined;
	const mimeType =
		screenshot.mimeType === "image/png" ||
		screenshot.mimeType === "image/jpeg" ||
		screenshot.mimeType === "image/gif" ||
		screenshot.mimeType === "image/webp"
			? screenshot.mimeType
			: "image/jpeg";
	return { type: "image", data, mimeType };
}

function writeDispositionForEvent(
	cwd: string,
	frame: Record<string, unknown>,
): { toolCallId: string; disposition: FileChangeDisposition } | undefined {
	if (frame.type !== "tool_execution_start" || frame.toolName !== "write" || typeof frame.toolCallId !== "string") {
		return undefined;
	}
	const args = isRecord(frame.args) ? frame.args : undefined;
	const target = typeof args?.path === "string" ? args.path.trim() : "";
	const windowsAbsolute = path.win32.isAbsolute(target);
	if (
		!target ||
		/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ||
		(/^[a-z][a-z0-9+.-]*:/i.test(target) && !windowsAbsolute)
	) {
		return undefined;
	}
	const workspace = path.resolve(cwd);
	const resolved = path.resolve(workspace, target);
	const relative = path.relative(workspace, resolved);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return undefined;
	}
	return { toolCallId: frame.toolCallId, disposition: fs.existsSync(resolved) ? "edited" : "created" };
}

type RuntimeSession = {
	record: SessionRecordV1;
	process: RpcProcess;
	timeline: TranscriptStore;
	attachments: PromptAttachmentStore;
	state: ProcessState;
	subagents: SubagentView[];
	agentHub?: AgentHubSnapshot;
	commands: SlashCommand[];
	browserInventory: BrowserTabInventoryView[];
	models?: ModelOption[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	fastMode?: boolean;
	planMode?: { enabled: boolean; planFilePath?: string; workflow?: string };
	planReviewSupported: boolean;
	planReview?: PlanReviewView;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	interruptMode?: InterruptMode;
	autoCompactionEnabled?: boolean;
	autoRetryEnabled?: boolean;
	contextTokens?: number;
	contextWindow?: number;
	tokensPerSecond?: number | null;
	queuedMessageCount?: number;
	isStreaming?: boolean;
	isCompacting?: boolean;
	retryState?: SessionRetryState;
	todoState: TodoState;
	outstandingExtensions: Map<string, RpcExtensionUIRequest>;
	fileDiffCache: Map<string, { expiresAt: number; request: Promise<FileDiffView> }>;
};

type TimerHandle = NodeJS.Timeout;
const FILE_DIFF_CACHE_TTL_MS = 1_000;
const EVENT_BATCH_DELAY_MS = 16;
const MAX_WORKSPACE_IMAGE_DIMENSION = 8_192;
const MAX_WORKSPACE_IMAGE_PIXELS = 4_194_304;
const MIN_IMAGE_PREVIEW_DIMENSION = 64;
const MAX_IMAGE_PREVIEW_DIMENSION = 2_048;
interface StateData {
	sessionId: string;
	sessionFile?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	sessionName?: string;
	fastModeEnabled: boolean;
	planMode?: { enabled: boolean; planFilePath?: string; workflow?: string };
	capabilities?: { planReview?: number };
	planReview?: unknown;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	interruptMode: InterruptMode;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	contextUsage?: { tokens: number; contextWindow: number };
	tokensPerSecond: number | null;
	isStreaming?: boolean;
	isCompacting?: boolean;
	queuedMessageCount: number;
	todoState: TodoState;
}
async function loadHistory(client: RpcClient): Promise<unknown[]> {
	const paged = await client.request({ type: "get_messages_page", limit: 256 });
	if (!paged.success) {
		const legacy = await client.request({ type: "get_messages" });
		if (!legacy.success || legacy.command !== "get_messages") throw new Error(legacy.error ?? "History load failed");
		const data = legacy.data as { messages?: unknown[] };
		return Array.isArray(data.messages) ? data.messages : [];
	}
	const messages: unknown[] = [];
	let response: typeof paged | undefined = paged;
	let pageCount = 0;
	while (response?.success && response.command === "get_messages_page") {
		const data = response.data as { messages?: unknown[]; nextCursor?: string };
		if (!Array.isArray(data.messages)) throw new Error("History page was invalid");
		messages.push(...data.messages);
		if (!data.nextCursor) return messages;

		if (++pageCount > 10_000) throw new Error("History pagination exceeded its safety bound");
		response = await client.request({ type: "get_messages_page", cursor: data.nextCursor, limit: 256 });
	}
	throw new Error(response?.error ?? "History page load failed");
}

function normalizeBranchMessages(value: unknown): Array<{ entryId: string; text: string }> {
	if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("Branch messages response was invalid");
	return value.messages.map(message => {
		if (!isRecord(message) || typeof message.entryId !== "string" || typeof message.text !== "string") {
			throw new Error("Branch message was invalid");
		}
		return { entryId: message.entryId, text: message.text };
	});
}

function normalizeBranchImages(value: unknown): PromptImageContent[] {
	if (!Array.isArray(value)) throw new Error("Branch images response was invalid");
	if (value.length > MAX_PROMPT_ATTACHMENT_COUNT) throw new Error("Branch images exceed the count limit");
	let totalBytes = 0;
	return value.map(image => {
		if (
			!isRecord(image) ||
			image.type !== "image" ||
			typeof image.data !== "string" ||
			image.data.length === 0 ||
			(image.mimeType !== "image/png" &&
				image.mimeType !== "image/jpeg" &&
				image.mimeType !== "image/gif" &&
				image.mimeType !== "image/webp")
		) {
			throw new Error("Branch image was invalid");
		}

		const bytes = Buffer.byteLength(image.data, "base64");
		if (bytes > MAX_PROMPT_IMAGE_BYTES) throw new Error("Branch image exceeds the size limit");
		totalBytes += bytes;
		if (totalBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new Error("Branch images exceed the batch size limit");
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}
function optionalInstructions(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new TypeError(`${label} must be text`);
	const normalized = value.trim();
	if (normalized.length > 16_384) throw new RangeError(`${label} is too long`);
	return normalized || undefined;
}

function sessionStatNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Session statistics field ${label} was invalid`);
	}
	return value;
}

function normalizeSessionStats(value: unknown): SessionStatsView {
	if (!isRecord(value) || !isRecord(value.tokens) || typeof value.sessionId !== "string") {
		throw new Error("Session statistics response was invalid");
	}
	const context = isRecord(value.contextUsage) ? value.contextUsage : undefined;
	return {
		...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
		sessionId: value.sessionId,
		userMessages: sessionStatNumber(value.userMessages, "userMessages"),
		assistantMessages: sessionStatNumber(value.assistantMessages, "assistantMessages"),
		toolCalls: sessionStatNumber(value.toolCalls, "toolCalls"),
		toolResults: sessionStatNumber(value.toolResults, "toolResults"),
		totalMessages: sessionStatNumber(value.totalMessages, "totalMessages"),
		tokens: {
			input: sessionStatNumber(value.tokens.input, "tokens.input"),
			output: sessionStatNumber(value.tokens.output, "tokens.output"),
			reasoning: sessionStatNumber(value.tokens.reasoning, "tokens.reasoning"),
			cacheRead: sessionStatNumber(value.tokens.cacheRead, "tokens.cacheRead"),
			cacheWrite: sessionStatNumber(value.tokens.cacheWrite, "tokens.cacheWrite"),
			total: sessionStatNumber(value.tokens.total, "tokens.total"),
		},
		premiumRequests: sessionStatNumber(value.premiumRequests, "premiumRequests"),
		cost: sessionStatNumber(value.cost, "cost"),
		...(context
			? {
					contextUsage: {
						tokens: sessionStatNumber(context.tokens, "contextUsage.tokens"),
						contextWindow: sessionStatNumber(context.contextWindow, "contextUsage.contextWindow"),
						...(typeof context.percentage === "number" && Number.isFinite(context.percentage)
							? { percentage: context.percentage }
							: {}),
					},
				}
			: {}),
	};
}
const PLAN_REVIEW_STATUSES = new Set(["ready", "awaiting_refinement", "applying", "failed"]);
const PLAN_REVIEW_PHASES = new Set([
	"ready",
	"awaiting_refinement",
	"accepted",
	"mode_exited",
	"session_reset",
	"compaction_finished",
	"prompt_admitted",
	"failed",
]);

function normalizePlanReview(value: unknown): PlanReviewView {
	if (!isRecord(value)) throw new Error("Plan review payload was invalid");
	const id = assertBoundedText(value.id, "plan review id");
	const title = assertBoundedText(value.title, "plan review title");
	const planFilePath = assertBoundedText(value.planFilePath, "plan review path");
	const revision = assertBoundedText(value.revision, "plan review revision");
	const content = assertBoundedText(value.content, "plan review content");
	const suggestedSaveName = assertBoundedText(value.suggestedSaveName, "plan review save name");
	if (
		!id.startsWith("plan-") ||
		!planFilePath.startsWith("local://") ||
		planFilePath.includes("\\0") ||
		planFilePath.includes("\\") ||
		planFilePath.slice("local://".length).split("/").includes("..")
	) {
		throw new Error("Plan review identity or path was invalid");
	}
	if (typeof value.status !== "string" || !PLAN_REVIEW_STATUSES.has(value.status)) {
		throw new Error("Plan review status was invalid");
	}
	if (typeof value.phase !== "string" || !PLAN_REVIEW_PHASES.has(value.phase)) {
		throw new Error("Plan review phase was invalid");
	}
	if (!isRecord(value.annotationState)) throw new Error("Plan review annotations were invalid");
	if (Buffer.byteLength(JSON.stringify(value.annotationState), "utf8") > MAX_INLINE_PROMPT_BYTES) {
		throw new RangeError("Plan review annotations exceed 512 KiB");
	}
	if (
		!Array.isArray(value.annotationState.annotations) ||
		!Array.isArray(value.annotationState.deletedSections) ||
		typeof value.annotationState.additionalFeedback !== "string"
	) {
		throw new Error("Plan review annotations were invalid");
	}
	const annotations: PlanReviewView["annotationState"]["annotations"] = value.annotationState.annotations.map(
		annotationValue => {
			if (!isRecord(annotationValue) || !isRecord(annotationValue.section) || !isRecord(annotationValue.target)) {
				throw new Error("Plan review annotation was invalid");
			}
			const sectionIndex = annotationValue.section.index;
			if (!Number.isSafeInteger(sectionIndex) || (sectionIndex as number) < 0) {
				throw new Error("Plan review annotation section was invalid");
			}
			const section = {
				index: sectionIndex as number,
				title: assertBoundedText(annotationValue.section.title, "plan review annotation title"),
				...(Array.isArray(annotationValue.section.path)
					? {
							path: annotationValue.section.path.map(segment =>
								assertBoundedText(segment, "plan review annotation path"),
							),
						}
					: {}),
				...(typeof annotationValue.section.contentHash === "string"
					? {
							contentHash: assertBoundedText(
								annotationValue.section.contentHash,
								"plan review annotation content hash",
							),
						}
					: {}),
			};
			let target: PlanReviewView["annotationState"]["annotations"][number]["target"];
			if (annotationValue.target.kind === "section") {
				target = { kind: "section" };
			} else if (
				annotationValue.target.kind === "line" &&
				Number.isSafeInteger(annotationValue.target.row) &&
				(annotationValue.target.row as number) >= 0
			) {
				target = {
					kind: "line",
					row: annotationValue.target.row as number,
					context: assertBoundedText(annotationValue.target.context, "plan review line context"),
					...(annotationValue.target.contextTruncated === true ? { contextTruncated: true } : {}),
				};
			} else {
				throw new Error("Plan review annotation target was invalid");
			}
			return {
				section,
				target,
				note: assertBoundedText(annotationValue.note, "plan review annotation note"),
			};
		},
	);
	const annotationState: PlanReviewView["annotationState"] = {
		annotations,
		deletedSections: value.annotationState.deletedSections.map(section =>
			assertBoundedText(section, "deleted plan section"),
		),
		additionalFeedback: assertBoundedText(value.annotationState.additionalFeedback, "additional plan feedback"),
	};
	if (!Array.isArray(value.executionModels)) throw new Error("Plan review execution models were invalid");
	const executionModels: PlanReviewView["executionModels"] = value.executionModels.map(modelValue => {
		if (!isRecord(modelValue)) throw new Error("Plan review execution model was invalid");
		return {
			role: assertBoundedText(modelValue.role, "plan review execution role"),
			provider: assertBoundedText(modelValue.provider, "plan review execution provider"),
			modelId: assertBoundedText(modelValue.modelId, "plan review execution model"),
			label: assertBoundedText(modelValue.label, "plan review execution label"),
			...(typeof modelValue.thinkingLevel === "string"
				? { thinkingLevel: assertBoundedText(modelValue.thinkingLevel, "plan review thinking level") }
				: {}),
		};
	});
	const roles = new Set(executionModels.map(model => model.role));
	if (roles.size !== executionModels.length) throw new Error("Plan review execution roles were duplicated");
	const defaultExecutionRole =
		typeof value.defaultExecutionRole === "string"
			? assertBoundedText(value.defaultExecutionRole, "default plan execution role")
			: undefined;
	if (defaultExecutionRole && !roles.has(defaultExecutionRole)) {
		throw new Error("Default plan execution role was invalid");
	}
	let contextUsage: PlanReviewView["contextUsage"];
	if (value.contextUsage !== undefined) {
		if (!isRecord(value.contextUsage)) throw new Error("Plan review context usage was invalid");
		const tokens = value.contextUsage.tokens;
		const contextWindow = value.contextUsage.contextWindow;
		const percent = value.contextUsage.percent;
		if (
			typeof tokens !== "number" ||
			!Number.isFinite(tokens) ||
			tokens < 0 ||
			typeof contextWindow !== "number" ||
			!Number.isFinite(contextWindow) ||
			contextWindow <= 0 ||
			typeof percent !== "number" ||
			!Number.isFinite(percent) ||
			percent < 0
		) {
			throw new Error("Plan review context usage was invalid");
		}
		contextUsage = { tokens, contextWindow, percent };
	}
	return {
		id,
		title,
		planFilePath,
		revision,
		status: value.status as PlanReviewView["status"],
		phase: value.phase as PlanReviewView["phase"],
		content,
		annotationState,
		suggestedSaveName,
		...(contextUsage ? { contextUsage } : {}),
		keepContextDisabled: value.keepContextDisabled === true,
		executionModels,
		...(defaultExecutionRole ? { defaultExecutionRole } : {}),
		...(typeof value.error === "string" ? { error: assertBoundedText(value.error, "plan review error") } : {}),
	};
}

function isWindowUsable(window?: BrowserWindow): boolean {
	if (!window) return false;
	if (typeof window.isDestroyed === "function" && window.isDestroyed()) return false;
	if (window.webContents && typeof window.webContents.isDestroyed === "function" && window.webContents.isDestroyed())
		return false;
	return Boolean(window.webContents?.send);
}
interface PlanReviewResetGate {
	incarnation: string;
	frames: Array<{ event: unknown; sourceClient: RpcClient; incarnation: string }>;
}
class PlanReviewRpcError extends Error {
	constructor(
		message: string,
		readonly code: string | undefined,
	) {
		super(message);
		this.name = "PlanReviewRpcError";
	}
}

export class DesktopHost {
	#registry: SessionRegistry;
	#window: BrowserWindow | undefined;
	#userDataPath: string;
	#runtimes = new Map<string, RuntimeSession>();
	#supervisor: RuntimeSupervisor;
	#eventQueues = new Map<string, GradivusEvent[]>();
	#eventQueueIndexes = new Map<string, Map<string, number>>();
	#eventTimers = new Map<string, TimerHandle>();
	#warning: string | undefined;
	#authProcess: RpcProcess | undefined;
	#authClient: Promise<RpcClient> | undefined;
	#authClientUsers = 0;
	#authLogin: Promise<AuthAccountView[]> | undefined;
	#activeAuthProvider: { id: string; name: string } | undefined;
	#authPrompt:
		| {
				id: string;
				process: RpcProcess;
		  }
		| undefined;
	#document: WorkspaceDocumentV1 | undefined;
	#principal: WorkspacePrincipalV1 | undefined;
	#paneBroker: PaneBroker | undefined;
	#paneBrokerUnavailable = new Map<string, string>();
	#hostToolRefreshQueue = Promise.resolve();
	#pendingHostToolCalls = new Map<string, { runtimeId: string; incarnation: string; controller: AbortController }>();
	#planReviewMutationTails = new Map<string, Promise<void>>();
	#planReviewResetGates = new Map<string, PlanReviewResetGate>();
	#suppressedEventSessions = new Set<string>();

	constructor(userDataPath: string) {
		this.#registry = new SessionRegistry(userDataPath);
		this.#userDataPath = userDataPath;
		this.#supervisor = new RuntimeSupervisor({
			maxResident: 3,
			idleTimeoutMs: 300_000,
			sampleIntervalMs: 5_000,
			onReport: report => this.#onRuntimeReport(report),
		});
	}

	setWorkspaceAuthority(principal: WorkspacePrincipalV1, document: WorkspaceDocumentV1): void {
		this.#principal = principal;
		this.#document = document;
	}

	get principal(): WorkspacePrincipalV1 | undefined {
		return this.#principal;
	}

	getDocument(): WorkspaceDocumentV1 | undefined {
		return this.#document;
	}

	paneAutomationSession(sessionId: string):
		| {
				record: SessionRecordV1;
				principal: WorkspacePrincipalV1;
				incarnation: string;
				automationUnavailableReason?: string;
		  }
		| undefined {
		const runtime = this.#runtimes.get(sessionId);
		const incarnation = runtime?.process.incarnation;
		if (!runtime || !incarnation || !this.#principal) return undefined;
		return {
			record: runtime.record,
			principal: this.#principal,
			incarnation,
			...(this.#paneBrokerUnavailable.has(sessionId)
				? { automationUnavailableReason: this.#paneBrokerUnavailable.get(sessionId) }
				: {}),
		};
	}

	browserInventoryForSession(sessionId: string): BrowserTabInventoryView[] {
		const runtime = this.#runtimes.get(sessionId);
		return runtime ? structuredClone(runtime.browserInventory) : [];
	}

	async closeBrowserTabForSession(
		sessionIdInput: unknown,
		nameInput: unknown,
		confirm = false,
	): Promise<{
		closed: boolean;
		requiresConfirmation: boolean;
		tab?: BrowserTabInventoryView;
		inventory: BrowserTabInventoryView[];
	}> {
		const sessionId = typeof sessionIdInput === "string" ? sessionIdInput.trim() : "";
		const name = typeof nameInput === "string" ? nameInput.trim() : "";
		if (!sessionId) throw new TypeError("Invalid session id");
		if (!name || name.length > 100 || name.includes("\0")) throw new TypeError("Invalid browser tab name");
		const runtime = this.#requiredRuntime(sessionId);
		const client = runtime.process.client;
		if (!client) {
			return {
				closed: false,
				requiresConfirmation: false,
				inventory: structuredClone(runtime.browserInventory),
			};
		}
		const response = await client.request({ type: "close_browser_tab", name, confirm });
		if (!response.success || response.command !== "close_browser_tab" || !isRecord(response.data)) {
			throw new Error(
				response.success
					? "OMP browser tab response was invalid"
					: (response.error ?? "OMP browser tab close failed"),
			);
		}
		const inventory = normalizeBrowserInventory(response.data.inventory);
		const tab = normalizeBrowserInventory([response.data.tab])[0];
		runtime.browserInventory = inventory;
		this.#emitUrgent({
			sessionId: runtime.record.id,
			type: "browser_inventory",
			browserInventory: structuredClone(inventory),
		});
		return {
			closed: response.data.closed === true,
			requiresConfirmation: response.data.requiresConfirmation === true,
			...(tab ? { tab } : {}),
			inventory: structuredClone(inventory),
		};
	}

	syncWithDocument(doc: WorkspaceDocumentV1): void {
		this.#document = doc;
	}

	setPaneBroker(broker: PaneBroker): void {
		this.#paneBroker = broker;
		void this.refreshPaneBroker();
	}

	refreshPaneBroker(): Promise<void> {
		for (const pending of this.#pendingHostToolCalls.values()) {
			pending.controller.abort(new Error("Gradivus pane authorization changed"));
		}
		const refresh = this.#hostToolRefreshQueue
			.catch(() => undefined)
			.then(async () => {
				for (const runtime of this.#runtimes.values()) {
					const client = runtime.process.client;
					if (client) await this.#registerRuntimeHostTools(runtime, client);
				}
			});
		this.#hostToolRefreshQueue = refresh.catch(error => {
			logger.warn("Failed to refresh desktop host tools", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return this.#hostToolRefreshQueue;
	}

	async load(): Promise<void> {
		await this.#registry.load();
		this.#warning = this.#registry.warning;
		for (const record of this.#registry.value.sessions) this.#createRuntime(record);
	}

	setWindow(window: BrowserWindow | undefined): void {
		this.#window = window;
	}

	bootstrap(): BootstrapSnapshot {
		const registry = this.#registry.value;
		return {
			registry: {
				...registry,
				sessions: registry.sessions.filter(record => record.surface !== "browser-selection"),
			},
			warning: this.#warning,
		};
	}
	async getAuthStatus(): Promise<AuthAccountView[]> {
		return this.#authAccounts();
	}

	async getOAuthAccounts(): Promise<OAuthAccountsView> {
		return this.#oauthAccounts();
	}

	async setOAuthAccountLock(providerInput: unknown, credentialInput: unknown): Promise<OAuthAccountsView> {
		const providerId = assertAuthProvider(providerInput);
		const credentialId = credentialInput === undefined ? undefined : assertCredentialId(credentialInput);
		const response = await this.#withAuthClient(client =>
			client.request({
				type: "set_oauth_account_lock",
				providerId,
				...(credentialId === undefined ? {} : { credentialId }),
			}),
		);
		if (!response.success) throw new Error(response.error ?? "OAuth account lock update failed");
		return normalizeOAuthAccounts(response.data);
	}

	async setOAuthAccountFailover(enabledInput: unknown): Promise<OAuthAccountsView> {
		if (typeof enabledInput !== "boolean") throw new TypeError("account failover must be boolean");
		const response = await this.#withAuthClient(client =>
			client.request({ type: "set_oauth_account_failover", enabled: enabledInput }),
		);
		if (!response.success) throw new Error(response.error ?? "OAuth account failover update failed");
		return normalizeOAuthAccounts(response.data);
	}

	async removeOAuthAccount(providerInput: unknown, credentialInput: unknown): Promise<OAuthAccountsView> {
		const providerId = assertAuthProvider(providerInput);
		const credentialId = assertCredentialId(credentialInput);
		const response = await this.#withAuthClient(client =>
			client.request({ type: "remove_oauth_account", providerId, credentialId }),
		);
		if (!response.success) throw new Error(response.error ?? "OAuth account removal failed");
		return normalizeOAuthAccounts(response.data);
	}

	async loginProvider(providerInput: unknown): Promise<AuthAccountView[]> {
		const provider = assertAuthProvider(providerInput);
		if (this.#authLogin) return this.#authLogin;
		const operation = this.#runAuthLogin(provider);
		this.#authLogin = operation;
		try {
			return await operation;
		} finally {
			if (this.#authLogin === operation) this.#authLogin = undefined;
		}
	}

	async logoutProvider(providerInput: unknown): Promise<AuthAccountView[]> {
		const provider = assertAuthProvider(providerInput);
		const accounts = await this.#authAccounts();
		const account = accounts.find(candidate => candidate.provider === provider);
		if (!account) {
			throw new Error(
				accounts.length === 0
					? "Provider status could not be loaded; sign-out availability is unknown"
					: `Unsupported OAuth provider: ${provider}`,
			);
		}
		const response = await this.#withAuthClient(client => client.request({ type: "logout", providerId: provider }));
		if (!response.success) throw new Error(response.error ?? "Sign-out failed");
		this.#emitAuth({ type: "complete", provider, message: `Signed out of ${account.name}.` });
		return this.#authAccounts();
	}

	respondAuthPrompt(valueInput: unknown): void {
		const value = assertBoundedText(valueInput, "auth prompt");
		const pending = this.#authPrompt;
		if (!pending) throw new Error("No authentication prompt is pending");
		this.#authPrompt = undefined;
		pending.process.client?.sendExtensionResponse({ type: "extension_ui_response", id: pending.id, value });
	}

	async getAgentSettings(idInput?: unknown): Promise<AgentSettingView[]> {
		const response = await this.#withSettingsClient(idInput, client => client.request({ type: "get_settings" }));
		if (!response.success) throw new Error(response.error ?? "Agent settings are unavailable");
		const data = isRecord(response.data) ? response.data : undefined;
		return normalizeAgentSettings(data?.settings);
	}

	async setAgentSetting(idInput: unknown, pathInput: unknown, valueInput: unknown): Promise<AgentSettingView> {
		const path = assertBoundedText(pathInput, "setting path").trim();
		if (!path || path.length > 160) throw new TypeError("invalid setting path");
		const value = assertAgentSettingValue(valueInput);
		const response = await this.#withSettingsClient(idInput, client =>
			client.request({ type: "set_setting", path, value }),
		);
		if (!response.success) throw new Error(response.error ?? "Agent setting update failed");
		const data = isRecord(response.data) ? response.data : undefined;
		const setting = normalizeAgentSetting(data?.setting);
		if (!setting) throw new Error("Agent setting response was invalid");
		return setting;
	}

	async getAgentPrompts(idInput?: unknown): Promise<AgentPromptView[]> {
		const response = await this.#withAgentPromptClient(idInput, client =>
			client.request({ type: "get_agent_prompts" }),
		);
		if (!response.success) throw rpcResponseError(response.error, response.code, "Subagent prompts are unavailable");
		const data = isRecord(response.data) ? response.data : undefined;
		return normalizeAgentPrompts(data?.agents);
	}

	async saveAgentPrompt(
		idInput: unknown,
		nameInput: unknown,
		scopeInput: unknown,
		systemPromptInput: unknown,
		expectedRevisionInput: unknown,
	): Promise<AgentPromptView> {
		const name = assertAgentPromptName(nameInput);
		const scope = assertAgentPromptScope(scopeInput);
		const systemPrompt = assertBoundedText(systemPromptInput, "agent prompt");
		if (!systemPrompt.trim()) throw new TypeError("agent prompt cannot be empty");
		const expectedRevision = assertAgentPromptRevision(expectedRevisionInput, true);
		const response = await this.#withAgentPromptClient(idInput, client =>
			client.request({
				type: "save_agent_prompt",
				name,
				scope,
				systemPrompt,
				expectedRevision,
			}),
		);
		if (!response.success) throw rpcResponseError(response.error, response.code, "Subagent prompt save failed");
		const data = isRecord(response.data) ? response.data : undefined;
		const agent = normalizeAgentPrompt(data?.agent);
		if (!agent) throw new Error("Subagent prompt response was invalid");
		return agent;
	}

	async resetAgentPrompt(
		idInput: unknown,
		nameInput: unknown,
		scopeInput: unknown,
		expectedRevisionInput: unknown,
	): Promise<AgentPromptView> {
		const name = assertAgentPromptName(nameInput);
		const scope = assertAgentPromptScope(scopeInput);
		const expectedRevision = assertAgentPromptRevision(expectedRevisionInput, false);
		const response = await this.#withAgentPromptClient(idInput, client =>
			client.request({ type: "reset_agent_prompt", name, scope, expectedRevision }),
		);
		if (!response.success) throw rpcResponseError(response.error, response.code, "Subagent prompt reset failed");
		const data = isRecord(response.data) ? response.data : undefined;
		const agent = normalizeAgentPrompt(data?.agent);
		if (!agent) throw new Error("Subagent prompt response was invalid");
		return agent;
	}

	/** Validated saved workspace preference for the create-session dialog; undefined when unusable. */
	async #savedWorkspaceDefaultPath(): Promise<string | undefined> {
		try {
			const saved = (await loadPersistedGradivusSettings(this.#userDataPath)).workspace.defaultPath.trim();
			if (!saved) return undefined;
			const stat = await fs.promises.stat(saved).catch(() => undefined);
			return stat?.isDirectory() ? saved : undefined;
		} catch {
			return undefined;
		}
	}
	async chooseAndCreate(kindInput: unknown, cwdInput?: unknown): Promise<SessionSnapshot | null> {
		const kind = assertSessionKind(kindInput);
		let cwd: string;
		if (cwdInput === undefined) {
			if (!this.#window) throw new Error("Main window is not ready");
			const options: Electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
			const defaultPath = await this.#savedWorkspaceDefaultPath();
			if (defaultPath) options.defaultPath = defaultPath;
			const result = await dialog.showOpenDialog(this.#window, options);
			if (result.canceled || result.filePaths.length === 0) return null;
			cwd = result.filePaths[0];
		} else {
			const candidate = path.resolve(assertBoundedText(cwdInput, "workspace cwd"));
			const stat = await fs.promises.stat(candidate).catch(() => undefined);
			if (!stat?.isDirectory()) throw new Error("Workspace folder is not a directory");
			cwd = candidate;
		}
		return this.#createSession(kind, cwd);
	}

	async createBrowserSelectionSession(cwdInput: unknown): Promise<SessionRecordV1> {
		const cwd = path.resolve(assertBoundedText(cwdInput, "browser selection workspace"));
		const stat = await fs.promises.stat(cwd).catch(() => undefined);
		if (!stat?.isDirectory()) throw new Error("Browser selection workspace folder is not a directory");
		const snapshot = await this.#createSession("work", cwd, "browser-selection", "Page Agent", false);
		return snapshot.record;
	}

	async discardBrowserSelectionSession(idInput: unknown): Promise<void> {
		const record = this.#record(idInput);
		if (record.surface !== "browser-selection") {
			throw new Error("Only browser selection sessions can be discarded through this path");
		}
		await this.deleteSession(record.id);
	}

	async #createSession(
		kind: SessionRecordV1["kind"],
		cwd: string,
		surface: NonNullable<SessionRecordV1["surface"]> = "chat",
		title: string | null = null,
		activate = true,
	): Promise<SessionSnapshot> {
		const now = new Date().toISOString();
		const record: SessionRecordV1 = {
			id: randomUUID(),
			kind,
			...(surface === "chat" ? {} : { surface }),
			cwd,
			ompSessionId: "",
			sessionFile: "",
			title,
			createdAt: now,
			lastOpenedAt: now,
		};
		const runtime = this.#createRuntime(record);
		try {
			return await this.#supervisor.run(record.id, async () => {
				await this.#registry.create(runtime.record, activate);
				return this.#snapshot(runtime);
			});
		} catch (error) {
			await this.#supervisor.unregister(record.id);
			await runtime.attachments.close();
			this.#runtimes.delete(record.id);
			throw error;
		}
	}
	async openSession(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		return this.#supervisor.run(record.id, async () => {
			const lastOpenedAt = new Date().toISOString();
			await this.#registry.update(record.id, { lastOpenedAt });
			const runtime = this.#requiredRuntime(record.id);
			runtime.record = { ...runtime.record, lastOpenedAt };
			this.#supervisor.touch(record.id);
			await this.#registry.setActive(record.kind, record.id);
			return this.#snapshot(runtime);
		});
	}
	async resume(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		if (!record.sessionFile) throw new Error("No resumable OMP session file exists");
		return this.#supervisor.run(record.id, async () => {
			const runtime = this.#requiredRuntime(record.id);
			const lastOpenedAt = new Date().toISOString();
			await this.#registry.update(record.id, { lastOpenedAt });
			await this.#registry.setActive(record.kind, record.id);
			runtime.record = { ...runtime.record, lastOpenedAt };
			this.#supervisor.touch(record.id);
			return this.#snapshot(runtime);
		});
	}

	async loadTimelinePage(idInput: unknown, beforeInput: unknown, limitInput: unknown): Promise<TimelinePage> {
		const record = this.#record(idInput);
		const runtime = this.#runtimes.get(record.id);
		if (!runtime) throw new Error("Session is not loaded");
		const before = assertTimelineOffset(beforeInput, "timeline cursor");
		const limit = Math.min(assertTimelineOffset(limitInput, "timeline limit"), 200);
		const end = Math.min(before, runtime.timeline.size);
		const start = Math.max(0, end - limit);
		return {
			items: runtime.timeline.page(start, end - start).map(dehydrateTimelineItem),
			start,
			total: runtime.timeline.size,
		};
	}

	async loadTimelineItem(idInput: unknown, itemIdInput: unknown): Promise<TimelineItem> {
		const record = this.#record(idInput);
		const runtime = this.#runtimes.get(record.id);
		if (!runtime) throw new Error("Session is not loaded");
		if (typeof itemIdInput !== "string" || itemIdInput.length === 0) throw new TypeError("invalid timeline item id");
		const item = runtime.timeline.find(itemIdInput);
		if (!item) throw new Error("Timeline item not found");
		return { ...item, textLoaded: true };
	}
	async loadTimelineToolDetail(idInput: unknown, itemIdInput: unknown): Promise<TimelineToolActivity> {
		const record = this.#record(idInput);
		const runtime = this.#runtimes.get(record.id);
		if (!runtime) throw new Error("Session is not loaded");
		if (typeof itemIdInput !== "string" || itemIdInput.length === 0) throw new TypeError("invalid timeline item id");
		const item = runtime.timeline.find(itemIdInput);
		if (!item) throw new Error("Timeline item not found");
		if (item.toolActivity?.operation !== "eval") throw new Error("Timeline item has no eval detail");
		return structuredClone({ ...item.toolActivity, detailsLoaded: true });
	}
	async getAvailableCommands(idInput: unknown): Promise<SlashCommand[]> {
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			if (runtime.commands.length > 0) return [...runtime.commands];
			const response = await client.request({ type: "get_available_commands" });
			if (!response.success) throw new Error(response.error ?? "Slash commands are unavailable");
			const data = isRecord(response.data) ? response.data : undefined;
			runtime.commands = normalizeSlashCommands(data?.commands);
			return [...runtime.commands];
		});
	}

	async getAvailableModels(idInput: unknown): Promise<ModelOption[]> {
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			if (runtime.models) return [...runtime.models];
			const response = await client.request({ type: "get_available_models" });
			if (!response.success) throw new Error(response.error ?? "Models are unavailable");
			const data = isRecord(response.data) ? response.data : undefined;
			const models = Array.isArray(data?.models)
				? data.models.map(toModelOption).filter((model): model is ModelOption => model !== undefined)
				: [];
			runtime.models = models;
			return [...models];
		});
	}
	async getOpenRouterModelRouting(idInput: unknown, modelInput: unknown): Promise<OpenRouterModelRouting> {
		const modelId = assertBoundedText(modelInput, "model").trim();
		if (!modelId) throw new TypeError("invalid model");
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({
				type: "get_openrouter_model_routing",
				modelId,
			});
			if (!response.success) throw new Error(response.error ?? "OpenRouter routes are unavailable");
			return normalizeOpenRouterModelRouting(response.data);
		});
	}

	async setOpenRouterProviderEnabled(
		idInput: unknown,
		modelInput: unknown,
		providerInput: unknown,
		enabledInput: unknown,
	): Promise<OpenRouterModelRouting> {
		const modelId = assertBoundedText(modelInput, "model").trim();
		const providerId = assertBoundedText(providerInput, "provider").trim();
		if (!modelId || !providerId || typeof enabledInput !== "boolean") {
			throw new TypeError("invalid OpenRouter routing preference");
		}
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({
				type: "set_openrouter_provider_enabled",
				modelId,
				providerId,
				enabled: enabledInput,
			});
			if (!response.success) throw new Error(response.error ?? "OpenRouter route could not be updated");
			return normalizeOpenRouterModelRouting(response.data);
		});
	}

	async stop(id: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		await this.#supervisor.stop(record.id);
		this.#flushEvents(record.id);
		return this.#snapshot(this.#requiredRuntime(record.id));
	}

	async rename(id: unknown, titleInput: unknown): Promise<SessionSnapshot> {
		const record = this.#record(id);
		const title = assertSessionName(titleInput);
		const runtime = this.#requiredRuntime(record.id);
		if (runtime.state === "ready" || runtime.state === "running") {
			await this.#supervisor.run(record.id, async () => {
				const client = runtime.process.client;
				if (!client) throw new Error("OMP is not ready");
				const response = await client.request({ type: "set_session_name", name: title });
				if (!response.success) throw new Error(response.error);
			});
		}
		await this.#registry.update(record.id, { title });
		runtime.record = { ...runtime.record, title };
		return this.#snapshot(runtime);
	}
	async deleteSession(idInput: unknown): Promise<BootstrapSnapshot> {
		if (typeof idInput !== "string") throw new TypeError("invalid session id");
		const record = this.#record(idInput);
		await this.#supervisor.stop(record.id);
		this.#flushEvents(record.id);
		await this.#supervisor.unregister(record.id);
		const runtime = this.#runtimes.get(record.id);
		if (runtime) await runtime.attachments.close();
		this.#runtimes.delete(record.id);
		await this.#registry.remove(record.id);
		return this.bootstrap();
	}

	async stagePromptAttachments(idInput: unknown, uploadsInput: unknown): Promise<PromptAttachmentView[]> {
		const record = this.#record(idInput);
		const runtime = this.#requiredRuntime(record.id);
		return runtime.attachments.stageUploads(uploadsInput);
	}

	async stagePromptText(idInput: unknown, textInput: unknown): Promise<PromptAttachmentView> {
		const record = this.#record(idInput);
		const runtime = this.#requiredRuntime(record.id);
		return runtime.attachments.stagePromptText(textInput);
	}

	async releasePromptAttachments(idInput: unknown, attachmentIdsInput: unknown): Promise<void> {
		const record = this.#record(idInput);
		const runtime = this.#requiredRuntime(record.id);
		await runtime.attachments.release(attachmentIdsInput);
	}

	async prompt(id: unknown, compositionInput: unknown): Promise<string> {
		return this.#runWithRuntime(id, async (runtime, client) => {
			const resolved: ResolvedPromptComposition = await runtime.attachments.resolve(compositionInput);
			return client.prompt(resolved.text, resolved.images.length > 0 ? resolved.images : undefined, "steer");
		});
	}
	async requestPlanReview(idInput: unknown): Promise<PlanReviewView> {
		return this.#enqueuePlanReviewMutation(idInput, async (runtime, client) => {
			const response = await client.request({ type: "request_plan_review" });
			if (!response.success || response.command !== "request_plan_review") {
				throw new PlanReviewRpcError(response.error ?? "Plan review is unavailable", response.code);
			}
			const data = isRecord(response.data) ? response.data : undefined;
			const planReview = normalizePlanReview(data?.planReview);
			runtime.planReview = planReview;
			this.#emitUrgent({ sessionId: runtime.record.id, type: "plan_review", planReview });
			return structuredClone(planReview);
		});
	}

	async updatePlanReview(
		idInput: unknown,
		reviewIdInput: unknown,
		contentInput: unknown,
		expectedRevisionInput: unknown,
		annotationStateInput: unknown,
	): Promise<PlanReviewView> {
		const reviewId = assertBoundedText(reviewIdInput, "plan review id");
		const content = assertBoundedText(contentInput, "plan review content");
		const expectedRevision = assertBoundedText(expectedRevisionInput, "plan review revision");
		return this.#enqueuePlanReviewMutation(idInput, async (runtime, client) => {
			if (!runtime.planReview) throw new Error("No plan review is pending");
			const annotationState = normalizePlanReview({
				...runtime.planReview,
				content,
				annotationState: annotationStateInput,
			}).annotationState;
			const response = await client.request({
				type: "update_plan_review",
				reviewId,
				content,
				expectedRevision,
				annotationState,
			});
			if (!response.success || response.command !== "update_plan_review") {
				throw new PlanReviewRpcError(response.error ?? "Plan review update failed", response.code);
			}
			const data = isRecord(response.data) ? response.data : undefined;
			const planReview = normalizePlanReview(data?.planReview);
			runtime.planReview = planReview;
			this.#emitUrgent({ sessionId: runtime.record.id, type: "plan_review", planReview });
			return structuredClone(planReview);
		});
	}

	async resolvePlanReview(
		idInput: unknown,
		reviewIdInput: unknown,
		expectedRevisionInput: unknown,
		decisionInput: unknown,
	): Promise<PlanReviewResolutionResult> {
		const record = this.#record(idInput);
		const reviewId = assertBoundedText(reviewIdInput, "plan review id");
		const expectedRevision = assertBoundedText(expectedRevisionInput, "plan review revision");
		if (!isRecord(decisionInput) || typeof decisionInput.kind !== "string") {
			throw new TypeError("invalid plan review decision");
		}
		return this.#enqueuePlanReviewMutation(record.id, async (runtime, client) => {
			const current = runtime.planReview;
			if (!current || current.id !== reviewId) throw new Error("This plan review is no longer current");
			let decision: Record<string, unknown>;
			let savedPath: string | undefined;
			if (decisionInput.kind === "approve") {
				if (
					decisionInput.context !== "fresh" &&
					decisionInput.context !== "compact" &&
					decisionInput.context !== "keep"
				) {
					throw new TypeError("invalid plan approval context");
				}
				const executionRole =
					decisionInput.executionRole === undefined
						? undefined
						: assertBoundedText(decisionInput.executionRole, "plan execution role");
				if (executionRole && !current.executionModels.some(model => model.role === executionRole)) {
					throw new TypeError("invalid plan execution role");
				}
				decision = {
					kind: "approve",
					context: decisionInput.context,
					...(executionRole ? { executionRole } : {}),
				};
			} else if (decisionInput.kind === "refine") {
				const feedback = assertBoundedText(decisionInput.feedback, "plan refinement feedback");
				let resolvedText = "";
				let images: PromptImageContent[] = [];
				if (decisionInput.composition !== undefined) {
					const resolved = await runtime.attachments.resolve(decisionInput.composition);
					resolvedText = resolved.text;
					images = resolved.images;
				}
				const text = [feedback.trim(), resolvedText.trim()].filter(Boolean).join("\\n\\n");
				decision = {
					kind: "refine",
					feedback: text,
					...(images.length > 0 ? { images } : {}),
				};
			} else if (decisionInput.kind === "save") {
				const options: Electron.SaveDialogOptions = {
					title: "Save reviewed plan",
					defaultPath: current.suggestedSaveName,
					filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				};
				const result = this.#window
					? await dialog.showSaveDialog(this.#window, options)
					: await dialog.showSaveDialog(options);
				if (result.canceled || !result.filePath) return { accepted: false, cancelled: true };
				savedPath = result.filePath;
				decision = { kind: "save", outputPath: savedPath };
			} else {
				throw new TypeError("invalid plan review decision");
			}

			const response = await client.request({
				type: "resolve_plan_review",
				reviewId,
				expectedRevision,
				decision,
			});
			if (!response.success || response.command !== "resolve_plan_review") {
				throw new PlanReviewRpcError(response.error ?? "Plan review decision failed", response.code);
			}
			const data = isRecord(response.data) ? response.data : undefined;
			if (data?.accepted !== true) throw new Error("Plan review response was invalid");
			if (decisionInput.kind !== "save") {
				return {
					accepted: true,
					...(data.awaitingRefinement === true ? { awaitingRefinement: true } : {}),
				};
			}
			runtime.planReview = undefined;
			this.#emitUrgent({ sessionId: runtime.record.id, type: "plan_review" });
			try {
				const createdSession = await this.#createSession(record.kind, record.cwd);
				return { accepted: true, savedPath, createdSession };
			} catch (error) {
				throw new Error(
					`Saved plan to ${savedPath}, but could not start a new chat: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		});
	}

	async editMessage(idInput: unknown, timelineItemIdInput: unknown, textInput: unknown): Promise<EditMessageResult> {
		if (typeof timelineItemIdInput !== "string" || timelineItemIdInput.trim().length === 0) {
			throw new TypeError("invalid timeline item id");
		}
		const editedText = assertBoundedText(textInput, "edited text");
		if (editedText.trim().length === 0) throw new RangeError("edited text cannot be blank");

		return this.#runWithRuntime(idInput, async (runtime, client) => {
			const stateResponse = await client.request({ type: "get_state" });
			if (!stateResponse.success || stateResponse.command !== "get_state") {
				throw new Error(
					stateResponse.success
						? "OMP state response was invalid"
						: (stateResponse.error ?? "OMP state request failed"),
				);
			}
			const liveState = stateResponse.data as StateData;
			if (liveState.isStreaming === true || liveState.queuedMessageCount > 0) {
				throw new Error("Messages can only be edited while the session is idle");
			}

			const branchMessagesResponse = await client.request({ type: "get_branch_messages" });
			if (!branchMessagesResponse.success || branchMessagesResponse.command !== "get_branch_messages") {
				throw new Error(
					branchMessagesResponse.success
						? "OMP branch messages response was invalid"
						: (branchMessagesResponse.error ?? "OMP branch messages request failed"),
				);
			}
			const branchMessages = normalizeBranchMessages(branchMessagesResponse.data);
			const branchTarget = runtime.timeline.resolveBranchEntry(timelineItemIdInput, branchMessages);
			if (!branchTarget) throw new Error("The selected user message is not available for branching");

			const branchResponse = await client.request({ type: "branch", entryId: branchTarget.entryId });
			if (!branchResponse.success || branchResponse.command !== "branch") {
				throw new Error(
					branchResponse.success
						? "OMP branch response was invalid"
						: (branchResponse.error ?? "OMP branch failed"),
				);
			}
			if (
				!isRecord(branchResponse.data) ||
				typeof branchResponse.data.cancelled !== "boolean" ||
				typeof branchResponse.data.text !== "string"
			) {
				throw new Error("OMP branch response was invalid");
			}
			const branchImages = normalizeBranchImages(branchResponse.data.images);
			if (branchResponse.data.cancelled) {
				return { cancelled: true, snapshot: this.#snapshot(runtime) };
			}

			const refreshedStateResponse = await client.request({ type: "get_state" });
			if (!refreshedStateResponse.success || refreshedStateResponse.command !== "get_state") {
				throw new Error(
					refreshedStateResponse.success
						? "OMP state response after branching was invalid"
						: (refreshedStateResponse.error ?? "OMP state refresh after branching failed"),
				);
			}
			const refreshedState = refreshedStateResponse.data as StateData;
			if (typeof refreshedState.sessionId !== "string" || refreshedState.sessionId.length === 0) {
				throw new Error("OMP state response after branching was invalid");
			}
			const lastOpenedAt = new Date().toISOString();
			runtime.record = {
				...runtime.record,
				ompSessionId: refreshedState.sessionId,
				sessionFile: refreshedState.sessionFile ?? runtime.record.sessionFile,
				lastOpenedAt,
			};
			await this.#registry.update(runtime.record.id, {
				ompSessionId: runtime.record.ompSessionId,
				sessionFile: runtime.record.sessionFile,
				lastOpenedAt,
			});
			runtime.timeline.load(await loadHistory(client));
			runtime.subagents = [];
			runtime.agentHub = undefined;
			runtime.queuedMessageCount = refreshedState.queuedMessageCount;
			const snapshot = this.#snapshot(runtime);

			try {
				const requestId = await client.prompt(editedText, branchImages.length > 0 ? branchImages : undefined);
				return { cancelled: false, snapshot, requestId };
			} catch (error) {
				return {
					cancelled: false,
					snapshot,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		});
	}

	async deliverElementPrompt(
		promptText: string,
		targetSessionId: string,
		metadata?: SelectionPromptMetadata,
	): Promise<void> {
		const image = selectionPromptImage(metadata);
		await this.#runWithRuntime(targetSessionId, async (_runtime, client) => {
			await client.prompt(promptText, image ? [image] : undefined);
		});
	}

	async executeInlinePrompt(
		promptText: string,
		targetSessionId: string,
		metadata?: SelectionPromptMetadata,
	): Promise<string> {
		const runtime = this.#runtimes.get(targetSessionId);
		const client = runtime?.process.client;
		if (!client) throw new Error("OMP is not ready for inline selection");

		let requestId: string | undefined;
		let unsubscribe: (() => void) | undefined;
		const output = new Promise<string>((resolve, reject) => {
			const chunks: string[] = [];
			let settled = false;
			const finish = (value: string): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const fail = (error: unknown): void => {
				if (settled) return;
				settled = true;
				reject(error instanceof Error ? error : new Error(String(error)));
			};
			const textFromContent = (content: unknown): string => {
				if (typeof content === "string") return content;
				if (!Array.isArray(content)) return "";
				return content
					.map(block => {
						if (typeof block === "string") return block;
						if (!isRecord(block)) return "";
						return typeof block.text === "string"
							? block.text
							: typeof block.content === "string"
								? block.content
								: "";
					})
					.join("");
			};
			unsubscribe = client.onEvent(event => {
				if (!isRecord(event)) return;
				const type = event.type;
				if (type === "message_delta" || type === "text_delta" || type === "delta") {
					const delta =
						typeof event.delta === "string" ? event.delta : typeof event.text === "string" ? event.text : "";
					if (delta) chunks.push(delta);
					return;
				}
				if (
					(type === "message_start" || type === "message_update" || type === "message_end") &&
					isRecord(event.message)
				) {
					const message = event.message;
					if (message.role === "assistant") {
						const text = textFromContent(message.content);
						if (text && (type === "message_end" || chunks.length === 0)) {
							chunks.length = 0;
							chunks.push(text);
						}
					}
					return;
				}
				if (type !== "prompt_result") return;
				if (requestId && event.id !== requestId) return;
				if (isRecord(event.error) && typeof event.error.message === "string") {
					fail(new Error(event.error.message));
					return;
				}
				if (event.agentInvoked !== true) {
					fail(new Error("Inline prompt completed without an agent response"));
					return;
				}
				finish(chunks.join(""));
			});
		});

		try {
			const image = selectionPromptImage(metadata);
			requestId = await client.prompt(promptText, image ? [image] : undefined);
			const response = await output;
			if (!response.trim()) throw new Error("OMP returned no inline output");
			return response;
		} finally {
			unsubscribe?.();
		}
	}
	resolveSelectionTarget(
		paneId: string,
		targetAgentId: string | undefined,
		documentEpoch: number,
	): { scope: SelectionAuthScope; target: SelectionTargetAgent } {
		if (!paneId || paneId.trim().length === 0) {
			throw new Error("Pane ID is required for selection scope");
		}

		const doc = this.#document;
		const principal = this.#principal;

		if (!doc || !principal) {
			throw new Error("No authenticated workspace authority found for selection");
		}

		// 1. Requested pane
		const pane = doc.panes.find(p => p.id === paneId);
		if (!pane) {
			throw new Error(`Pane '${paneId}' not found in authority document`);
		}
		if (pane.kind !== "browser") {
			throw new Error(`Pane '${paneId}' is a ${pane.kind} pane, not a browser pane`);
		}

		// 2. Owning tab
		const tab = doc.tabs.find(t => t.id === pane.tabId);
		if (!tab) {
			throw new Error(`Tab '${pane.tabId}' for pane '${paneId}' not found in authority document`);
		}

		// 3. Owning workspace from the tab
		const workspace = doc.workspaces.find(w => w.id === tab.workspaceId);
		if (!workspace) {
			throw new Error(`Workspace '${tab.workspaceId}' for tab '${tab.id}' not found in authority document`);
		}

		// 4. Tab location
		const location = doc.locations.find(l => l.id === tab.locationId);
		if (!location) {
			throw new Error(`Location '${tab.locationId}' for tab '${tab.id}' not found in authority document`);
		}

		if (tab.generation !== location.lifecycle.generation) {
			throw new Error(
				`Tab generation ${tab.generation} does not match active location generation ${location.lifecycle.generation}`,
			);
		}

		// 5. Exact open browser entity verification
		const browser = doc.browsers.find(
			b =>
				b.id === pane.entityId &&
				b.paneId === pane.id &&
				b.locationId === location.id &&
				b.generation === location.lifecycle.generation &&
				(b.status === "opening" || b.status === "open"),
		);
		if (!browser) {
			throw new Error(`Open browser entity '${pane.entityId}' for pane '${paneId}' not found in authority document`);
		}

		if (!Number.isSafeInteger(documentEpoch) || documentEpoch <= 0) {
			throw new Error("Valid positive documentEpoch is required for selection scope");
		}

		const rejectTarget = (): never => {
			throw new Error("No deliverable workspace agent is available for selection");
		};
		const agentId = targetAgentId?.trim();
		const agent = agentId ? doc.agents.find(candidate => candidate.id === agentId) : undefined;
		if (!agent) {
			throw new Error("No deliverable workspace agent is available for selection");
		}

		const agentStatus = String(agent.status).toLowerCase();
		if (
			agentStatus === "stopped" ||
			agentStatus === "failed" ||
			agentStatus === "exited" ||
			agentStatus === "error"
		) {
			rejectTarget();
		}
		const targetSessionId = agent.sessionId;
		if (!targetSessionId) {
			throw new Error("No deliverable workspace agent is available for selection");
		}

		const session = doc.sessions.find(candidate => candidate.id === targetSessionId);
		if (
			!session ||
			session.actorId !== agent.id ||
			session.status !== "active" ||
			session.locationId !== tab.locationId
		) {
			rejectTarget();
		}

		const ownedPaneIds = new Set<string>();
		if (agent.paneId) ownedPaneIds.add(agent.paneId);
		if (agent.terminalId) {
			const terminal = doc.terminals.find(candidate => candidate.id === agent.terminalId);
			const terminalPaneId =
				terminal?.paneId ??
				(terminal ? doc.panes.find(candidate => candidate.entityId === terminal.id)?.id : undefined);
			if (!terminalPaneId) {
				throw new Error("No deliverable workspace agent is available for selection");
			}
			ownedPaneIds.add(terminalPaneId);
		}
		for (const ownedPaneId of ownedPaneIds) {
			const ownedPane = doc.panes.find(candidate => candidate.id === ownedPaneId);
			const ownedTab = ownedPane ? doc.tabs.find(candidate => candidate.id === ownedPane.tabId) : undefined;
			if (!ownedTab || ownedTab.workspaceId !== workspace.id) rejectTarget();
		}

		const profile = doc.agentProfiles.find(candidate => candidate.id === agent.profileId);
		const target: SelectionTargetAgent = {
			id: agent.id,
			name: profile?.name || agent.id,
			swatch: getAgentSwatch(agent.id),
		};
		const scope: SelectionAuthScope = {
			principalId: principal.id,
			workspaceId: workspace.id,
			tabId: tab.id,
			paneId: pane.id,
			documentEpoch,
			locationGeneration: location.lifecycle.generation,
			locationId: location.id,
			agentId: agent.id,
			sessionId: targetSessionId,
		};
		return { scope, target };
	}

	async steer(id: unknown, compositionInput: unknown): Promise<void> {
		await this.#runWithRuntime(id, async (runtime, client) => {
			const resolved: ResolvedPromptComposition = await runtime.attachments.resolve(compositionInput);
			const response = await client.request({
				type: "steer",
				message: resolved.text,
				...(resolved.images.length > 0 ? { images: resolved.images } : {}),
			});
			if (!response.success) throw new Error(response.error);
		});
	}
	async steerQueued(id: unknown, compositionInput: unknown): Promise<void> {
		await this.#runWithRuntime(id, async (runtime, client) => {
			const resolved: ResolvedPromptComposition = await runtime.attachments.resolve(compositionInput);
			const response = await client.request({
				type: "steer_queued",
				message: resolved.text,
			});
			if (!response.success) throw new Error(response.error);
			await this.#refreshQueuedMessageCount(runtime, client).catch(() => {});
		});
	}

	async queueFollowUp(id: unknown, compositionInput: unknown): Promise<void> {
		await this.#runWithRuntime(id, async (runtime, client) => {
			const resolved: ResolvedPromptComposition = await runtime.attachments.resolve(compositionInput);
			const response = await client.request({
				type: "follow_up",
				message: resolved.text,
				...(resolved.images.length > 0 ? { images: resolved.images } : {}),
			});
			if (!response.success) throw new Error(response.error);
			await this.#refreshQueuedMessageCount(runtime, client).catch(() => {});
		});
	}

	async setTodos(
		idInput: unknown,
		phasesInput: unknown,
		expectedRevisionInput: unknown,
		actionInput: unknown,
	): Promise<TodoState> {
		const phases = normalizeTodoPhasesInput(phasesInput);
		if (!Number.isSafeInteger(expectedRevisionInput) || (expectedRevisionInput as number) < 0) {
			throw new TypeError("invalid todo revision");
		}
		const expectedRevision = expectedRevisionInput as number;
		const action = assertBoundedText(actionInput, "todo action").trim();
		if (!action || action.length > 256) throw new TypeError("invalid todo action");
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			const response = await client.request({
				type: "set_todos",
				phases,
				expectedRevision,
				action,
			});
			if (!response.success) throw rpcResponseError(response.error, response.code, "Todo update failed");
			const data = isRecord(response.data) ? response.data : undefined;
			const todoState = normalizeTodoState(data?.todoState);
			runtime.todoState = todoState;
			return structuredClone(todoState);
		});
	}

	async compact(idInput: unknown, instructionsInput: unknown): Promise<ContextMutationResult> {
		const instructions = optionalInstructions(instructionsInput, "compaction instructions");
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			if (runtime.isStreaming || runtime.isCompacting || (runtime.queuedMessageCount ?? 0) > 0) {
				throw new Error("Compaction is unavailable while the session is busy or has queued messages");
			}
			const beforeTokens = runtime.contextTokens ?? 0;
			runtime.isCompacting = true;
			this.#emitRuntimeLifecycle(runtime);
			try {
				const response = await client.request({ type: "compact", customInstructions: instructions });
				if (!response.success) throw new Error(response.error ?? "Compaction failed");
				await this.#refreshRuntimeContext(runtime, client);
				const afterTokens = runtime.contextTokens ?? 0;
				return { beforeTokens, afterTokens, changed: beforeTokens !== afterTokens };
			} finally {
				runtime.isCompacting = false;
				this.#emitRuntimeLifecycle(runtime);
			}
		});
	}

	async handoff(idInput: unknown, instructionsInput: unknown): Promise<ContextMutationResult> {
		const instructions = optionalInstructions(instructionsInput, "handoff instructions");
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			if (runtime.isStreaming) throw new Error("Cannot hand off while a response is in progress");
			const beforeTokens = runtime.contextTokens ?? 0;
			runtime.isCompacting = true;
			this.#emitRuntimeLifecycle(runtime);
			try {
				const response = await client.request({ type: "handoff", customInstructions: instructions });
				if (!response.success) throw new Error(response.error ?? "Handoff failed");
				await this.#refreshRuntimeContext(runtime, client);
				const data = isRecord(response.data) ? response.data : undefined;
				const afterTokens = runtime.contextTokens ?? 0;
				return {
					beforeTokens,
					afterTokens,
					changed: response.data !== null,
					...(typeof data?.savedPath === "string" ? { savedPath: data.savedPath } : {}),
				};
			} finally {
				runtime.isCompacting = false;
				this.#emitRuntimeLifecycle(runtime);
			}
		});
	}

	async retry(idInput: unknown): Promise<{ started: boolean }> {
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "prompt", message: "/retry" });
			if (!response.success) throw new Error(response.error ?? "Retry failed");
			const data = isRecord(response.data) ? response.data : undefined;
			return { started: data?.agentInvoked === true };
		});
	}

	async abortRetry(idInput: unknown): Promise<void> {
		await this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "abort_retry" });
			if (!response.success) throw new Error(response.error ?? "Cancel retry failed");
		});
	}

	async getSessionStats(idInput: unknown): Promise<SessionStatsView> {
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "get_session_stats" });
			if (!response.success) throw new Error(response.error ?? "Session statistics are unavailable");
			return normalizeSessionStats(response.data);
		});
	}

	async exportHtml(idInput: unknown, outputPathInput: unknown): Promise<ExportHtmlResult> {
		const record = this.#record(idInput);
		let outputPath = outputPathInput === undefined ? undefined : assertBoundedText(outputPathInput, "export path");
		if (!outputPath) {
			const options: Electron.SaveDialogOptions = {
				title: "Export OMP session",
				defaultPath: `${record.title?.trim() || "OMP session"}.html`,
				filters: [{ name: "HTML", extensions: ["html"] }],
				properties: ["createDirectory", "showOverwriteConfirmation"],
			};
			const result = this.#window
				? await dialog.showSaveDialog(this.#window, options)
				: await dialog.showSaveDialog(options);
			if (result.canceled || !result.filePath) return { cancelled: true };
			outputPath = result.filePath;
		}
		return this.#runWithRuntime(record.id, async (_runtime, client) => {
			const response = await client.request({ type: "export_html", outputPath });
			if (!response.success) throw new Error(response.error ?? "HTML export failed");
			const data = isRecord(response.data) ? response.data : undefined;
			if (typeof data?.path !== "string") throw new Error("HTML export response was invalid");
			return { cancelled: false, path: data.path };
		});
	}

	async restart(idInput: unknown): Promise<SessionSnapshot> {
		const record = this.#record(idInput);
		await this.#runWithRuntime(record.id, async (runtime, client) => {
			const response = await client.request({ type: "get_state" });
			if (!response.success || !isRecord(response.data))
				throw new Error(response.error ?? "OMP state refresh failed");
			const sessionFile =
				typeof response.data.sessionFile === "string" ? response.data.sessionFile : runtime.record.sessionFile;
			if (runtime.timeline.size > 0 && !sessionFile) {
				throw new Error("This session has no resumable session file");
			}
			runtime.record = { ...runtime.record, sessionFile };
			await this.#registry.update(runtime.record.id, { sessionFile });
		});
		this.#flushEvents(record.id);
		await this.#supervisor.stop(record.id);
		const runtime = this.#requiredRuntime(record.id);
		runtime.outstandingExtensions.clear();
		runtime.retryState = undefined;
		return this.#runWithRuntime(record.id, () => this.#snapshot(runtime));
	}

	async #refreshRuntimeContext(runtime: RuntimeSession, client: RpcClient): Promise<void> {
		const state = await client.request({ type: "get_state" });
		if (!state.success || !isRecord(state.data)) throw new Error(state.error ?? "OMP state refresh failed");
		const contextUsage = isRecord(state.data.contextUsage) ? state.data.contextUsage : undefined;
		runtime.contextTokens =
			typeof contextUsage?.tokens === "number" && Number.isFinite(contextUsage.tokens)
				? contextUsage.tokens
				: undefined;
		runtime.contextWindow =
			typeof contextUsage?.contextWindow === "number" && Number.isFinite(contextUsage.contextWindow)
				? contextUsage.contextWindow
				: runtime.contextWindow;
		runtime.tokensPerSecond =
			typeof state.data.tokensPerSecond === "number" || state.data.tokensPerSecond === null
				? state.data.tokensPerSecond
				: runtime.tokensPerSecond;
		runtime.queuedMessageCount =
			Number.isSafeInteger(state.data.queuedMessageCount) && (state.data.queuedMessageCount as number) >= 0
				? (state.data.queuedMessageCount as number)
				: runtime.queuedMessageCount;
		runtime.isStreaming = state.data.isStreaming === true;
		runtime.isCompacting = state.data.isCompacting === true;
		runtime.timeline.load(await loadHistory(client));
		this.#emitRuntimeLifecycle(runtime);
	}

	#emitRuntimeLifecycle(runtime: RuntimeSession): void {
		this.#emitUrgent({
			sessionId: runtime.record.id,
			type: "session",
			isStreaming: runtime.isStreaming,
			isCompacting: runtime.isCompacting,
			retryState: runtime.retryState,
		});
	}

	async #refreshQueuedMessageCount(runtime: RuntimeSession, client: RpcClient): Promise<void> {
		const state = await client.request({ type: "get_state" });
		if (!state.success || state.command !== "get_state" || !isRecord(state.data)) return;
		const count = state.data.queuedMessageCount;
		if (Number.isSafeInteger(count) && (count as number) >= 0) runtime.queuedMessageCount = count as number;
	}

	async abort(id: unknown): Promise<void> {
		await this.#runWithRuntime(id, async (_runtime, client) => {
			const response = await client.request({ type: "abort" });
			if (!response.success) throw new Error(response.error);
		});
	}

	async setModel(id: unknown, providerInput: unknown, modelIdInput: unknown): Promise<void> {
		const provider = assertBoundedText(providerInput, "model provider");
		const modelId = assertBoundedText(modelIdInput, "model id");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({
				type: "set_model",
				provider,
				modelId,
			});
			if (!response.success) throw new Error(response.error);
			runtime.model = `${provider}/${modelId}`;
		});
	}

	async setThinking(id: unknown, levelInput: unknown): Promise<void> {
		return this.setThinkingLevel(id, levelInput);
	}

	async setThinkingLevel(id: unknown, levelInput: unknown): Promise<void> {
		const level = assertThinkingLevel(levelInput);
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({
				type: "set_thinking_level",
				level,
			});
			if (!response.success) throw new Error(response.error);
			runtime.thinkingLevel = level;
		});
	}
	async setFastMode(id: unknown, enabled: unknown): Promise<void> {
		if (typeof enabled !== "boolean") throw new TypeError("invalid fast mode value");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_fast_mode", enabled });
			if (!response.success) throw new Error(response.error);
			const data = isRecord(response.data) ? response.data : undefined;
			runtime.fastMode = typeof data?.enabled === "boolean" ? data.enabled : enabled;
		});
	}
	async togglePlanMode(
		id: unknown,
		enabledInput?: unknown,
	): Promise<{ enabled: boolean; planFilePath?: string } | undefined> {
		return this.#runWithRuntime(id, async (runtime, client) => {
			const targetEnabled = typeof enabledInput === "boolean" ? enabledInput : !runtime.planMode?.enabled;
			const response = await client.request({
				type: "set_plan_mode",
				enabled: targetEnabled,
			});
			if (!response.success) throw new Error(response.error ?? "Failed to toggle plan mode");
			const data = isRecord(response.data) ? response.data : undefined;
			const planModeData = isRecord(data?.planMode) ? data?.planMode : undefined;
			runtime.planMode = planModeData
				? {
						enabled: planModeData.enabled === true,
						planFilePath: typeof planModeData.planFilePath === "string" ? planModeData.planFilePath : undefined,
						workflow: typeof planModeData.workflow === "string" ? planModeData.workflow : undefined,
					}
				: undefined;
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "config",
				config: {
					model: runtime.model,
					thinkingLevel: runtime.thinkingLevel,
					fastMode: runtime.fastMode,
					planMode: runtime.planMode,
					steeringMode: runtime.steeringMode,
					followUpMode: runtime.followUpMode,
					interruptMode: runtime.interruptMode,
					autoCompactionEnabled: runtime.autoCompactionEnabled,
					autoRetryEnabled: runtime.autoRetryEnabled,
				},
			});
			return runtime.planMode;
		});
	}

	async setQueueMode(id: unknown, kindInput: unknown, modeInput: unknown): Promise<void> {
		if (kindInput !== "steering" && kindInput !== "follow-up") throw new TypeError("invalid queue mode kind");
		const mode = assertQueueMode(modeInput);
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({
				type: kindInput === "steering" ? "set_steering_mode" : "set_follow_up_mode",
				mode,
			});
			if (!response.success) throw new Error(response.error);
			if (kindInput === "steering") runtime.steeringMode = mode;
			else runtime.followUpMode = mode;
		});
	}

	async setInterruptMode(id: unknown, modeInput: unknown): Promise<void> {
		const mode = assertInterruptMode(modeInput);
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_interrupt_mode", mode });
			if (!response.success) throw new Error(response.error);
			runtime.interruptMode = mode;
		});
	}

	async setAutoCompaction(id: unknown, enabled: unknown): Promise<void> {
		if (typeof enabled !== "boolean") throw new TypeError("invalid auto-compaction value");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_auto_compaction", enabled });
			if (!response.success) throw new Error(response.error);
			runtime.autoCompactionEnabled = enabled;
		});
	}

	async setAutoRetry(id: unknown, enabled: unknown): Promise<void> {
		if (typeof enabled !== "boolean") throw new TypeError("invalid auto-retry value");
		await this.#runWithRuntime(id, async (runtime, client) => {
			const response = await client.request({ type: "set_auto_retry", enabled });
			if (!response.success) throw new Error(response.error);
			runtime.autoRetryEnabled = enabled;
		});
	}

	async extensionResponse(idInput: unknown, responseInput: unknown): Promise<void> {
		if (typeof responseInput !== "object" || responseInput === null || !("id" in responseInput))
			throw new TypeError("invalid extension response");
		const response = responseInput as Record<string, unknown>;
		if (typeof response.id !== "string") throw new TypeError("invalid extension response id");
		if (response.value !== undefined) assertBoundedText(response.value, "extension response");
		if (response.confirmed !== undefined && typeof response.confirmed !== "boolean")
			throw new TypeError("invalid extension confirmation");
		if (response.cancelled !== undefined && response.cancelled !== true)
			throw new TypeError("invalid extension cancellation");
		await this.#runWithRuntime(idInput, (runtime, client) => {
			const expected = runtime.outstandingExtensions.get(response.id as string);
			if (!expected) throw new Error("stale extension response");
			if (response.method !== undefined && response.method !== expected.method)
				throw new Error("extension response method mismatch");
			runtime.outstandingExtensions.delete(response.id as string);
			client.sendExtensionResponse({
				...response,
				type: "extension_ui_response",
			} as RpcExtensionUIResponse);
		});
	}

	async getSubagentMessages(idInput: unknown, subagentIdInput: unknown, fromByteInput: unknown): Promise<unknown> {
		if (
			typeof subagentIdInput !== "string" ||
			typeof fromByteInput !== "number" ||
			!Number.isSafeInteger(fromByteInput) ||
			fromByteInput < 0
		)
			throw new TypeError("invalid subagent transcript request");
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({
				type: "get_subagent_messages",
				subagentId: subagentIdInput,
				fromByte: fromByteInput,
			});
			if (!response.success) throw new Error(response.error ?? "subagent transcript unavailable");
			return response.data;
		});
	}

	async getAgentHub(idInput: unknown): Promise<AgentHubSnapshot> {
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			const response = await client.request({ type: "get_agent_hub" });
			if (!response.success) throw new Error(response.error ?? "Agent Hub unavailable");
			const snapshot = normalizeAgentHubSnapshot(response.data);
			runtime.agentHub = snapshot;
			return snapshot;
		});
	}

	async getAgentHubMessages(
		idInput: unknown,
		agentIdInput: unknown,
		fromByteInput: unknown,
	): Promise<AgentHubMessagePage> {
		const agentId = assertAgentHubId(agentIdInput);
		const fromByte = assertAgentHubByteOffset(fromByteInput);
		return this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "get_agent_hub_messages", agentId, fromByte });
			if (!response.success) throw new Error(response.error ?? "Agent Hub transcript unavailable");
			return normalizeAgentHubMessagePage(response.data);
		});
	}

	async agentHubMessage(idInput: unknown, agentIdInput: unknown, messageInput: unknown): Promise<void> {
		const agentId = assertAgentHubId(agentIdInput);
		const message = assertAgentHubMessage(messageInput);
		await this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "agent_hub_message", agentId, message });
			if (!response.success) throw new Error(response.error ?? "Agent Hub message failed");
		});
	}

	async agentHubKill(idInput: unknown, agentIdInput: unknown): Promise<void> {
		const agentId = assertAgentHubId(agentIdInput);
		await this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "agent_hub_kill", agentId });
			if (!response.success) throw new Error(response.error ?? "Agent Hub kill failed");
		});
	}

	async agentHubClear(idInput: unknown, agentIdInput: unknown): Promise<void> {
		const agentId = assertAgentHubId(agentIdInput);
		await this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "agent_hub_clear", agentId });
			if (!response.success) throw new Error(response.error ?? "Agent Hub clear failed");
		});
	}

	async agentHubRevive(idInput: unknown, agentIdInput: unknown): Promise<void> {
		const agentId = assertAgentHubId(agentIdInput);
		await this.#runWithRuntime(idInput, async (_runtime, client) => {
			const response = await client.request({ type: "agent_hub_revive", agentId });
			if (!response.success) throw new Error(response.error ?? "Agent Hub revive failed");
		});
	}
	async loadFileDiff(idInput: unknown, targetInput: unknown): Promise<FileDiffView> {
		const target = assertBoundedText(targetInput, "file diff path").trim();
		if (!target || target.length > 4_096) throw new TypeError("invalid file diff path");
		return this.#runWithRuntime(idInput, async (runtime, client) => {
			const key = fileDiffCacheKey(target);
			const cached = runtime.fileDiffCache.get(key);
			if (cached && cached.expiresAt > Date.now()) return cached.request;

			const request = client.request({ type: "get_file_diff", path: target }).then(response => {
				if (!response.success) throw new Error(response.error ?? "File diff is unavailable");
				return normalizeFileDiff(response.data);
			});
			const entry = { expiresAt: Date.now() + FILE_DIFF_CACHE_TTL_MS, request };
			runtime.fileDiffCache.set(key, entry);
			try {
				return await request;
			} catch (error) {
				if (runtime.fileDiffCache.get(key) === entry) runtime.fileDiffCache.delete(key);
				throw error;
			}
		});
	}

	async loadWorkspaceImage(
		idInput: unknown,
		targetInput: unknown,
		maxDimensionInput: unknown,
	): Promise<WorkspaceImagePreview> {
		const record = this.#record(idInput);
		if (typeof targetInput !== "string") throw new TypeError("image path must be text");
		if (
			typeof maxDimensionInput !== "number" ||
			!Number.isInteger(maxDimensionInput) ||
			maxDimensionInput < MIN_IMAGE_PREVIEW_DIMENSION ||
			maxDimensionInput > MAX_IMAGE_PREVIEW_DIMENSION
		) {
			throw new RangeError("invalid image preview dimension");
		}
		const resolved = await resolveWorkspaceTarget(record.cwd, targetInput);
		const stat = await fs.promises.stat(resolved.target);
		if (!stat.isFile()) throw new Error("Image preview target is not a file");
		if (stat.size <= 0 || stat.size > MAX_PROMPT_IMAGE_BYTES) {
			throw new RangeError("Image preview exceeds the 20 MiB limit");
		}
		const bytes = await fs.promises.readFile(resolved.target);
		const metadata = parseImageMetadata(bytes);
		if (!metadata) throw new Error("Image preview format is unsupported");
		const width = metadata.width ?? 0;
		const height = metadata.height ?? 0;
		if (
			width <= 0 ||
			height <= 0 ||
			width > MAX_WORKSPACE_IMAGE_DIMENSION ||
			height > MAX_WORKSPACE_IMAGE_DIMENSION ||
			width * height > MAX_WORKSPACE_IMAGE_PIXELS
		) {
			throw new RangeError("Image preview dimensions are unsupported");
		}
		const source = nativeImage.createFromBuffer(bytes);
		if (source.isEmpty()) throw new Error("Image preview could not be decoded");
		const scale = Math.min(1, maxDimensionInput / Math.max(width, height));
		const image =
			scale < 1
				? source.resize({
						width: Math.max(1, Math.round(width * scale)),
						height: Math.max(1, Math.round(height * scale)),
						quality: "good",
					})
				: source;
		const previewSize = image.getSize();
		return {
			path: targetInput,
			dataUrl: image.toDataURL(),
			width: previewSize.width,
			height: previewSize.height,
		};
	}

	async openWorkspaceFile(idInput: unknown, targetInput: unknown): Promise<void> {
		const record = this.#record(idInput);
		if (typeof targetInput !== "string") throw new TypeError("target must be text");
		const resolved = await resolveWorkspaceTarget(record.cwd, targetInput);
		if (resolved.revealOnly) await shell.showItemInFolder(resolved.target);
		else {
			const error = await shell.openPath(resolved.target);
			if (error) throw new Error(error);
		}
	}

	async openExternal(urlInput: unknown): Promise<void> {
		const url = safeExternalUrl(urlInput);
		await shell.openExternal(url.toString());
	}

	async stopAll(): Promise<void> {
		await this.#supervisor.close();
		this.#flushAllEvents();
	}
	async close(): Promise<void> {
		this.#authPrompt = undefined;
		const authProcess = this.#authProcess;
		this.#authProcess = undefined;
		this.#authClient = undefined;
		await Promise.all([this.#supervisor.close(), authProcess?.stop().catch(() => {})]);
		this.#flushAllEvents();
		await Promise.all([...this.#runtimes.values()].map(runtime => runtime.attachments.close()));
	}

	#createRuntime(record: SessionRecordV1): RuntimeSession {
		const runtime = {} as RuntimeSession;
		runtime.record = record;
		runtime.attachments = new PromptAttachmentStore();
		runtime.timeline = new TranscriptStore();
		runtime.state = "stopped";
		runtime.subagents = [];
		runtime.commands = [];
		runtime.browserInventory = [];
		runtime.planReviewSupported = false;
		runtime.todoState = { phases: [], revision: 0 };
		runtime.outstandingExtensions = new Map();
		runtime.fileDiffCache = new Map();
		runtime.process = new RpcProcess({
			cwd: record.cwd,
			onEvent: (event, client, incarnation) => this.#onEvent(runtime, event, client, incarnation),
			onExtension: request => this.#onExtension(runtime, request),
			onState: (state, error) => {
				runtime.state = state;
				if (this.#runtimes.get(runtime.record.id) !== runtime) return;
				this.#supervisor.updateState(runtime.record.id, state);
				this.#emitUrgent({
					sessionId: runtime.record.id,
					type: "session",
					state,
					runtime: this.#supervisor.report(runtime.record.id),
					message: error,
				});
			},
		});
		this.#runtimes.set(record.id, runtime);
		this.#supervisor.register({
			id: record.id,
			start: async () => {
				try {
					await this.#startRuntime(runtime);
				} catch (error) {
					if (runtime.process.state !== "stopping" && runtime.process.state !== "stopped") {
						await runtime.process.stop().catch(() => {});
					}
					throw error;
				}
			},
			stop: async () => {
				this.#abortHostToolCalls(runtime.record.id, "OMP runtime stopped");
				await runtime.process.stop();
				runtime.outstandingExtensions.clear();
			},
			sample: () => runtime.process.sample(),
		});
		return runtime;
	}

	#abortHostToolCalls(runtimeId: string, reason: string): void {
		for (const pending of this.#pendingHostToolCalls.values()) {
			if (pending.runtimeId === runtimeId) pending.controller.abort(new Error(reason));
		}
		void this.#paneBroker?.revokeSession(runtimeId);
		this.#paneBrokerUnavailable.delete(runtimeId);
	}

	async #registerRuntimeHostTools(runtime: RuntimeSession, client: RpcClient): Promise<void> {
		const incarnation = runtime.process.incarnation;
		const definition = incarnation ? this.#paneBroker?.definitionFor(runtime.record.id, incarnation) : undefined;
		try {
			const response = await client.request({ type: "set_host_tools", tools: definition ? [definition] : [] });
			if (!response.success || response.command !== "set_host_tools") {
				throw new Error(
					response.success
						? "OMP host tool response was invalid"
						: (response.error ?? "OMP host tool registration failed"),
				);
			}
			this.#paneBrokerUnavailable.delete(runtime.record.id);
		} catch (error) {
			const reason = `Pane automation is unavailable for this OMP runtime: ${
				error instanceof Error ? error.message : String(error)
			}`;
			this.#paneBrokerUnavailable.set(runtime.record.id, reason);
			logger.warn("Failed to register desktop host tools", { sessionId: runtime.record.id, error: reason });
		}
	}
	#applyStateData(runtime: RuntimeSession, data: StateData): void {
		runtime.record = {
			...runtime.record,
			ompSessionId: data.sessionId,
			sessionFile: data.sessionFile ?? runtime.record.sessionFile,
			...(data.sessionName ? { title: data.sessionName } : {}),
			lastOpenedAt: new Date().toISOString(),
		};
		runtime.model = data.model ? `${data.model.provider}/${data.model.id}` : undefined;
		runtime.thinkingLevel = data.thinkingLevel;
		runtime.fastMode = data.fastModeEnabled;
		const planModeRecord = isRecord(data.planMode) ? data.planMode : undefined;
		runtime.planMode = planModeRecord
			? {
					enabled: planModeRecord.enabled === true,
					planFilePath: typeof planModeRecord.planFilePath === "string" ? planModeRecord.planFilePath : undefined,
					workflow: typeof planModeRecord.workflow === "string" ? planModeRecord.workflow : undefined,
				}
			: undefined;
		const capabilities = isRecord(data.capabilities) ? data.capabilities : undefined;
		runtime.planReviewSupported = capabilities?.planReview === 1;
		if (!runtime.planReviewSupported || data.planReview === undefined) {
			runtime.planReview = undefined;
		} else {
			try {
				runtime.planReview = normalizePlanReview(data.planReview);
			} catch (error) {
				logger.warn("Ignoring malformed plan review state", {
					sessionId: runtime.record.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		runtime.steeringMode = data.steeringMode ?? "one-at-a-time";
		runtime.followUpMode = data.followUpMode ?? "one-at-a-time";
		runtime.interruptMode = data.interruptMode ?? "immediate";
		runtime.autoCompactionEnabled = data.autoCompactionEnabled ?? true;
		runtime.autoRetryEnabled = data.autoRetryEnabled ?? true;
		runtime.contextTokens = data.contextUsage?.tokens;
		runtime.contextWindow = data.contextUsage?.contextWindow;
		runtime.tokensPerSecond = data.tokensPerSecond;
		runtime.queuedMessageCount = data.queuedMessageCount;
		runtime.isStreaming = data.isStreaming === true;
		runtime.isCompacting = data.isCompacting === true;
		runtime.todoState = normalizeTodoState(data.todoState);
	}

	async #startRuntime(runtime: RuntimeSession): Promise<void> {
		const client = await runtime.process.start(runtime.record.sessionFile || undefined);
		await this.#registerRuntimeHostTools(runtime, client);
		const state = await client.request({ type: "get_state" });
		if (!state.success || state.command !== "get_state")
			throw new Error(
				state.success ? "OMP state response was invalid" : (state.error ?? "OMP state request failed"),
			);
		const data = state.data as StateData;
		this.#applyStateData(runtime, data);
		const messages = await loadHistory(client);
		runtime.timeline.load(messages);
		const subagents = await client.request({ type: "get_subagents" });
		if (subagents.success && subagents.command === "get_subagents") {
			const data = subagents.data as { subagents: unknown[] };
			runtime.subagents = data.subagents.map(toSubagentView);
		}
		const agentHub = await client.request({ type: "get_agent_hub" });
		if (agentHub.success) {
			try {
				runtime.agentHub = normalizeAgentHubSnapshot(agentHub.data);
			} catch {
				runtime.agentHub = undefined;
			}
		}
		const commands = await client.request({ type: "set_subagent_subscription", level: "progress" });
		if (!commands.success) throw new Error(commands.error ?? "Subagent subscription failed");
		await this.#registry.update(runtime.record.id, runtime.record);
		this.#emitUrgent({ sessionId: runtime.record.id, type: "timeline" });
	}

	async #runWithRuntime<T>(
		idInput: unknown,
		operation: (runtime: RuntimeSession, client: RpcClient) => T | Promise<T>,
	): Promise<T> {
		const record = this.#record(idInput);
		const runtime = this.#requiredRuntime(record.id);
		return this.#supervisor.run(record.id, () => {
			const client = runtime.process.client;
			if (!client) throw new Error("OMP is not ready");
			return operation(runtime, client);
		});
	}
	#enqueuePlanReviewMutation<T>(
		idInput: unknown,
		operation: (runtime: RuntimeSession, client: RpcClient) => T | Promise<T>,
	): Promise<T> {
		const record = this.#record(idInput);
		const previous = this.#planReviewMutationTails.get(record.id) ?? Promise.resolve();
		const result = previous
			.catch(() => {})
			.then(() =>
				this.#runWithRuntime(record.id, async (runtime, client) => {
					const incarnation = runtime.process.incarnation;
					if (!incarnation) throw new Error("OMP runtime incarnation is unavailable");
					const value = await operation(runtime, client);
					if (
						this.#runtimes.get(record.id) !== runtime ||
						runtime.process.client !== client ||
						runtime.process.incarnation !== incarnation
					) {
						throw new Error("OMP runtime changed during the plan review operation");
					}
					return value;
				}),
			);
		const tail = result.then(
			() => {},
			() => {},
		);
		this.#planReviewMutationTails.set(record.id, tail);
		void tail.finally(() => {
			if (this.#planReviewMutationTails.get(record.id) === tail) this.#planReviewMutationTails.delete(record.id);
		});
		return result;
	}

	/**
	 * Resolve a loaded desktop session to its registered workspace without
	 * starting, resuming, or otherwise touching its OMP runtime.
	 */
	resolveSessionWorkspace(idInput: unknown): { sessionId: string; cwd: string; workspace: string } {
		const record = this.#record(idInput);
		return {
			sessionId: record.id,
			cwd: path.resolve(record.cwd),
			workspace: record.title?.trim() || path.basename(record.cwd) || "Workspace",
		};
	}

	resolveChatSessionForBrowserAgent(idInput: unknown): string {
		const source = this.#record(idInput);
		const sourceCwd = path.resolve(source.cwd);
		const registry = this.#registry.value;
		const visibleSessions = registry.sessions.filter(
			record => record.surface !== "browser-selection" && path.resolve(record.cwd) === sourceCwd,
		);
		const activeIds = new Set([registry.activeByKind.work, registry.activeByKind.code]);
		const selected = visibleSessions
			.filter(record => activeIds.has(record.id))
			.sort(
				(a, b) =>
					new Date(b.lastOpenedAt || b.createdAt).getTime() - new Date(a.lastOpenedAt || a.createdAt).getTime(),
			)[0];
		const fallback =
			selected ??
			visibleSessions.sort(
				(a, b) =>
					new Date(b.lastOpenedAt || b.createdAt).getTime() - new Date(a.lastOpenedAt || a.createdAt).getTime(),
			)[0];
		if (!fallback) throw new Error("Open a chat for this workspace before sending a Page Agent task to chat");
		return fallback.id;
	}

	#requiredRuntime(id: string): RuntimeSession {
		const runtime = this.#runtimes.get(id);
		if (!runtime) throw new Error(`Runtime ${id} is not registered`);
		return runtime;
	}
	#record(idInput: unknown): SessionRecordV1 {
		if (typeof idInput !== "string") throw new TypeError("invalid session id");
		const record = this.#registry.value.sessions.find(candidate => candidate.id === idInput);
		if (!record) throw new Error("Session not found");
		return record;
	}

	#snapshot(runtime: RuntimeSession): SessionSnapshot {
		const timelineTotal = runtime.timeline.size;
		const timelineStart = Math.max(0, timelineTotal - 200);
		const pendingRequest = runtime.outstandingExtensions.values().next().value;
		return {
			record: runtime.record,
			state: runtime.state,
			timeline: runtime.timeline.page(timelineStart, timelineTotal - timelineStart).map(dehydrateTimelineItem),
			timelineStart,
			timelineTotal,
			subagents: runtime.subagents,
			agentHub: runtime.agentHub,
			commands: [...runtime.commands],
			browserInventory: structuredClone(runtime.browserInventory),
			model: runtime.model,
			thinkingLevel: runtime.thinkingLevel,
			fastMode: runtime.fastMode,
			planMode: runtime.planMode,
			planReviewSupported: runtime.planReviewSupported,
			...(runtime.planReview ? { planReview: structuredClone(runtime.planReview) } : {}),
			steeringMode: runtime.steeringMode,
			followUpMode: runtime.followUpMode,
			interruptMode: runtime.interruptMode,
			autoCompactionEnabled: runtime.autoCompactionEnabled,
			autoRetryEnabled: runtime.autoRetryEnabled,
			contextTokens: runtime.contextTokens,
			contextWindow: runtime.contextWindow,
			tokensPerSecond: runtime.tokensPerSecond,
			queuedMessageCount: runtime.queuedMessageCount,
			isStreaming: runtime.isStreaming,
			isCompacting: runtime.isCompacting,
			retryState: runtime.retryState,
			todoState: structuredClone(runtime.todoState),
			...(pendingRequest ? { pendingExtension: extensionView(pendingRequest) } : {}),
			runtime: this.#supervisor.report(runtime.record.id),
		};
	}

	async #oauthAccounts(): Promise<OAuthAccountsView> {
		const response = await this.#withAuthClient(client => client.request({ type: "get_oauth_accounts" }));
		if (!response.success) throw new Error(response.error ?? "OAuth accounts are unavailable");
		return normalizeOAuthAccounts(response.data);
	}
	async #authAccounts(): Promise<AuthAccountView[]> {
		try {
			const response = await this.#withAuthClient(client => client.request({ type: "get_login_providers" }));
			if (!response.success) {
				this.#emitAuth({
					type: "error",
					provider: AUTH_DISCOVERY_PROVIDER,
					message: `Provider status could not be loaded: ${
						response.error ?? "the local OMP runtime did not report sign-in providers"
					}`,
				});
				return [];
			}
			const data = isRecord(response.data) ? response.data : undefined;
			return normalizeAuthAccounts(data?.providers);
		} catch (error) {
			this.#emitAuth({
				type: "error",
				provider: AUTH_DISCOVERY_PROVIDER,
				message: `Provider status could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
			});
			return [];
		}
	}

	async #runAuthLogin(provider: string): Promise<AuthAccountView[]> {
		let providerName = provider;
		try {
			const accounts = await this.#authAccounts();
			const account = accounts.find(candidate => candidate.provider === provider);
			if (!account) {
				throw new Error(
					accounts.length === 0
						? "Provider status could not be loaded; sign-in availability is unknown"
						: `Unsupported OAuth provider: ${provider}`,
				);
			}
			if (!account.available) throw new Error(`${account.name} sign-in is unavailable on this system`);
			providerName = account.name;
			this.#activeAuthProvider = { id: provider, name: providerName };
			const response = await this.#withAuthClient(client => client.request({ type: "login", providerId: provider }));
			if (!response.success) throw new Error(response.error ?? `${providerName} sign-in failed`);
			this.#emitAuth({ type: "complete", provider, message: `${providerName} sign-in complete.` });
			return this.#authAccounts();
		} catch (error) {
			this.#authPrompt = undefined;
			const message = error instanceof Error ? error.message : String(error);
			this.#emitAuth({ type: "error", provider, message });
			throw error;
		} finally {
			if (this.#activeAuthProvider?.id === provider) this.#activeAuthProvider = undefined;
		}
	}

	async #withAgentPromptClient<T>(idInput: unknown, operation: (client: RpcClient) => Promise<T>): Promise<T> {
		let cwd: string | undefined;
		if (idInput !== undefined) {
			const record = this.#record(idInput);
			cwd = record.cwd;
			const runtime = this.#runtimes.get(record.id);
			if (runtime && (runtime.state === "ready" || runtime.state === "running")) {
				return this.#supervisor.run(record.id, () => {
					const client = runtime.process.client;
					if (!client) throw new Error("OMP is not ready");
					return operation(client);
				});
			}
		} else {
			cwd = await this.#savedWorkspaceDefaultPath();
		}
		if (!cwd) throw new Error("Choose a workspace before editing project subagent prompts");

		const process = new RpcProcess({
			cwd,
			onEvent: () => {},
			onExtension: () => {},
			onState: () => {},
		});
		try {
			return await operation(await process.start());
		} finally {
			await process.stop();
		}
	}

	async #withSettingsClient<T>(idInput: unknown, operation: (client: RpcClient) => Promise<T>): Promise<T> {
		if (idInput !== undefined) {
			const record = this.#record(idInput);
			const runtime = this.#requiredRuntime(record.id);
			if (runtime.state === "ready" || runtime.state === "running") {
				return this.#supervisor.run(record.id, () => {
					const client = runtime.process.client;
					if (!client) throw new Error("OMP is not ready");
					return operation(client);
				});
			}
		}
		return this.#withAuthClient(operation);
	}

	async #withAuthClient<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
		this.#authClientUsers++;
		try {
			let clientPromise = this.#authClient;
			if (!clientPromise) {
				const authProcess = new RpcProcess({
					cwd: process.cwd(),
					onEvent: () => {},
					onExtension: request => this.#onAuthExtension(request),
					onState: () => {},
				});
				this.#authProcess = authProcess;
				clientPromise = authProcess.start();
				this.#authClient = clientPromise;
			}
			return await operation(await clientPromise);
		} finally {
			this.#authClientUsers--;
			if (this.#authClientUsers === 0) {
				const authProcess = this.#authProcess;
				this.#authProcess = undefined;
				this.#authClient = undefined;
				await authProcess?.stop().catch(() => {});
			}
		}
	}

	#onAuthExtension(request: RpcExtensionUIRequest): void {
		const provider = this.#activeAuthProvider ?? {
			id: "openai-codex",
			name: "ChatGPT Plus/Pro (Codex Subscription)",
		};
		if (request.method === "notify" && request.message) {
			this.#emitAuth({ type: "progress", provider: provider.id, message: request.message });
			return;
		}
		if (request.method === "open_url" && request.url) {
			this.#emitAuth({
				type: "auth-url",
				provider: provider.id,
				message: `Opening ${provider.name} sign-in in your browser.`,
				url: request.launchUrl ?? request.url,
			});
			void this.openExternal(request.launchUrl ?? request.url).catch(error =>
				this.#emitAuth({
					type: "error",
					provider: provider.id,
					message: error instanceof Error ? error.message : String(error),
				}),
			);
			return;
		}
		if (request.method !== "input" || !this.#authProcess) return;
		this.#authPrompt = { id: request.id, process: this.#authProcess };
		this.#emitAuth({
			type: "prompt",
			provider: provider.id,
			message: request.title ?? `Finish signing in to ${provider.name}`,
			placeholder: request.placeholder,
			sensitive: true,
		});
	}

	#emitAuth(event: AuthEvent): void {
		if (isWindowUsable(this.#window)) {
			try {
				this.#window?.webContents.send("gradivus:auth", event);
			} catch {}
		}
	}

	#onRuntimeReport(report: RuntimeReportView): void {
		if (!this.#runtimes.has(report.id)) return;
		this.#emitUrgent({
			sessionId: report.id,
			type: "session",
			state: report.processState,
			runtime: report,
		});
	}

	#cancelHostToolCall(runtime: RuntimeSession, incarnation: string, frame: RpcHostToolCancelRequest): void {
		const pending = this.#pendingHostToolCalls.get(`${incarnation}:${frame.targetId}`);
		if (!pending || pending.runtimeId !== runtime.record.id || pending.incarnation !== incarnation) return;
		pending.controller.abort(new Error("Pane Browser call cancelled by OMP"));
	}

	async #handleHostToolCall(
		runtime: RuntimeSession,
		client: RpcClient,
		incarnation: string,
		frame: RpcHostToolCallRequest,
	): Promise<void> {
		const pendingKey = `${incarnation}:${frame.id}`;
		if (this.#pendingHostToolCalls.has(pendingKey)) {
			await client.sendHostToolResult({
				type: "host_tool_result",
				id: frame.id,
				result: { content: [{ type: "text", text: "Duplicate Gradivus pane call ID" }] },
				isError: true,
			});
			return;
		}
		const controller = new AbortController();
		this.#pendingHostToolCalls.set(pendingKey, { runtimeId: runtime.record.id, incarnation, controller });
		let result: RpcHostToolResultBody;
		let isError = false;
		try {
			if (frame.toolName !== "gradivus_pane" || !this.#paneBroker) {
				throw new Error(`Host tool ${frame.toolName} is unavailable`);
			}
			result = await this.#paneBroker.execute(runtime.record.id, incarnation, frame.arguments, controller.signal);
		} catch (error) {
			isError = true;
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_048);
			result = { content: [{ type: "text", text: message || "Gradivus pane call failed" }] };
		} finally {
			this.#pendingHostToolCalls.delete(pendingKey);
		}
		if (controller.signal.aborted || runtime.process.client !== client || runtime.process.incarnation !== incarnation)
			return;
		try {
			await client.sendHostToolResult({
				type: "host_tool_result",
				id: frame.id,
				result,
				...(isError ? { isError: true } : {}),
			});
		} catch (error) {
			logger.warn("Failed to return Gradivus pane result", {
				sessionId: runtime.record.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	#startPlanReviewReset(runtime: RuntimeSession, client: RpcClient, incarnation: string): void {
		if (this.#planReviewResetGates.has(runtime.record.id)) return;
		const gate: PlanReviewResetGate = { incarnation, frames: [] };
		this.#planReviewResetGates.set(runtime.record.id, gate);
		void this.#hydratePlanReviewReset(runtime, client, gate);
	}

	async #hydratePlanReviewReset(runtime: RuntimeSession, client: RpcClient, gate: PlanReviewResetGate): Promise<void> {
		const sessionId = runtime.record.id;
		try {
			const [state, messages] = await Promise.all([client.request({ type: "get_state" }), loadHistory(client)]);
			if (!state.success || state.command !== "get_state") {
				throw new Error(
					state.success ? "OMP state response was invalid" : (state.error ?? "OMP state refresh failed"),
				);
			}
			const ownsGate = this.#planReviewResetGates.get(sessionId) === gate;
			if (!ownsGate || runtime.process.client !== client || runtime.process.incarnation !== gate.incarnation) {
				if (ownsGate) this.#planReviewResetGates.delete(sessionId);
				return;
			}
			const data = state.data as StateData;
			if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
				throw new Error("OMP reset state response was invalid");
			}
			this.#suppressedEventSessions.add(sessionId);
			this.#discardQueuedEvents(sessionId);
			this.#applyStateData(runtime, data);
			runtime.timeline.load(messages);
			this.#planReviewResetGates.delete(sessionId);
			for (const buffered of gate.frames) {
				if (buffered.incarnation === gate.incarnation && buffered.sourceClient === client) {
					this.#onEvent(runtime, buffered.event, buffered.sourceClient, buffered.incarnation);
				}
			}
			await this.#registry.update(sessionId, runtime.record);
			this.#suppressedEventSessions.delete(sessionId);
			this.#emitUrgent({ sessionId, type: "session_reset", snapshot: this.#snapshot(runtime) });
		} catch (error) {
			if (this.#planReviewResetGates.get(sessionId) !== gate) return;
			this.#planReviewResetGates.delete(sessionId);
			this.#suppressedEventSessions.delete(sessionId);
			this.#emitUrgent({
				sessionId,
				type: "warning",
				message: `Could not refresh the reset plan session: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
			for (const buffered of gate.frames) {
				if (buffered.incarnation === gate.incarnation && buffered.sourceClient === client) {
					this.#onEvent(runtime, buffered.event, buffered.sourceClient, buffered.incarnation);
				}
			}
		}
	}

	#discardQueuedEvents(sessionId: string): void {
		clearTimeout(this.#eventTimers.get(sessionId));
		this.#eventTimers.delete(sessionId);
		this.#eventQueues.delete(sessionId);
		this.#eventQueueIndexes.delete(sessionId);
	}

	#onEvent(runtime: RuntimeSession, event: unknown, sourceClient: RpcClient, incarnation: string): void {
		this.#supervisor.touch(runtime.record.id, false);
		const frame = event as Record<string, unknown>;
		if (
			frame.type === "host_tool_call" &&
			typeof frame.id === "string" &&
			typeof frame.toolCallId === "string" &&
			typeof frame.toolName === "string" &&
			isRecord(frame.arguments)
		) {
			void this.#handleHostToolCall(runtime, sourceClient, incarnation, frame as unknown as RpcHostToolCallRequest);
			return;
		}
		if (frame.type === "host_tool_cancel" && typeof frame.id === "string" && typeof frame.targetId === "string") {
			this.#cancelHostToolCall(runtime, incarnation, frame as unknown as RpcHostToolCancelRequest);
			return;
		}
		const resetGate = this.#planReviewResetGates.get(runtime.record.id);
		if (resetGate && resetGate.incarnation === incarnation) {
			resetGate.frames.push({ event, sourceClient, incarnation });
			return;
		}
		if (resetGate) this.#planReviewResetGates.delete(runtime.record.id);
		if (frame.type === "plan_review_update") {
			runtime.planReviewSupported = true;
			let malformedMessage: string | undefined;
			try {
				runtime.planReview =
					"planReview" in frame && frame.planReview !== undefined
						? normalizePlanReview(frame.planReview)
						: undefined;
			} catch (error) {
				malformedMessage = error instanceof Error ? error.message : String(error);
				if (runtime.planReview) {
					runtime.planReview = {
						...runtime.planReview,
						error: `Plan review update was invalid: ${malformedMessage}`,
					};
				}
				logger.warn("Ignoring malformed plan review update", {
					sessionId: runtime.record.id,
					error: malformedMessage,
				});
			}
			const sessionReset = isRecord(frame.sessionReset) ? frame.sessionReset : undefined;
			if (sessionReset && typeof sessionReset.sessionId === "string" && sessionReset.sessionId.length > 0) {
				this.#startPlanReviewReset(runtime, sourceClient, incarnation);
				return;
			}
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "plan_review",
				...(runtime.planReview ? { planReview: structuredClone(runtime.planReview) } : {}),
				...(malformedMessage && !runtime.planReview
					? { message: `Plan review update was invalid: ${malformedMessage}` }
					: {}),
			});
			return;
		}
		if (frame.type === "prompt_result") {
			const rawError = isRecord(frame.error) ? frame.error : undefined;
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "prompt_result",
				requestId: typeof frame.id === "string" ? frame.id : undefined,
				agentInvoked: frame.agentInvoked === true,
				error:
					rawError && typeof rawError.message === "string"
						? {
								message: rawError.message,
								...(typeof rawError.code === "string" ? { code: rawError.code } : {}),
							}
						: undefined,
			});
			return;
		}
		if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
			this.#updateSubagents(runtime, frame);
			this.#queueEvent({ sessionId: runtime.record.id, type: "subagents", subagents: runtime.subagents });
			return;
		}
		if (frame.type === "agent_hub_update") {
			try {
				const snapshot = normalizeAgentHubSnapshot(frame);
				runtime.agentHub = snapshot;
				this.#queueEvent({ sessionId: runtime.record.id, type: "agent_hub_update", agentHub: snapshot });
			} catch {
				// Ignore malformed push payloads; the RPC stream must remain usable.
			}
			return;
		}
		if (frame.type === "available_commands_update") {
			runtime.commands = normalizeSlashCommands(frame.commands);
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "commands",
				commands: [...runtime.commands],
			});
			return;
		}
		if (frame.type === "browser_inventory_update") {
			runtime.browserInventory = normalizeBrowserInventory(frame.inventory);
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "browser_inventory",
				browserInventory: structuredClone(runtime.browserInventory),
			});
			return;
		}
		if (frame.type === "todo_update") {
			try {
				const todoState = normalizeTodoState({ phases: frame.phases, revision: frame.revision });
				runtime.todoState = todoState;
				this.#queueEvent({ sessionId: runtime.record.id, type: "todo_update", todoState });
			} catch {
				// Ignore malformed pushes; retain the last canonical state.
			}
			return;
		}
		if (frame.type === "config_update") {
			const model = toModelOption(frame.model);
			if (model) runtime.model = `${model.provider}/${model.id}`;
			if (isThinkingLevel(frame.thinkingLevel)) runtime.thinkingLevel = frame.thinkingLevel;
			if ("planMode" in frame) {
				const planRecord = isRecord(frame.planMode) ? frame.planMode : undefined;
				runtime.planMode = planRecord
					? {
							enabled: planRecord.enabled === true,
							planFilePath: typeof planRecord.planFilePath === "string" ? planRecord.planFilePath : undefined,
							workflow: typeof planRecord.workflow === "string" ? planRecord.workflow : undefined,
						}
					: undefined;
			}
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "config",
				config: {
					model: runtime.model,
					thinkingLevel: runtime.thinkingLevel,
					fastMode: runtime.fastMode,
					planMode: runtime.planMode,
					steeringMode: runtime.steeringMode,
					followUpMode: runtime.followUpMode,
					interruptMode: runtime.interruptMode,
					autoCompactionEnabled: runtime.autoCompactionEnabled,
					autoRetryEnabled: runtime.autoRetryEnabled,
				},
			});
			return;
		}
		if (frame.type === "session_info_update" && typeof frame.title === "string") {
			let title: string;
			try {
				title = assertSessionName(frame.title);
			} catch {
				return;
			}
			runtime.record = { ...runtime.record, title };
			void this.#registry.update(runtime.record.id, { title }).catch(error => {
				this.#emitUrgent({
					sessionId: runtime.record.id,
					type: "warning",
					message: error instanceof Error ? error.message : String(error),
				});
			});
			this.#emitUrgent({ sessionId: runtime.record.id, type: "session", record: runtime.record });
			return;
		}
		if (frame.type === "agent_start") {
			runtime.isStreaming = true;
			this.#emitRuntimeLifecycle(runtime);
		} else if (frame.type === "agent_end") {
			runtime.isStreaming = false;
			this.#emitRuntimeLifecycle(runtime);
		} else if (frame.type === "auto_compaction_start") {
			runtime.isCompacting = true;
			this.#emitRuntimeLifecycle(runtime);
		} else if (frame.type === "auto_compaction_end") {
			runtime.isCompacting = false;
			this.#emitRuntimeLifecycle(runtime);
		} else if (
			frame.type === "auto_retry_start" &&
			Number.isSafeInteger(frame.attempt) &&
			Number.isSafeInteger(frame.maxAttempts) &&
			typeof frame.delayMs === "number" &&
			Number.isFinite(frame.delayMs)
		) {
			runtime.retryState = {
				attempt: frame.attempt as number,
				maxAttempts: frame.maxAttempts as number,
				delayMs: Math.max(0, frame.delayMs),
			};
			this.#emitRuntimeLifecycle(runtime);
		} else if (frame.type === "auto_retry_end") {
			runtime.retryState = undefined;
			this.#emitRuntimeLifecycle(runtime);
		}
		const writeDisposition = writeDispositionForEvent(runtime.record.cwd, frame);
		let items = runtime.timeline.applyChanges(event);
		if (writeDisposition) {
			const updated = runtime.timeline.setWriteDisposition(
				writeDisposition.toolCallId,
				writeDisposition.disposition,
			);
			if (updated) {
				items = items.map(item => (item.toolCallId === writeDisposition.toolCallId ? updated : item));
			}
		}
		if (items.some(item => item.status === "complete" && item.isError !== true && item.files?.length)) {
			runtime.fileDiffCache.clear();
		}
		for (const item of items) {
			this.#queueEvent({ sessionId: runtime.record.id, type: "timeline", item: dehydrateTimelineItem(item) });
		}
	}

	#updateSubagents(runtime: RuntimeSession, frame: Record<string, unknown>): void {
		const payload =
			typeof frame.payload === "object" && frame.payload !== null
				? (frame.payload as Record<string, unknown>)
				: undefined;
		if (!payload) return;
		const id =
			typeof payload.id === "string" ? payload.id : typeof payload.agent === "string" ? payload.agent : undefined;
		if (!id) return;
		const current = runtime.subagents.find(agent => agent.id === id);
		const progress =
			typeof payload.progress === "object" && payload.progress !== null
				? (payload.progress as Record<string, unknown>)
				: undefined;
		const value: SubagentView = {
			id,
			agent: typeof payload.agent === "string" ? payload.agent : (current?.agent ?? "subagent"),
			status: typeof payload.status === "string" ? payload.status : (current?.status ?? "running"),
			task: typeof payload.task === "string" ? payload.task : current?.task,
			assignment: typeof payload.assignment === "string" ? payload.assignment : current?.assignment,
			parentToolCallId:
				typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : current?.parentToolCallId,
			progress: progress
				? {
						currentTool: typeof progress.currentTool === "string" ? progress.currentTool : undefined,
						lastIntent: typeof progress.lastIntent === "string" ? progress.lastIntent : undefined,
						tokens: typeof progress.tokens === "number" ? progress.tokens : undefined,
						contextTokens: typeof progress.contextTokens === "number" ? progress.contextTokens : undefined,
						contextWindow: typeof progress.contextWindow === "number" ? progress.contextWindow : undefined,
						cost: typeof progress.cost === "number" ? progress.cost : undefined,
						durationMs: typeof progress.durationMs === "number" ? progress.durationMs : undefined,
						recentOutput: Array.isArray(progress.recentOutput)
							? progress.recentOutput.filter((value): value is string => typeof value === "string")
							: undefined,
						resolvedModel: typeof progress.resolvedModel === "string" ? progress.resolvedModel : undefined,
						requests: typeof progress.requests === "number" ? progress.requests : undefined,
					}
				: current?.progress,
		};
		if (current) runtime.subagents = runtime.subagents.map(agent => (agent.id === id ? value : agent));
		else runtime.subagents = [...runtime.subagents, value];
	}

	#onExtension(runtime: RuntimeSession, request: RpcExtensionUIRequest): void {
		this.#supervisor.touch(runtime.record.id);
		if (request.method === "cancel") {
			if (request.targetId) runtime.outstandingExtensions.delete(request.targetId);
			this.#emitUrgent({
				sessionId: runtime.record.id,
				type: "extension",
				extension: { id: request.id, method: "cancel", targetId: request.targetId },
			});
			return;
		}
		if (expectsExtensionResponse(request.method)) runtime.outstandingExtensions.set(request.id, request);
		const extension = extensionView(request);
		this.#emitUrgent({ sessionId: runtime.record.id, type: "extension", extension });
	}

	// Stream updates wait one frame; urgent lifecycle/control events flush this queue in arrival order.
	#queueEvent(event: GradivusEvent): void {
		if (this.#suppressedEventSessions.has(event.sessionId)) return;
		const key =
			event.type === "timeline"
				? typeof event.item?.id === "string"
					? `timeline:${event.item.id}`
					: undefined
				: event.type === "subagents" || event.type === "agent_hub_update"
					? event.type
					: undefined;
		const queue = this.#eventQueues.get(event.sessionId) ?? [];
		const indexes = this.#eventQueueIndexes.get(event.sessionId) ?? new Map<string, number>();
		if (key !== undefined) {
			const index = indexes.get(key);
			if (index !== undefined) {
				queue[index] = event;
			} else {
				indexes.set(key, queue.length);
				queue.push(event);
			}
		} else {
			queue.push(event);
		}
		this.#eventQueues.set(event.sessionId, queue);
		this.#eventQueueIndexes.set(event.sessionId, indexes);
		if (!this.#eventTimers.has(event.sessionId))
			this.#eventTimers.set(
				event.sessionId,
				setTimeout(() => this.#flushEvents(event.sessionId), EVENT_BATCH_DELAY_MS),
			);
	}

	#emitUrgent(event: GradivusEvent): void {
		this.#queueEvent(event);
		this.#flushEvents(event.sessionId);
	}

	#flushAllEvents(): void {
		for (const sessionId of this.#eventQueues.keys()) this.#flushEvents(sessionId);
	}

	#flushEvents(sessionId: string): void {
		const timer = this.#eventTimers.get(sessionId);
		clearTimeout(timer);

		this.#eventTimers.delete(sessionId);
		const queue = this.#eventQueues.get(sessionId);
		this.#eventQueues.delete(sessionId);
		this.#eventQueueIndexes.delete(sessionId);
		if (!queue || queue.length === 0) return;
		if (isWindowUsable(this.#window)) {
			try {
				for (const event of queue) this.#window?.webContents.send("gradivus:event", event);
			} catch {}
		}
	}
}
function expectsExtensionResponse(method: RpcExtensionUIRequest["method"]): boolean {
	return (
		method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "open_url"
	);
}
function extensionView(request: RpcExtensionUIRequest): ExtensionView {
	return {
		id: request.id,
		method: request.method,
		targetId: request.targetId,
		title: request.title,
		message: request.message,
		options: request.options,
		placeholder: request.placeholder,
		sensitive: request.sensitive,
		prefill: request.prefill,
		text: request.text,
		url: request.url,
		instructions: request.instructions,
		notifyType: request.notifyType,
		statusKey: request.statusKey,
		statusText: request.statusText,
		widgetKey: request.widgetKey,
		widgetLines: request.widgetLines,
		widgetPlacement: request.widgetPlacement,
	};
}
function assertTimelineOffset(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000) {
		throw new RangeError(`${label} must be a non-negative integer`);
	}
	return value as number;
}
function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "inherit" ||
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function assertThinkingLevel(value: unknown): ThinkingLevel {
	if (!isThinkingLevel(value)) throw new TypeError("invalid thinking level");
	return value;
}

function assertQueueMode(value: unknown): QueueMode {
	if (value !== "all" && value !== "one-at-a-time") throw new TypeError("invalid queue mode");
	return value;
}

function assertInterruptMode(value: unknown): InterruptMode {
	if (value !== "immediate" && value !== "wait") throw new TypeError("invalid interrupt mode");
	return value;
}

function normalizeSlashCommands(value: unknown): SlashCommand[] {
	if (!Array.isArray(value)) return [];
	const commands: SlashCommand[] = [];
	const seen = new Set<string>();
	for (const item of value.slice(0, 5_000)) {
		if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0 || item.name.length > 160)
			continue;
		if (!isSlashCommandSource(item.source) || seen.has(item.name)) continue;
		seen.add(item.name);
		const aliases = Array.isArray(item.aliases)
			? item.aliases
					.filter((alias): alias is string => typeof alias === "string" && alias.length <= 160)
					.slice(0, 32)
			: undefined;
		const input =
			isRecord(item.input) && typeof item.input.hint === "string"
				? { hint: item.input.hint.slice(0, 256) }
				: undefined;
		const subcommands = Array.isArray(item.subcommands)
			? item.subcommands
					.slice(0, 100)
					.map(subcommand => {
						if (!isRecord(subcommand) || typeof subcommand.name !== "string") return undefined;
						return {
							name: subcommand.name.slice(0, 160),
							description:
								typeof subcommand.description === "string" ? subcommand.description.slice(0, 1_024) : undefined,
							usage: typeof subcommand.usage === "string" ? subcommand.usage.slice(0, 512) : undefined,
						};
					})
					.filter((subcommand): subcommand is NonNullable<typeof subcommand> => subcommand !== undefined)
			: undefined;
		commands.push({
			name: item.name,
			aliases,
			description: typeof item.description === "string" ? item.description.slice(0, 4_096) : undefined,
			input,
			subcommands,
			source: item.source,
		});
	}
	return commands;
}

function isSlashCommandSource(value: unknown): value is SlashCommand["source"] {
	return (
		value === "builtin" ||
		value === "skill" ||
		value === "extension" ||
		value === "custom" ||
		value === "mcp_prompt" ||
		value === "file"
	);
}

function toModelOption(value: unknown): ModelOption | undefined {
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
	if (value.provider.length === 0 || value.provider.length > 160 || value.id.length === 0 || value.id.length > 512)
		return undefined;
	return {
		provider: value.provider,
		id: value.id,
		name: typeof value.name === "string" && value.name.length <= 512 ? value.name : value.id,
		reasoning: value.reasoning === true,
		input: Array.isArray(value.input)
			? [
					...new Set(
						value.input.filter(
							(input): input is ModelOption["input"][number] => input === "text" || input === "image",
						),
					),
				]
			: ["text"],
		contextWindow:
			typeof value.contextWindow === "number" && Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0
				? value.contextWindow
				: undefined,
	};
}
function assertAgentHubId(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("agent id must be text");
	const id = value.trim();
	if (id.length === 0 || id.length > 256) throw new RangeError("invalid agent id");
	return id;
}

function assertAgentHubByteOffset(value: unknown): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError("invalid Agent Hub byte offset");
	return value as number;
}

function assertAgentHubMessage(value: unknown): string {
	const message = assertBoundedText(value, "agent hub message").trim();
	if (message.length === 0 || message.length > 64 * 1024) throw new RangeError("invalid Agent Hub message");
	return message;
}
function normalizeAgentHubSnapshot(value: unknown): AgentHubSnapshot {
	if (!isRecord(value) || !Array.isArray(value.agents)) throw new Error("Agent Hub snapshot was invalid");
	const agents = value.agents
		.slice(0, 10_000)
		.map(normalizeAgentHubAgent)
		.filter((agent): agent is AgentHubAgent => agent !== undefined);
	return { agents };
}

function normalizeAgentHubAgent(value: unknown): AgentHubAgent | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		value.id.length > 256 ||
		typeof value.displayName !== "string" ||
		value.displayName.length === 0 ||
		value.displayName.length > 512 ||
		(value.kind !== "sub" && value.kind !== "advisor") ||
		(value.status !== "running" &&
			value.status !== "idle" &&
			value.status !== "parked" &&
			value.status !== "aborted") ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		typeof value.lastActivity !== "number" ||
		!Number.isFinite(value.lastActivity)
	)
		return undefined;
	const optionalText = (key: string, max: number): string | undefined => {
		const candidate = value[key];
		return typeof candidate === "string" && candidate.length > 0 && candidate.length <= max ? candidate : undefined;
	};
	return {
		id: value.id,
		displayName: value.displayName,
		kind: value.kind,
		parentId: optionalText("parentId", 256),
		status: value.status,
		activity: optionalText("activity", 4_096),
		createdAt: value.createdAt,
		lastActivity: value.lastActivity,
		transcriptAvailable: value.transcriptAvailable === true,
		readOnly: value.readOnly === true,
		agent: optionalText("agent", 256),
		modelRole: optionalText("modelRole", 256),
		resolvedModel: optionalText("resolvedModel", 512),
		metrics: normalizeAgentHubMetrics(value.metrics),
		progress: normalizeAgentHubProgress(value.progress),
	};
}
function normalizeAgentHubProgress(value: unknown): SubagentView["progress"] | undefined {
	if (!isRecord(value)) return undefined;
	const textValue = (key: string, max = 4_096): string | undefined => {
		const candidate = value[key];
		return typeof candidate === "string" && candidate.length <= max ? candidate : undefined;
	};
	const numberValue = (key: string): number | undefined => {
		const candidate = value[key];
		return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
	};
	const recentOutput = Array.isArray(value.recentOutput)
		? value.recentOutput
				.slice(0, 12)
				.filter((item): item is string => typeof item === "string" && item.length <= 4_096)
		: undefined;
	return {
		currentTool: textValue("currentTool"),
		lastIntent: textValue("lastIntent"),
		tokens: numberValue("tokens"),
		contextTokens: numberValue("contextTokens"),
		contextWindow: numberValue("contextWindow"),
		cost: numberValue("cost"),
		durationMs: numberValue("durationMs"),
		recentOutput,
		resolvedModel: textValue("resolvedModel", 512),
		requests: numberValue("requests"),
	};
}

function normalizeAgentHubMetrics(value: unknown): AgentHubMetrics | undefined {
	if (!isRecord(value)) return undefined;
	const numeric = (key: string): number | undefined => {
		const candidate = value[key];
		return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
	};
	const tokens = numeric("tokens");
	const requests = numeric("requests");
	const tools = numeric("tools");
	const cost = numeric("cost");
	const durationMs = numeric("durationMs");
	if (
		tokens === undefined ||
		requests === undefined ||
		tools === undefined ||
		cost === undefined ||
		durationMs === undefined
	)
		return undefined;
	return {
		tokens,
		requests,
		tools,
		cost,
		durationMs,
		contextTokens: numeric("contextTokens"),
		contextWindow: numeric("contextWindow"),
	};
}

function normalizeAgentHubMessagePage(value: unknown): AgentHubMessagePage {
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.fromByte) ||
		(value.fromByte as number) < 0 ||
		!Number.isSafeInteger(value.nextByte) ||
		(value.nextByte as number) < 0 ||
		typeof value.reset !== "boolean" ||
		!Array.isArray(value.entries) ||
		!Array.isArray(value.messages)
	)
		throw new Error("Agent Hub message response was invalid");
	const fromByte = value.fromByte as number;
	const nextByte = value.nextByte as number;
	return {
		fromByte,
		nextByte,
		reset: value.reset,
		entries: value.entries.slice(0, 2_000),
		messages: value.messages.slice(0, 2_000),
	};
}

function normalizeOpenRouterModelRouting(value: unknown): OpenRouterModelRouting {
	if (
		!isRecord(value) ||
		typeof value.modelId !== "string" ||
		value.modelId.length === 0 ||
		value.modelId.length > 512 ||
		!Array.isArray(value.providers) ||
		value.providers.length > 512
	) {
		throw new Error("OpenRouter routing response was invalid");
	}
	const providers: OpenRouterModelRouting["providers"] = [];
	const seen = new Set<string>();
	for (const item of value.providers) {
		if (
			!isRecord(item) ||
			typeof item.id !== "string" ||
			item.id.length === 0 ||
			item.id.length > 128 ||
			typeof item.name !== "string" ||
			item.name.length === 0 ||
			item.name.length > 256 ||
			typeof item.enabled !== "boolean" ||
			seen.has(item.id)
		) {
			throw new Error("OpenRouter routing response was invalid");
		}
		seen.add(item.id);
		providers.push({ id: item.id, name: item.name, enabled: item.enabled });
	}
	if (providers.length === 0) throw new Error("OpenRouter routing response did not include providers");
	return { modelId: value.modelId, providers };
}

function dehydrateTimelineItem(item: TimelineItem): TimelineItem {
	if (item.toolActivity?.operation === "eval") {
		const dehydrated = { ...item };
		delete dehydrated.args;
		delete dehydrated.result;
		delete dehydrated.detail;
		delete dehydrated.images;
		const activity = { ...item.toolActivity };
		const omittedImageCount = activity.omittedImageCount + (activity.images?.length ?? 0);
		delete activity.cells;
		delete activity.jsonOutputs;
		delete activity.images;
		delete activity.statusEvents;
		dehydrated.toolActivity = { ...activity, omittedImageCount, detailsLoaded: false };
		return dehydrated;
	}
	if (item.kind !== "thinking" || item.text.length <= 64 * 1024) return { ...item };
	return { ...item, text: "Reasoning available. Open to load the full record.", textLoaded: false };
}

function normalizeFileDiff(value: unknown): FileDiffView {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		typeof value.diff !== "string" ||
		!isFileDiffStatus(value.status) ||
		typeof value.additions !== "number" ||
		!Number.isSafeInteger(value.additions) ||
		value.additions < 0 ||
		typeof value.deletions !== "number" ||
		!Number.isSafeInteger(value.deletions) ||
		value.deletions < 0 ||
		typeof value.truncated !== "boolean"
	)
		throw new Error("File diff response was invalid");
	return {
		path: value.path,
		diff: value.diff,
		status: value.status,
		additions: value.additions,
		deletions: value.deletions,
		truncated: value.truncated,
		message: typeof value.message === "string" ? value.message : undefined,
	};
}

function isFileDiffStatus(value: unknown): value is FileDiffView["status"] {
	return (
		value === "modified" ||
		value === "added" ||
		value === "deleted" ||
		value === "renamed" ||
		value === "clean" ||
		value === "binary" ||
		value === "unavailable"
	);
}

function fileDiffCacheKey(target: string): string {
	const normalized = target.replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function toSubagentView(value: unknown): SubagentView {
	const candidate = value as Record<string, unknown>;
	const progress =
		typeof candidate.progress === "object" && candidate.progress !== null
			? (candidate.progress as Record<string, unknown>)
			: undefined;
	return {
		id: String(candidate.id ?? randomUUID()),
		agent: String(candidate.agent ?? "subagent"),
		status: String(candidate.status ?? "pending"),
		task: typeof candidate.task === "string" ? candidate.task : undefined,
		assignment: typeof candidate.assignment === "string" ? candidate.assignment : undefined,
		parentToolCallId: typeof candidate.parentToolCallId === "string" ? candidate.parentToolCallId : undefined,
		progress: progress
			? {
					currentTool: typeof progress.currentTool === "string" ? progress.currentTool : undefined,
					lastIntent: typeof progress.lastIntent === "string" ? progress.lastIntent : undefined,
					tokens: typeof progress.tokens === "number" ? progress.tokens : undefined,
					contextTokens: typeof progress.contextTokens === "number" ? progress.contextTokens : undefined,
					contextWindow: typeof progress.contextWindow === "number" ? progress.contextWindow : undefined,
					cost: typeof progress.cost === "number" ? progress.cost : undefined,
					durationMs: typeof progress.durationMs === "number" ? progress.durationMs : undefined,
					recentOutput: Array.isArray(progress.recentOutput)
						? progress.recentOutput.filter((item): item is string => typeof item === "string")
						: undefined,
					resolvedModel: typeof progress.resolvedModel === "string" ? progress.resolvedModel : undefined,
					requests: typeof progress.requests === "number" ? progress.requests : undefined,
				}
			: undefined,
	};
}
function normalizeAuthAccounts(value: unknown): AuthAccountView[] {
	if (!Array.isArray(value)) return [];
	const accounts: AuthAccountView[] = [];
	const seen = new Set<string>();
	for (const candidate of value.slice(0, 1_000)) {
		if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.name !== "string") continue;
		if (
			candidate.id.length === 0 ||
			candidate.id.length > 160 ||
			candidate.name.length === 0 ||
			candidate.name.length > 512 ||
			seen.has(candidate.id)
		)
			continue;
		seen.add(candidate.id);
		accounts.push({
			provider: candidate.id,
			name: candidate.name,
			available: candidate.available === true,
			signedIn: candidate.authenticated === true,
		});
	}
	return accounts.sort(
		(left, right) =>
			Number(right.signedIn) - Number(left.signedIn) ||
			Number(right.available) - Number(left.available) ||
			left.name.localeCompare(right.name),
	);
}

function normalizeOAuthAccounts(value: unknown): OAuthAccountsView {
	const data = isRecord(value) ? value : undefined;
	const providers: OAuthProviderAccountsView[] = [];
	const seenProviders = new Set<string>();
	if (!Array.isArray(data?.providers)) return { providers };
	for (const candidate of data.providers.slice(0, 1_000)) {
		if (
			!isRecord(candidate) ||
			typeof candidate.id !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(candidate.id) ||
			typeof candidate.name !== "string" ||
			candidate.name.length === 0 ||
			candidate.name.length > 512 ||
			seenProviders.has(candidate.id)
		)
			continue;
		seenProviders.add(candidate.id);
		const accounts: OAuthAccountSummaryView[] = [];
		const seenCredentials = new Set<number>();
		if (Array.isArray(candidate.accounts)) {
			for (const account of candidate.accounts.slice(0, 1_000)) {
				if (
					!isRecord(account) ||
					!Number.isSafeInteger(account.credentialId) ||
					(account.credentialId as number) < 0 ||
					seenCredentials.has(account.credentialId as number)
				)
					continue;
				const optionalText = (key: string): string | undefined => {
					const value = account[key];
					return typeof value === "string" && value.length <= 512 ? value : undefined;
				};
				const credentialId = account.credentialId as number;
				seenCredentials.add(credentialId);
				accounts.push({
					credentialId,
					email: optionalText("email"),
					accountId: optionalText("accountId"),
					orgId: optionalText("orgId"),
					orgName: optionalText("orgName"),
					projectId: optionalText("projectId"),
					active: account.active === true,
					locked: account.locked === true,
					lockable: account.lockable === true,
				});
			}
		}
		const lockedCredentialId =
			Number.isSafeInteger(candidate.lockedCredentialId) && (candidate.lockedCredentialId as number) >= 0
				? (candidate.lockedCredentialId as number)
				: undefined;
		providers.push({
			id: candidate.id,
			name: candidate.name,
			available: candidate.available === true,
			failover: candidate.failover === true,
			lockedCredentialId,
			accounts,
		});
	}
	return { providers };
}
function normalizeTodoPhasesInput(value: unknown): TodoPhase[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error("Todo phases are invalid");
	const phases: TodoPhase[] = [];
	const phaseIds = new Set<string>();
	const phaseNames = new Set<string>();
	const taskIds = new Set<string>();
	const taskContents = new Set<string>();
	for (const candidate of value) {
		if (
			!isRecord(candidate) ||
			typeof candidate.id !== "string" ||
			!candidate.id ||
			phaseIds.has(candidate.id) ||
			typeof candidate.name !== "string" ||
			!candidate.name ||
			phaseNames.has(candidate.name) ||
			!Array.isArray(candidate.tasks) ||
			candidate.tasks.length > 10_000
		) {
			throw new Error("Todo phase is invalid");
		}
		const earlierIds = new Set<string>();
		const tasks: TodoPhase["tasks"] = [];
		for (const task of candidate.tasks) {
			if (
				!isRecord(task) ||
				typeof task.id !== "string" ||
				!task.id ||
				taskIds.has(task.id) ||
				typeof task.content !== "string" ||
				!task.content ||
				task.content.length > 8_192 ||
				taskContents.has(task.content) ||
				(task.status !== "pending" &&
					task.status !== "in_progress" &&
					task.status !== "completed" &&
					task.status !== "abandoned" &&
					task.status !== "blocked") ||
				(task.blocker !== undefined && (typeof task.blocker !== "string" || task.blocker.length > 8_192)) ||
				(task.parentId !== undefined && (typeof task.parentId !== "string" || !earlierIds.has(task.parentId)))
			) {
				throw new Error("Todo task is invalid");
			}
			tasks.push({
				id: task.id,
				content: task.content,
				status: task.status,
				...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
				...(typeof task.parentId === "string" ? { parentId: task.parentId } : {}),
			});
			earlierIds.add(task.id);
			taskIds.add(task.id);
			taskContents.add(task.content);
		}
		phases.push({ id: candidate.id, name: candidate.name, tasks });
		phaseIds.add(candidate.id);
		phaseNames.add(candidate.name);
	}
	return phases;
}

function normalizeBrowserInventory(value: unknown): BrowserTabInventoryView[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 100).flatMap(candidate => {
		if (
			!isRecord(candidate) ||
			typeof candidate.name !== "string" ||
			!candidate.name ||
			candidate.name.length > 100 ||
			(candidate.state !== "alive" && candidate.state !== "dead") ||
			(candidate.browser !== "headless" &&
				candidate.browser !== "connected" &&
				candidate.browser !== "relay" &&
				candidate.browser !== "spawned" &&
				candidate.browser !== "cmux") ||
			typeof candidate.url !== "string" ||
			typeof candidate.title !== "string" ||
			!Array.isArray(candidate.owners) ||
			!candidate.owners.every(owner => typeof owner === "string") ||
			!Number.isSafeInteger(candidate.activeRunCount) ||
			(candidate.activeRunCount as number) < 0 ||
			!Number.isSafeInteger(candidate.queuedRunCount) ||
			(candidate.queuedRunCount as number) < 0
		) {
			return [];
		}
		return [
			{
				name: candidate.name,
				state: candidate.state,
				browser: candidate.browser,
				url: candidate.url.slice(0, 4_096),
				title: candidate.title.slice(0, 240),
				owners: candidate.owners.slice(0, 100),
				activeRunCount: candidate.activeRunCount as number,
				queuedRunCount: candidate.queuedRunCount as number,
			} satisfies BrowserTabInventoryView,
		];
	});
}
function normalizeTodoState(value: unknown): TodoState {
	if (!isRecord(value)) throw new Error("Todo state response was invalid");
	const revision = value.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
		throw new Error("Todo state response was invalid");
	}
	return { phases: normalizeTodoPhasesInput(value.phases), revision };
}

function normalizeAgentPrompts(value: unknown): AgentPromptView[] {
	if (!Array.isArray(value)) throw new Error("Subagent prompt response was invalid");
	const agents = value
		.slice(0, 1_000)
		.map(normalizeAgentPrompt)
		.filter((agent): agent is AgentPromptView => agent !== undefined);
	if (agents.length !== value.length) throw new Error("Subagent prompt response was invalid");
	return agents;
}

function normalizeAgentPrompt(value: unknown): AgentPromptView | undefined {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value.name) ||
		typeof value.description !== "string" ||
		value.description.length > 8_192 ||
		(value.effectiveSource !== "project" &&
			value.effectiveSource !== "user" &&
			value.effectiveSource !== "bundled") ||
		typeof value.systemPrompt !== "string" ||
		Buffer.byteLength(value.systemPrompt, "utf8") > 512 * 1024 ||
		value.apply !== "next-spawn"
	) {
		return undefined;
	}
	const project = normalizeAgentPromptOverride(value.project);
	const user = normalizeAgentPromptOverride(value.user);
	if ((value.project !== undefined && !project) || (value.user !== undefined && !user)) return undefined;
	return {
		name: value.name,
		description: value.description,
		effectiveSource: value.effectiveSource,
		systemPrompt: value.systemPrompt,
		...(project ? { project } : {}),
		...(user ? { user } : {}),
		apply: "next-spawn",
	};
}

function normalizeAgentPromptOverride(value: unknown): AgentPromptView["project"] {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		typeof value.systemPrompt !== "string" ||
		Buffer.byteLength(value.systemPrompt, "utf8") > 512 * 1024 ||
		typeof value.revision !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.revision)
	) {
		return undefined;
	}
	return { systemPrompt: value.systemPrompt, revision: value.revision };
}

function assertAgentPromptName(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value)) {
		throw new TypeError("invalid agent name");
	}
	return value;
}

function assertAgentPromptScope(value: unknown): AgentPromptScope {
	if (value !== "project" && value !== "user") throw new TypeError("invalid agent prompt scope");
	return value;
}

function assertAgentPromptRevision(value: unknown, allowNull: true): string | null;
function assertAgentPromptRevision(value: unknown, allowNull: false): string;
function assertAgentPromptRevision(value: unknown, allowNull: boolean): string | null {
	if (allowNull && value === null) return null;
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		throw new TypeError("invalid agent prompt revision");
	}
	return value;
}

function rpcResponseError(message: string | undefined, code: string | undefined, fallback: string): Error {
	const error = new Error(message ?? fallback);
	error.name = code ?? "RpcError";
	return error;
}

function normalizeAgentSettings(value: unknown): AgentSettingView[] {
	if (!Array.isArray(value)) return [];
	return value
		.slice(0, 1_000)
		.map(normalizeAgentSetting)
		.filter((setting): setting is AgentSettingView => setting !== undefined);
}

function normalizeAgentSetting(value: unknown): AgentSettingView | undefined {
	if (
		!isRecord(value) ||
		typeof value.path !== "string" ||
		value.path.length === 0 ||
		value.path.length > 160 ||
		!isAgentSettingTab(value.tab) ||
		typeof value.label !== "string" ||
		value.label.length === 0 ||
		value.label.length > 512 ||
		typeof value.description !== "string" ||
		value.description.length > 8_192 ||
		(value.control !== "toggle" && value.control !== "select" && value.control !== "multiselect") ||
		(value.apply !== "immediate" && value.apply !== "next-session") ||
		!isAgentSettingValue(value.value)
	)
		return undefined;
	if (value.control === "toggle" && typeof value.value !== "boolean") return undefined;
	if (
		value.control === "multiselect" &&
		(!Array.isArray(value.value) || !value.value.every(item => typeof item === "string"))
	) {
		return undefined;
	}
	const options = Array.isArray(value.options)
		? value.options
				.slice(0, 1_000)
				.map(normalizeAgentSettingOption)
				.filter((option): option is AgentSettingOption => option !== undefined)
		: undefined;
	if ((value.control === "select" || value.control === "multiselect") && (!options || options.length === 0))
		return undefined;
	return {
		path: value.path,
		tab: value.tab,
		group: typeof value.group === "string" && value.group.length <= 160 ? value.group : undefined,
		label: value.label,
		description: value.description,
		control: value.control,
		value: value.value,
		options,
		...(value.control === "multiselect" && typeof value.ordered === "boolean" ? { ordered: value.ordered } : {}),
		apply: value.apply,
	};
}

function normalizeAgentSettingOption(value: unknown): AgentSettingOption | undefined {
	if (
		!isRecord(value) ||
		!isAgentSettingValue(value.value) ||
		typeof value.label !== "string" ||
		value.label.length === 0 ||
		value.label.length > 512
	)
		return undefined;
	return {
		value: value.value,
		label: value.label,
		description:
			typeof value.description === "string" && value.description.length <= 4_096 ? value.description : undefined,
	};
}

function isAgentSettingTab(value: unknown): value is AgentSettingView["tab"] {
	return (
		value === "appearance" ||
		value === "model" ||
		value === "interaction" ||
		value === "context" ||
		value === "files" ||
		value === "shell" ||
		value === "tools" ||
		value === "tasks"
	);
}

function isAgentSettingValue(value: unknown): value is AgentSettingValue {
	return (
		typeof value === "boolean" ||
		(typeof value === "string" && value.length <= 2_048) ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) &&
			value.length <= 1_000 &&
			value.every(item => typeof item === "string" && item.length <= 2_048))
	);
}

function assertAgentSettingValue(value: unknown): AgentSettingValue {
	if (!isAgentSettingValue(value)) throw new TypeError("invalid agent setting value");
	return value;
}

function assertAuthProvider(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value))
		throw new TypeError("invalid auth provider");
	return value;
}

function assertCredentialId(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new TypeError("invalid credential id");
	}
	return value as number;
}

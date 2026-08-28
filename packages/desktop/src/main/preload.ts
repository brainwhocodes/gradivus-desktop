import { contextBridge, ipcRenderer } from "electron";
import type {
	AgentHubMessagePage,
	AgentHubSnapshot,
	AgentSettingValue,
	AgentSettingView,
	AuthAccountView,
	AuthEvent,
	BootstrapSnapshot,
	BrowserBounds,
	BrowserNavigationAction,
	BrowserViewState,
	ChatTerminalViewState,
	CreateBrowserInput,
	CreateTerminalInput,
	ElementEditState,
	FileDiffView,
	GradivusApi,
	GradivusEvent,
	GradivusSettings,
	InterruptMode,
	ModelOption,
	OAuthAccountsView,
	OpenChatTerminalInput,
	OpenRouterModelRouting,
	PromptAttachmentUpload,
	PromptAttachmentView,
	PromptComposition,
	PromptCompositionPart,
	QueueMode,
	SessionSnapshot,
	SlashCommand,
	TerminalViewState,
	ThinkingLevel,
	TimelineItem,
	TimelinePage,
	WorkspaceDocumentV1,
	WorkspaceEvent,
	WorkspaceImagePreview,
} from "../shared/contracts";
import {
	MAX_INLINE_PROMPT_BYTES,
	MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
	MAX_PROMPT_ATTACHMENT_BYTES,
	MAX_PROMPT_ATTACHMENT_COUNT,
	MAX_TEMP_PROMPT_BYTES,
} from "../shared/contracts";

const MAX_BYTES = MAX_INLINE_PROMPT_BYTES;

function text(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be text`);
	if (new TextEncoder().encode(value).byteLength > MAX_BYTES) throw new RangeError(`${label} exceeds 512 KiB`);
	return value;
}
function attachmentUploads(value: unknown): PromptAttachmentUpload[] {
	if (!Array.isArray(value)) throw new TypeError("attachments must be an array");
	if (value.length > MAX_PROMPT_ATTACHMENT_COUNT) throw new RangeError("too many attachments");
	let batchBytes = 0;
	return value.map((candidate, index) => {
		if (typeof candidate !== "object" || candidate === null)
			throw new TypeError(`attachment ${index + 1} is invalid`);
		const input = candidate as Record<string, unknown>;
		if (typeof input.name !== "string" || input.name.length === 0 || Array.from(input.name).length > 160)
			throw new RangeError(`attachment ${index + 1} has an invalid name`);
		if (input.mimeType !== undefined && (typeof input.mimeType !== "string" || input.mimeType.length > 160))
			throw new RangeError(`attachment ${index + 1} has an invalid MIME type`);
		if (!(input.data instanceof Uint8Array)) throw new TypeError(`attachment ${index + 1} data must be bytes`);
		const data = new Uint8Array(input.data);
		if (data.byteLength === 0 || data.byteLength > MAX_PROMPT_ATTACHMENT_BYTES)
			throw new RangeError(`attachment ${index + 1} exceeds the size limit`);
		batchBytes += data.byteLength;
		if (batchBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) throw new RangeError("attachment batch exceeds 32 MiB");
		return { name: input.name, mimeType: input.mimeType as string | undefined, data };
	});
}

function optionalAttachmentIds(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new TypeError("attachment IDs must be an array");
	if (value.length > MAX_PROMPT_ATTACHMENT_COUNT) throw new RangeError("too many attachment IDs");
	return value.map((id, index) => {
		if (typeof id !== "string" || id.length < 8 || id.length > 100)
			throw new TypeError(`attachment ID ${index + 1} is invalid`);
		return id;
	});
}

function promptText(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("prompt text must be text");
	const bytes = new TextEncoder().encode(value).byteLength;
	if (bytes === 0) throw new RangeError("prompt text cannot be empty");
	if (bytes > MAX_TEMP_PROMPT_BYTES) throw new RangeError("prompt text exceeds 16 MiB");
	return value;
}

function promptComposition(value: unknown): PromptComposition {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new TypeError("prompt composition must be an object");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "parts") || !Array.isArray(input.parts))
		throw new TypeError("prompt composition is invalid");
	if (input.parts.length > 1_024) throw new RangeError("too many prompt composition parts");
	const parts: PromptCompositionPart[] = [];
	const attachmentIds = new Set<string>();
	let inlineBytes = 0;
	for (let index = 0; index < input.parts.length; index++) {
		const candidate = input.parts[index];
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
			throw new TypeError(`prompt composition part ${index + 1} is invalid`);
		const part = candidate as Record<string, unknown>;
		if (part.type === "text") {
			if (
				Object.keys(part).length !== 2 ||
				!Object.hasOwn(part, "type") ||
				!Object.hasOwn(part, "text") ||
				typeof part.text !== "string"
			)
				throw new TypeError(`prompt composition text part ${index + 1} is invalid`);
			inlineBytes += new TextEncoder().encode(part.text).byteLength;
			if (inlineBytes > MAX_INLINE_PROMPT_BYTES) throw new RangeError("prompt exceeds 512 KiB");
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (
			part.type !== "attachment" ||
			Object.keys(part).length !== 2 ||
			!Object.hasOwn(part, "type") ||
			!Object.hasOwn(part, "id") ||
			typeof part.id !== "string" ||
			part.id.length < 8 ||
			part.id.length > 100
		)
			throw new TypeError(`prompt composition attachment part ${index + 1} is invalid`);
		if (attachmentIds.has(part.id)) throw new RangeError("duplicate prompt attachment ID");
		if (attachmentIds.size >= MAX_PROMPT_ATTACHMENT_COUNT) throw new RangeError("too many attachment IDs");
		attachmentIds.add(part.id);
		parts.push({ type: "attachment", id: part.id });
	}
	return { parts };
}

function sessionName(value: unknown): string {
	const name = text(value, "session name").trim();
	if (name.length === 0 || Array.from(name).length > 160)
		throw new RangeError("session name must contain 1–160 characters");
	return name;
}

function sessionId(value: unknown): string {
	if (typeof value !== "string" || value.length < 8 || value.length > 100) throw new TypeError("invalid session id");
	return value;
}

function agentHubId(value: unknown): string {
	const id = text(value, "agent id").trim();
	if (id.length === 0 || id.length > 256) throw new RangeError("invalid agent id");
	return id;
}

function agentHubByteOffset(value: unknown): number {
	if (value === undefined) return 0;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError("invalid Agent Hub byte offset");
	return value as number;
}

function agentHubMessage(value: unknown): string {
	const message = text(value, "agent hub message").trim();
	if (message.length === 0 || message.length > 64 * 1024) throw new RangeError("invalid Agent Hub message");
	return message;
}

function paneId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9-]{8,100}$/i.test(value)) throw new TypeError("invalid pane id");
	return value;
}

function terminalDimension(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${label} must be a number`);
	}
	const rounded = Math.round(value);
	return Math.max(2, Math.min(500, rounded));
}
function chatTerminalInput(value: unknown): OpenChatTerminalInput {
	if (typeof value !== "object" || value === null) throw new TypeError("invalid chat terminal input");
	const input = value as Partial<OpenChatTerminalInput>;
	const id = paneId(input.id);
	const session = sessionId(input.sessionId);
	if (!Number.isSafeInteger(input.fromOffset) || (input.fromOffset as number) < 0)
		throw new RangeError("invalid replay offset");
	return {
		id,
		sessionId: session,
		cols: terminalDimension(input.cols, "columns"),
		rows: terminalDimension(input.rows, "rows"),
		fromOffset: input.fromOffset as number,
	};
}

function browserBounds(value: unknown): BrowserBounds {
	if (typeof value !== "object" || value === null) throw new TypeError("invalid browser bounds");
	const bounds = value as Record<string, unknown>;
	for (const key of ["x", "y", "width", "height"] as const) {
		const coordinate = bounds[key];
		if (!Number.isFinite(coordinate) || Math.abs(coordinate as number) > 32_768)
			throw new RangeError(`invalid browser ${key}`);
	}
	return {
		x: Math.round(bounds.x as number),
		y: Math.round(bounds.y as number),
		width: Math.max(0, Math.round(bounds.width as number)),
		height: Math.max(0, Math.round(bounds.height as number)),
	};
}

function browserAction(value: unknown): BrowserNavigationAction {
	if (value !== "back" && value !== "forward" && value !== "reload" && value !== "stop")
		throw new TypeError("invalid browser action");
	return value;
}
function optionalTabLayout(value: unknown): "columns" | "rows" | "grid" | undefined {
	if (value === undefined) return undefined;
	if (value !== "columns" && value !== "rows" && value !== "grid") {
		throw new TypeError("layout must be columns, rows, or grid");
	}
	return value;
}

function extensionResponse(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("id" in value))
		throw new TypeError("invalid extension response");
	const response = value as Record<string, unknown>;
	if (typeof response.id !== "string" || response.id.length === 0)
		throw new TypeError("invalid extension response id");
	if (response.value !== undefined) text(response.value, "extension response");
	return value;
}
const authProvider = (value: unknown): string => {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value))
		throw new TypeError("unsupported auth provider");
	return value;
};
const credentialId = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("invalid credential id");
	return value as number;
};
const agentSettingValue = (value: unknown): AgentSettingValue => {
	if (
		typeof value !== "boolean" &&
		typeof value !== "string" &&
		!(typeof value === "number" && Number.isFinite(value))
	)
		throw new TypeError("invalid agent setting value");
	return value;
};
const thinkingLevel = (value: unknown): ThinkingLevel => {
	if (
		value !== "inherit" &&
		value !== "off" &&
		value !== "minimal" &&
		value !== "low" &&
		value !== "medium" &&
		value !== "high" &&
		value !== "xhigh" &&
		value !== "max"
	)
		throw new TypeError("invalid thinking level");
	return value;
};
const queueMode = (value: unknown): QueueMode => {
	if (value !== "all" && value !== "one-at-a-time") throw new TypeError("invalid queue mode");
	return value;
};
const interruptMode = (value: unknown): InterruptMode => {
	if (value !== "immediate" && value !== "wait") throw new TypeError("invalid interrupt mode");
	return value;
};
const optionalReason = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	return text(value, "cancel reason");
};
const optionalInstruction = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	return text(value, "instruction");
};
const optionalCaptureMode = (value: unknown): "dom" | "screenshot" | undefined => {
	if (value === undefined || value === null) return undefined;
	if (value !== "dom" && value !== "screenshot") throw new TypeError("captureMode must be dom or screenshot");
	return value;
};
const api: GradivusApi = {
	platform: process.platform,
	getAuthStatus: () => ipcRenderer.invoke("gradivus:auth-status") as Promise<AuthAccountView[]>,
	getOAuthAccounts: () => ipcRenderer.invoke("gradivus:oauth-accounts") as Promise<OAuthAccountsView>,
	setOAuthAccountLock: (provider, credential) =>
		ipcRenderer.invoke(
			"gradivus:set-oauth-account-lock",
			authProvider(provider),
			credential === undefined ? undefined : credentialId(credential),
		) as Promise<OAuthAccountsView>,
	setOAuthAccountFailover: enabled => {
		if (typeof enabled !== "boolean") throw new TypeError("account failover must be boolean");
		return ipcRenderer.invoke("gradivus:set-oauth-account-failover", enabled) as Promise<OAuthAccountsView>;
	},
	removeOAuthAccount: (provider, credential) =>
		ipcRenderer.invoke(
			"gradivus:remove-oauth-account",
			authProvider(provider),
			credentialId(credential),
		) as Promise<OAuthAccountsView>,
	loginProvider: provider =>
		ipcRenderer.invoke("gradivus:auth-login", authProvider(provider)) as Promise<AuthAccountView[]>,
	logoutProvider: provider =>
		ipcRenderer.invoke("gradivus:auth-logout", authProvider(provider)) as Promise<AuthAccountView[]>,
	respondAuthPrompt: value => ipcRenderer.invoke("gradivus:auth-prompt", text(value, "auth prompt")) as Promise<void>,
	getAppSettings: () => ipcRenderer.invoke("gradivus:settings-get") as Promise<GradivusSettings>,
	updateAppSettings: updates =>
		ipcRenderer.invoke(
			"gradivus:settings-update",
			typeof updates === "object" && updates !== null ? updates : {},
		) as Promise<GradivusSettings>,
	resetAppSettings: () => ipcRenderer.invoke("gradivus:settings-reset") as Promise<GradivusSettings>,
	getAgentSettings: id =>
		ipcRenderer.invoke("gradivus:agent-settings", id === undefined ? undefined : sessionId(id)) as Promise<
			AgentSettingView[]
		>,
	setAgentSetting: (id, path, value) =>
		ipcRenderer.invoke(
			"gradivus:set-agent-setting",
			id === undefined ? undefined : sessionId(id),
			text(path, "setting path"),
			agentSettingValue(value),
		) as Promise<AgentSettingView>,
	bootstrap: () => ipcRenderer.invoke("gradivus:bootstrap") as Promise<BootstrapSnapshot>,
	reconnectRuntime: () => ipcRenderer.invoke("gradivus:runtime-reconnect") as Promise<void>,
	chooseAndCreate: (kind, cwd) =>
		ipcRenderer.invoke(
			"gradivus:choose-and-create",
			kind,
			cwd === undefined ? undefined : text(cwd, "workspace cwd"),
		) as Promise<SessionSnapshot | null>,
	openSession: id => ipcRenderer.invoke("gradivus:open", sessionId(id)) as Promise<SessionSnapshot>,
	resume: id => ipcRenderer.invoke("gradivus:resume", sessionId(id)) as Promise<SessionSnapshot>,
	loadTimelinePage: (id, before, limit) => {
		if (!Number.isSafeInteger(before) || before < 0) throw new RangeError("invalid timeline cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("invalid timeline limit");
		return ipcRenderer.invoke("gradivus:timeline-page", sessionId(id), before, limit) as Promise<TimelinePage>;
	},
	loadTimelineItem: (id, itemId) =>
		ipcRenderer.invoke(
			"gradivus:timeline-item",
			sessionId(id),
			text(itemId, "timeline item id"),
		) as Promise<TimelineItem>,
	getAvailableCommands: id =>
		ipcRenderer.invoke("gradivus:available-commands", sessionId(id)) as Promise<SlashCommand[]>,
	getAvailableModels: id => ipcRenderer.invoke("gradivus:available-models", sessionId(id)) as Promise<ModelOption[]>,
	getOpenRouterModelRouting: (id, modelId) =>
		ipcRenderer.invoke(
			"gradivus:openrouter-model-routing",
			sessionId(id),
			text(modelId, "model"),
		) as Promise<OpenRouterModelRouting>,
	setOpenRouterProviderEnabled: (id, modelId, providerId, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("provider enabled state must be boolean");
		return ipcRenderer.invoke(
			"gradivus:set-openrouter-provider-enabled",
			sessionId(id),
			text(modelId, "model"),
			text(providerId, "provider"),
			enabled,
		) as Promise<OpenRouterModelRouting>;
	},
	stop: id => ipcRenderer.invoke("gradivus:stop", sessionId(id)) as Promise<SessionSnapshot>,
	rename: (id, title) =>
		ipcRenderer.invoke("gradivus:rename", sessionId(id), sessionName(title)) as Promise<SessionSnapshot>,
	deleteSession: id => ipcRenderer.invoke("gradivus:delete", sessionId(id)) as Promise<BootstrapSnapshot>,
	stagePromptAttachments: (id, uploads) =>
		ipcRenderer.invoke("gradivus:stage-prompt-attachments", sessionId(id), attachmentUploads(uploads)) as Promise<
			PromptAttachmentView[]
		>,
	stagePromptText: (id, value) =>
		ipcRenderer.invoke(
			"gradivus:stage-prompt-text",
			sessionId(id),
			promptText(value),
		) as Promise<PromptAttachmentView>,
	releasePromptAttachments: (id, attachmentIds) =>
		ipcRenderer.invoke(
			"gradivus:release-prompt-attachments",
			sessionId(id),
			optionalAttachmentIds(attachmentIds) ?? [],
		) as Promise<void>,
	prompt: (id, composition) =>
		ipcRenderer.invoke("gradivus:prompt", sessionId(id), promptComposition(composition)) as Promise<string>,
	steer: (id, composition) =>
		ipcRenderer.invoke("gradivus:steer", sessionId(id), promptComposition(composition)) as Promise<void>,
	queueFollowUp: (id, composition) =>
		ipcRenderer.invoke("gradivus:queue", sessionId(id), promptComposition(composition)) as Promise<void>,
	abort: id => ipcRenderer.invoke("gradivus:abort", sessionId(id)) as Promise<void>,
	setModel: (id, provider, modelId) =>
		ipcRenderer.invoke(
			"gradivus:set-model",
			sessionId(id),
			text(provider, "provider"),
			text(modelId, "model"),
		) as Promise<void>,
	setThinking: (id, level) =>
		ipcRenderer.invoke("gradivus:set-thinking", sessionId(id), thinkingLevel(level)) as Promise<void>,
	setFastMode: (id, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("fast mode must be boolean");
		return ipcRenderer.invoke("gradivus:set-fast", sessionId(id), enabled) as Promise<void>;
	},
	togglePlanMode: (id, enabled) => {
		if (enabled !== undefined && typeof enabled !== "boolean")
			throw new TypeError("plan mode enabled must be boolean or undefined");
		return ipcRenderer.invoke("gradivus:toggle-plan-mode", sessionId(id), enabled) as Promise<
			{ enabled: boolean; planFilePath?: string } | undefined
		>;
	},
	setQueueMode: (id, kind, mode) => {
		if (kind !== "steering" && kind !== "follow-up") throw new TypeError("invalid queue mode kind");
		return ipcRenderer.invoke("gradivus:set-queue-mode", sessionId(id), kind, queueMode(mode)) as Promise<void>;
	},
	setInterruptMode: (id, mode) =>
		ipcRenderer.invoke("gradivus:set-interrupt-mode", sessionId(id), interruptMode(mode)) as Promise<void>,
	setAutoCompaction: (id, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("auto-compaction must be boolean");
		return ipcRenderer.invoke("gradivus:set-auto-compaction", sessionId(id), enabled) as Promise<void>;
	},
	setAutoRetry: (id, enabled) => {
		if (typeof enabled !== "boolean") throw new TypeError("auto-retry must be boolean");
		return ipcRenderer.invoke("gradivus:set-auto-retry", sessionId(id), enabled) as Promise<void>;
	},
	extensionResponse: (id, response) =>
		ipcRenderer.invoke("gradivus:extension-response", sessionId(id), extensionResponse(response)) as Promise<void>,
	getSubagentMessages: (id, subagentId, fromByte) => {
		if (!Number.isSafeInteger(fromByte) || fromByte < 0) throw new RangeError("invalid subagent byte offset");
		return ipcRenderer.invoke(
			"gradivus:subagent-messages",
			sessionId(id),
			text(subagentId, "subagent id"),
			fromByte,
		) as Promise<unknown>;
	},
	getAgentHub: id => ipcRenderer.invoke("gradivus:agent-hub", sessionId(id)) as Promise<AgentHubSnapshot>,
	getAgentHubMessages: (id, agentId, fromByte) =>
		ipcRenderer.invoke(
			"gradivus:agent-hub-messages",
			sessionId(id),
			agentHubId(agentId),
			agentHubByteOffset(fromByte),
		) as Promise<AgentHubMessagePage>,
	agentHubMessage: (id, agentId, message) =>
		ipcRenderer.invoke(
			"gradivus:agent-hub-message",
			sessionId(id),
			agentHubId(agentId),
			agentHubMessage(message),
		) as Promise<void>,
	agentHubKill: (id, agentId) =>
		ipcRenderer.invoke("gradivus:agent-hub-kill", sessionId(id), agentHubId(agentId)) as Promise<void>,
	agentHubRevive: (id, agentId) =>
		ipcRenderer.invoke("gradivus:agent-hub-revive", sessionId(id), agentHubId(agentId)) as Promise<void>,
	loadFileDiff: (id, target) =>
		ipcRenderer.invoke("gradivus:file-diff", sessionId(id), text(target, "file diff path")) as Promise<FileDiffView>,
	loadWorkspaceImage: (id, target, maxDimension) => {
		if (!Number.isInteger(maxDimension) || maxDimension < 64 || maxDimension > 2_048) {
			throw new RangeError("invalid image preview dimension");
		}
		return ipcRenderer.invoke(
			"gradivus:workspace-image",
			sessionId(id),
			text(target, "workspace image path"),
			maxDimension,
		) as Promise<WorkspaceImagePreview>;
	},
	writeClipboardText: value =>
		ipcRenderer.invoke("gradivus:clipboard-write", text(value, "clipboard text")) as Promise<void>,
	openWorkspaceFile: (id, target) =>
		ipcRenderer.invoke(
			"gradivus:open-workspace-file",
			sessionId(id),
			text(target, "workspace target"),
		) as Promise<void>,
	openExternal: url => ipcRenderer.invoke("gradivus:open-external", text(url, "URL")) as Promise<void>,
	getWorkspaceDocument: () =>
		ipcRenderer.invoke("gradivus:workspace-document-get") as Promise<WorkspaceDocumentV1 | null>,
	createBrowser: options => {
		if (typeof options !== "object" || options === null) throw new TypeError("CreateBrowserInput must be an object");
		const o = options as CreateBrowserInput;
		return ipcRenderer.invoke("gradivus:browser-create", {
			id: paneId(o.id),
			url: text(o.url, "URL"),
			workspaceId: text(o.workspaceId, "workspace ID"),
			tabId: text(o.tabId, "tab ID"),
			...(o.layout !== undefined ? { layout: optionalTabLayout(o.layout) } : {}),
		}) as Promise<BrowserViewState>;
	},
	navigateBrowser: (id, url) =>
		ipcRenderer.invoke("gradivus:browser-navigate", paneId(id), text(url, "URL")) as Promise<BrowserViewState>,
	controlBrowser: (id, action) =>
		ipcRenderer.invoke("gradivus:browser-control", paneId(id), browserAction(action)) as Promise<void>,
	setBrowserBounds: (id, bounds) =>
		ipcRenderer.invoke("gradivus:browser-bounds", paneId(id), browserBounds(bounds)) as Promise<void>,
	setVisibleBrowsers: ids => {
		if (!Array.isArray(ids) || ids.length > 32) throw new RangeError("invalid visible browser list");
		return ipcRenderer.invoke("gradivus:browser-visible", ids.map(paneId)) as Promise<void>;
	},
	closeBrowser: id => ipcRenderer.invoke("gradivus:browser-close", paneId(id)) as Promise<void>,
	showPaneContextMenu: (id, canSplit) => {
		if (typeof canSplit !== "boolean") throw new TypeError("pane split availability must be boolean");
		ipcRenderer.send("gradivus:pane-context-menu", paneId(id), canSplit);
	},
	createTerminal: options => {
		if (typeof options !== "object" || options === null) throw new TypeError("CreateTerminalInput must be an object");
		const o = options as CreateTerminalInput;
		return ipcRenderer.invoke("gradivus:terminal-create", {
			id: paneId(o.id),
			tabId: text(o.tabId, "tab ID"),
			workspaceId: text(o.workspaceId, "workspace ID"),
			cols: terminalDimension(o.cols, "columns"),
			rows: terminalDimension(o.rows, "rows"),
			...(o.layout !== undefined ? { layout: optionalTabLayout(o.layout) } : {}),
		}) as Promise<TerminalViewState>;
	},
	openChatTerminal: input =>
		ipcRenderer.invoke("gradivus:chat-terminal-open", chatTerminalInput(input)) as Promise<ChatTerminalViewState>,
	writeTerminal: (id, data) =>
		ipcRenderer.invoke("gradivus:terminal-write", paneId(id), text(data, "terminal input")) as Promise<void>,
	resizeTerminal: (id, cols, rows) =>
		ipcRenderer.invoke(
			"gradivus:terminal-resize",
			paneId(id),
			terminalDimension(cols, "columns"),
			terminalDimension(rows, "rows"),
		) as Promise<void>,
	closeTerminal: id => ipcRenderer.invoke("gradivus:terminal-close", paneId(id)) as Promise<void>,
	updateTab: (tabId, updates) => {
		if (typeof updates !== "object" || updates === null) throw new TypeError("UpdateTabInput must be an object");
		return ipcRenderer.invoke("gradivus:tab-update", text(tabId, "tab ID"), updates) as Promise<void>;
	},
	closeTab: tabId => ipcRenderer.invoke("gradivus:tab-close", text(tabId, "tab ID")) as Promise<void>,
	closePane: paneIdValue => ipcRenderer.invoke("gradivus:pane-close", paneId(paneIdValue)) as Promise<void>,
	minimizeWindow: () => ipcRenderer.invoke("gradivus:window-minimize") as Promise<void>,
	toggleMaximizeWindow: () => ipcRenderer.invoke("gradivus:window-toggle-maximize") as Promise<boolean>,
	closeWindow: () => ipcRenderer.invoke("gradivus:window-close") as Promise<void>,
	onEvent: listener => {
		const handler = (_event: Electron.IpcRendererEvent, value: GradivusEvent) => listener(value);
		ipcRenderer.on("gradivus:event", handler);
		return () => ipcRenderer.removeListener("gradivus:event", handler);
	},
	onAuthEvent: listener => {
		const handler = (_event: Electron.IpcRendererEvent, value: AuthEvent) => listener(value);
		ipcRenderer.on("gradivus:auth", handler);
		return () => ipcRenderer.removeListener("gradivus:auth", handler);
	},
	onWorkspaceEvent: listener => {
		const handler = (_event: Electron.IpcRendererEvent, value: WorkspaceEvent) => listener(value);
		ipcRenderer.on("gradivus:workspace", handler);
		return () => ipcRenderer.removeListener("gradivus:workspace", handler);
	},
	onWorkspaceDocument: listener => {
		const handler = (_event: Electron.IpcRendererEvent, doc: WorkspaceDocumentV1) => listener(doc);
		ipcRenderer.on("gradivus:workspace-document", handler);
		return () => ipcRenderer.removeListener("gradivus:workspace-document", handler);
	},
	startSelection: (id: string, captureMode?: "dom" | "screenshot") =>
		ipcRenderer.invoke(
			"gradivus:selection-start",
			paneId(id),
			optionalCaptureMode(captureMode),
		) as Promise<ElementEditState>,
	cancelSelection: (id, reason) =>
		ipcRenderer.invoke("gradivus:selection-cancel", paneId(id), optionalReason(reason)) as Promise<ElementEditState>,
	commitSelection: (id, instruction, action) =>
		ipcRenderer.invoke(
			"gradivus:selection-commit",
			paneId(id),
			optionalInstruction(instruction),
			action === "inline" || action === "queue" || action === "chat" ? action : undefined,
		) as Promise<ElementEditState>,
	runQueuedTasks: id => ipcRenderer.invoke("gradivus:selection-run-queued", paneId(id)) as Promise<ElementEditState>,
	clearQueuedTasks: id =>
		ipcRenderer.invoke("gradivus:selection-clear-queued", paneId(id)) as Promise<ElementEditState>,
	getSelectionState: id => ipcRenderer.invoke("gradivus:selection-state", paneId(id)) as Promise<ElementEditState>,
	onSelectionStateChanged: listener => {
		const handler = (_event: Electron.IpcRendererEvent, state: ElementEditState) => listener(state);
		ipcRenderer.on("gradivus:selection-state", handler);
		return () => ipcRenderer.removeListener("gradivus:selection-state", handler);
	},
};

contextBridge.exposeInMainWorld("gradivus", api);

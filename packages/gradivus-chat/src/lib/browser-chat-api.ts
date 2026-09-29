import { readDesktopEvents } from "../connection/desktop-events";
import type { DesktopAuthorization } from "../connection/desktop-oauth";
import { fetchDesktop } from "../connection/loopback-fetch";
import type { ChatApi } from "./chat-api";
import type {
	HostedBootstrapSnapshot,
	HostedChatEvent,
	HostedCommandError,
	HostedSessionSnapshot,
} from "./contracts";
import {
	GRADIVUS_CHAT_PROTOCOL_VERSION,
	type HostedChatOperation,
	type HostedChatPayload,
	type HostedChatResult,
	type HostedChatValue,
	type HostedStreamMessage,
} from "./protocol";

export type DesktopTransportStatus =
	| "connected"
	| "interrupted"
	| "expired"
	| "revoked";

export class DesktopCommandError extends Error {
	constructor(readonly detail: HostedCommandError) {
		super(detail.message);
		this.name = "DesktopCommandError";
	}
}

interface DesktopTransportOptions {
	onStatus: (status: DesktopTransportStatus) => void;
	requestDesktopPermission: () => Promise<void>;
}

const nativeOperations = new Set<HostedChatOperation>([
	"chooseWorkspaceAndCreate",
	"exportHtml",
	"openWorkspaceFile",
	"reconnectRuntime",
	"openDesktopAccounts",
]);
const snapshotOperations = new Set<HostedChatOperation>([
	"openSession",
	"createInWorkspace",
	"resume",
	"stop",
	"restart",
	"rename",
]);

/** Browser facade only: Desktop owns every command, tool invocation, session, and provider credential. */
export class BrowserChatTransport {
	#authorization: DesktopAuthorization;
	#options: DesktopTransportOptions;
	#controller: AbortController | undefined;
	#lifetime = new AbortController();
	#generation = 0;
	#connected = false;
	#lastStatus: DesktopTransportStatus = "interrupted";
	#listeners = new Set<(event: HostedChatEvent) => void>();
	#reconnectListeners = new Set<(snapshot: HostedBootstrapSnapshot) => void>();
	#queue: Array<Extract<HostedStreamMessage, { type: "chat_event" }>> = [];
	#hold = 0;
	#bootstrapped = false;
	#snapshotSequences = new Map<string, number>();
	#openedSessions = new Set<string>();
	#activeSessionId: string | undefined;
	#expiryTimer: number | undefined;
	#streamTask: Promise<void> | undefined;

	constructor(
		authorization: DesktopAuthorization,
		options: DesktopTransportOptions,
	) {
		this.#authorization = authorization;
		this.#options = options;
	}

	get authorization(): DesktopAuthorization {
		return this.#authorization;
	}

	onEvent(listener: (event: HostedChatEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onReconnect(
		listener: (snapshot: HostedBootstrapSnapshot) => void,
	): () => void {
		this.#reconnectListeners.add(listener);
		return () => this.#reconnectListeners.delete(listener);
	}

	#emit(event: HostedChatEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	#flush(): void {
		if (this.#hold || !this.#bootstrapped || !this.#connected) return;
		const queued = this.#queue;
		this.#queue = [];
		for (const message of queued) {
			const sessionId =
				"sessionId" in message.event ? message.event.sessionId : undefined;
			if (
				sessionId &&
				message.sequence <= (this.#snapshotSequences.get(sessionId) ?? -1)
			)
				continue;
			this.#emit(message.event);
		}
	}

	#status(status: DesktopTransportStatus): void {
		this.#connected = status === "connected";
		this.#lastStatus = status;
		if (status === "expired" || status === "revoked") {
			this.#authorization = { accessToken: "", expiresAt: 0, scopes: [] };
			this.#controller?.abort();
		}
		this.#options.onStatus(status);
	}

	#checkAuthorization(): void {
		if (Date.now() >= this.#authorization.expiresAt) {
			this.#status("expired");
			throw new Error(
				"Your Desktop connection expired. Connect again to continue.",
			);
		}
		if (this.#lifetime.signal.aborted)
			throw new Error("This Desktop connection is closed.");
	}

	#authorizationFailed(): boolean {
		return this.#lastStatus === "expired" || this.#lastStatus === "revoked";
	}

	async #readResponse<Operation extends HostedChatOperation>(
		response: Response,
		id: string,
	): Promise<{ value: HostedChatValue<Operation>; atSequence: number }> {
		const value: unknown = await response.json();
		if (typeof value !== "object" || value === null)
			throw new Error("Invalid Desktop response.");
		const record = value as Record<string, unknown>;
		if (record.error && typeof record.error === "object") {
			const detail = record.error as HostedCommandError;
			if (detail.code === "grant_expired") this.#status("expired");
			else if (
				detail.code === "grant_revoked" ||
				detail.code === "unauthorized"
			)
				this.#status("revoked");
			throw new DesktopCommandError(detail);
		}
		if (
			!response.ok ||
			record.protocolVersion !== GRADIVUS_CHAT_PROTOCOL_VERSION ||
			record.id !== id ||
			record.ok !== true ||
			!Number.isSafeInteger(record.atSequence) ||
			(record.atSequence as number) < 0 ||
			!Object.hasOwn(record, "value")
		) {
			throw new Error("Desktop returned an incompatible command response.");
		}
		const result = value as HostedChatResult<Operation>;
		if (!result.ok) throw new DesktopCommandError(result.error);
		return { value: result.value, atSequence: result.atSequence };
	}

	async request<Operation extends HostedChatOperation>(
		operation: Operation,
		payload: HostedChatPayload<Operation>,
		files?: readonly File[],
	): Promise<HostedChatValue<Operation>> {
		this.#checkAuthorization();
		if (
			nativeOperations.has(operation) &&
			!this.#authorization.scopes.includes("desktop.present")
		)
			await this.#options.requestDesktopPermission();
		this.#checkAuthorization();
		if (!this.#connected)
			throw new Error("Reconnect to Gradivus Desktop before continuing.");
		const id = crypto.randomUUID();
		const envelope = {
			protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
			id,
			operation,
			payload,
		};
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.#authorization.accessToken}`,
		};
		let body: BodyInit;
		let path = "/v1/command";
		if (files) {
			const upload = payload as HostedChatPayload<"stagePromptAttachments">;
			path = `/v1/sessions/${encodeURIComponent(upload.sessionId)}/attachments`;
			const form = new FormData();
			for (const file of files) form.append("files", file, file.name);
			form.append("command", JSON.stringify(envelope));
			body = form;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(envelope);
		}
		const snapshot =
			operation === "bootstrap" || snapshotOperations.has(operation);
		if (snapshot) this.#hold += 1;
		try {
			const response = await fetchDesktop(path, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.any([
					this.#lifetime.signal,
					AbortSignal.timeout(180_000),
				]),
			});
			const result = await this.#readResponse<Operation>(response, id);
			if (operation === "bootstrap") {
				this.#bootstrapped = true;
				this.#queue = this.#queue.filter(
					(message) => message.sequence > result.atSequence,
				);
			} else if (snapshotOperations.has(operation)) {
				const current = result.value as HostedSessionSnapshot;
				this.#snapshotSequences.set(current.record.id, result.atSequence);
				this.#openedSessions.add(current.record.id);
				if (operation === "openSession" || operation === "createInWorkspace")
					this.#activeSessionId = current.record.id;
			}
			return result.value;
		} catch (error) {
			if (error instanceof TypeError && !this.#lifetime.signal.aborted)
				this.#status("interrupted");
			throw error;
		} finally {
			if (snapshot) {
				// Let the caller install its snapshot before delivering newer streamed events.
				window.setTimeout(() => {
					this.#hold -= 1;
					this.#flush();
				}, 0);
			}
		}
	}

	async connect(authorization = this.#authorization): Promise<void> {
		this.#authorization = authorization;
		this.#checkAuthorization();
		const resync = this.#bootstrapped;
		window.clearTimeout(this.#expiryTimer);
		this.#lastStatus = "interrupted";
		this.#generation += 1;
		const generation = this.#generation;
		this.#controller?.abort();
		this.#controller = new AbortController();
		const controller = this.#controller;
		this.#authorization = authorization;
		this.#queue = [];
		this.#snapshotSequences.clear();
		this.#hold += 1;
		this.#connected = false;
		const ready = Promise.withResolvers<void>();
		let activityTimer: number | undefined;
		const readyTimer = window.setTimeout(() => {
			ready.reject(
				new Error("Desktop did not open its event stream. Try reconnecting."),
			);
			controller.abort();
		}, 15_000);
		this.#streamTask = (async () => {
			try {
				const response = await fetchDesktop("/v1/events", {
					headers: {
						Authorization: `Bearer ${authorization.accessToken}`,
						Accept: "text/event-stream",
					},
					signal: controller.signal,
				});
				if (!response.ok) {
					await this.#readResponse(response, "stream");
					throw new Error("Desktop could not open the event stream.");
				}
				if (
					!response.body ||
					!response.headers.get("Content-Type")?.startsWith("text/event-stream")
				)
					throw new Error("Invalid Desktop event stream.");
				let epoch: string | undefined;
				let sequence = -1;
				for await (const message of readDesktopEvents(response.body)) {
					if (generation !== this.#generation) return;
					window.clearTimeout(activityTimer);
					// Desktop sends a heartbeat every 15 seconds. A silent socket is not a live connection.
					activityTimer = window.setTimeout(() => {
						this.#status("interrupted");
						controller.abort();
					}, 45_000);
					if (!epoch) {
						if (message.type !== "stream_ready")
							throw new Error("Desktop event stream did not initialize.");
						epoch = message.epoch;
						sequence = message.currentSequence;
						this.#connected = true;
						ready.resolve();
						window.clearTimeout(readyTimer);
						continue;
					}
					if (
						message.epoch !== epoch ||
						message.type === "reset_required" ||
						message.type === "stream_ready"
					)
						throw new Error("Desktop needs a fresh session snapshot.");
					if (message.type === "chat_event" && message.sequence > sequence) {
						sequence = message.sequence;
						this.#queue.push(message);
						if (this.#queue.length > 512)
							throw new Error("Desktop updates need to be refreshed.");
						this.#flush();
					}
				}
				throw new Error("Desktop connection was interrupted.");
			} catch (error) {
				ready.reject(error);
				if (
					generation === this.#generation &&
					!controller.signal.aborted &&
					!this.#lifetime.signal.aborted
				) {
					const code =
						error instanceof DesktopCommandError
							? error.detail.code
							: undefined;
					this.#status(
						code === "grant_expired" || Date.now() >= authorization.expiresAt
							? "expired"
							: code === "grant_revoked" || code === "unauthorized"
								? "revoked"
								: "interrupted",
					);
				}
			} finally {
				window.clearTimeout(readyTimer);
				window.clearTimeout(activityTimer);
			}
		})();
		try {
			await ready.promise;
			if (resync) {
				const bootstrap = await this.request("bootstrap", {});
				for (const listener of this.#reconnectListeners) listener(bootstrap);
				// openSession changes Desktop selection. Refresh the selected chat last.
				const activeSessionId = this.#activeSessionId;
				const sessionIds = [...this.#openedSessions].filter(
					(id) => id !== activeSessionId,
				);
				if (activeSessionId) sessionIds.push(activeSessionId);
				for (const sessionId of sessionIds) {
					if (!bootstrap.sessions.some((session) => session.id === sessionId)) {
						this.#openedSessions.delete(sessionId);
						continue;
					}
					const snapshot = await this.request("openSession", { sessionId });
					this.#emit({ type: "session_reset", sessionId, snapshot });
				}
			}
			this.#status("connected");
			window.clearTimeout(this.#expiryTimer);
			this.#expiryTimer = window.setTimeout(
				() => {
					controller.abort();
					this.#status("expired");
				},
				Math.min(authorization.expiresAt - Date.now(), 2_147_483_647),
			);
		} catch (error) {
			controller.abort();
			if (generation === this.#generation && !this.#authorizationFailed())
				this.#status("interrupted");
			throw error;
		} finally {
			this.#hold -= 1;
			this.#flush();
		}
	}

	async destroy(): Promise<void> {
		this.#generation += 1;
		this.#controller?.abort();
		this.#lifetime.abort();
		window.clearTimeout(this.#expiryTimer);
		this.#queue = [];
		this.#listeners.clear();
		this.#reconnectListeners.clear();
		this.#authorization = { accessToken: "", expiresAt: 0, scopes: [] };
		this.#connected = false;
		await this.#streamTask;
	}
}

export function createBrowserChatApi(transport: BrowserChatTransport): ChatApi {
	const request = <Operation extends HostedChatOperation>(
		operation: Operation,
		payload: HostedChatPayload<Operation>,
	): Promise<HostedChatValue<Operation>> =>
		transport.request(operation, payload);
	return {
		bootstrap: () => request("bootstrap", {}),
		createInWorkspace: (workspaceId, kind) =>
			request("createInWorkspace", { workspaceId, kind }),
		chooseWorkspaceAndCreate: (kind) =>
			request("chooseWorkspaceAndCreate", { kind }),
		openSession: (sessionId) => request("openSession", { sessionId }),
		resume: (sessionId) => request("resume", { sessionId }),
		stop: (sessionId) => request("stop", { sessionId }),
		restart: (sessionId) => request("restart", { sessionId }),
		rename: (sessionId, title) => request("rename", { sessionId, title }),
		deleteSession: (sessionId, confirmation) =>
			request("deleteSession", { sessionId, confirmation }),
		loadTimelinePage: (sessionId, before, limit) =>
			request("loadTimelinePage", { sessionId, before, limit }),
		loadTimelineItem: (sessionId, itemId) =>
			request("loadTimelineItem", { sessionId, itemId }),
		loadTimelineToolDetail: (sessionId, itemId) =>
			request("loadTimelineToolDetail", { sessionId, itemId }),
		stagePromptText: (sessionId, text) =>
			request("stagePromptText", { sessionId, text }),
		stagePromptAttachments: (sessionId, files) =>
			transport.request(
				"stagePromptAttachments",
				{
					sessionId,
					metadata: files.map((file) => ({
						name: file.name,
						...(file.type ? { mimeType: file.type } : {}),
						size: file.size,
					})),
				},
				files,
			),
		releasePromptAttachments: async (sessionId, attachmentIds) => {
			await request("releasePromptAttachments", { sessionId, attachmentIds });
		},
		prompt: async (sessionId, composition) =>
			(await request("prompt", { sessionId, composition })).requestId,
		editMessage: (sessionId, timelineItemId, text) =>
			request("editMessage", { sessionId, timelineItemId, text }),
		abort: async (sessionId) => {
			await request("abort", { sessionId });
		},
		steer: async (sessionId, composition) => {
			await request("steer", { sessionId, composition });
		},
		steerQueued: async (sessionId, composition) => {
			await request("steerQueued", { sessionId, composition });
		},
		queueFollowUp: async (sessionId, composition) => {
			await request("queueFollowUp", { sessionId, composition });
		},
		getAvailableCommands: (sessionId) =>
			request("getAvailableCommands", { sessionId }),
		getAvailableModels: (sessionId) =>
			request("getAvailableModels", { sessionId }),
		getOpenRouterModelRouting: (sessionId, modelId) =>
			request("getOpenRouterModelRouting", { sessionId, modelId }),
		setOpenRouterProviderEnabled: (sessionId, modelId, providerId, enabled) =>
			request("setOpenRouterProviderEnabled", {
				sessionId,
				modelId,
				providerId,
				enabled,
			}),
		compact: (sessionId, instructions) =>
			request("compact", { sessionId, instructions }),
		handoff: (sessionId, instructions) =>
			request("handoff", { sessionId, instructions }),
		retry: (sessionId) => request("retry", { sessionId }),
		abortRetry: async (sessionId) => {
			await request("abortRetry", { sessionId });
		},
		getSessionStats: (sessionId) => request("getSessionStats", { sessionId }),
		exportHtml: (sessionId) => request("exportHtml", { sessionId }),
		requestPlanReview: (sessionId) =>
			request("requestPlanReview", { sessionId }),
		updatePlanReview: (
			sessionId,
			reviewId,
			content,
			expectedRevision,
			annotationState,
		) =>
			request("updatePlanReview", {
				sessionId,
				reviewId,
				content,
				expectedRevision,
				annotationState,
			}),
		resolvePlanReview: (sessionId, reviewId, expectedRevision, decision) =>
			request("resolvePlanReview", {
				sessionId,
				reviewId,
				expectedRevision,
				decision,
			}),
		setTodos: (sessionId, phases, expectedRevision, action) =>
			request("setTodos", { sessionId, phases, expectedRevision, action }),
		setModel: async (sessionId, provider, modelId) => {
			await request("setModel", { sessionId, provider, modelId });
		},
		setThinking: async (sessionId, level) => {
			await request("setThinking", { sessionId, level });
		},
		setFastMode: async (sessionId, enabled) => {
			await request("setFastMode", { sessionId, enabled });
		},
		togglePlanMode: async (sessionId, enabled) =>
			(await request("togglePlanMode", { sessionId, enabled })) ?? undefined,
		setQueueMode: async (sessionId, kind, mode) => {
			await request("setQueueMode", { sessionId, kind, mode });
		},
		setInterruptMode: async (sessionId, mode) => {
			await request("setInterruptMode", { sessionId, mode });
		},
		setAutoCompaction: async (sessionId, enabled) => {
			await request("setAutoCompaction", { sessionId, enabled });
		},
		setAutoRetry: async (sessionId, enabled) => {
			await request("setAutoRetry", { sessionId, enabled });
		},
		getSubagentMessages: (sessionId, subagentId, fromByte) =>
			request("getSubagentMessages", { sessionId, subagentId, fromByte }),
		getAgentHub: (sessionId) => request("getAgentHub", { sessionId }),
		getAgentHubMessages: (sessionId, agentId, fromByte) =>
			request("getAgentHubMessages", { sessionId, agentId, fromByte }),
		agentHubMessage: async (sessionId, agentId, message) => {
			await request("agentHubMessage", { sessionId, agentId, message });
		},
		agentHubKill: async (sessionId, agentId) => {
			await request("agentHubKill", { sessionId, agentId });
		},
		agentHubClear: async (sessionId, agentId) => {
			await request("agentHubClear", { sessionId, agentId });
		},
		agentHubRevive: async (sessionId, agentId) => {
			await request("agentHubRevive", { sessionId, agentId });
		},
		loadFileDiff: (sessionId, target) =>
			request("loadFileDiff", { sessionId, target }),
		loadWorkspaceFilePreview: (sessionId, target, maxDimension) =>
			request("loadWorkspaceFilePreview", { sessionId, target, maxDimension }),
		openWorkspaceFile: (sessionId, target) =>
			request("openWorkspaceFile", { sessionId, target }),
		getAgentSettings: (sessionId) => request("getAgentSettings", { sessionId }),
		setAgentSetting: (sessionId, path, value) =>
			request("setAgentSetting", { sessionId, path, value }),
		getAgentPrompts: (sessionId) => request("getAgentPrompts", { sessionId }),
		saveAgentPrompt: (sessionId, name, scope, systemPrompt, expectedRevision) =>
			request("saveAgentPrompt", {
				sessionId,
				name,
				scope,
				systemPrompt,
				expectedRevision,
			}),
		resetAgentPrompt: (sessionId, name, scope, expectedRevision) =>
			request("resetAgentPrompt", { sessionId, name, scope, expectedRevision }),
		reconnectRuntime: () => request("reconnectRuntime", {}),
		openDesktopAccounts: () => request("openDesktopAccounts", {}),
		onEvent: (listener) => transport.onEvent(listener),
		onReconnect: (listener) => transport.onReconnect(listener),
	};
}

import type {
	DesktopActionEvent,
	HostedCommandErrorCode,
	HostedPromptComposition,
	HostedSessionKind,
} from "@gradivus/chat/contracts";
import type { HostedChatCommand, HostedChatOperation, HostedChatValue } from "@gradivus/chat/protocol";
import type {
	BootstrapSnapshot,
	ProcessState,
	PromptAttachmentTempFile,
	SessionRecordV1,
	SessionSnapshot,
} from "../shared/contracts";
import type { DesktopHost } from "./desktop-host";
import { CHAT_COMMAND_POLICY } from "./hosted-command-policy";
import { operationSessionId } from "./hosted-command-validation";
import type { HostedGrantCapabilityStore } from "./hosted-grant-capabilities";
import type { HostedProjection } from "./hosted-projection";
import type { VerifiedLocalAccess } from "./local-chat-tokens";

export interface HostedNativeCommandActions {
	chooseWorkspaceAndCreate(
		grantId: string,
		kind: HostedSessionKind,
	): Promise<{ action: DesktopActionEvent; snapshot?: SessionSnapshot }>;
	exportHtml(grantId: string, sessionId: string): Promise<{ action: DesktopActionEvent; cancelled: boolean }>;
	openWorkspaceFile(grantId: string, sessionId: string, target: string): Promise<DesktopActionEvent>;
	reconnectRuntime(grantId: string): Promise<{ action: DesktopActionEvent; snapshot?: BootstrapSnapshot }>;
	openDesktopAccounts(grantId: string): Promise<DesktopActionEvent>;
}

export interface HostedCommandDispatchContext {
	temporaryFiles?: PromptAttachmentTempFile[];
}

export class HostedCommandDispatchError extends Error {
	readonly code: HostedCommandErrorCode;
	readonly retryable: boolean;

	constructor(code: HostedCommandErrorCode, message: string, retryable = false) {
		super(message);
		this.name = "HostedCommandDispatchError";
		this.code = code;
		this.retryable = retryable;
	}
}

interface AuthorizedSession {
	record: SessionRecordV1;
}

function requiredSession(value: AuthorizedSession | undefined): SessionRecordV1 {
	if (!value) throw new HostedCommandDispatchError("validation_error", "A session id is required for this command.");
	return value.record;
}

function compositionAttachmentIds(composition: HostedPromptComposition): string[] {
	return composition.parts.filter(part => part.type === "attachment").map(part => part.id);
}

export class HostedCommandDispatcher {
	readonly #host: DesktopHost;
	readonly #projection: HostedProjection;
	readonly #capabilities: HostedGrantCapabilityStore;
	readonly #native: HostedNativeCommandActions;

	constructor(options: {
		host: DesktopHost;
		projection: HostedProjection;
		capabilities: HostedGrantCapabilityStore;
		native: HostedNativeCommandActions;
	}) {
		this.#host = options.host;
		this.#projection = options.projection;
		this.#capabilities = options.capabilities;
		this.#native = options.native;
	}

	async dispatch(
		command: HostedChatCommand,
		access: VerifiedLocalAccess,
		context: HostedCommandDispatchContext = {},
	): Promise<HostedChatValue<HostedChatOperation>> {
		const authorized = this.#authorize(command, access);
		const grantId = access.grant.id;
		switch (command.operation) {
			case "bootstrap": {
				const snapshot = await this.#projection.projectHostedBootstrap(this.#host.bootstrap());
				this.#capabilities.hydrate(grantId, snapshot);
				return snapshot;
			}
			case "createInWorkspace": {
				this.#capabilities.assertWorkspace(grantId, command.payload.workspaceId);
				const root = this.#projection.workspaceRoot(command.payload.workspaceId);
				if (!root) throw new HostedCommandDispatchError("unauthorized", "Workspace capability is unavailable.");
				const snapshot = await this.#host.chooseAndCreate(command.payload.kind, root);
				if (!snapshot)
					throw new HostedCommandDispatchError("desktop_action_cancelled", "Session creation was cancelled.");
				const projected = await this.#projection.projectHostedSession(snapshot);
				this.#capabilities.allowSession(grantId, projected.record);
				return projected;
			}
			case "chooseWorkspaceAndCreate": {
				const result = await this.#native.chooseWorkspaceAndCreate(grantId, command.payload.kind);
				if (!result.snapshot) return { action: result.action };
				const snapshot = await this.#projection.projectHostedSession(result.snapshot);
				this.#capabilities.allowSession(grantId, snapshot.record);
				return { action: result.action, snapshot };
			}
			case "openSession": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedSession(await this.#host.openSession(record.id));
			}
			case "resume": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedSession(await this.#host.resume(record.id));
			}
			case "stop": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedSession(await this.#host.stop(record.id));
			}
			case "restart": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedSession(await this.#host.restart(record.id));
			}
			case "rename": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedSession(await this.#host.rename(record.id, command.payload.title));
			}
			case "deleteSession": {
				const record = requiredSession(authorized);
				if (
					command.payload.confirmation.sessionId !== record.id ||
					command.payload.confirmation.title !== record.title
				) {
					throw new HostedCommandDispatchError(
						"conflict",
						"Session confirmation no longer matches the current session.",
					);
				}
				const snapshot = await this.#projection.projectHostedBootstrap(await this.#host.deleteSession(record.id));
				this.#capabilities.removeSession(record.id);
				this.#capabilities.hydrate(grantId, snapshot);
				return snapshot;
			}
			case "loadTimelinePage": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedTimelinePage(
					record,
					await this.#host.loadTimelinePage(record.id, command.payload.before, command.payload.limit),
				);
			}
			case "loadTimelineItem": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedTimelineItem(
					record,
					await this.#host.loadTimelineItem(record.id, command.payload.itemId),
				);
			}
			case "loadTimelineToolDetail": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedTimelineToolDetail(
					record,
					await this.#host.loadTimelineToolDetail(record.id, command.payload.itemId),
				);
			}
			case "stagePromptText": {
				const record = requiredSession(authorized);
				const attachment = await this.#projection.projectHostedPromptAttachment(
					record,
					await this.#host.stagePromptText(record.id, command.payload.text),
				);
				this.#capabilities.allowAttachments(grantId, record.id, [attachment.id]);
				return attachment;
			}
			case "stagePromptAttachments": {
				const record = requiredSession(authorized);
				const files = context.temporaryFiles;
				if (!files || files.length !== command.payload.metadata.length) {
					throw new HostedCommandDispatchError(
						"validation_error",
						"Attachment bytes must match command metadata.",
					);
				}
				for (let index = 0; index < files.length; index += 1) {
					const metadata = command.payload.metadata[index];
					const file = files[index];
					if (
						!metadata ||
						!file ||
						metadata.name !== file.name ||
						metadata.mimeType !== file.mimeType ||
						metadata.size !== file.size
					) {
						throw new HostedCommandDispatchError(
							"validation_error",
							"Attachment bytes do not match command metadata.",
						);
					}
				}
				const attachments = await this.#projection.projectHostedPromptAttachments(
					record,
					await this.#host.stagePromptTemporaryFiles(record.id, files),
				);
				this.#capabilities.allowAttachments(
					grantId,
					record.id,
					attachments.map(attachment => attachment.id),
				);
				return attachments;
			}
			case "releasePromptAttachments": {
				const record = requiredSession(authorized);
				this.#capabilities.assertAttachments(grantId, record.id, command.payload.attachmentIds);
				await this.#host.releasePromptAttachments(record.id, command.payload.attachmentIds);
				this.#capabilities.removeAttachments(grantId, command.payload.attachmentIds);
				return null;
			}
			case "prompt": {
				const record = requiredSession(authorized);
				this.#capabilities.assertAttachments(
					grantId,
					record.id,
					compositionAttachmentIds(command.payload.composition),
				);
				return { requestId: await this.#host.prompt(record.id, command.payload.composition) };
			}
			case "editMessage": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedEditMessage(
					record,
					await this.#host.editMessage(record.id, command.payload.timelineItemId, command.payload.text),
				);
			}
			case "abort": {
				const record = requiredSession(authorized);
				await this.#host.abort(record.id);
				return null;
			}
			case "steer": {
				const record = requiredSession(authorized);
				this.#capabilities.assertAttachments(
					grantId,
					record.id,
					compositionAttachmentIds(command.payload.composition),
				);
				await this.#host.steer(record.id, command.payload.composition);
				return null;
			}
			case "steerQueued": {
				const record = requiredSession(authorized);
				this.#capabilities.assertAttachments(
					grantId,
					record.id,
					compositionAttachmentIds(command.payload.composition),
				);
				await this.#host.steerQueued(record.id, command.payload.composition);
				return null;
			}
			case "queueFollowUp": {
				const record = requiredSession(authorized);
				this.#capabilities.assertAttachments(
					grantId,
					record.id,
					compositionAttachmentIds(command.payload.composition),
				);
				await this.#host.queueFollowUp(record.id, command.payload.composition);
				return null;
			}
			case "getAvailableCommands": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedCommands(record, await this.#host.getAvailableCommands(record.id));
			}
			case "getAvailableModels": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedModels(record, await this.#host.getAvailableModels(record.id));
			}
			case "getOpenRouterModelRouting": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedOpenRouterRouting(
					record,
					await this.#host.getOpenRouterModelRouting(record.id, command.payload.modelId),
				);
			}
			case "setOpenRouterProviderEnabled": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedOpenRouterRouting(
					record,
					await this.#host.setOpenRouterProviderEnabled(
						record.id,
						command.payload.modelId,
						command.payload.providerId,
						command.payload.enabled,
					),
				);
			}
			case "compact": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedContextMutation(
					record,
					await this.#host.compact(record.id, command.payload.instructions),
				);
			}
			case "handoff": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedContextMutation(
					record,
					await this.#host.handoff(record.id, command.payload.instructions),
				);
			}
			case "retry": {
				const record = requiredSession(authorized);
				return this.#host.retry(record.id);
			}
			case "abortRetry": {
				const record = requiredSession(authorized);
				await this.#host.abortRetry(record.id);
				return null;
			}
			case "getSessionStats": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedStats(await this.#host.getSessionStats(record.id));
			}
			case "exportHtml": {
				const record = requiredSession(authorized);
				return this.#native.exportHtml(grantId, record.id);
			}
			case "requestPlanReview": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedPlanReview(record, await this.#host.requestPlanReview(record.id));
			}
			case "updatePlanReview": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedPlanReview(
					record,
					await this.#host.updatePlanReview(
						record.id,
						command.payload.reviewId,
						command.payload.content,
						command.payload.expectedRevision,
						command.payload.annotationState,
					),
				);
			}
			case "resolvePlanReview": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedPlanResolution(
					record,
					await this.#host.resolvePlanReview(
						record.id,
						command.payload.reviewId,
						command.payload.expectedRevision,
						command.payload.decision,
					),
				);
			}
			case "setTodos": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedTodoState(
					record,
					await this.#host.setTodos(
						record.id,
						command.payload.phases,
						command.payload.expectedRevision,
						command.payload.action,
					),
				);
			}
			case "setModel": {
				const record = requiredSession(authorized);
				await this.#host.setModel(record.id, command.payload.provider, command.payload.modelId);
				return null;
			}
			case "setThinking": {
				const record = requiredSession(authorized);
				await this.#host.setThinking(record.id, command.payload.level);
				return null;
			}
			case "setFastMode": {
				const record = requiredSession(authorized);
				await this.#host.setFastMode(record.id, command.payload.enabled);
				return null;
			}
			case "togglePlanMode": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedPlanMode(
					record,
					await this.#host.togglePlanMode(record.id, command.payload.enabled),
				);
			}
			case "setQueueMode": {
				const record = requiredSession(authorized);
				await this.#host.setQueueMode(record.id, command.payload.kind, command.payload.mode);
				return null;
			}
			case "setInterruptMode": {
				const record = requiredSession(authorized);
				await this.#host.setInterruptMode(record.id, command.payload.mode);
				return null;
			}
			case "setAutoCompaction": {
				const record = requiredSession(authorized);
				await this.#host.setAutoCompaction(record.id, command.payload.enabled);
				return null;
			}
			case "setAutoRetry": {
				const record = requiredSession(authorized);
				await this.#host.setAutoRetry(record.id, command.payload.enabled);
				return null;
			}
			case "getSubagentMessages": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedAgentHubMessages(
					record,
					await this.#host.getSubagentMessages(record.id, command.payload.subagentId, command.payload.fromByte),
				);
			}
			case "getAgentHub": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedAgentHub(record, await this.#host.getAgentHub(record.id));
			}
			case "getAgentHubMessages": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedAgentHubMessages(
					record,
					await this.#host.getAgentHubMessages(record.id, command.payload.agentId, command.payload.fromByte),
				);
			}
			case "agentHubMessage": {
				const record = requiredSession(authorized);
				await this.#host.agentHubMessage(record.id, command.payload.agentId, command.payload.message);
				return null;
			}
			case "agentHubKill": {
				const record = requiredSession(authorized);
				await this.#host.agentHubKill(record.id, command.payload.agentId);
				return null;
			}
			case "agentHubClear": {
				const record = requiredSession(authorized);
				await this.#host.agentHubClear(record.id, command.payload.agentId);
				return null;
			}
			case "agentHubRevive": {
				const record = requiredSession(authorized);
				await this.#host.agentHubRevive(record.id, command.payload.agentId);
				return null;
			}
			case "loadFileDiff": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedFileDiff(
					record,
					await this.#host.loadFileDiff(record.id, command.payload.target),
				);
			}
			case "loadWorkspaceImage": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedImage(
					record,
					await this.#host.loadWorkspaceImage(record.id, command.payload.target, command.payload.maxDimension),
				);
			}
			case "openWorkspaceFile": {
				const record = requiredSession(authorized);
				return { action: await this.#native.openWorkspaceFile(grantId, record.id, command.payload.target) };
			}
			case "getAgentSettings": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedAgentSettings(record, await this.#host.getAgentSettings(record.id));
			}
			case "setAgentSetting": {
				const record = requiredSession(authorized);
				const setting = await this.#host.setAgentSetting(record.id, command.payload.path, command.payload.value);
				return (
					(await this.#projection.projectHostedAgentSettings(record, [setting]))[0] ??
					(() => {
						throw new HostedCommandDispatchError(
							"runtime_unavailable",
							"Agent setting response was unavailable.",
						);
					})()
				);
			}
			case "getAgentPrompts": {
				const record = requiredSession(authorized);
				return this.#projection.projectHostedAgentPrompts(record, await this.#host.getAgentPrompts(record.id));
			}
			case "saveAgentPrompt": {
				const record = requiredSession(authorized);
				const prompt = await this.#host.saveAgentPrompt(
					record.id,
					command.payload.name,
					command.payload.scope,
					command.payload.systemPrompt,
					command.payload.expectedRevision,
				);
				return (
					(await this.#projection.projectHostedAgentPrompts(record, [prompt]))[0] ??
					(() => {
						throw new HostedCommandDispatchError("runtime_unavailable", "Agent prompt response was unavailable.");
					})()
				);
			}
			case "resetAgentPrompt": {
				const record = requiredSession(authorized);
				const prompt = await this.#host.resetAgentPrompt(
					record.id,
					command.payload.name,
					command.payload.scope,
					command.payload.expectedRevision,
				);
				return (
					(await this.#projection.projectHostedAgentPrompts(record, [prompt]))[0] ??
					(() => {
						throw new HostedCommandDispatchError("runtime_unavailable", "Agent prompt response was unavailable.");
					})()
				);
			}
			case "reconnectRuntime": {
				const result = await this.#native.reconnectRuntime(grantId);
				const bootstrap = result.snapshot
					? await this.#projection.projectHostedBootstrap(result.snapshot)
					: undefined;
				if (bootstrap) this.#capabilities.hydrate(grantId, bootstrap);
				return bootstrap ? { action: result.action, bootstrap } : { action: result.action };
			}
			case "openDesktopAccounts":
				return { action: await this.#native.openDesktopAccounts(grantId) };
			default:
				command satisfies never;
				throw new Error("Hosted command dispatch is not exhaustive");
		}
	}

	#authorize(command: HostedChatCommand, access: VerifiedLocalAccess): AuthorizedSession | undefined {
		const policy = CHAT_COMMAND_POLICY[command.operation];
		const now = Math.floor(Date.now() / 1_000);
		if (access.grant.status !== "active") {
			throw new HostedCommandDispatchError("grant_revoked", "Consent grant is no longer active.");
		}
		if (Math.floor(access.grant.expiresAt / 1_000) <= now || access.claims.exp <= now) {
			throw new HostedCommandDispatchError("grant_expired", "Consent grant has expired.");
		}
		const scopes = new Set(access.claims.scope.split(/\s+/).filter(Boolean));
		for (const scope of policy.requiredScopes) {
			if (!scopes.has(scope) || !access.grant.scopes.includes(scope)) {
				throw new HostedCommandDispatchError("scope_denied", `The ${scope} scope is required.`);
			}
		}
		const sessionId = operationSessionId(command);
		if (!sessionId) {
			if (policy.requiresSession) {
				throw new HostedCommandDispatchError("validation_error", "A session id is required for this command.");
			}
			return undefined;
		}
		this.#capabilities.assertSession(access.grant.id, sessionId);
		let authority: { record: SessionRecordV1; state: ProcessState };
		try {
			authority = this.#host.resolveHostedChatSessionAuthority(sessionId);
		} catch {
			throw new HostedCommandDispatchError("session_not_found", "Session is unavailable.");
		}
		const surface = authority.record.surface ?? "chat";
		if (policy.surface && surface !== policy.surface) {
			throw new HostedCommandDispatchError("unauthorized", "This command is not available for the session surface.");
		}
		const allowedStates: readonly ProcessState[] = policy.allowedStates;
		if (!allowedStates.includes(authority.state)) {
			throw new HostedCommandDispatchError(
				"conflict",
				`This command is not available while the session is ${authority.state}.`,
			);
		}
		return { record: authority.record };
	}
}

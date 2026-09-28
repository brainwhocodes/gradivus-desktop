import type { HostedBootstrapSnapshot, HostedSessionRecord, HostedWorkspaceView } from "@gradivus/chat/contracts";
import { LocalTokenValidationError } from "./local-chat-tokens";

interface GrantCapabilities {
	sessionIds: Set<string>;
	workspaceIds: Set<string>;
	attachmentSessions: Map<string, string>;
}

export class HostedGrantCapabilityStore {
	#byGrant = new Map<string, GrantCapabilities>();

	hydrate(grantId: string, snapshot: HostedBootstrapSnapshot): void {
		const capabilities = this.#capabilities(grantId);
		for (const workspace of snapshot.workspaces) capabilities.workspaceIds.add(workspace.id);
		for (const session of snapshot.sessions) {
			capabilities.sessionIds.add(session.id);
			capabilities.workspaceIds.add(session.workspace.id);
		}
	}

	allowSession(grantId: string, session: HostedSessionRecord): void {
		const capabilities = this.#capabilities(grantId);
		capabilities.sessionIds.add(session.id);
		capabilities.workspaceIds.add(session.workspace.id);
	}

	allowWorkspace(grantId: string, workspace: HostedWorkspaceView): void {
		this.#capabilities(grantId).workspaceIds.add(workspace.id);
	}

	allowAttachments(grantId: string, sessionId: string, attachmentIds: readonly string[]): void {
		const capabilities = this.#capabilities(grantId);
		for (const attachmentId of attachmentIds) capabilities.attachmentSessions.set(attachmentId, sessionId);
	}

	assertSession(grantId: string, sessionId: string): void {
		if (!this.#byGrant.get(grantId)?.sessionIds.has(sessionId)) {
			throw new LocalTokenValidationError(
				"unauthorized",
				"Session capability does not belong to this consent grant.",
			);
		}
	}

	assertWorkspace(grantId: string, workspaceId: string): void {
		if (!this.#byGrant.get(grantId)?.workspaceIds.has(workspaceId)) {
			throw new LocalTokenValidationError(
				"unauthorized",
				"Workspace capability does not belong to this consent grant.",
			);
		}
	}

	ownsSession(grantId: string, sessionId: string): boolean {
		return this.#byGrant.get(grantId)?.sessionIds.has(sessionId) === true;
	}

	assertAttachments(grantId: string, sessionId: string, attachmentIds: readonly string[]): void {
		const attachments = this.#byGrant.get(grantId)?.attachmentSessions;
		if (attachmentIds.some(attachmentId => attachments?.get(attachmentId) !== sessionId)) {
			throw new LocalTokenValidationError(
				"unauthorized",
				"Attachment capability does not belong to this consent grant and session.",
			);
		}
	}

	attachmentGroups(grantId: string): Array<{ sessionId: string; attachmentIds: string[] }> {
		const attachments = this.#byGrant.get(grantId)?.attachmentSessions;
		if (!attachments) return [];
		const bySession = new Map<string, string[]>();
		for (const [attachmentId, sessionId] of attachments) {
			const ids = bySession.get(sessionId) ?? [];
			ids.push(attachmentId);
			bySession.set(sessionId, ids);
		}
		return [...bySession].map(([sessionId, attachmentIds]) => ({ sessionId, attachmentIds }));
	}
	removeAttachments(grantId: string, attachmentIds: readonly string[]): void {
		const attachments = this.#byGrant.get(grantId)?.attachmentSessions;
		for (const attachmentId of attachmentIds) attachments?.delete(attachmentId);
	}

	removeSession(sessionId: string): void {
		for (const capabilities of this.#byGrant.values()) {
			capabilities.sessionIds.delete(sessionId);
			for (const [attachmentId, ownerSessionId] of capabilities.attachmentSessions) {
				if (ownerSessionId === sessionId) capabilities.attachmentSessions.delete(attachmentId);
			}
		}
	}

	revokeGrant(grantId: string): void {
		this.#byGrant.delete(grantId);
	}

	#capabilities(grantId: string): GrantCapabilities {
		let capabilities = this.#byGrant.get(grantId);
		if (!capabilities) {
			capabilities = { sessionIds: new Set(), workspaceIds: new Set(), attachmentSessions: new Map() };
			this.#byGrant.set(grantId, capabilities);
		}
		return capabilities;
	}
}

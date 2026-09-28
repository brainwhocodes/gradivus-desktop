import type { LocalChatConnectionView } from "../shared/local-chat-consent";
import type { DesktopHost } from "./desktop-host";
import type { HostedEventSequencer } from "./hosted-event-sequencer";
import type { HostedGrantCapabilityStore } from "./hosted-grant-capabilities";
import { LOCAL_CHAT_SCOPE_PRESENTATION } from "./local-chat-consent";
import type { FixedHostedClientRepository } from "./local-chat-oauth";
import type { LocalGrantRepository, LocalTokenService } from "./local-chat-tokens";

export class LocalChatConnectionController {
	readonly #clients: FixedHostedClientRepository;
	readonly #grants: LocalGrantRepository;
	readonly #tokens: LocalTokenService;
	readonly #events: HostedEventSequencer;
	readonly #capabilities: HostedGrantCapabilityStore;
	readonly #host: DesktopHost;
	readonly #onChanged: (connections: LocalChatConnectionView[]) => void;

	constructor(options: {
		clients: FixedHostedClientRepository;
		grants: LocalGrantRepository;
		tokens: LocalTokenService;
		events: HostedEventSequencer;
		capabilities: HostedGrantCapabilityStore;
		host: DesktopHost;
		onChanged?: (connections: LocalChatConnectionView[]) => void;
	}) {
		this.#clients = options.clients;
		this.#grants = options.grants;
		this.#tokens = options.tokens;
		this.#events = options.events;
		this.#capabilities = options.capabilities;
		this.#host = options.host;
		this.#onChanged = options.onChanged ?? (() => {});
	}

	list(): LocalChatConnectionView[] {
		return this.#grants
			.list()
			.filter(grant => grant.status !== "revoked")
			.map(grant => ({
				grantId: grant.id,
				clientName: this.#clients.clientFor(grant.clientId)?.name ?? grant.clientId,
				origin: grant.origin,
				scopes: grant.scopes.map(scope => ({ scope, label: LOCAL_CHAT_SCOPE_PRESENTATION[scope] })),
				createdAt: grant.createdAt,
				lastUsedAt: grant.lastUsedAt,
				expiresAt: grant.expiresAt,
				activeTokenCount: this.#tokens.activeTokenCount(grant.id),
				status: grant.status,
			}));
	}

	notifyChanged(): void {
		this.#onChanged(this.list());
	}

	async revoke(grantIdInput: unknown): Promise<LocalChatConnectionView[]> {
		if (typeof grantIdInput !== "string" || grantIdInput.length < 8 || grantIdInput.length > 128) {
			throw new TypeError("invalid local chat grant id");
		}
		const grant = this.#grants
			.list()
			.find(candidate => candidate.id === grantIdInput && candidate.status !== "revoked");
		if (!grant) throw new Error("Local app connection was not found");
		const attachments = this.#capabilities.attachmentGroups(grant.id);
		this.#tokens.revokeGrant(grant.id);
		this.#events.closeGrant(grant.id);
		for (const group of attachments) {
			await this.#host.releasePromptAttachments(group.sessionId, group.attachmentIds).catch(() => undefined);
		}
		this.#capabilities.revokeGrant(grant.id);
		const connections = this.list();
		this.#onChanged(connections);
		return connections;
	}
}

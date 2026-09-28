import type { HostedScope } from "@gradivus/chat/contracts";
import { GRADIVUS_CHAT_EXPANDED_SCOPES, GRADIVUS_CHAT_INITIAL_SCOPES } from "@gradivus/chat/protocol";
import type {
	LocalChatConsentDecision,
	LocalChatConsentRequest,
	LocalChatConsentScopeView,
} from "../shared/local-chat-consent";
import { LocalOAuthError, type ValidatedAuthorizationRequest } from "./local-chat-oauth";
import type { LocalConsentGrant, LocalGrantRepository } from "./local-chat-tokens";

const CONSENT_TIMEOUT_MS = 2 * 60 * 1000;
const AUTHORIZATION_RATE_WINDOW_MS = 60 * 1000;
const AUTHORIZATION_RATE_LIMIT = 3;

export const LOCAL_CHAT_SCOPE_PRESENTATION: Readonly<Record<HostedScope, string>> = {
	"chat.read": "View chats and transcripts",
	"agent.execute": "Send prompts to coding agents using this session’s files, commands, network, and tools",
	"sessions.manage": "Create, rename, and delete chats",
	"files.read": "Preview workspace files",
	"desktop.present": "Open Desktop pickers, files, and Accounts",
};

export interface LocalChatConsentPresenter {
	present(request: LocalChatConsentRequest): Promise<LocalChatConsentDecision>;
}

export interface ConsentAuthorizationResult {
	grant: LocalConsentGrant;
	consentRequired: boolean;
}

interface PendingConsent {
	scopesKey: string;
	promise: Promise<ConsentAuthorizationResult>;
	resolveUnavailable: () => void;
}

export class LocalAuthorizationRateLimitError extends Error {
	constructor() {
		super("Too many Gradivus Chat authorization attempts. Try again in a minute.");
		this.name = "LocalAuthorizationRateLimitError";
	}
}

function scopeKey(scopes: readonly HostedScope[]): string {
	return [...scopes].sort().join(" ");
}

function isInitialScopeSet(scopes: readonly HostedScope[]): boolean {
	return (
		scopes.length === GRADIVUS_CHAT_INITIAL_SCOPES.length &&
		GRADIVUS_CHAT_INITIAL_SCOPES.every(scope => scopes.includes(scope))
	);
}

function isExpandedScopeSet(scopes: readonly HostedScope[]): boolean {
	return (
		scopes.length === GRADIVUS_CHAT_EXPANDED_SCOPES.length &&
		GRADIVUS_CHAT_EXPANDED_SCOPES.every(scope => scopes.includes(scope))
	);
}
function scopeViews(scopes: readonly HostedScope[]): LocalChatConsentScopeView[] {
	return scopes.map(scope => ({ scope, label: LOCAL_CHAT_SCOPE_PRESENTATION[scope] }));
}

export class LocalChatConsentController {
	#grants: LocalGrantRepository;
	#presenter: LocalChatConsentPresenter;
	#pendingByClient = new Map<string, PendingConsent>();
	#startsByClient = new Map<string, number[]>();
	#now: () => number;
	#timeoutMs: number;

	constructor(
		grants: LocalGrantRepository,
		presenter: LocalChatConsentPresenter,
		options: { now?: () => number; timeoutMs?: number } = {},
	) {
		this.#grants = grants;
		this.#presenter = presenter;
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? CONSENT_TIMEOUT_MS;
	}

	async authorizeInitial(request: ValidatedAuthorizationRequest): Promise<ConsentAuthorizationResult> {
		if (!isInitialScopeSet(request.scopes)) {
			throw new LocalOAuthError(
				"invalid_scope",
				"Initial Gradivus Chat authorization requires chat.read, agent.execute, sessions.manage, and files.read.",
			);
		}
		return this.#authorize(request, undefined, false);
	}

	async authorizeExpansion(request: ValidatedAuthorizationRequest): Promise<ConsentAuthorizationResult> {
		if (!isExpandedScopeSet(request.scopes)) {
			throw new LocalOAuthError(
				"invalid_scope",
				"Desktop presentation expansion requires the complete Gradivus Chat scope set.",
			);
		}
		const existing = this.#grants.activeFor(request.client.id, request.origin, GRADIVUS_CHAT_INITIAL_SCOPES);
		if (!existing) {
			throw new LocalOAuthError("invalid_grant", "An active Gradivus Chat grant is required for scope expansion.");
		}
		if (request.scopes.every(scope => existing.scopes.includes(scope))) {
			return { grant: existing, consentRequired: false };
		}
		return this.#authorize(request, existing, true);
	}

	cancelAll(): void {
		for (const pending of this.#pendingByClient.values()) pending.resolveUnavailable();
	}

	async #authorize(
		request: ValidatedAuthorizationRequest,
		existingGrant: LocalConsentGrant | undefined,
		forceConsent: boolean,
	): Promise<ConsentAuthorizationResult> {
		const key = `${request.client.id}\u0000${request.origin}`;
		const scopesKey = scopeKey(request.scopes);
		const pending = this.#pendingByClient.get(key);
		if (pending) {
			if (pending.scopesKey === scopesKey) return pending.promise;
			throw new LocalOAuthError("temporarily_unavailable", "Another Gradivus Chat authorization is pending.");
		}
		this.#recordAuthorizationStart(key);
		const active = existingGrant ?? this.#grants.activeFor(request.client.id, request.origin, request.scopes);
		if (active && !forceConsent) return { grant: active, consentRequired: false };

		const result = Promise.withResolvers<ConsentAuthorizationResult>();
		const decision = Promise.withResolvers<LocalChatConsentDecision>();
		let settled = false;
		const resolveUnavailable = (): void => {
			if (settled) return;
			settled = true;
			decision.resolve({ requestId: consentRequest.requestId, decision: "unavailable" });
		};
		const consentRequest = this.#consentRequest(request);
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const handleTimeout = (): void => resolveUnavailable();
		timeout.addEventListener("abort", handleTimeout, { once: true });
		void this.#presenter.present(consentRequest).then(
			value => {
				if (settled || value.requestId !== consentRequest.requestId) return;
				settled = true;
				decision.resolve(value);
			},
			() => resolveUnavailable(),
		);
		const promise = result.promise.finally(() => {
			timeout.removeEventListener("abort", handleTimeout);
			this.#pendingByClient.delete(key);
		});
		this.#pendingByClient.set(key, { scopesKey, promise, resolveUnavailable });

		void decision.promise.then(value => {
			if (value.decision === "deny") {
				result.reject(new LocalOAuthError("access_denied", "Access wasn’t allowed in Gradivus Desktop."));
				return;
			}
			if (value.decision === "unavailable") {
				result.reject(
					new LocalOAuthError("temporarily_unavailable", "Gradivus Desktop couldn’t finish the request."),
				);
				return;
			}
			result.resolve({
				grant: existingGrant
					? this.#grants.expandScopes(existingGrant.id, request.scopes)
					: this.#grants.create(request.client.id, request.origin, request.scopes),
				consentRequired: true,
			});
		});
		return promise;
	}

	#consentRequest(request: ValidatedAuthorizationRequest): LocalChatConsentRequest {
		return {
			requestId: crypto.randomUUID(),
			clientId: request.client.id,
			clientName: request.client.name,
			origin: request.origin,
			scopes: scopeViews(request.scopes),
			title: "Allow Gradivus Chat to use this Desktop?",
			riskNotice:
				"Sending prompts into an existing OMP session inherits that session’s configured tools and approval policy, including file changes, commands, network access, and subagents.",
			securityNote: "The Gradivus Chat connection API does not expose provider credentials or local API tokens.",
			allowLabel: "Allow coding chat access",
			denyLabel: "Deny",
			expiresAt: this.#now() + this.#timeoutMs,
		};
	}

	#recordAuthorizationStart(key: string): void {
		const now = this.#now();
		const recent = (this.#startsByClient.get(key) ?? []).filter(
			timestamp => timestamp > now - AUTHORIZATION_RATE_WINDOW_MS,
		);
		if (recent.length >= AUTHORIZATION_RATE_LIMIT) throw new LocalAuthorizationRateLimitError();
		recent.push(now);
		this.#startsByClient.set(key, recent);
	}
}

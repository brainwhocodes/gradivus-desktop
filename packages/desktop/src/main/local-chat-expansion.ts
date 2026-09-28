import type { HostedScope } from "@gradivus/chat/contracts";
import { GRADIVUS_CHAT_EXPANDED_SCOPES, GRADIVUS_CHAT_INITIAL_SCOPES } from "@gradivus/chat/protocol";
import type { ConsentAuthorizationResult, LocalChatConsentController } from "./local-chat-consent";
import {
	type AuthorizationCodeExchange,
	LocalOAuthError,
	type ValidatedAuthorizationRequest,
} from "./local-chat-oauth";
import type { IssuedLocalAccessToken, LocalConsentGrant, LocalTokenService } from "./local-chat-tokens";

function isExpandedScopeSet(scopes: readonly HostedScope[]): boolean {
	return (
		scopes.length === GRADIVUS_CHAT_EXPANDED_SCOPES.length &&
		GRADIVUS_CHAT_EXPANDED_SCOPES.every(scope => scopes.includes(scope))
	);
}

export class LocalScopeExpansionCoordinator {
	#consent: LocalChatConsentController;
	#tokens: LocalTokenService;

	constructor(consent: LocalChatConsentController, tokens: LocalTokenService) {
		this.#consent = consent;
		this.#tokens = tokens;
	}

	authorize(request: ValidatedAuthorizationRequest): Promise<ConsentAuthorizationResult> {
		return this.#consent.authorizeExpansion(request);
	}

	async issueReplacement(exchange: AuthorizationCodeExchange, currentBearer: string): Promise<IssuedLocalAccessToken> {
		if (!isExpandedScopeSet(exchange.scopes)) {
			throw new LocalOAuthError("invalid_scope", "Replacement token requires the complete expanded scope set.");
		}
		const current = await this.#tokens.verify(currentBearer, {
			clientId: exchange.clientId,
			origin: exchange.origin,
			requiredScopes: GRADIVUS_CHAT_INITIAL_SCOPES,
		});
		if (current.grant.id !== exchange.grantId) {
			throw new LocalOAuthError("invalid_grant", "Replacement token does not match the active consent grant.");
		}
		return this.#tokens.issue({
			grantId: exchange.grantId,
			clientId: exchange.clientId,
			origin: exchange.origin,
			scopes: exchange.scopes,
			replacesJtiHash: current.jtiHash,
			adopted: false,
		});
	}

	adoptReplacement(jtiHash: string): boolean {
		return this.#tokens.adoptReplacement(jtiHash);
	}

	rollbackReplacement(jtiHash: string): boolean {
		return this.#tokens.rollbackReplacement(jtiHash);
	}

	isAwaitingAdoption(jtiHash: string): boolean {
		return this.#tokens.isUnadoptedReplacement(jtiHash);
	}
}

export function isGrantExpanded(grant: LocalConsentGrant): boolean {
	return isExpandedScopeSet(grant.scopes);
}

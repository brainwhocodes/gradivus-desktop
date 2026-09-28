import type { HostedScope } from "@gradivus/chat/contracts";
import {
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_EXPANDED_SCOPES,
	GRADIVUS_CHAT_INITIAL_SCOPES,
	GRADIVUS_CHAT_ORIGIN,
	GRADIVUS_CHAT_REDIRECT_URI,
} from "@gradivus/chat/protocol";
import { describe, expect, it } from "vitest";
import { LocalChatConsentController, type LocalChatConsentPresenter } from "../src/main/local-chat-consent";
import { LocalScopeExpansionCoordinator } from "../src/main/local-chat-expansion";
import {
	type AuthorizationCodeExchange,
	FixedHostedClientRepository,
	type ValidatedAuthorizationRequest,
} from "../src/main/local-chat-oauth";
import { LocalGrantRepository, LocalTokenService } from "../src/main/local-chat-tokens";
import type { LocalChatConsentDecision, LocalChatConsentRequest } from "../src/shared/local-chat-consent";

class ExpansionPresenter implements LocalChatConsentPresenter {
	request: LocalChatConsentRequest | undefined;
	#decision = Promise.withResolvers<LocalChatConsentDecision>();

	present(request: LocalChatConsentRequest): Promise<LocalChatConsentDecision> {
		this.request = request;
		return this.#decision.promise;
	}

	decide(decision: LocalChatConsentDecision["decision"]): void {
		if (!this.request) throw new Error("Expansion consent is not pending");
		this.#decision.resolve({ requestId: this.request.requestId, decision });
	}
}

function validated(scopes: HostedScope[]): ValidatedAuthorizationRequest {
	const client = new FixedHostedClientRepository(false).clientFor(GRADIVUS_CHAT_CLIENT_ID);
	if (!client) throw new Error("Production client is missing");
	return {
		client,
		origin: GRADIVUS_CHAT_ORIGIN,
		redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
		state: Buffer.alloc(32, 1).toString("base64url"),
		scopes,
		codeChallenge: Buffer.alloc(32, 2).toString("base64url"),
		codeChallengeMethod: "S256",
	};
}

function exchange(
	grantId: string,
	scopes: HostedScope[] = [...GRADIVUS_CHAT_EXPANDED_SCOPES],
): AuthorizationCodeExchange {
	return {
		grantId,
		clientId: GRADIVUS_CHAT_CLIENT_ID,
		origin: GRADIVUS_CHAT_ORIGIN,
		redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
		ownerId: "local-owner",
		scopes,
		state: Buffer.alloc(32, 1).toString("base64url"),
		codeChallenge: Buffer.alloc(32, 2).toString("base64url"),
		codeChallengeMethod: "S256",
		hash: "code-hash",
		exchangeId: crypto.randomUUID(),
		expiresAt: Date.now() + 60_000,
	};
}

async function initialAccess(grants: LocalGrantRepository, tokens: LocalTokenService) {
	const grant = grants.create(GRADIVUS_CHAT_CLIENT_ID, GRADIVUS_CHAT_ORIGIN, GRADIVUS_CHAT_INITIAL_SCOPES);
	const token = await tokens.issue({
		grantId: grant.id,
		clientId: grant.clientId,
		origin: grant.origin,
		scopes: GRADIVUS_CHAT_INITIAL_SCOPES,
	});
	return { grant, token };
}

describe("LocalScopeExpansionCoordinator", () => {
	it("keeps the old token active until the expanded stream adopts its replacement", async () => {
		const grants = new LocalGrantRepository();
		const tokens = new LocalTokenService(grants, { key: new Uint8Array(32).fill(3) });
		const old = await initialAccess(grants, tokens);
		const presenter = new ExpansionPresenter();
		const consent = new LocalChatConsentController(grants, presenter);
		const coordinator = new LocalScopeExpansionCoordinator(consent, tokens);

		const authorization = coordinator.authorize(validated([...GRADIVUS_CHAT_EXPANDED_SCOPES]));
		expect(presenter.request?.scopes.at(-1)).toEqual({
			scope: "desktop.present",
			label: "Open Desktop pickers, files, and Accounts",
		});
		presenter.decide("allow");
		const expanded = await authorization;
		expect(expanded.grant.id).toBe(old.grant.id);
		expect(expanded.grant.scopes).toEqual([...GRADIVUS_CHAT_EXPANDED_SCOPES]);

		const replacement = await coordinator.issueReplacement(exchange(old.grant.id), old.token.accessToken);
		expect(coordinator.isAwaitingAdoption(replacement.jtiHash)).toBe(true);
		await expect(
			tokens.verify(old.token.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).resolves.toBeTruthy();
		await expect(
			tokens.verify(replacement.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
				requiredScopes: ["desktop.present"],
			}),
		).resolves.toBeTruthy();

		expect(coordinator.adoptReplacement(replacement.jtiHash)).toBe(true);
		expect(coordinator.isAwaitingAdoption(replacement.jtiHash)).toBe(false);
		await expect(
			tokens.verify(old.token.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "grant_revoked" });
		await expect(
			tokens.verify(replacement.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).resolves.toBeTruthy();
		expect(tokens.activeTokenCount(old.grant.id)).toBe(1);
	});

	it("preserves the old token when consent is denied or an unadopted replacement rolls back", async () => {
		const deniedGrants = new LocalGrantRepository();
		const deniedTokens = new LocalTokenService(deniedGrants, { key: new Uint8Array(32).fill(4) });
		const deniedOld = await initialAccess(deniedGrants, deniedTokens);
		const deniedPresenter = new ExpansionPresenter();
		const deniedCoordinator = new LocalScopeExpansionCoordinator(
			new LocalChatConsentController(deniedGrants, deniedPresenter),
			deniedTokens,
		);
		const denied = deniedCoordinator.authorize(validated([...GRADIVUS_CHAT_EXPANDED_SCOPES]));
		deniedPresenter.decide("deny");
		await expect(denied).rejects.toMatchObject({ oauthError: "access_denied" });
		expect(deniedGrants.get(deniedOld.grant.id)?.scopes).toEqual([...GRADIVUS_CHAT_INITIAL_SCOPES]);
		await expect(
			deniedTokens.verify(deniedOld.token.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).resolves.toBeTruthy();

		const grants = new LocalGrantRepository();
		const tokens = new LocalTokenService(grants, { key: new Uint8Array(32).fill(5) });
		const old = await initialAccess(grants, tokens);
		grants.expandScopes(old.grant.id, GRADIVUS_CHAT_EXPANDED_SCOPES);
		const coordinator = new LocalScopeExpansionCoordinator(
			new LocalChatConsentController(grants, new ExpansionPresenter()),
			tokens,
		);
		const replacement = await coordinator.issueReplacement(exchange(old.grant.id), old.token.accessToken);
		expect(coordinator.rollbackReplacement(replacement.jtiHash)).toBe(true);
		await expect(
			tokens.verify(old.token.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).resolves.toBeTruthy();
		await expect(
			tokens.verify(replacement.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "grant_revoked" });
	});

	it("rejects replacement exchange with a bearer from another consent grant", async () => {
		const grants = new LocalGrantRepository();
		const tokens = new LocalTokenService(grants, { key: new Uint8Array(32).fill(6) });
		const first = await initialAccess(grants, tokens);
		const second = await initialAccess(grants, tokens);
		grants.expandScopes(first.grant.id, GRADIVUS_CHAT_EXPANDED_SCOPES);
		const coordinator = new LocalScopeExpansionCoordinator(
			new LocalChatConsentController(grants, new ExpansionPresenter()),
			tokens,
		);
		await expect(
			coordinator.issueReplacement(exchange(first.grant.id), second.token.accessToken),
		).rejects.toMatchObject({ oauthError: "invalid_grant" });
		expect(tokens.activeTokenCount(first.grant.id)).toBe(1);
		expect(tokens.activeTokenCount(second.grant.id)).toBe(1);
	});
});

import type { HostedScope } from "@gradivus/chat/contracts";
import { GRADIVUS_CHAT_CLIENT_ID, GRADIVUS_CHAT_INITIAL_SCOPES, GRADIVUS_CHAT_ORIGIN } from "@gradivus/chat/protocol";
import { describe, expect, it } from "vitest";
import { LocalChatConsentController, type LocalChatConsentPresenter } from "../src/main/local-chat-consent";
import { FixedHostedClientRepository, type ValidatedAuthorizationRequest } from "../src/main/local-chat-oauth";
import { LocalGrantRepository } from "../src/main/local-chat-tokens";
import type { LocalChatConsentDecision, LocalChatConsentRequest } from "../src/shared/local-chat-consent";

class ConsentPresenterHarness implements LocalChatConsentPresenter {
	requests: LocalChatConsentRequest[] = [];
	#decisions: Array<PromiseWithResolvers<LocalChatConsentDecision>> = [];

	present(request: LocalChatConsentRequest): Promise<LocalChatConsentDecision> {
		this.requests.push(request);
		const decision = Promise.withResolvers<LocalChatConsentDecision>();
		this.#decisions.push(decision);
		return decision.promise;
	}

	decide(index: number, decision: LocalChatConsentDecision["decision"]): void {
		const request = this.requests[index];
		const pending = this.#decisions[index];
		if (!request || !pending) throw new Error("Consent decision is not pending");
		pending.resolve({ requestId: request.requestId, decision });
	}
}

function authorization(scopes: HostedScope[] = [...GRADIVUS_CHAT_INITIAL_SCOPES]): ValidatedAuthorizationRequest {
	const client = new FixedHostedClientRepository(false).clientFor(GRADIVUS_CHAT_CLIENT_ID);
	if (!client) throw new Error("Production Gradivus Chat client is missing");
	return {
		client,
		origin: GRADIVUS_CHAT_ORIGIN,
		redirectUri: client.redirectUris[0],
		state: Buffer.alloc(32, 7).toString("base64url"),
		scopes,
		codeChallenge: Buffer.alloc(32, 8).toString("base64url"),
		codeChallengeMethod: "S256",
	};
}

describe("LocalChatConsentController", () => {
	it("presents the full coding authority risk before creating a memory-only grant", async () => {
		const presenter = new ConsentPresenterHarness();
		const grants = new LocalGrantRepository();
		const controller = new LocalChatConsentController(grants, presenter);
		const resultPromise = controller.authorizeInitial(authorization());
		expect(presenter.requests).toHaveLength(1);
		const request = presenter.requests[0]!;
		expect(request.title).toBe("Allow Gradivus Chat to use this Desktop?");
		expect(request.origin).toBe(GRADIVUS_CHAT_ORIGIN);
		expect(request.scopes.map(scope => scope.label)).toEqual([
			"View chats and transcripts",
			"Send prompts to coding agents using this session’s files, commands, network, and tools",
			"Create, rename, and delete chats",
			"Preview workspace files",
		]);
		expect(request.riskNotice).toContain("file changes, commands, network access, and subagents");
		expect(request.securityNote).toBe(
			"The Gradivus Chat connection API does not expose provider credentials or local API tokens.",
		);
		expect(request.denyLabel).toBe("Deny");
		expect(request.allowLabel).toBe("Allow coding chat access");

		presenter.decide(0, "allow");
		const result = await resultPromise;
		expect(result.consentRequired).toBe(true);
		expect(result.grant).toMatchObject({
			clientId: GRADIVUS_CHAT_CLIENT_ID,
			origin: GRADIVUS_CHAT_ORIGIN,
			status: "active",
			scopes: [...GRADIVUS_CHAT_INITIAL_SCOPES],
		});
		expect(grants.list()).toHaveLength(1);

		const silent = await controller.authorizeInitial(authorization());
		expect(silent.consentRequired).toBe(false);
		expect(silent.grant.id).toBe(result.grant.id);
		expect(presenter.requests).toHaveLength(1);
	});

	it("deduplicates one pending request and maps deny, cancellation, and timeout to OAuth errors", async () => {
		const presenter = new ConsentPresenterHarness();
		const controller = new LocalChatConsentController(new LocalGrantRepository(), presenter);
		const first = controller.authorizeInitial(authorization());
		const duplicate = controller.authorizeInitial(authorization());
		expect(presenter.requests).toHaveLength(1);
		presenter.decide(0, "deny");
		await expect(first).rejects.toMatchObject({ oauthError: "access_denied" });
		await expect(duplicate).rejects.toMatchObject({ oauthError: "access_denied" });

		const cancelled = controller.authorizeInitial(authorization());
		controller.cancelAll();
		await expect(cancelled).rejects.toMatchObject({ oauthError: "temporarily_unavailable" });

		const timeoutPresenter = new ConsentPresenterHarness();
		const timed = new LocalChatConsentController(new LocalGrantRepository(), timeoutPresenter, { timeoutMs: 1 });
		await expect(timed.authorizeInitial(authorization())).rejects.toMatchObject({
			oauthError: "temporarily_unavailable",
		});
	});

	it("rejects desktop.present on initial authorization and rate-limits repeated starts", async () => {
		const presenter = new ConsentPresenterHarness();
		const controller = new LocalChatConsentController(new LocalGrantRepository(), presenter);
		await expect(
			controller.authorizeInitial(authorization([...GRADIVUS_CHAT_INITIAL_SCOPES, "desktop.present"])),
		).rejects.toMatchObject({ oauthError: "invalid_scope" });
		expect(presenter.requests).toHaveLength(0);

		const first = controller.authorizeInitial(authorization());
		presenter.decide(0, "allow");
		await first;
		await controller.authorizeInitial(authorization());
		await controller.authorizeInitial(authorization());
		await expect(controller.authorizeInitial(authorization())).rejects.toMatchObject({
			name: "LocalAuthorizationRateLimitError",
		});
	});
});

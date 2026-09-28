import {
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_DEV_CLIENT_ID,
	GRADIVUS_CHAT_DEV_REDIRECT_URI,
	GRADIVUS_CHAT_REDIRECT_URI,
} from "@gradivus/chat/protocol";
import { describe, expect, it } from "vitest";
import {
	type AuthorizationCodeBinding,
	FixedHostedClientRepository,
	FixedHostedScopeRepository,
	InMemoryAuthorizationCodeRepository,
	LOCAL_CHAT_OWNER,
	validateAuthorizationRequest,
} from "../src/main/local-chat-oauth";

function base64Url32(seed: number): string {
	return Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff)).toString("base64url");
}

async function challenge(verifier: string): Promise<string> {
	return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
}

async function authorizationUrl(
	clientId = GRADIVUS_CHAT_CLIENT_ID,
	redirectUri = GRADIVUS_CHAT_REDIRECT_URI,
): Promise<URL> {
	const verifier = "A".repeat(43);
	const url = new URL("http://127.0.0.1:47832/oauth/authorize");
	url.search = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "chat.read agent.execute sessions.manage files.read",
		state: base64Url32(7),
		code_challenge: await challenge(verifier),
		code_challenge_method: "S256",
	}).toString();
	return url;
}

async function binding(): Promise<AuthorizationCodeBinding> {
	return {
		grantId: "grant-1",
		clientId: GRADIVUS_CHAT_CLIENT_ID,
		origin: "https://gradivus.brainwhocodes.rocks",
		redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
		ownerId: String(LOCAL_CHAT_OWNER.id),
		scopes: ["chat.read", "agent.execute", "sessions.manage", "files.read"],
		state: base64Url32(9),
		codeChallenge: await challenge("A".repeat(43)),
		codeChallengeMethod: "S256",
	};
}

describe("fixed hosted OAuth repositories", () => {
	it("registers only the fixed public production client unless development is explicitly enabled", async () => {
		const packaged = new FixedHostedClientRepository(false);
		const production = await packaged.getByIdentifier(GRADIVUS_CHAT_CLIENT_ID);
		expect(production.redirectUris).toEqual([GRADIVUS_CHAT_REDIRECT_URI]);
		expect(production.secret).toBeUndefined();
		expect(await packaged.isClientValid("authorization_code", production)).toBe(true);
		expect(await packaged.isClientValid("authorization_code", production, "secret")).toBe(false);
		await expect(packaged.getByIdentifier(GRADIVUS_CHAT_DEV_CLIENT_ID)).rejects.toMatchObject({
			name: "OAuthException",
		});

		const development = new FixedHostedClientRepository(true);
		expect((await development.getByIdentifier(GRADIVUS_CHAT_DEV_CLIENT_ID)).redirectUris).toEqual([
			GRADIVUS_CHAT_DEV_REDIRECT_URI,
		]);
	});

	it("validates exact redirects, state, scope, response type, and S256 PKCE before consent", async () => {
		const clients = new FixedHostedClientRepository(false);
		const scopes = new FixedHostedScopeRepository();
		const valid = await validateAuthorizationRequest(await authorizationUrl(), clients, scopes);
		expect(valid.client.id).toBe(GRADIVUS_CHAT_CLIENT_ID);
		expect(valid.state).toBe(base64Url32(7));
		expect(valid.scopes).toEqual(["chat.read", "agent.execute", "sessions.manage", "files.read"]);
		expect(valid.codeChallengeMethod).toBe("S256");

		const invalidCases: Array<{ mutate: (url: URL) => void; oauthError: string }> = [
			{
				mutate: url => url.searchParams.set("redirect_uri", "https://gradivus.brainwhocodes.rocks/other"),
				oauthError: "invalid_request",
			},
			{ mutate: url => url.searchParams.set("response_type", "token"), oauthError: "unsupported_response_type" },
			{ mutate: url => url.searchParams.set("state", "short"), oauthError: "invalid_request" },
			{ mutate: url => url.searchParams.set("scope", "chat.read unknown.scope"), oauthError: "invalid_scope" },
			{ mutate: url => url.searchParams.set("code_challenge_method", "plain"), oauthError: "invalid_request" },
			{ mutate: url => url.searchParams.set("code_challenge", "A".repeat(42)), oauthError: "invalid_request" },
			{ mutate: url => url.searchParams.append("state", base64Url32(8)), oauthError: "invalid_request" },
			{ mutate: url => url.searchParams.set("unexpected", "value"), oauthError: "invalid_request" },
		];
		for (const testCase of invalidCases) {
			const url = await authorizationUrl();
			testCase.mutate(url);
			await expect(validateAuthorizationRequest(url, clients, scopes)).rejects.toMatchObject({
				oauthError: testCase.oauthError,
			});
		}
	});

	it("stores only hashed codes, serializes concurrent exchange, and consumes only after token persistence", async () => {
		let now = 1_000;
		const repository = new InMemoryAuthorizationCodeRepository(() => now);
		const code = await repository.issue(await binding());
		expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(repository.storedHashes()).toHaveLength(1);
		expect(repository.storedHashes()[0]).not.toBe(code);

		await expect(
			repository.beginExchange({
				code,
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
				codeVerifier: "B".repeat(43),
			}),
		).rejects.toMatchObject({ oauthError: "invalid_grant" });
		expect(await repository.status(code)).toBe("active");

		const attempts = await Promise.allSettled([
			repository.beginExchange({
				code,
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
				codeVerifier: "A".repeat(43),
			}),
			repository.beginExchange({
				code,
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
				codeVerifier: "A".repeat(43),
			}),
		]);
		const fulfilled = attempts.filter(result => result.status === "fulfilled");
		const rejected = attempts.filter(result => result.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		const exchange = fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value : undefined;
		if (!exchange) throw new Error("Expected one successful authorization code exchange");

		repository.finishExchange(exchange, false);
		expect(await repository.status(code)).toBe("active");
		const retry = await repository.beginExchange({
			code,
			clientId: GRADIVUS_CHAT_CLIENT_ID,
			redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
			codeVerifier: "A".repeat(43),
		});
		repository.finishExchange(retry, true);
		expect(await repository.status(code)).toBe("consumed");
		await expect(
			repository.beginExchange({
				code,
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				redirectUri: GRADIVUS_CHAT_REDIRECT_URI,
				codeVerifier: "A".repeat(43),
			}),
		).rejects.toMatchObject({ oauthError: "invalid_grant" });

		now += 2 * 60 * 1000 + 1;
		expect(await repository.status(code)).toBe("expired");
	});
});

import {
	GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE,
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_LOCAL_ORIGIN,
	GRADIVUS_CHAT_ORIGIN,
} from "@gradivus/chat/protocol";
import { JwtService } from "@jmondi/oauth2-server";
import { describe, expect, it } from "vitest";
import { LocalGrantRepository, LocalTokenService } from "../src/main/local-chat-tokens";

const TOKEN_SCOPES = ["chat.read", "agent.execute", "sessions.manage", "files.read"] as const;

async function setup() {
	let now = 1_800_000_000_000;
	const key = new Uint8Array(32).fill(0x42);
	const grants = new LocalGrantRepository(() => now);
	const grant = grants.create(GRADIVUS_CHAT_CLIENT_ID, GRADIVUS_CHAT_ORIGIN, TOKEN_SCOPES);
	const service = new LocalTokenService(grants, { key, now: () => now });
	const issued = await service.issue({
		grantId: grant.id,
		clientId: GRADIVUS_CHAT_CLIENT_ID,
		origin: GRADIVUS_CHAT_ORIGIN,
		scopes: TOKEN_SCOPES,
	});
	return {
		advance(milliseconds: number) {
			now += milliseconds;
		},
		grant,
		grants,
		issued,
		key,
		service,
	};
}

function tokenPayload(token: string): Record<string, unknown> {
	const encoded = token.split(".")[1];
	if (!encoded) throw new Error("JWT payload is missing");
	const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
	if (typeof value !== "object" || value === null) throw new Error("JWT payload is not an object");
	return value as Record<string, unknown>;
}

describe("LocalTokenService", () => {
	it("issues an eight-hour HS256 bearer token and verifies its launch, client, origin, scope, and JTI bindings", async () => {
		const fixture = await setup();
		expect(fixture.issued.expiresIn).toBe(8 * 60 * 60);
		expect(fixture.issued.scope).toBe(TOKEN_SCOPES.join(" "));
		expect(fixture.service.hasJtiHash(fixture.issued.jtiHash)).toBe(true);
		expect(fixture.issued.accessToken).not.toContain(fixture.issued.jtiHash);

		const verified = await fixture.service.verify(fixture.issued.accessToken, {
			clientId: GRADIVUS_CHAT_CLIENT_ID,
			origin: GRADIVUS_CHAT_ORIGIN,
			requiredScopes: ["chat.read", "files.read"],
		});
		expect(verified.claims).toMatchObject({
			iss: GRADIVUS_CHAT_LOCAL_ORIGIN,
			aud: GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE,
			sub: "local-owner",
			cid: GRADIVUS_CHAT_CLIENT_ID,
			scope: TOKEN_SCOPES.join(" "),
		});
		expect(verified.grant.id).toBe(fixture.grant.id);
		expect(fixture.service.activeTokenCount(fixture.grant.id)).toBe(1);

		await expect(
			fixture.service.verify(fixture.issued.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
				requiredScopes: ["desktop.present"],
			}),
		).rejects.toMatchObject({ code: "scope_denied" });
		await expect(
			fixture.service.verify(fixture.issued.accessToken, {
				clientId: "wrong-client",
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "unauthorized" });
		await expect(
			fixture.service.verify(fixture.issued.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: "https://unexpected.example",
			}),
		).rejects.toMatchObject({ code: "unauthorized" });
	});

	it("rejects wrong algorithms and every required claim binding before dispatch", async () => {
		const fixture = await setup();
		const payload = tokenPayload(fixture.issued.accessToken);
		const signer = new JwtService(Buffer.from(fixture.key));
		const maliciousClaims: Array<Record<string, unknown>> = [
			{ ...payload, iss: "https://wrong-issuer.example" },
			{ ...payload, aud: "wrong-audience" },
			{ ...payload, cid: "wrong-client" },
			{ ...payload, scope: "chat.read desktop.present" },
			{ ...payload, jti: "unregistered-jti" },
			{ ...payload, unexpected: true },
		];
		for (const claims of maliciousClaims) {
			const token = await signer.sign(claims);
			await expect(
				fixture.service.verify(token, {
					clientId: GRADIVUS_CHAT_CLIENT_ID,
					origin: GRADIVUS_CHAT_ORIGIN,
				}),
			).rejects.toMatchObject({ code: "unauthorized" });
		}

		const [, encodedPayload] = fixture.issued.accessToken.split(".");
		const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		await expect(
			fixture.service.verify(`${noneHeader}.${encodedPayload}.`, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "unauthorized" });
	});

	it("expires tokens, rejects tokens from a restarted Desktop launch, and gates revocation synchronously", async () => {
		const fixture = await setup();
		const restarted = new LocalTokenService(fixture.grants, { key: fixture.key, now: () => 1_800_000_000_000 });
		await expect(
			restarted.verify(fixture.issued.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "unauthorized" });

		fixture.advance(8 * 60 * 60 * 1000 + 1);
		await expect(
			fixture.service.verify(fixture.issued.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "grant_expired" });

		const active = await setup();
		active.service.revokeGrant(active.grant.id);
		expect(active.grants.get(active.grant.id)?.status).toBe("revoked");
		expect(active.service.activeTokenCount(active.grant.id)).toBe(0);
		await expect(
			active.service.verify(active.issued.accessToken, {
				clientId: GRADIVUS_CHAT_CLIENT_ID,
				origin: GRADIVUS_CHAT_ORIGIN,
			}),
		).rejects.toMatchObject({ code: "grant_revoked" });
	});
});

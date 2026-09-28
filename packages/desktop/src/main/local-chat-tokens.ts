import type { HostedScope } from "@gradivus/chat/contracts";
import { GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE, GRADIVUS_CHAT_LOCAL_ORIGIN } from "@gradivus/chat/protocol";
import { JwtService } from "@jmondi/oauth2-server";
import { LOCAL_CHAT_OWNER } from "./local-chat-oauth";

const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;
const ACCESS_TOKEN_CLAIMS = new Set(["iss", "aud", "sub", "cid", "scope", "jti", "iat", "nbf", "exp"]);

export type LocalGrantStatus = "active" | "revoking" | "revoked";

export interface LocalConsentGrant {
	id: string;
	clientId: string;
	origin: string;
	scopes: HostedScope[];
	status: LocalGrantStatus;
	createdAt: number;
	lastUsedAt: number;
	expiresAt: number;
}

export interface LocalAccessTokenClaims {
	iss: typeof GRADIVUS_CHAT_LOCAL_ORIGIN;
	aud: typeof GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE;
	sub: typeof LOCAL_CHAT_OWNER.id;
	cid: string;
	scope: string;
	jti: string;
	iat: number;
	nbf: number;
	exp: number;
}

export interface VerifiedLocalAccess {
	claims: LocalAccessTokenClaims;
	grant: LocalConsentGrant;
	jtiHash: string;
}

export interface IssuedLocalAccessToken {
	accessToken: string;
	tokenType: "Bearer";
	expiresIn: number;
	scope: string;
	jtiHash: string;
	grantId: string;
}

interface LocalTokenRow {
	jtiHash: string;
	grantId: string;
	clientId: string;
	origin: string;
	scopes: HostedScope[];
	issuedAt: number;
	expiresAt: number;
	revokedAt?: number;
	replacesJtiHash?: string;
	adopted: boolean;
}

export type TokenValidationErrorCode = "unauthorized" | "grant_expired" | "grant_revoked" | "scope_denied";

export class LocalTokenValidationError extends Error {
	readonly code: TokenValidationErrorCode;

	constructor(code: TokenValidationErrorCode, message: string) {
		super(message);
		this.name = "LocalTokenValidationError";
		this.code = code;
	}
}

function randomBase64Url(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Buffer.from(digest).toString("base64url");
}

function scopeNames(value: string): HostedScope[] {
	const scopes = value.split(" ").filter(Boolean);
	const known = new Set<HostedScope>([
		"chat.read",
		"agent.execute",
		"sessions.manage",
		"files.read",
		"desktop.present",
	]);
	if (
		scopes.length === 0 ||
		scopes.some(scope => !known.has(scope as HostedScope)) ||
		new Set(scopes).size !== scopes.length
	) {
		throw new LocalTokenValidationError("unauthorized", "Access token scope claim is invalid.");
	}
	return scopes as HostedScope[];
}

function sameScopes(left: readonly HostedScope[], right: readonly HostedScope[]): boolean {
	if (left.length !== right.length) return false;
	const expected = new Set(right);
	return left.every(scope => expected.has(scope));
}

function requireInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value)) {
		throw new LocalTokenValidationError("unauthorized", `Access token ${name} claim is invalid.`);
	}
	return value as number;
}

function parseClaims(value: Record<string, unknown>): LocalAccessTokenClaims {
	const keys = Object.keys(value);
	if (keys.length !== ACCESS_TOKEN_CLAIMS.size || keys.some(key => !ACCESS_TOKEN_CLAIMS.has(key))) {
		throw new LocalTokenValidationError("unauthorized", "Access token contains unexpected claims.");
	}
	if (
		value.iss !== GRADIVUS_CHAT_LOCAL_ORIGIN ||
		value.aud !== GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE ||
		value.sub !== LOCAL_CHAT_OWNER.id ||
		typeof value.cid !== "string" ||
		!value.cid ||
		typeof value.scope !== "string" ||
		typeof value.jti !== "string" ||
		!value.jti
	) {
		throw new LocalTokenValidationError("unauthorized", "Access token claims are invalid.");
	}
	scopeNames(value.scope);
	return {
		iss: value.iss,
		aud: value.aud,
		sub: value.sub,
		cid: value.cid,
		scope: value.scope,
		jti: value.jti,
		iat: requireInteger(value.iat, "iat"),
		nbf: requireInteger(value.nbf, "nbf"),
		exp: requireInteger(value.exp, "exp"),
	};
}

function assertHs256Header(token: string): void {
	const [encodedHeader] = token.split(".");
	if (!encodedHeader) throw new LocalTokenValidationError("unauthorized", "Access token header is invalid.");
	try {
		const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as unknown;
		if (typeof header !== "object" || header === null || !("alg" in header) || header.alg !== "HS256") {
			throw new LocalTokenValidationError("unauthorized", "Access token algorithm is invalid.");
		}
	} catch (error) {
		if (error instanceof LocalTokenValidationError) throw error;
		throw new LocalTokenValidationError("unauthorized", "Access token header is invalid.");
	}
}

export class LocalGrantRepository {
	#grants = new Map<string, LocalConsentGrant>();
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	create(clientId: string, origin: string, scopes: readonly HostedScope[]): LocalConsentGrant {
		const now = this.#now();
		const grant: LocalConsentGrant = {
			id: crypto.randomUUID(),
			clientId,
			origin,
			scopes: [...scopes],
			status: "active",
			createdAt: now,
			lastUsedAt: now,
			expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
		};
		this.#grants.set(grant.id, grant);
		return this.#copy(grant);
	}

	get(id: string): LocalConsentGrant | undefined {
		const grant = this.#grants.get(id);
		return grant ? this.#copy(grant) : undefined;
	}

	activeFor(clientId: string, origin: string, scopes: readonly HostedScope[]): LocalConsentGrant | undefined {
		const now = this.#now();
		for (const grant of this.#grants.values()) {
			if (
				grant.status === "active" &&
				grant.expiresAt > now &&
				grant.clientId === clientId &&
				grant.origin === origin &&
				scopes.every(scope => grant.scopes.includes(scope))
			) {
				return this.#copy(grant);
			}
		}
		return undefined;
	}

	assertActive(id: string): LocalConsentGrant {
		const grant = this.#grants.get(id);
		if (!grant) throw new LocalTokenValidationError("unauthorized", "Consent grant was not found.");
		if (grant.status !== "active") throw new LocalTokenValidationError("grant_revoked", "Consent grant was revoked.");
		if (grant.expiresAt <= this.#now())
			throw new LocalTokenValidationError("grant_expired", "Consent grant expired.");
		return this.#copy(grant);
	}

	touch(id: string): void {
		const grant = this.#grants.get(id);
		if (grant?.status === "active") grant.lastUsedAt = this.#now();
	}

	expandScopes(id: string, scopes: readonly HostedScope[]): LocalConsentGrant {
		const grant = this.#grants.get(id);
		if (!grant) throw new LocalTokenValidationError("unauthorized", "Consent grant was not found.");
		if (grant.status !== "active") throw new LocalTokenValidationError("grant_revoked", "Consent grant was revoked.");
		if (grant.expiresAt <= this.#now())
			throw new LocalTokenValidationError("grant_expired", "Consent grant expired.");
		if (grant.scopes.some(scope => !scopes.includes(scope)) || new Set(scopes).size !== scopes.length) {
			throw new LocalTokenValidationError("scope_denied", "Expanded consent must retain every existing scope.");
		}
		grant.scopes = [...scopes];
		grant.lastUsedAt = this.#now();
		return this.#copy(grant);
	}

	beginRevocation(id: string): LocalConsentGrant | undefined {
		const grant = this.#grants.get(id);
		if (grant?.status !== "active") return grant ? this.#copy(grant) : undefined;
		grant.status = "revoking";
		return this.#copy(grant);
	}

	finishRevocation(id: string): void {
		const grant = this.#grants.get(id);
		if (grant) grant.status = "revoked";
	}

	list(): LocalConsentGrant[] {
		return [...this.#grants.values()].map(grant => this.#copy(grant));
	}

	#copy(grant: LocalConsentGrant): LocalConsentGrant {
		return { ...grant, scopes: [...grant.scopes] };
	}
}

export interface LocalTokenServiceOptions {
	key?: Uint8Array;
	now?: () => number;
}

export class LocalTokenService {
	#jwt: JwtService;
	#grants: LocalGrantRepository;
	#rows = new Map<string, LocalTokenRow>();
	#now: () => number;

	constructor(grants: LocalGrantRepository, options: LocalTokenServiceOptions = {}) {
		const key = options.key ?? crypto.getRandomValues(new Uint8Array(32));
		this.#jwt = new JwtService(Buffer.from(key));
		this.#grants = grants;
		this.#now = options.now ?? Date.now;
	}

	async issue(input: {
		grantId: string;
		clientId: string;
		origin: string;
		scopes: readonly HostedScope[];
		replacesJtiHash?: string;
		adopted?: boolean;
	}): Promise<IssuedLocalAccessToken> {
		const grant = this.#grants.assertActive(input.grantId);
		if (
			grant.clientId !== input.clientId ||
			grant.origin !== input.origin ||
			input.scopes.length === 0 ||
			input.scopes.some(scope => !grant.scopes.includes(scope))
		) {
			throw new LocalTokenValidationError("scope_denied", "Requested token scope is outside the consent grant.");
		}
		const now = Math.floor(this.#now() / 1000);
		const expiresAt = now + ACCESS_TOKEN_TTL_SECONDS;
		const jti = randomBase64Url(32);
		const scope = input.scopes.join(" ");
		const claims: LocalAccessTokenClaims = {
			iss: GRADIVUS_CHAT_LOCAL_ORIGIN,
			aud: GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE,
			sub: LOCAL_CHAT_OWNER.id,
			cid: input.clientId,
			scope,
			jti,
			iat: now,
			nbf: now,
			exp: expiresAt,
		};
		const accessToken = await this.#jwt.sign({ ...claims });
		const jtiHash = await sha256(jti);
		this.#rows.set(jtiHash, {
			jtiHash,
			grantId: grant.id,
			clientId: input.clientId,
			origin: input.origin,
			scopes: [...input.scopes],
			issuedAt: now * 1000,
			expiresAt: expiresAt * 1000,
			replacesJtiHash: input.replacesJtiHash,
			adopted: input.adopted ?? true,
		});
		return {
			accessToken,
			tokenType: "Bearer",
			expiresIn: ACCESS_TOKEN_TTL_SECONDS,
			scope,
			jtiHash,
			grantId: grant.id,
		};
	}

	async verify(
		token: string,
		expected: { clientId: string; origin: string; requiredScopes?: readonly HostedScope[] },
	): Promise<VerifiedLocalAccess> {
		assertHs256Header(token);
		let decoded: Record<string, unknown>;
		try {
			decoded = await this.#jwt.verify(token, {
				issuer: GRADIVUS_CHAT_LOCAL_ORIGIN,
				audience: GRADIVUS_CHAT_ACCESS_TOKEN_AUDIENCE,
				clockTimestamp: Math.floor(this.#now() / 1000),
			});
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			if (name === "TokenExpiredError")
				throw new LocalTokenValidationError("grant_expired", "Access token expired.");
			throw new LocalTokenValidationError("unauthorized", "Access token signature or lifetime is invalid.");
		}
		const claims = parseClaims(decoded);
		const now = Math.floor(this.#now() / 1000);
		if (claims.exp <= now) throw new LocalTokenValidationError("grant_expired", "Access token expired.");
		if (claims.nbf > now || claims.iat > now)
			throw new LocalTokenValidationError("unauthorized", "Access token is not active.");
		const jtiHash = await sha256(claims.jti);
		const row = this.#rows.get(jtiHash);
		if (!row)
			throw new LocalTokenValidationError("unauthorized", "Access token was not issued by this Desktop launch.");
		if (row.revokedAt !== undefined)
			throw new LocalTokenValidationError("grant_revoked", "Access token was revoked.");
		if (row.expiresAt <= this.#now()) throw new LocalTokenValidationError("grant_expired", "Access token expired.");
		const scopes = scopeNames(claims.scope);
		if (
			claims.cid !== expected.clientId ||
			row.clientId !== expected.clientId ||
			row.origin !== expected.origin ||
			!sameScopes(scopes, row.scopes)
		) {
			throw new LocalTokenValidationError("unauthorized", "Access token binding is invalid.");
		}
		if (expected.requiredScopes?.some(scope => !scopes.includes(scope))) {
			throw new LocalTokenValidationError("scope_denied", "Access token does not grant the required scope.");
		}
		const grant = this.#grants.assertActive(row.grantId);
		if (
			grant.clientId !== row.clientId ||
			grant.origin !== row.origin ||
			row.scopes.some(scope => !grant.scopes.includes(scope))
		) {
			throw new LocalTokenValidationError("unauthorized", "Consent grant binding is invalid.");
		}
		this.#grants.touch(grant.id);
		return { claims, grant: this.#grants.assertActive(grant.id), jtiHash };
	}

	async revokeAccessToken(token: string, expected: { clientId: string; origin: string }): Promise<void> {
		const verified = await this.verify(token, expected);
		const row = this.#rows.get(verified.jtiHash);
		if (row) row.revokedAt = this.#now();
	}

	revokeGrant(grantId: string): void {
		const grant = this.#grants.beginRevocation(grantId);
		if (!grant) return;
		const revokedAt = this.#now();
		for (const row of this.#rows.values()) {
			if (row.grantId === grantId) row.revokedAt = revokedAt;
		}
		this.#grants.finishRevocation(grantId);
	}

	adoptReplacement(jtiHash: string): boolean {
		const row = this.#rows.get(jtiHash);
		if (!row?.replacesJtiHash || row.adopted || row.revokedAt !== undefined || row.expiresAt <= this.#now()) {
			return false;
		}
		const previous = this.#rows.get(row.replacesJtiHash);
		if (!previous || previous.grantId !== row.grantId || previous.revokedAt !== undefined) {
			return false;
		}
		row.adopted = true;
		previous.revokedAt = this.#now();
		return true;
	}

	rollbackReplacement(jtiHash: string): boolean {
		const row = this.#rows.get(jtiHash);
		if (!row?.replacesJtiHash || row.adopted || row.revokedAt !== undefined) return false;
		row.revokedAt = this.#now();
		return true;
	}

	isUnadoptedReplacement(jtiHash: string): boolean {
		const row = this.#rows.get(jtiHash);
		return Boolean(row?.replacesJtiHash && !row.adopted && row.revokedAt === undefined);
	}

	activeTokenCount(grantId: string): number {
		const now = this.#now();
		let count = 0;
		for (const row of this.#rows.values()) {
			if (row.grantId === grantId && row.revokedAt === undefined && row.expiresAt > now) count += 1;
		}
		return count;
	}

	hasJtiHash(jtiHash: string): boolean {
		return this.#rows.has(jtiHash);
	}
}

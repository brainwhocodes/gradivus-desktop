import type { HostedScope } from "@gradivus/chat/contracts";
import {
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_DEV_CLIENT_ID,
	GRADIVUS_CHAT_DEV_ORIGIN,
	GRADIVUS_CHAT_DEV_REDIRECT_URI,
	GRADIVUS_CHAT_ORIGIN,
	GRADIVUS_CHAT_REDIRECT_URI,
} from "@gradivus/chat/protocol";
import {
	type GrantIdentifier,
	type OAuthClient,
	type OAuthClientRepository,
	OAuthException,
	type OAuthScope,
	type OAuthScopeRepository,
	type OAuthUser,
	type OAuthUserIdentifier,
	type OAuthUserRepository,
} from "@jmondi/oauth2-server";

export const LOCAL_CHAT_OWNER = { id: "local-owner" } as const satisfies OAuthUser;
export const LOCAL_CHAT_SCOPES = [
	{ name: "chat.read" },
	{ name: "agent.execute" },
	{ name: "sessions.manage" },
	{ name: "files.read" },
	{ name: "desktop.present" },
] as const satisfies readonly OAuthScope[];

const AUTHORIZATION_QUERY_FIELDS = new Set([
	"client_id",
	"redirect_uri",
	"response_type",
	"scope",
	"state",
	"code_challenge",
	"code_challenge_method",
]);
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000;

export type OAuthProtocolError =
	| "invalid_request"
	| "invalid_client"
	| "invalid_scope"
	| "unsupported_response_type"
	| "access_denied"
	| "invalid_grant"
	| "temporarily_unavailable";

export class LocalOAuthError extends Error {
	readonly oauthError: OAuthProtocolError;

	constructor(oauthError: OAuthProtocolError, message: string) {
		super(message);
		this.name = "LocalOAuthError";
		this.oauthError = oauthError;
	}
}

export interface HostedOAuthClient extends OAuthClient {
	origin: string;
	redirectUris: [string];
}

function client(id: string, name: string, origin: string, redirectUri: string): HostedOAuthClient {
	return {
		id,
		name,
		origin,
		redirectUris: [redirectUri],
		allowedGrants: ["authorization_code"],
		scopes: LOCAL_CHAT_SCOPES.map(scope => ({ name: scope.name })),
	};
}

export class FixedHostedClientRepository implements OAuthClientRepository {
	#clients: ReadonlyMap<string, HostedOAuthClient>;

	constructor(allowDevelopmentClient: boolean) {
		const clients = [
			client(GRADIVUS_CHAT_CLIENT_ID, "Gradivus Chat", GRADIVUS_CHAT_ORIGIN, GRADIVUS_CHAT_REDIRECT_URI),
		];
		if (allowDevelopmentClient) {
			clients.push(
				client(
					GRADIVUS_CHAT_DEV_CLIENT_ID,
					"Gradivus Chat development",
					GRADIVUS_CHAT_DEV_ORIGIN,
					GRADIVUS_CHAT_DEV_REDIRECT_URI,
				),
			);
		}
		this.#clients = new Map(clients.map(value => [value.id, value]));
	}

	clientFor(identifier: string): HostedOAuthClient | undefined {
		return this.#clients.get(identifier);
	}

	clientForOrigin(origin: string): HostedOAuthClient | undefined {
		for (const value of this.#clients.values()) {
			if (value.origin === origin) return value;
		}
		return undefined;
	}

	async getByIdentifier(clientId: string): Promise<OAuthClient> {
		const value = this.#clients.get(clientId);
		if (!value) throw OAuthException.invalidClient("Unknown Gradivus Chat client");
		return value;
	}

	async isClientValid(grantType: GrantIdentifier, value: OAuthClient, clientSecret?: string): Promise<boolean> {
		const registered = this.#clients.get(value.id);
		return Boolean(
			registered &&
			grantType === "authorization_code" &&
			registered.allowedGrants.includes(grantType) &&
			clientSecret === undefined,
		);
	}
}

export class FixedHostedScopeRepository implements OAuthScopeRepository {
	#scopes: Map<string, OAuthScope> = new Map(LOCAL_CHAT_SCOPES.map(scope => [scope.name, { name: scope.name }]));

	async getAllByIdentifiers(scopeNames: string[]): Promise<OAuthScope[]> {
		const scopes = scopeNames.map(name => this.#scopes.get(name));
		if (scopes.some(scope => scope === undefined)) throw OAuthException.invalidScope(scopeNames.join(" "));
		return scopes.filter((scope): scope is OAuthScope => scope !== undefined);
	}

	async finalize(
		scopes: OAuthScope[],
		grantType: GrantIdentifier,
		value: OAuthClient,
		_userId?: OAuthUserIdentifier,
	): Promise<OAuthScope[]> {
		if (grantType !== "authorization_code") throw OAuthException.invalidScope();
		const allowed = new Set(value.scopes.map(scope => scope.name));
		if (scopes.length === 0 || scopes.some(scope => !allowed.has(scope.name) || !this.#scopes.has(scope.name))) {
			throw OAuthException.invalidScope(scopes.map(scope => scope.name).join(" "));
		}
		return scopes;
	}
}

export class FixedLocalOwnerRepository implements OAuthUserRepository {
	async getUserByCredentials(identifier: OAuthUserIdentifier): Promise<OAuthUser | undefined> {
		return identifier === LOCAL_CHAT_OWNER.id ? LOCAL_CHAT_OWNER : undefined;
	}
}

export interface ValidatedAuthorizationRequest {
	client: HostedOAuthClient;
	origin: string;
	redirectUri: string;
	state: string;
	scopes: HostedScope[];
	codeChallenge: string;
	codeChallengeMethod: "S256";
}

function singleParameter(url: URL, name: string): string {
	const values = url.searchParams.getAll(name);
	if (values.length !== 1 || !values[0])
		throw new LocalOAuthError("invalid_request", `${name} is required exactly once.`);
	return values[0];
}

export async function validateAuthorizationRequest(
	url: URL,
	clients: FixedHostedClientRepository,
	scopes: FixedHostedScopeRepository,
): Promise<ValidatedAuthorizationRequest> {
	for (const key of url.searchParams.keys()) {
		if (!AUTHORIZATION_QUERY_FIELDS.has(key))
			throw new LocalOAuthError("invalid_request", `Unknown authorization field: ${key}`);
	}
	const clientId = singleParameter(url, "client_id");
	const registered = clients.clientFor(clientId);
	if (!registered) throw new LocalOAuthError("invalid_client", "Unknown Gradivus Chat client.");
	const redirectUri = singleParameter(url, "redirect_uri");
	if (redirectUri !== registered.redirectUris[0]) {
		throw new LocalOAuthError("invalid_request", "redirect_uri does not match the registered callback.");
	}
	if (singleParameter(url, "response_type") !== "code") {
		throw new LocalOAuthError("unsupported_response_type", "Only the authorization code response type is supported.");
	}
	const state = singleParameter(url, "state");
	if (!BASE64URL_32_BYTES.test(state)) {
		throw new LocalOAuthError("invalid_request", "state must be a 32-byte base64url value.");
	}
	const codeChallenge = singleParameter(url, "code_challenge");
	if (!PKCE_CHALLENGE.test(codeChallenge)) {
		throw new LocalOAuthError("invalid_request", "code_challenge must be a 43-128 character RFC 7636 value.");
	}
	if (singleParameter(url, "code_challenge_method") !== "S256") {
		throw new LocalOAuthError("invalid_request", "code_challenge_method must be S256.");
	}
	const scopeValue = singleParameter(url, "scope");
	const scopeNames = scopeValue.split(" ").filter(Boolean);
	if (scopeNames.length === 0 || new Set(scopeNames).size !== scopeNames.length) {
		throw new LocalOAuthError("invalid_scope", "scope must contain a nonempty unique scope set.");
	}
	let finalized: OAuthScope[];
	try {
		finalized = await scopes.finalize(
			await scopes.getAllByIdentifiers(scopeNames),
			"authorization_code",
			registered,
			LOCAL_CHAT_OWNER.id,
		);
	} catch {
		throw new LocalOAuthError("invalid_scope", "The requested scope set is not allowed.");
	}
	return {
		client: registered,
		origin: registered.origin,
		redirectUri,
		state,
		scopes: finalized.map(scope => scope.name as HostedScope),
		codeChallenge,
		codeChallengeMethod: "S256",
	};
}

export interface AuthorizationCodeBinding {
	grantId: string;
	clientId: string;
	origin: string;
	redirectUri: string;
	ownerId: string;
	scopes: HostedScope[];
	state: string;
	codeChallenge: string;
	codeChallengeMethod: "S256";
}

interface AuthorizationCodeRow extends AuthorizationCodeBinding {
	hash: string;
	expiresAt: number;
	status: "active" | "exchanging" | "consumed";
	exchangeId?: string;
}

export interface AuthorizationCodeExchange extends AuthorizationCodeBinding {
	hash: string;
	exchangeId: string;
	expiresAt: number;
}

function randomBase64Url(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Buffer.from(digest).toString("base64url");
}

function fixedLengthEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

export class InMemoryAuthorizationCodeRepository {
	#rows = new Map<string, AuthorizationCodeRow>();
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	async issue(binding: AuthorizationCodeBinding): Promise<string> {
		this.#cleanup();
		const code = randomBase64Url(32);
		const hash = await sha256(code);
		this.#rows.set(hash, {
			...binding,
			scopes: [...binding.scopes],
			hash,
			expiresAt: this.#now() + AUTHORIZATION_CODE_TTL_MS,
			status: "active",
		});
		return code;
	}

	async beginExchange(input: {
		code: string;
		clientId: string;
		redirectUri: string;
		codeVerifier: string;
	}): Promise<AuthorizationCodeExchange> {
		if (!PKCE_VERIFIER.test(input.codeVerifier))
			throw new LocalOAuthError("invalid_grant", "Authorization code is invalid.");
		const hash = await sha256(input.code);
		const row = this.#rows.get(hash);
		if (
			row?.status !== "active" ||
			row.expiresAt <= this.#now() ||
			row.clientId !== input.clientId ||
			row.redirectUri !== input.redirectUri
		) {
			throw new LocalOAuthError("invalid_grant", "Authorization code is invalid.");
		}
		const exchangeId = crypto.randomUUID();
		row.status = "exchanging";
		row.exchangeId = exchangeId;
		const verifierDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.codeVerifier));
		const verifierChallenge = Buffer.from(verifierDigest).toString("base64url");
		if (!fixedLengthEqual(verifierChallenge, row.codeChallenge)) {
			row.status = "active";
			row.exchangeId = undefined;
			throw new LocalOAuthError("invalid_grant", "Authorization code is invalid.");
		}
		return {
			grantId: row.grantId,
			clientId: row.clientId,
			origin: row.origin,
			redirectUri: row.redirectUri,
			ownerId: row.ownerId,
			scopes: [...row.scopes],
			state: row.state,
			codeChallenge: row.codeChallenge,
			codeChallengeMethod: row.codeChallengeMethod,
			hash,
			exchangeId,
			expiresAt: row.expiresAt,
		};
	}

	finishExchange(exchange: AuthorizationCodeExchange, tokenPersisted: boolean): void {
		const row = this.#rows.get(exchange.hash);
		if (row?.status !== "exchanging" || row.exchangeId !== exchange.exchangeId) {
			throw new LocalOAuthError("invalid_grant", "Authorization code exchange is no longer active.");
		}
		row.status = tokenPersisted ? "consumed" : "active";
		row.exchangeId = undefined;
	}

	async revoke(code: string): Promise<void> {
		const row = this.#rows.get(await sha256(code));
		if (row) {
			row.status = "consumed";
			row.exchangeId = undefined;
		}
	}

	async status(code: string): Promise<AuthorizationCodeRow["status"] | "missing" | "expired"> {
		const row = this.#rows.get(await sha256(code));
		if (!row) return "missing";
		if (row.expiresAt <= this.#now()) return "expired";
		return row.status;
	}

	storedHashes(): string[] {
		return [...this.#rows.keys()];
	}

	#cleanup(): void {
		const now = this.#now();
		for (const [hash, row] of this.#rows) {
			if (row.expiresAt <= now) this.#rows.delete(hash);
		}
	}
}

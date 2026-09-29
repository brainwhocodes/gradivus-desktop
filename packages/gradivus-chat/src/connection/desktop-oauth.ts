import type { HostedScope } from "../lib/contracts";
import {
	GRADIVUS_CHAT_CALLBACK_PATH,
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_DEV_CLIENT_ID,
	GRADIVUS_CHAT_DEV_ORIGIN,
	GRADIVUS_CHAT_EXPANDED_SCOPES,
	GRADIVUS_CHAT_INITIAL_SCOPES,
	GRADIVUS_CHAT_LOCAL_ORIGIN,
	GRADIVUS_CHAT_ORIGIN,
} from "../lib/protocol";
import { fetchDesktop } from "./loopback-fetch";

const CALLBACK_MESSAGE = "gradivus:oauth-callback";
const AUTHORIZATION_TIMEOUT_MS = 125_000;

export interface DesktopAuthorization {
	accessToken: string;
	expiresAt: number;
	scopes: readonly HostedScope[];
}

export class DesktopAuthorizationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "DesktopAuthorizationError";
	}
}

export function oauthClient(origin: string): {
	clientId: string;
	redirectUri: string;
} {
	if (origin !== GRADIVUS_CHAT_ORIGIN && origin !== GRADIVUS_CHAT_DEV_ORIGIN) {
		throw new DesktopAuthorizationError(
			"origin_not_allowed",
			"This web address is not registered with Gradivus Desktop.",
		);
	}
	return {
		clientId:
			origin === GRADIVUS_CHAT_DEV_ORIGIN
				? GRADIVUS_CHAT_DEV_CLIENT_ID
				: GRADIVUS_CHAT_CLIENT_ID,
		redirectUri: `${origin}${GRADIVUS_CHAT_CALLBACK_PATH}`,
	};
}

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

export async function createProofKey(): Promise<{
	state: string;
	verifier: string;
	challenge: string;
}> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		),
	);
	return { state, verifier, challenge };
}

type OAuthCallbackMessage = { type: typeof CALLBACK_MESSAGE; state: string } & (
	| { code: string; error?: never }
	| { error: string; code?: never }
);

export function validateOAuthMessage(
	event: Pick<MessageEvent, "origin" | "source" | "data">,
	origin: string,
	popup: Window,
	state: string,
): OAuthCallbackMessage | undefined {
	if (event.origin !== origin || event.source !== popup) return undefined;
	if (
		typeof event.data !== "object" ||
		event.data === null ||
		Array.isArray(event.data)
	)
		return undefined;
	const data = event.data as Record<string, unknown>;
	if (data.type !== CALLBACK_MESSAGE || data.state !== state) return undefined;
	if (
		Object.keys(data).some(
			(key) => !["type", "state", "code", "error"].includes(key),
		)
	)
		return undefined;
	if (
		typeof data.code === "string" &&
		data.code.length > 0 &&
		data.error === undefined
	)
		return { type: CALLBACK_MESSAGE, state, code: data.code };
	if (
		typeof data.error === "string" &&
		data.error.length > 0 &&
		data.code === undefined
	)
		return { type: CALLBACK_MESSAGE, state, error: data.error };
	return undefined;
}

/** The callback transfers only the one-time code. Tokens and the verifier never enter URLs or storage. */
export function completeOAuthCallback(): string {
	const url = new URL(window.location.href);
	window.history.replaceState(null, "", GRADIVUS_CHAT_CALLBACK_PATH);
	try {
		oauthClient(url.origin);
		if (!window.opener)
			return "Return to Gradivus Chat and connect again. This approval window has no waiting tab.";
		if (
			[...url.searchParams.keys()].some(
				(key) => !["state", "code", "error", "error_description"].includes(key),
			)
		)
			throw new Error("Invalid callback.");
		for (const key of ["state", "code", "error", "error_description"]) {
			if (url.searchParams.getAll(key).length > 1)
				throw new Error("Invalid callback.");
		}
		const state = url.searchParams.get("state");
		const code = url.searchParams.get("code");
		const error = url.searchParams.get("error");
		if (
			!state ||
			!/^[A-Za-z0-9_-]{43}$/.test(state) ||
			Boolean(code) === Boolean(error)
		)
			throw new Error("Invalid callback.");
		let message: OAuthCallbackMessage;
		if (code) message = { type: CALLBACK_MESSAGE, state, code };
		else if (error) message = { type: CALLBACK_MESSAGE, state, error };
		else throw new Error("Invalid callback.");
		window.opener.postMessage(message, url.origin);
		window.close();
		return "Approval received. Return to your Gradivus Chat tab. You can close this window.";
	} catch {
		return "This approval response is invalid. Return to Gradivus Chat and connect again.";
	}
}

function waitForCallback(
	popup: Window,
	state: string,
	signal: AbortSignal,
): Promise<string> {
	const pending = Promise.withResolvers<string>();
	const cleanup = (): void => {
		window.removeEventListener("message", onMessage);
		signal.removeEventListener("abort", onAbort);
		window.clearTimeout(timeout);
		window.clearInterval(closedCheck);
	};
	const fail = (error: Error): void => {
		cleanup();
		pending.reject(error);
	};
	const onAbort = (): void =>
		fail(new DesktopAuthorizationError("cancelled", "Connection cancelled."));
	const onMessage = (event: MessageEvent): void => {
		const message = validateOAuthMessage(
			event,
			window.location.origin,
			popup,
			state,
		);
		if (!message) return;
		cleanup();
		if (message.error) {
			pending.reject(
				new DesktopAuthorizationError(
					message.error,
					message.error === "access_denied"
						? "Access was not approved in Desktop."
						: "Desktop could not approve this connection. Try again.",
				),
			);
		} else if (message.code) pending.resolve(message.code);
	};
	const timeout = window.setTimeout(
		() =>
			fail(
				new DesktopAuthorizationError(
					"expired",
					"The approval request expired. Connect again when you are ready.",
				),
			),
		AUTHORIZATION_TIMEOUT_MS,
	);
	const closedCheck = window.setInterval(() => {
		if (popup.closed)
			fail(
				new DesktopAuthorizationError(
					"cancelled",
					"The approval window closed. Connect again to continue.",
				),
			);
	}, 400);
	window.addEventListener("message", onMessage);
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	return pending.promise;
}

export async function authorizeDesktop(
	popup: Window,
	signal: AbortSignal,
	previous?: DesktopAuthorization,
): Promise<DesktopAuthorization> {
	const client = oauthClient(window.location.origin);
	const proof = await createProofKey();
	signal.throwIfAborted();
	const scopes = previous
		? GRADIVUS_CHAT_EXPANDED_SCOPES
		: GRADIVUS_CHAT_INITIAL_SCOPES;
	const url = new URL("/oauth/authorize", GRADIVUS_CHAT_LOCAL_ORIGIN);
	url.search = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: client.redirectUri,
		response_type: "code",
		scope: scopes.join(" "),
		state: proof.state,
		code_challenge: proof.challenge,
		code_challenge_method: "S256",
	}).toString();
	const callback = waitForCallback(popup, proof.state, signal);
	popup.location.href = url.href;
	const code = await callback;
	const response = await fetchDesktop("/oauth/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...(previous ? { Authorization: `Bearer ${previous.accessToken}` } : {}),
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: client.clientId,
			redirect_uri: client.redirectUri,
			code,
			code_verifier: proof.verifier,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	const result: unknown = await response.json();
	if (!response.ok)
		throw new DesktopAuthorizationError(
			"exchange_failed",
			"Desktop could not complete approval. Connect again.",
		);
	if (typeof result !== "object" || result === null)
		throw new DesktopAuthorizationError(
			"protocol_mismatch",
			"Desktop returned an invalid authorization response.",
		);
	const token = result as Record<string, unknown>;
	if (
		typeof token.access_token !== "string" ||
		!token.access_token ||
		token.token_type !== "Bearer" ||
		typeof token.expires_in !== "number" ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0 ||
		typeof token.scope !== "string"
	) {
		throw new DesktopAuthorizationError(
			"protocol_mismatch",
			"Desktop returned an invalid authorization response.",
		);
	}
	const granted = token.scope.split(" ");
	if (
		granted.length !== scopes.length ||
		!scopes.every((scope) => granted.includes(scope))
	) {
		throw new DesktopAuthorizationError(
			"protocol_mismatch",
			"Desktop returned unexpected permissions.",
		);
	}
	return {
		accessToken: token.access_token,
		expiresAt: Date.now() + token.expires_in * 1_000,
		scopes,
	};
}

export async function revokeDesktopAuthorization(
	authorization: DesktopAuthorization,
): Promise<void> {
	const client = oauthClient(window.location.origin);
	const response = await fetchDesktop("/oauth/revoke", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			token: authorization.accessToken,
			client_id: client.clientId,
			token_type_hint: "access_token",
		}),
		signal: AbortSignal.timeout(5_000),
	});
	if (!response.ok)
		throw new Error("Desktop could not revoke this connection.");
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { HostedCommandError, HostedCommandErrorCode } from "@gradivus/chat/contracts";
import {
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_LOCAL_ORIGIN,
	GRADIVUS_CHAT_PROTOCOL_VERSION,
	type HostedAuthorizationServerMetadata,
	type HostedOAuthTokenResponse,
	validateHostedCommandEnvelope,
} from "@gradivus/chat/protocol";
import {
	FormDataParseError,
	MaxFileSizeExceededError,
	MaxFilesExceededError,
	MaxHeaderSizeExceededError,
	MultipartParseError,
	parseFormData,
} from "@mjackson/form-data-parser";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import {
	MAX_PROMPT_ATTACHMENT_BATCH_BYTES,
	MAX_PROMPT_ATTACHMENT_BYTES,
	MAX_PROMPT_ATTACHMENT_COUNT,
	type PromptAttachmentTempFile,
} from "../shared/contracts";
import {
	type HostedCommandDispatchContext,
	HostedCommandDispatchError,
	type HostedCommandDispatcher,
} from "./hosted-command-dispatcher";
import { HostedPayloadValidationError, validateHostedCommandPayload } from "./hosted-command-validation";
import type { HostedEventSequencer } from "./hosted-event-sequencer";
import type { LocalChatConsentController } from "./local-chat-consent";
import type { LocalScopeExpansionCoordinator } from "./local-chat-expansion";
import {
	type FixedHostedClientRepository,
	type FixedHostedScopeRepository,
	type InMemoryAuthorizationCodeRepository,
	LOCAL_CHAT_OWNER,
	LOCAL_CHAT_SCOPES,
	LocalOAuthError,
	type ValidatedAuthorizationRequest,
	validateAuthorizationRequest,
} from "./local-chat-oauth";
import { type LocalTokenService, LocalTokenValidationError, type VerifiedLocalAccess } from "./local-chat-tokens";

const FORM_BODY_LIMIT = 8 * 1024;
const COMMAND_BODY_LIMIT = 17 * 1024 * 1024;
const MULTIPART_WIRE_LIMIT = 34 * 1024 * 1024;
const MULTIPART_METADATA_LIMIT = 64 * 1024;
const MULTIPART_HEADER_LIMIT = 8 * 1024;
const URLENCODED_MEDIA_TYPE = "application/x-www-form-urlencoded";
const JSON_MEDIA_TYPE = "application/json";
const MULTIPART_MEDIA_TYPE = "multipart/form-data";

export interface LocalChatApiOptions {
	clients: FixedHostedClientRepository;
	scopes: FixedHostedScopeRepository;
	codes: InMemoryAuthorizationCodeRepository;
	consent: LocalChatConsentController;
	expansion: LocalScopeExpansionCoordinator;
	tokens: LocalTokenService;
	dispatcher: HostedCommandDispatcher;
	desktopVersion: string;
	eventSequencer?: HostedEventSequencer;
	currentSequence?: () => number;
	onConnectionsChanged?: () => void;
}

class LocalChatHttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "LocalChatHttpError";
		this.status = status;
		this.code = code;
	}
}

class LocalChatAttachmentError extends Error {
	readonly code: HostedCommandErrorCode;

	constructor(code: HostedCommandErrorCode, message: string) {
		super(message);
		this.name = "LocalChatAttachmentError";
		this.code = code;
	}
}

function contentType(request: Request): string {
	return (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function requireMediaType(request: Request, expected: string): void {
	if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") {
		throw new LocalChatHttpError(415, "validation_error", "Compressed request bodies are not accepted.");
	}
	if (contentType(request) !== expected) {
		throw new LocalChatHttpError(415, "validation_error", `Content-Type must be ${expected}.`);
	}
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
			throw new LocalChatHttpError(413, "validation_error", "Request body is too large.");
		}
	}
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel("Request body is too large.").catch(() => undefined);
				throw new LocalChatHttpError(413, "validation_error", "Request body is too large.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function boundedMultipartRequest(request: Request): Request {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0 || length > MULTIPART_WIRE_LIMIT) {
			throw new LocalChatAttachmentError("attachment_too_large", "Multipart request exceeds 34 MiB.");
		}
	}
	if (!request.body) throw new LocalChatAttachmentError("validation_error", "Multipart request body is required.");
	const reader = request.body.getReader();
	let total = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					return;
				}
				total += value.byteLength;
				if (total > MULTIPART_WIRE_LIMIT) {
					await reader.cancel("Multipart request exceeds 34 MiB.").catch(() => undefined);
					controller.error(
						new LocalChatAttachmentError("attachment_too_large", "Multipart request exceeds 34 MiB."),
					);
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => undefined);
		},
	});
	const init: RequestInit & { duplex: "half" } = {
		method: request.method,
		headers: request.headers,
		body,
		signal: request.signal,
		duplex: "half",
	};
	return new Request(request.url, init);
}

function temporaryFileName(name: string): string {
	const extension = path.extname(path.basename(name)).toLowerCase();
	return `${crypto.randomUUID()}${/^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ".bin"}`;
}

function attachmentCommandError(error: unknown): HostedCommandError {
	if (error instanceof LocalChatAttachmentError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof MaxFilesExceededError) {
		return { code: "attachment_count_exceeded", message: "A maximum of 12 files is allowed.", retryable: false };
	}
	if (error instanceof MaxFileSizeExceededError) {
		return { code: "attachment_too_large", message: "Each file must be 25 MiB or smaller.", retryable: false };
	}
	if (
		error instanceof MaxHeaderSizeExceededError ||
		error instanceof MultipartParseError ||
		error instanceof FormDataParseError
	) {
		return { code: "validation_error", message: "Multipart attachment data is invalid.", retryable: false };
	}
	return commandError(error);
}

async function writeFileUpload(target: string, file: File): Promise<void> {
	const handle = await fs.open(target, "wx", 0o600);
	const reader = file.stream().getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await handle.write(value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
		await handle.close();
	}
}
function exactForm(body: Uint8Array, required: readonly string[], optional: readonly string[] = []): URLSearchParams {
	const form = new URLSearchParams(new TextDecoder().decode(body));
	const allowed = new Set([...required, ...optional]);
	for (const key of form.keys()) {
		if (!allowed.has(key) || form.getAll(key).length !== 1) {
			throw new LocalChatHttpError(400, "invalid_request", `Invalid form field: ${key}`);
		}
	}
	for (const key of required) {
		if (!form.has(key) || !form.get(key)) {
			throw new LocalChatHttpError(400, "invalid_request", `${key} is required.`);
		}
	}
	return form;
}

function jsonError(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

function protectedRouteError(error: unknown): Response {
	if (error instanceof LocalChatHttpError) return jsonError(error.status, error.code, error.message);
	if (error instanceof LocalTokenValidationError) return jsonError(errorStatus(error.code), error.code, error.message);
	return jsonError(503, "runtime_unavailable", "Gradivus Desktop could not complete the request.");
}

function oauthError(error: LocalOAuthError | LocalChatHttpError): Response {
	return Response.json(
		{ error: error instanceof LocalOAuthError ? error.oauthError : error.code, error_description: error.message },
		{ status: error instanceof LocalChatHttpError ? error.status : 400, headers: { "Cache-Control": "no-store" } },
	);
}

function redirectAuthorizationError(request: ValidatedAuthorizationRequest, error: LocalOAuthError): Response {
	const redirect = new URL(request.redirectUri);
	redirect.searchParams.set("error", error.oauthError);
	redirect.searchParams.set("error_description", error.message);
	redirect.searchParams.set("state", request.state);
	return Response.redirect(redirect, 302);
}

function bearerToken(request: Request): string {
	const authorization = request.headers.get("authorization");
	const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
	if (!match?.[1]) throw new LocalChatHttpError(401, "unauthorized", "A valid bearer token is required.");
	return match[1];
}

function commandError(error: unknown): HostedCommandError {
	if (error instanceof HostedCommandDispatchError) {
		return { code: error.code, message: error.message, retryable: error.retryable };
	}
	if (error instanceof HostedPayloadValidationError) {
		return { code: "validation_error", message: error.message, retryable: false };
	}
	if (error instanceof LocalTokenValidationError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof TypeError) {
		return { code: "validation_error", message: "Command payload is invalid.", retryable: false };
	}
	return { code: "runtime_unavailable", message: "Gradivus Desktop could not complete the command.", retryable: true };
}

function errorStatus(code: HostedCommandErrorCode): number {
	if (code === "unauthorized" || code === "grant_expired" || code === "grant_revoked") return 401;
	if (code === "scope_denied") return 403;
	if (code === "validation_error" || code === "protocol_mismatch") return 400;
	if (code === "session_not_found") return 404;
	if (code === "conflict") return 409;
	return 503;
}

export class LocalChatApi {
	readonly #clients: FixedHostedClientRepository;
	readonly #scopes: FixedHostedScopeRepository;
	readonly #codes: InMemoryAuthorizationCodeRepository;
	readonly #consent: LocalChatConsentController;
	readonly #expansion: LocalScopeExpansionCoordinator;
	readonly #tokens: LocalTokenService;
	readonly #dispatcher: HostedCommandDispatcher;
	readonly #desktopVersion: string;
	readonly #eventSequencer: HostedEventSequencer | undefined;
	readonly #currentSequence: () => number;
	readonly #onConnectionsChanged: () => void;

	constructor(options: LocalChatApiOptions) {
		this.#clients = options.clients;
		this.#scopes = options.scopes;
		this.#codes = options.codes;
		this.#consent = options.consent;
		this.#expansion = options.expansion;
		this.#tokens = options.tokens;
		this.#dispatcher = options.dispatcher;
		this.#desktopVersion = options.desktopVersion;
		this.#eventSequencer = options.eventSequencer;
		this.#currentSequence = options.currentSequence ?? (() => this.#eventSequencer?.currentSequence ?? 0);
		this.#onConnectionsChanged = options.onConnectionsChanged ?? (() => {});
	}

	metadata(): Response {
		const metadata: HostedAuthorizationServerMetadata = {
			issuer: GRADIVUS_CHAT_LOCAL_ORIGIN,
			authorization_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/authorize`,
			token_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/token`,
			revocation_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/revoke`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			scopes_supported: LOCAL_CHAT_SCOPES.map(scope => scope.name),
			protocol_versions_supported: [GRADIVUS_CHAT_PROTOCOL_VERSION],
			client_id: GRADIVUS_CHAT_CLIENT_ID,
			desktop_version: this.#desktopVersion,
		};
		return Response.json(metadata);
	}

	async authorize(request: Request): Promise<Response> {
		let validated: ValidatedAuthorizationRequest;
		try {
			validated = await validateAuthorizationRequest(new URL(request.url), this.#clients, this.#scopes);
		} catch (error) {
			return error instanceof LocalOAuthError
				? oauthError(error)
				: oauthError(new LocalOAuthError("invalid_request", "Authorization request is invalid."));
		}
		try {
			const authorization = validated.scopes.includes("desktop.present")
				? await this.#expansion.authorize(validated)
				: await this.#consent.authorizeInitial(validated);
			const code = await this.#codes.issue({
				grantId: authorization.grant.id,
				clientId: validated.client.id,
				origin: validated.origin,
				redirectUri: validated.redirectUri,
				ownerId: LOCAL_CHAT_OWNER.id,
				scopes: validated.scopes,
				state: validated.state,
				codeChallenge: validated.codeChallenge,
				codeChallengeMethod: validated.codeChallengeMethod,
			});
			this.#onConnectionsChanged();
			const redirect = new URL(validated.redirectUri);
			redirect.searchParams.set("code", code);
			redirect.searchParams.set("state", validated.state);
			return Response.redirect(redirect, 302);
		} catch (error) {
			const failure =
				error instanceof LocalOAuthError
					? error
					: new LocalOAuthError("temporarily_unavailable", "Gradivus Desktop couldn’t finish the request.");
			return redirectAuthorizationError(validated, failure);
		}
	}

	async token(request: Request): Promise<Response> {
		try {
			requireMediaType(request, URLENCODED_MEDIA_TYPE);
			const form = exactForm(await readBoundedBody(request, FORM_BODY_LIMIT), [
				"grant_type",
				"code",
				"redirect_uri",
				"client_id",
				"code_verifier",
			]);
			if (form.get("grant_type") !== "authorization_code") {
				throw new LocalChatHttpError(400, "unsupported_grant_type", "Only authorization_code is supported.");
			}
			const clientId = form.get("client_id") ?? "";
			const origin = request.headers.get("origin") ?? "";
			const client = this.#clients.clientFor(clientId);
			if (!client || client.origin !== origin) {
				throw new LocalChatHttpError(401, "invalid_client", "Client and request origin do not match.");
			}
			const exchange = await this.#codes.beginExchange({
				code: form.get("code") ?? "",
				clientId,
				redirectUri: form.get("redirect_uri") ?? "",
				codeVerifier: form.get("code_verifier") ?? "",
			});
			try {
				const issued = exchange.scopes.includes("desktop.present")
					? await this.#expansion.issueReplacement(exchange, bearerToken(request))
					: await this.#tokens.issue({
							grantId: exchange.grantId,
							clientId: exchange.clientId,
							origin: exchange.origin,
							scopes: exchange.scopes,
						});
				this.#codes.finishExchange(exchange, true);
				const response: HostedOAuthTokenResponse = {
					access_token: issued.accessToken,
					token_type: issued.tokenType,
					expires_in: issued.expiresIn,
					scope: issued.scope,
				};
				this.#onConnectionsChanged();
				return Response.json(response);
			} catch (error) {
				this.#codes.finishExchange(exchange, false);
				throw error;
			}
		} catch (error) {
			if (error instanceof LocalOAuthError || error instanceof LocalChatHttpError) return oauthError(error);
			if (error instanceof LocalTokenValidationError) {
				return oauthError(new LocalOAuthError("invalid_grant", error.message));
			}
			return oauthError(new LocalOAuthError("temporarily_unavailable", "Token exchange failed."));
		}
	}

	async revoke(request: Request): Promise<Response> {
		try {
			requireMediaType(request, URLENCODED_MEDIA_TYPE);
			const form = exactForm(
				await readBoundedBody(request, FORM_BODY_LIMIT),
				["token", "client_id"],
				["token_type_hint"],
			);
			const clientId = form.get("client_id") ?? "";
			const origin = request.headers.get("origin") ?? "";
			const client = this.#clients.clientFor(clientId);
			if (!client || client.origin !== origin) {
				throw new LocalChatHttpError(401, "invalid_client", "Client and request origin do not match.");
			}
			const token = form.get("token") ?? "";
			try {
				const access = await this.#tokens.verify(token, { clientId, origin });
				await this.#tokens.revokeAccessToken(token, { clientId, origin });
				this.#eventSequencer?.closeGrant(access.grant.id);
			} catch (error) {
				if (!(error instanceof LocalTokenValidationError)) throw error;
			}
			this.#onConnectionsChanged();
			return new Response(null, { status: 204 });
		} catch (error) {
			if (error instanceof LocalChatHttpError) return oauthError(error);
			return oauthError(new LocalChatHttpError(400, "invalid_request", "Revocation request is invalid."));
		}
	}

	async command(request: Request, context: HostedCommandDispatchContext = {}): Promise<Response> {
		let id = "unknown";
		try {
			requireMediaType(request, JSON_MEDIA_TYPE);
			const access = await this.#verifyAccess(request);
			const raw = await readBoundedBody(request, COMMAND_BODY_LIMIT);
			let parsed: unknown;
			try {
				parsed = JSON.parse(new TextDecoder().decode(raw));
			} catch {
				throw new HostedPayloadValidationError("Command body must be valid JSON.");
			}
			const envelope = validateHostedCommandEnvelope(parsed);
			if (!envelope.ok) {
				const result = {
					protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
					id,
					ok: false as const,
					atSequence: this.#currentSequence(),
					error: envelope.error,
				};
				return Response.json(result, { status: errorStatus(envelope.error.code) });
			}
			id = envelope.value.id;
			const command = validateHostedCommandPayload(envelope.value);
			const value = await this.#dispatcher.dispatch(command, access, context);
			return Response.json({
				protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
				id,
				ok: true as const,
				atSequence: this.#currentSequence(),
				value,
			});
		} catch (error) {
			if (error instanceof LocalChatHttpError) return jsonError(error.status, error.code, error.message);
			const failure = commandError(error);
			return Response.json(
				{
					protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
					id,
					ok: false as const,
					atSequence: this.#currentSequence(),
					error: failure,
				},
				{ status: errorStatus(failure.code) },
			);
		}
	}
	async attachments(request: Request, sessionId: string): Promise<Response> {
		let id = "unknown";
		let tempDir: TempDir | undefined;
		try {
			requireMediaType(request, MULTIPART_MEDIA_TYPE);
			const access = await this.#verifyAccess(request);
			tempDir = await TempDir.create("@gradivus-chat-upload-");
			await fs.chmod(tempDir.path(), 0o700);
			const files: PromptAttachmentTempFile[] = [];
			const names = new Set<string>();
			let aggregateBytes = 0;
			const form = await parseFormData(
				boundedMultipartRequest(request),
				{
					maxFiles: MAX_PROMPT_ATTACHMENT_COUNT,
					maxFileSize: MAX_PROMPT_ATTACHMENT_BYTES,
					maxHeaderSize: MULTIPART_HEADER_LIMIT,
				},
				async file => {
					if (file.fieldName !== "files") {
						throw new LocalChatAttachmentError("validation_error", "Attachment file field must be named files.");
					}
					if (file.size === 0) {
						throw new LocalChatAttachmentError("validation_error", "Attachment files cannot be empty.");
					}
					aggregateBytes += file.size;
					if (aggregateBytes > MAX_PROMPT_ATTACHMENT_BATCH_BYTES) {
						throw new LocalChatAttachmentError(
							"attachment_too_large",
							"Aggregate attachment data exceeds 32 MiB.",
						);
					}
					const nameKey = file.name.toLocaleLowerCase("en-US");
					if (names.has(nameKey)) {
						throw new LocalChatAttachmentError(
							"validation_error",
							"Duplicate attachment file names are not allowed.",
						);
					}
					names.add(nameKey);
					const target = tempDir?.join(temporaryFileName(file.name));
					if (!target) throw new LocalChatAttachmentError("runtime_unavailable", "Upload storage is unavailable.");
					await writeFileUpload(target, file);
					files.push({
						name: file.name,
						mimeType: file.type === "application/octet-stream" ? undefined : file.type || undefined,
						size: file.size,
						path: target,
					});
					return null;
				},
			);
			const commandFields = form.getAll("command");
			if (
				commandFields.length !== 1 ||
				typeof commandFields[0] !== "string" ||
				[...form.keys()].some(key => key !== "command")
			) {
				throw new LocalChatAttachmentError(
					"validation_error",
					"Multipart data must contain one command field and files fields only.",
				);
			}
			if (Buffer.byteLength(commandFields[0], "utf8") > MULTIPART_METADATA_LIMIT) {
				throw new LocalChatAttachmentError("validation_error", "Attachment command metadata exceeds 64 KiB.");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(commandFields[0]);
			} catch {
				throw new LocalChatAttachmentError("validation_error", "Attachment command metadata must be valid JSON.");
			}
			const envelope = validateHostedCommandEnvelope(parsed);
			if (!envelope.ok) throw new HostedCommandDispatchError(envelope.error.code, envelope.error.message);
			id = envelope.value.id;
			const command = validateHostedCommandPayload(envelope.value);
			if (command.operation !== "stagePromptAttachments" || command.payload.sessionId !== sessionId) {
				throw new LocalChatAttachmentError(
					"validation_error",
					"Attachment command must target the session in the request path.",
				);
			}
			const value = await this.#dispatcher.dispatch(command, access, { temporaryFiles: files });
			return Response.json({
				protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
				id,
				ok: true as const,
				atSequence: this.#currentSequence(),
				value,
			});
		} catch (error) {
			if (error instanceof LocalChatHttpError) return jsonError(error.status, error.code, error.message);
			if (error instanceof LocalTokenValidationError) return protectedRouteError(error);
			const failure = attachmentCommandError(error);
			return Response.json(
				{
					protocolVersion: GRADIVUS_CHAT_PROTOCOL_VERSION,
					id,
					ok: false as const,
					atSequence: this.#currentSequence(),
					error: failure,
				},
				{ status: errorStatus(failure.code) },
			);
		} finally {
			await tempDir?.remove().catch(() => undefined);
		}
	}

	async events(request: Request): Promise<Response> {
		try {
			if (request.headers.has("last-event-id")) {
				throw new LocalChatHttpError(400, "validation_error", "Last-Event-ID replay is not supported.");
			}
			const access = await this.#verifyAccess(request);
			if (!this.#eventSequencer) {
				return jsonError(503, "runtime_unavailable", "Hosted event streaming is not available.");
			}
			return this.#eventSequencer.open(access, () => {
				if (
					this.#expansion.isAwaitingAdoption(access.jtiHash) &&
					!this.#expansion.adoptReplacement(access.jtiHash)
				) {
					throw new LocalChatHttpError(409, "conflict", "Replacement token could not be adopted.");
				}
			});
		} catch (error) {
			return protectedRouteError(error);
		}
	}

	close(): void {
		this.#consent.cancelAll();
		this.#eventSequencer?.close();
	}

	async verifyAccess(request: Request): Promise<VerifiedLocalAccess> {
		return this.#verifyAccess(request);
	}

	async #verifyAccess(request: Request): Promise<VerifiedLocalAccess> {
		const origin = request.headers.get("origin") ?? "";
		const client = this.#clients.clientForOrigin(origin);
		if (!client) throw new LocalChatHttpError(401, "unauthorized", "Request origin is not a registered client.");
		return this.#tokens.verify(bearerToken(request), { clientId: client.id, origin });
	}
}

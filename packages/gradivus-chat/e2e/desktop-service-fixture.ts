import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type {
	HostedSessionRecord,
	HostedSessionSnapshot,
} from "../src/lib/contracts";
import {
	GRADIVUS_CHAT_DEV_CLIENT_ID,
	GRADIVUS_CHAT_DEV_ORIGIN,
	GRADIVUS_CHAT_DEV_REDIRECT_URI,
	GRADIVUS_CHAT_EXPANDED_SCOPES,
	GRADIVUS_CHAT_INITIAL_SCOPES,
	GRADIVUS_CHAT_LOCAL_ORIGIN,
	type HostedChatCommand,
	type HostedStreamMessage,
} from "../src/lib/protocol";

interface AuthorizationRequest {
	response: ServerResponse;
	url: URL;
}
interface IssuedCode {
	challenge: string;
	scopes: string;
	redirectUri: string;
}
interface IssuedToken {
	scopes: string;
	revoked: boolean;
}

/** External Desktop protocol fixture. It never launches OMP or reads real Desktop data. */
export class DesktopServiceFixture {
	#server: Server;
	#streams = new Set<ServerResponse>();
	#codes = new Map<string, IssuedCode>();
	#tokens = new Map<string, IssuedToken>();
	#sequence = 0;
	#record: HostedSessionRecord = {
		id: "desktop-session",
		kind: "code",
		workspace: { id: "desktop-workspace", name: "Desktop project" },
		title: "Desktop chat",
		createdAt: "2026-09-28T12:00:00Z",
		lastOpenedAt: "2026-09-28T12:00:00Z",
	};
	authorizations: AuthorizationRequest[] = [];
	commands: string[] = [];
	prompts: string[] = [];
	revocations = 0;
	unavailable = false;
	failBootstrap = false;
	versionMismatch = false;
	tokenLifetimeSeconds = 3600;
	constructor() {
		this.#server = createServer((request, response) => {
			void this.#handle(request, response).catch((error) => {
				response.writeHead(500);
				response.end(String(error));
			});
		});
	}
	async start(): Promise<void> {
		const result = Promise.withResolvers<void>();
		this.#server.once("error", result.reject);
		this.#server.listen(47832, "127.0.0.1", () => result.resolve());
		await result.promise;
	}
	async close(): Promise<void> {
		this.interrupt();
		for (const authorization of this.authorizations.splice(0))
			authorization.response.end();
		this.#server.closeAllConnections();
		const result = Promise.withResolvers<void>();
		this.#server.close((error) =>
			error ? result.reject(error) : result.resolve(),
		);
		await result.promise;
	}
	reset(): void {
		this.interrupt();
		this.authorizations = [];
		this.commands = [];
		this.prompts = [];
		this.revocations = 0;
		this.unavailable = false;
		this.versionMismatch = false;
		this.failBootstrap = false;
		this.tokenLifetimeSeconds = 3600;
		this.#codes.clear();
		this.#tokens.clear();
		this.#sequence = 0;
	}
	interrupt(): void {
		for (const response of this.#streams) response.end();
		this.#streams.clear();
	}
	revoke(): void {
		for (const token of this.#tokens.values()) token.revoked = true;
		this.interrupt();
	}
	resolveApproval(allow: boolean): void {
		const pending = this.authorizations.shift();
		if (!pending) throw new Error("No pending Desktop approval.");
		const target = new URL(pending.url.searchParams.get("redirect_uri") ?? "");
		target.searchParams.set(
			"state",
			pending.url.searchParams.get("state") ?? "",
		);
		if (allow) {
			const code = crypto.randomUUID();
			this.#codes.set(code, {
				challenge: pending.url.searchParams.get("code_challenge") ?? "",
				scopes: pending.url.searchParams.get("scope") ?? "",
				redirectUri: target.origin + target.pathname,
			});
			target.searchParams.set("code", code);
		} else target.searchParams.set("error", "access_denied");
		pending.response.writeHead(302, { Location: target.href });
		pending.response.end();
	}
	#snapshot(): HostedSessionSnapshot {
		return {
			record: this.#record,
			state: "ready",
			timeline: this.prompts.map((text, index) => ({
				id: `response-${index}`,
				kind: "assistant",
				text: `Desktop handled: ${text}`,
				status: "complete",
			})),
			subagents: [],
			agentHub: { agents: [] },
			commands: [],
			todoState: { phases: [], revision: 0 },
			planReviewSupported: true,
			isStreaming: false,
		};
	}
	#bootstrap() {
		return {
			workspaces: [this.#record.workspace],
			sessions: [this.#record],
			activeSessionId: this.#record.id,
		};
	}
	#json(response: ServerResponse, value: unknown, status = 200): void {
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(JSON.stringify(value));
	}
	#event(message: HostedStreamMessage): void {
		for (const response of this.#streams)
			response.write(`data: ${JSON.stringify(message)}\n\n`);
	}
	async #body(request: IncomingMessage): Promise<string> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString("utf8");
	}
	async #handle(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const url = new URL(request.url ?? "/", GRADIVUS_CHAT_LOCAL_ORIGIN);
		response.setHeader("Cache-Control", "no-store");
		if (request.headers.origin === GRADIVUS_CHAT_DEV_ORIGIN) {
			response.setHeader(
				"Access-Control-Allow-Origin",
				GRADIVUS_CHAT_DEV_ORIGIN,
			);
			response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
			response.setHeader(
				"Access-Control-Allow-Headers",
				"Authorization,Content-Type",
			);
			response.setHeader("Access-Control-Allow-Private-Network", "true");
		}
		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		if (this.unavailable) {
			this.#json(response, { error: "unavailable" }, 503);
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server") {
			this.#json(response, {
				issuer: GRADIVUS_CHAT_LOCAL_ORIGIN,
				authorization_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/authorize`,
				token_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/token`,
				revocation_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/revoke`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code"],
				code_challenge_methods_supported: ["S256"],
				scopes_supported: GRADIVUS_CHAT_EXPANDED_SCOPES,
				protocol_versions_supported: [this.versionMismatch ? 99 : 1],
				client_id: "gradivus-chat-web",
				desktop_version: "fixture",
			});
			return;
		}
		if (url.pathname === "/oauth/authorize") {
			if (
				url.searchParams.get("client_id") !== GRADIVUS_CHAT_DEV_CLIENT_ID ||
				url.searchParams.get("redirect_uri") !==
					GRADIVUS_CHAT_DEV_REDIRECT_URI ||
				url.searchParams.get("response_type") !== "code" ||
				url.searchParams.get("code_challenge_method") !== "S256" ||
				!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "") ||
				![
					GRADIVUS_CHAT_INITIAL_SCOPES.join(" "),
					GRADIVUS_CHAT_EXPANDED_SCOPES.join(" "),
				].includes(url.searchParams.get("scope") ?? "")
			) {
				this.#json(response, { error: "invalid_request" }, 400);
				return;
			}
			this.authorizations.push({ response, url });
			return;
		}
		if (request.headers.origin !== GRADIVUS_CHAT_DEV_ORIGIN) {
			this.#json(response, { error: "wrong_origin" }, 403);
			return;
		}
		if (url.pathname === "/oauth/token") {
			const form = new URLSearchParams(await this.#body(request));
			const code = this.#codes.get(form.get("code") ?? "");
			const hash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(form.get("code_verifier") ?? ""),
			);
			if (
				!code ||
				form.get("grant_type") !== "authorization_code" ||
				form.get("client_id") !== GRADIVUS_CHAT_DEV_CLIENT_ID ||
				form.get("redirect_uri") !== code.redirectUri ||
				Buffer.from(hash).toString("base64url") !== code.challenge
			) {
				this.#json(response, { error: "invalid_grant" }, 400);
				return;
			}
			this.#codes.delete(form.get("code") ?? "");
			if (
				code.scopes.includes("desktop.present") &&
				!this.#tokens.has(request.headers.authorization?.slice(7) ?? "")
			) {
				this.#json(response, { error: "invalid_grant" }, 400);
				return;
			}
			const token = crypto.randomUUID();
			this.#tokens.set(token, { scopes: code.scopes, revoked: false });
			this.#json(response, {
				access_token: token,
				token_type: "Bearer",
				expires_in: this.tokenLifetimeSeconds,
				scope: code.scopes,
			});
			return;
		}
		if (url.pathname === "/oauth/revoke") {
			const form = new URLSearchParams(await this.#body(request));
			const token = this.#tokens.get(form.get("token") ?? "");
			if (token) token.revoked = true;
			this.revocations += 1;
			this.interrupt();
			response.writeHead(204);
			response.end();
			return;
		}
		const token = this.#tokens.get(
			request.headers.authorization?.slice(7) ?? "",
		);
		if (!token || token.revoked) {
			this.#json(
				response,
				{
					error: {
						code: "grant_revoked",
						message: "This connection was revoked in Desktop.",
						retryable: false,
					},
				},
				401,
			);
			return;
		}
		if (url.pathname === "/v1/events") {
			response.writeHead(200, {
				"Content-Type": "text/event-stream",
				Connection: "keep-alive",
			});
			response.write(
				`data: ${JSON.stringify({ type: "stream_ready", epoch: "fixture-epoch", currentSequence: this.#sequence })}\n\n`,
			);
			this.#streams.add(response);
			response.on("close", () => this.#streams.delete(response));
			return;
		}
		if (url.pathname === "/v1/command") {
			const command = JSON.parse(
				await this.#body(request),
			) as HostedChatCommand;
			this.commands.push(command.operation);
			if (this.failBootstrap && command.operation === "bootstrap") {
				this.#json(
					response,
					{
						protocolVersion: 1,
						id: command.id,
						ok: false,
						atSequence: this.#sequence,
						error: {
							code: "runtime_unavailable",
							message: "Desktop is restarting.",
							retryable: true,
						},
					},
					503,
				);
				return;
			}
			let value: unknown;
			switch (command.operation) {
				case "bootstrap":
					value = this.#bootstrap();
					break;
				case "openSession":
					value = this.#snapshot();
					break;
				case "getAvailableCommands":
				case "getAvailableModels":
				case "getAgentSettings":
				case "getAgentPrompts":
					value = [];
					break;
				case "getAgentHub":
					value = { agents: [] };
					break;
				case "releasePromptAttachments":
					value = null;
					break;
				case "openDesktopAccounts":
					if (!token.scopes.includes("desktop.present")) {
						this.#json(
							response,
							{
								error: {
									code: "scope_denied",
									message: "Desktop approval required",
									retryable: false,
								},
							},
							403,
						);
						return;
					}
					value = {
						action: {
							actionId: "native-accounts",
							kind: "open_accounts",
							state: "completed",
						},
					};
					break;
				case "prompt":
					this.prompts.push(
						command.payload.composition.parts
							.map((part) => (part.type === "text" ? part.text : ""))
							.join(""),
					);
					value = { requestId: `request-${this.prompts.length}` };
					break;
				default:
					this.#json(
						response,
						{
							error: {
								code: "validation_error",
								message: `Unexpected fixture operation ${command.operation}`,
								retryable: false,
							},
						},
						400,
					);
					return;
			}
			this.#json(response, {
				protocolVersion: 1,
				id: command.id,
				ok: true,
				atSequence: this.#sequence,
				value,
			});
			if (command.operation === "prompt") {
				const item = this.#snapshot().timeline.at(-1);
				if (!item)
					throw new Error("Prompt fixture did not produce a response.");
				this.#event({
					type: "chat_event",
					epoch: "fixture-epoch",
					sequence: ++this.#sequence,
					event: {
						type: "timeline",
						sessionId: this.#record.id,
						item,
					},
				});
				this.#event({
					type: "chat_event",
					epoch: "fixture-epoch",
					sequence: ++this.#sequence,
					event: {
						type: "prompt_result",
						sessionId: this.#record.id,
						requestId: `request-${this.prompts.length}`,
						agentInvoked: true,
					},
				});
			}
			return;
		}
		this.#json(response, { error: "not_found" }, 404);
	}
}

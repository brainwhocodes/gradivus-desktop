import { node } from "@elysia/node";
import { GRADIVUS_CHAT_DEV_ORIGIN, GRADIVUS_CHAT_LOCAL_ORIGIN, GRADIVUS_CHAT_ORIGIN } from "@gradivus/chat/protocol";
import * as logger from "@oh-my-pi/pi-utils/logger";
import Elysia from "elysia";
import type { LocalChatApi } from "./local-chat-api";

export const LOCAL_CHAT_HOST = "127.0.0.1" as const;
export const LOCAL_CHAT_PORT = 47832 as const;

const CORS_VARY =
	"Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network";

interface RouteAuthority {
	methods: readonly string[];
	requestHeaders: readonly string[];
	originRequired: boolean;
}

const ROUTE_AUTHORITIES: Readonly<Record<string, RouteAuthority>> = {
	"/.well-known/oauth-authorization-server": { methods: ["GET"], requestHeaders: [], originRequired: false },
	"/oauth/authorize": { methods: ["GET"], requestHeaders: [], originRequired: false },
	"/oauth/token": { methods: ["POST"], requestHeaders: ["Authorization", "Content-Type"], originRequired: true },
	"/oauth/revoke": { methods: ["POST"], requestHeaders: ["Content-Type"], originRequired: true },
	"/v1/command": { methods: ["POST"], requestHeaders: ["Authorization", "Content-Type"], originRequired: true },
	"/v1/events": { methods: ["GET"], requestHeaders: ["Authorization"], originRequired: true },
};

function routeAuthority(pathname: string): RouteAuthority | undefined {
	if (/^\/v1\/sessions\/[^/]+\/attachments$/.test(pathname)) {
		return { methods: ["POST"], requestHeaders: ["Authorization", "Content-Type"], originRequired: true };
	}
	return ROUTE_AUTHORITIES[pathname];
}

function errorResponse(status: number, message: string, extraHeaders?: HeadersInit): Response {
	return Response.json(
		{ error: { code: "unauthorized", message } },
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				Vary: CORS_VARY,
				...extraHeaders,
			},
		},
	);
}

export type LocalChatServerStatus = "stopped" | "starting" | "listening" | "unavailable" | "stopping";

export interface LocalChatServerState {
	status: LocalChatServerStatus;
	origin: string;
	error?: string;
}

export interface LocalChatServerOptions {
	port?: number;
	onState?: (state: LocalChatServerState) => void;
	isPackaged?: boolean;
	allowDevelopmentClient?: boolean;
	api?: LocalChatApi;
}

interface NodeAdapterServer {
	port: number;
	raw: { serve(): Promise<unknown> };
	stop(): Promise<void> | void;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export class LocalChatServer {
	#app = new Elysia({ adapter: node() });
	#port: number;
	#onState: ((state: LocalChatServerState) => void) | undefined;
	#state: LocalChatServerState;
	#server: NodeAdapterServer | undefined;
	#accepting = false;
	#allowedOrigins: ReadonlySet<string>;
	#api: LocalChatApi | undefined;

	constructor(options: LocalChatServerOptions = {}) {
		this.#port = options.port ?? LOCAL_CHAT_PORT;
		this.#onState = options.onState;
		this.#api = options.api;
		const allowDevelopmentClient = options.allowDevelopmentClient === true || options.isPackaged === false;
		this.#allowedOrigins = new Set([
			GRADIVUS_CHAT_ORIGIN,
			...(allowDevelopmentClient ? [GRADIVUS_CHAT_DEV_ORIGIN] : []),
		]);
		this.#state = { status: "stopped", origin: this.#configuredOrigin() };
		this.#app
			.onRequest(({ request }) => this.#authorizeRequest(request))
			.onAfterHandle(({ request, set }) => {
				set.headers["Cache-Control"] = "no-store";
				set.headers.Vary = CORS_VARY;
				const origin = request.headers.get("origin");
				if (origin && this.#allowedOrigins.has(origin)) {
					set.headers["Access-Control-Allow-Origin"] = origin;
				}
			})
			.onError(({ request, set }) => {
				set.headers["Cache-Control"] = "no-store";
				set.headers.Vary = CORS_VARY;
				const origin = request.headers.get("origin");
				if (origin && this.#allowedOrigins.has(origin)) {
					set.headers["Access-Control-Allow-Origin"] = origin;
				}
			});
		if (this.#api) {
			const api = this.#api;
			this.#app
				.get("/.well-known/oauth-authorization-server", () => api.metadata())
				.get("/oauth/authorize", ({ request }) => api.authorize(request))
				.post("/oauth/token", ({ request }) => api.token(request), { parse: "none" })
				.post("/oauth/revoke", ({ request }) => api.revoke(request), { parse: "none" })
				.post("/v1/command", ({ request }) => api.command(request), { parse: "none" })
				.post("/v1/sessions/:id/attachments", ({ request, params }) => api.attachments(request, params.id), {
					parse: "none",
				})
				.get("/v1/events", ({ request }) => api.events(request));
		}
	}

	get state(): LocalChatServerState {
		return this.#state;
	}

	get port(): number {
		return this.#server?.port ?? this.#port;
	}

	get acceptingRequests(): boolean {
		return this.#accepting;
	}

	async start(): Promise<boolean> {
		if (this.#state.status === "listening") return true;
		if (this.#state.status === "starting") return false;
		this.#setState({ status: "starting", origin: this.#configuredOrigin() });
		this.#accepting = true;
		let server: NodeAdapterServer | undefined;
		try {
			this.#app.listen(
				{
					hostname: LOCAL_CHAT_HOST,
					port: this.#port,
					reusePort: false,
					maxRequestBodySize: 34 * 1024 * 1024,
				},
				value => {
					server = value as unknown as NodeAdapterServer;
				},
			);
			if (!server) throw new Error("Elysia Node server did not expose its listener");
			await server.raw.serve();
			this.#server = server;
			this.#setState({ status: "listening", origin: this.#listeningOrigin() });
			return true;
		} catch (error) {
			this.#accepting = false;
			if (server) await Promise.resolve(server.stop()).catch(() => undefined);
			const message =
				hasErrorCode(error, "EADDRINUSE") && this.#port === LOCAL_CHAT_PORT
					? "Gradivus local chat could not start because 127.0.0.1:47832 is in use."
					: `Gradivus local chat could not start: ${error instanceof Error ? error.message : String(error)}`;
			logger.error("Gradivus local chat server failed to start", { error: message });
			this.#setState({ status: "unavailable", origin: this.#configuredOrigin(), error: message });
			return false;
		}
	}

	async stop(): Promise<void> {
		if (this.#state.status === "stopped") return;
		this.#accepting = false;
		this.#setState({ status: "stopping", origin: this.#listeningOrigin() });
		if (this.#server) await Promise.resolve(this.#server.stop()).catch(() => undefined);
		this.#server = undefined;
		this.#api?.close();
		this.#setState({ status: "stopped", origin: this.#configuredOrigin() });
	}

	handle(request: Request): Promise<Response> {
		return this.#app.handle(request);
	}

	#authorizeRequest(request: Request): Response | undefined {
		if (!this.#accepting) return errorResponse(503, "Gradivus local chat is not accepting requests.");
		const expectedHost = `${LOCAL_CHAT_HOST}:${this.#port}`;
		if (request.headers.get("host") !== expectedHost) {
			return errorResponse(403, "Local chat requests require the fixed loopback Host.");
		}
		const url = new URL(request.url);
		const authority = routeAuthority(url.pathname);
		const origin = request.headers.get("origin");
		if (origin !== null && !this.#allowedOrigins.has(origin)) {
			return errorResponse(403, "Request origin is not authorized.");
		}

		if (request.method === "OPTIONS") {
			if (!authority) return errorResponse(404, "Local chat route was not found.");
			if (!origin) return errorResponse(403, "CORS preflight requires an authorized Origin.");
			const requestedMethod = request.headers.get("access-control-request-method");
			if (!requestedMethod || !authority.methods.includes(requestedMethod.toUpperCase())) {
				return errorResponse(405, "CORS preflight method is not allowed.", { Allow: authority.methods.join(", ") });
			}
			const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
				.split(",")
				.map(header => header.trim().toLowerCase())
				.filter(Boolean);
			const allowedHeaders = new Set(authority.requestHeaders.map(header => header.toLowerCase()));
			if (requestedHeaders.some(header => !allowedHeaders.has(header))) {
				return errorResponse(403, "CORS preflight headers are not allowed.");
			}
			const headers = new Headers({
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Methods": requestedMethod.toUpperCase(),
				"Cache-Control": "no-store",
				Vary: CORS_VARY,
			});
			if (authority.requestHeaders.length > 0) {
				headers.set("Access-Control-Allow-Headers", authority.requestHeaders.join(", "));
			}
			if (request.headers.get("access-control-request-private-network") === "true") {
				headers.set("Access-Control-Allow-Private-Network", "true");
			}
			return new Response(null, { status: 204, headers });
		}

		if (!authority) return undefined;
		if (!authority.methods.includes(request.method)) {
			return errorResponse(405, "HTTP method is not allowed.", { Allow: authority.methods.join(", ") });
		}
		if (authority.originRequired && !origin) {
			return errorResponse(403, "Request origin is required.");
		}
		return undefined;
	}

	#configuredOrigin(): string {
		return this.#port === LOCAL_CHAT_PORT ? GRADIVUS_CHAT_LOCAL_ORIGIN : `http://${LOCAL_CHAT_HOST}:${this.#port}`;
	}

	#listeningOrigin(): string {
		return `http://${LOCAL_CHAT_HOST}:${this.port}`;
	}

	#setState(state: LocalChatServerState): void {
		this.#state = state;
		this.#onState?.(state);
	}
}

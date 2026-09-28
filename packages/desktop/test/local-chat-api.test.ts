import * as net from "node:net";
import {
	GRADIVUS_CHAT_INITIAL_SCOPES,
	GRADIVUS_CHAT_ORIGIN,
	GRADIVUS_CHAT_REDIRECT_URI,
} from "@gradivus/chat/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopHost } from "../src/main/desktop-host";
import { HostedCommandDispatcher, type HostedNativeCommandActions } from "../src/main/hosted-command-dispatcher";
import { HostedEventSequencer } from "../src/main/hosted-event-sequencer";
import { HostedGrantCapabilityStore } from "../src/main/hosted-grant-capabilities";
import { HostedProjection } from "../src/main/hosted-projection";
import { LocalChatApi } from "../src/main/local-chat-api";
import { LocalChatConsentController } from "../src/main/local-chat-consent";
import { LocalScopeExpansionCoordinator } from "../src/main/local-chat-expansion";
import {
	FixedHostedClientRepository,
	FixedHostedScopeRepository,
	InMemoryAuthorizationCodeRepository,
} from "../src/main/local-chat-oauth";
import { LOCAL_CHAT_HOST, LocalChatServer } from "../src/main/local-chat-server";
import { LocalGrantRepository, LocalTokenService } from "../src/main/local-chat-tokens";
import { PromptAttachmentStore } from "../src/main/prompt-attachments";
import type { SessionRecordV1 } from "../src/shared/contracts";

const attachmentStores: PromptAttachmentStore[] = [];
const servers: LocalChatServer[] = [];

async function availablePort(): Promise<number> {
	const listener = net.createServer();
	const listening = Promise.withResolvers<void>();
	listener.once("error", listening.reject);
	listener.listen(0, LOCAL_CHAT_HOST, listening.resolve);
	await listening.promise;
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("Could not reserve a loopback test port");
	const closed = Promise.withResolvers<void>();
	listener.close(() => closed.resolve());
	await closed.promise;
	return address.port;
}

async function createApi(withSession = false): Promise<LocalChatApi> {
	const clients = new FixedHostedClientRepository(false);
	const scopes = new FixedHostedScopeRepository();
	const codes = new InMemoryAuthorizationCodeRepository();
	const grants = new LocalGrantRepository();
	const tokens = new LocalTokenService(grants);
	const consent = new LocalChatConsentController(grants, {
		present: async request => ({ requestId: request.requestId, decision: "allow" }),
	});
	const expansion = new LocalScopeExpansionCoordinator(consent, tokens);
	const projection = await HostedProjection.create();
	const capabilities = new HostedGrantCapabilityStore();
	const attachmentStore = new PromptAttachmentStore();
	if (withSession) attachmentStores.push(attachmentStore);
	const record: SessionRecordV1 = {
		id: "session-1",
		kind: "code",
		surface: "chat",
		cwd: process.cwd(),
		ompSessionId: "internal-session",
		sessionFile: `${process.cwd()}/.omp/internal.jsonl`,
		title: "Hosted session",
		createdAt: "2026-08-30T00:00:00.000Z",
		lastOpenedAt: "2026-08-30T00:00:01.000Z",
	};
	const host = {
		bootstrap: () => ({
			registry: {
				version: 1 as const,
				sessions: withSession ? [record] : [],
				activeByKind: { work: null, code: withSession ? record.id : null },
			},
		}),
		resolveHostedChatSessionAuthority: () => ({ record, state: "ready" as const }),
		stagePromptTemporaryFiles: (id: string, files: unknown) => {
			if (id !== record.id) throw new Error("wrong session");
			return attachmentStore.stageTemporaryFiles(files);
		},
		subscribeChatEvents: () => () => {},
	} as unknown as DesktopHost;
	const native: HostedNativeCommandActions = {
		chooseWorkspaceAndCreate: async () => ({
			action: { actionId: "choose", kind: "choose_workspace", state: "cancelled" },
		}),
		exportHtml: async () => ({
			action: { actionId: "export", kind: "save_export", state: "cancelled" },
			cancelled: true,
		}),
		openWorkspaceFile: async () => ({ actionId: "open", kind: "open_file", state: "cancelled" }),
		reconnectRuntime: async () => ({
			action: { actionId: "reconnect", kind: "open_accounts", state: "completed" },
		}),
		openDesktopAccounts: async () => ({ actionId: "accounts", kind: "open_accounts", state: "completed" }),
	};
	const eventSequencer = withSession ? new HostedEventSequencer({ host, projection, capabilities }) : undefined;
	return new LocalChatApi({
		clients,
		scopes,
		codes,
		consent,
		expansion,
		tokens,
		dispatcher: new HostedCommandDispatcher({ host, projection, capabilities, native }),
		eventSequencer,
		desktopVersion: "0.1.0-test",
	});
}

async function authorizeAndExchange(base: string): Promise<string> {
	const verifier = "v".repeat(43);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = Buffer.from(digest).toString("base64url");
	const authorize = new URL(`${base}/oauth/authorize`);
	authorize.searchParams.set("client_id", "gradivus-chat-web");
	authorize.searchParams.set("redirect_uri", GRADIVUS_CHAT_REDIRECT_URI);
	authorize.searchParams.set("response_type", "code");
	authorize.searchParams.set("state", "s".repeat(43));
	authorize.searchParams.set("scope", GRADIVUS_CHAT_INITIAL_SCOPES.join(" "));
	authorize.searchParams.set("code_challenge", challenge);
	authorize.searchParams.set("code_challenge_method", "S256");
	const authorization = await fetch(authorize, { redirect: "manual" });
	expect(authorization.status).toBe(302);
	const callback = new URL(authorization.headers.get("location") ?? "");
	expect(callback.origin).toBe(GRADIVUS_CHAT_ORIGIN);
	expect(callback.searchParams.get("state")).toBe("s".repeat(43));
	const code = callback.searchParams.get("code");
	if (!code) throw new Error("Authorization code was not returned");

	const token = await fetch(`${base}/oauth/token`, {
		method: "POST",
		headers: { Origin: GRADIVUS_CHAT_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: GRADIVUS_CHAT_REDIRECT_URI,
			client_id: "gradivus-chat-web",
			code_verifier: verifier,
		}),
	});
	expect(token.status).toBe(200);
	const payload = (await token.json()) as { access_token: string; scope: string };
	expect(payload.scope).toBe(GRADIVUS_CHAT_INITIAL_SCOPES.join(" "));
	return payload.access_token;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop()));
	await Promise.all(attachmentStores.splice(0).map(store => store.close()));
});

describe("LocalChatApi route surface", () => {
	it("exposes metadata, PKCE authorization/token exchange, and authenticated protocol commands only", async () => {
		const server = new LocalChatServer({ port: await availablePort(), isPackaged: true, api: await createApi() });
		servers.push(server);
		await expect(server.start()).resolves.toBe(true);
		const base = `http://${LOCAL_CHAT_HOST}:${server.port}`;

		const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
		expect(metadata.status).toBe(200);
		expect(await metadata.json()).toMatchObject({
			issuer: "http://127.0.0.1:47832",
			client_id: "gradivus-chat-web",
			desktop_version: "0.1.0-test",
			protocol_versions_supported: [1],
			code_challenge_methods_supported: ["S256"],
		});

		const accessToken = await authorizeAndExchange(base);
		const command = await fetch(`${base}/v1/command`, {
			method: "POST",
			headers: {
				Origin: GRADIVUS_CHAT_ORIGIN,
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ protocolVersion: 1, id: "bootstrap-1", operation: "bootstrap", payload: {} }),
		});
		expect(command.status).toBe(200);
		expect(await command.json()).toMatchObject({
			protocolVersion: 1,
			id: "bootstrap-1",
			ok: true,
			atSequence: 0,
			value: { sessions: [], activeSessionId: null, workspaces: [] },
		});

		for (const pathname of ["/gradivus:open-terminal", "/v1/browser", "/v1/settings", "/graphql"]) {
			expect((await fetch(`${base}${pathname}`)).status).toBe(404);
		}
	});

	it("streams multipart files into session-owned temporary attachment storage", async () => {
		const server = new LocalChatServer({ port: await availablePort(), isPackaged: true, api: await createApi(true) });
		servers.push(server);
		await server.start();
		const base = `http://${LOCAL_CHAT_HOST}:${server.port}`;
		const accessToken = await authorizeAndExchange(base);
		const headers = { Origin: GRADIVUS_CHAT_ORIGIN, Authorization: `Bearer ${accessToken}` };
		await fetch(`${base}/v1/command`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ protocolVersion: 1, id: "bootstrap-attachments", operation: "bootstrap", payload: {} }),
		});

		const replay = await fetch(`${base}/v1/events`, {
			headers: { ...headers, "Last-Event-ID": "1" },
		});
		expect(replay.status).toBe(400);
		const events = await fetch(`${base}/v1/events`, { headers });
		expect(events.status).toBe(200);
		expect(events.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		const eventReader = events.body!.getReader();
		const ready = await eventReader.read();
		expect(new TextDecoder().decode(ready.value)).toContain('"type":"stream_ready"');
		await eventReader.cancel();

		const file = new File(["streamed attachment"], "notes.txt", { type: "text/plain" });
		const form = new FormData();
		form.append(
			"command",
			JSON.stringify({
				protocolVersion: 1,
				id: "attachment-1",
				operation: "stagePromptAttachments",
				payload: {
					sessionId: "session-1",
					metadata: [{ name: file.name, mimeType: file.type, size: file.size }],
				},
			}),
		);
		form.append("files", file);
		const response = await fetch(`${base}/v1/sessions/session-1/attachments`, {
			method: "POST",
			headers,
			body: form,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			protocolVersion: 1,
			id: "attachment-1",
			ok: true,
			value: [{ name: "notes.txt", kind: "file", size: 19 }],
		});

		const duplicate = new FormData();
		duplicate.append(
			"command",
			JSON.stringify({
				protocolVersion: 1,
				id: "attachment-duplicate",
				operation: "stagePromptAttachments",
				payload: {
					sessionId: "session-1",
					metadata: [
						{ name: "same.txt", mimeType: "text/plain", size: 1 },
						{ name: "same.txt", mimeType: "text/plain", size: 1 },
					],
				},
			}),
		);
		duplicate.append("files", new File(["a"], "same.txt", { type: "text/plain" }));
		duplicate.append("files", new File(["b"], "same.txt", { type: "text/plain" }));
		const rejected = await fetch(`${base}/v1/sessions/session-1/attachments`, {
			method: "POST",
			headers,
			body: duplicate,
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "validation_error" } });
	});

	it("rejects unknown OAuth inputs and oversized form bodies before exchange", async () => {
		const server = new LocalChatServer({ port: await availablePort(), isPackaged: true, api: await createApi() });
		servers.push(server);
		await server.start();
		const base = `http://${LOCAL_CHAT_HOST}:${server.port}`;
		const malformed = await fetch(
			`${base}/oauth/authorize?client_id=unknown&redirect_uri=${encodeURIComponent(GRADIVUS_CHAT_REDIRECT_URI)}`,
		);
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: "invalid_client" });

		const oversized = await fetch(`${base}/oauth/token`, {
			method: "POST",
			headers: { Origin: GRADIVUS_CHAT_ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
			body: `grant_type=authorization_code&padding=${"x".repeat(9 * 1024)}`,
		});
		expect(oversized.status).toBe(413);
	});
});

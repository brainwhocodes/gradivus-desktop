import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDesktopEvents } from "../src/connection/desktop-events";
import {
	createProofKey,
	oauthClient,
	validateOAuthMessage,
} from "../src/connection/desktop-oauth";
import {
	BrowserChatTransport,
	createBrowserChatApi,
	type DesktopTransportStatus,
} from "../src/lib/browser-chat-api";
import type {
	HostedChatEvent,
	HostedSessionSnapshot,
} from "../src/lib/contracts";
import {
	GRADIVUS_CHAT_INITIAL_SCOPES,
	type HostedStreamMessage,
} from "../src/lib/protocol";

const encoder = new TextEncoder();
const record = {
	id: "one",
	kind: "code" as const,
	workspace: { id: "workspace", name: "project" },
	title: "Desktop chat",
	createdAt: "2026-09-28",
	lastOpenedAt: "2026-09-28",
};
const snapshot: HostedSessionSnapshot = {
	record,
	state: "ready",
	timeline: [],
	subagents: [],
	todoState: { phases: [], revision: 0 },
	planReviewSupported: true,
};

describe("Desktop authorization boundaries", () => {
	it("binds callback to the exact origin, popup, and one-use state; refuses ambiguous results", async () => {
		const proof = await createProofKey();
		expect(proof.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(proof.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(proof.verifier),
		);
		expect(proof.challenge).toBe(Buffer.from(digest).toString("base64url"));
		const popup = {} as Window;
		const origin = "https://gradivus.brainwhocodes.rocks";
		const data = {
			type: "gradivus:oauth-callback",
			state: proof.state,
			code: "single-use-code",
		};
		expect(
			validateOAuthMessage(
				{ origin, source: popup, data },
				origin,
				popup,
				proof.state,
			)?.code,
		).toBe("single-use-code");
		for (const event of [
			{ origin: "https://other.example", source: popup, data },
			{ origin, source: {} as Window, data },
			{ origin, source: popup, data: { ...data, state: "wrong" } },
			{ origin, source: popup, data: { ...data, error: "access_denied" } },
		])
			expect(
				validateOAuthMessage(event, origin, popup, proof.state),
			).toBeUndefined();
		expect(oauthClient("http://127.0.0.1:5190").clientId).toBe(
			"gradivus-chat-web-dev",
		);
		expect(() =>
			oauthClient("https://gradivus.brainwhocodes.rocks.attacker.example"),
		).toThrow("not registered");
	});

	it("decodes split UTF-8 and CRLF data frames while rejecting truncated or unknown events", async () => {
		const message: HostedStreamMessage = {
			type: "chat_event",
			epoch: "epoch",
			sequence: 3,
			event: { type: "warning", sessionId: "one", message: "Café" },
		};
		const bytes = encoder.encode(
			`: heartbeat\r\ndata: ${JSON.stringify(message)}\r\n\r\n`,
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				controller.close();
			},
		});
		const received: HostedStreamMessage[] = [];
		for await (const event of readDesktopEvents(stream)) received.push(event);
		expect(received).toEqual([message]);
		for (const wire of [
			'data: {"type":"other","epoch":"epoch","currentSequence":1}\n\n',
			'data: {"type":"stream_ready"',
		]) {
			const broken = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(wire));
					controller.close();
				},
			});
			await expect(async () => {
				for await (const _message of readDesktopEvents(broken)) {
					/* consume until invalid frame */
				}
			}).rejects.toThrow();
		}
	});
});

describe("browser to Desktop transport", () => {
	const transports: BrowserChatTransport[] = [];
	beforeEach(() => {
		vi.stubGlobal("window", globalThis);
	});
	afterEach(async () => {
		for (const transport of transports.splice(0)) await transport.destroy();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("uploads actual file bytes with Desktop metadata and never invokes native actions without approval", async () => {
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const request = input as Request;
			calls.push(new URL(request.url).pathname);
			if (request.url.endsWith("/v1/events"))
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									'data: {"type":"stream_ready","epoch":"one","currentSequence":0}\n\n',
								),
							);
							request.signal.addEventListener(
								"abort",
								() => controller.close(),
								{ once: true },
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			expect(request.url).toBe(
				"http://127.0.0.1:47832/v1/sessions/one/attachments",
			);
			expect(request.headers.get("Authorization")).toBe("Bearer fixture-token");
			const form = await request.formData();
			const file = form.get("files");
			if (!(file instanceof File))
				throw new Error("Expected an actual multipart file.");
			expect(await file.text()).toBe("Review these lines");
			const command = JSON.parse(String(form.get("command"))) as {
				id: string;
				operation: string;
				payload: unknown;
			};
			expect(command.operation).toBe("stagePromptAttachments");
			expect(command.payload).toEqual({
				sessionId: "one",
				metadata: [{ name: "notes.txt", mimeType: "text/plain", size: 18 }],
			});
			return Response.json({
				protocolVersion: 1,
				id: command.id,
				ok: true,
				atSequence: 0,
				value: [{ id: "staged-one", name: "notes.txt", kind: "file" }],
			});
		});
		const permission = vi.fn(async () => {
			throw new Error("Desktop permission denied");
		});
		const transport = new BrowserChatTransport(
			{
				accessToken: "fixture-token",
				expiresAt: Date.now() + 60_000,
				scopes: GRADIVUS_CHAT_INITIAL_SCOPES,
			},
			{ onStatus: () => undefined, requestDesktopPermission: permission },
		);
		transports.push(transport);
		await transport.connect();
		const api = createBrowserChatApi(transport);
		const attachments = await api.stagePromptAttachments("one", [
			new File(["Review these lines"], "notes.txt", { type: "text/plain" }),
		]);
		expect(attachments[0]?.id).toBe("staged-one");
		await expect(api.openDesktopAccounts()).rejects.toThrow(
			"permission denied",
		);
		expect(permission).toHaveBeenCalledOnce();
		expect(calls).toEqual(["/v1/events", "/v1/sessions/one/attachments"]);
	});

	it("replaces the old expiry deadline and pauses a silent stream after missed Desktop heartbeats", async () => {
		vi.useFakeTimers();
		const statuses: DesktopTransportStatus[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const request = input as Request;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								'data: {"type":"stream_ready","epoch":"one","currentSequence":0}\n\n',
							),
						);
						request.signal.addEventListener("abort", () => controller.close(), {
							once: true,
						});
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		});
		const transport = new BrowserChatTransport(
			{
				accessToken: "old",
				expiresAt: Date.now() + 10_000,
				scopes: GRADIVUS_CHAT_INITIAL_SCOPES,
			},
			{
				onStatus: (status) => statuses.push(status),
				requestDesktopPermission: async () => undefined,
			},
		);
		transports.push(transport);
		await transport.connect();
		await transport.connect({
			accessToken: "replacement",
			expiresAt: Date.now() + 60_000,
			scopes: GRADIVUS_CHAT_INITIAL_SCOPES,
		});
		await vi.advanceTimersByTimeAsync(11_000);
		expect(statuses.at(-1)).toBe("connected");
		await vi.advanceTimersByTimeAsync(34_000);
		expect(statuses.at(-1)).toBe("interrupted");
		await expect(
			transport.request("prompt", {
				sessionId: "one",
				composition: {
					parts: [{ type: "text", text: "No automatic resubmission" }],
				},
			}),
		).rejects.toThrow("Reconnect");
	});

	it("buffers events against authoritative snapshots and resyncs on a new stream without replaying stale events", async () => {
		let stream: ReadableStreamDefaultController<Uint8Array>;
		let sequence = 0;
		let failBootstrap = false;
		let failAuthorization = false;
		const statuses: DesktopTransportStatus[] = [];
		const commands: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const request = input as Request;
			expect(new URL(request.url).origin).toBe("http://127.0.0.1:47832");
			expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
			if (request.url.endsWith("/v1/events")) {
				if (failAuthorization)
					return Response.json(
						{
							error: {
								code: "grant_revoked",
								message: "Revoked in Desktop",
								retryable: false,
							},
						},
						{ status: 401 },
					);
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({ type: "stream_ready", epoch: "epoch", currentSequence: sequence })}\n\n`,
								),
							);
							request.signal.addEventListener(
								"abort",
								() => {
									try {
										controller.close();
									} catch {
										/* stream already closed */
									}
								},
								{ once: true },
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			const command = (await request.json()) as {
				id: string;
				operation: string;
				payload: { sessionId?: string };
			};
			commands.push(command.operation);
			if (failBootstrap && command.operation === "bootstrap")
				return Response.json({
					protocolVersion: 1,
					id: command.id,
					ok: false,
					atSequence: sequence,
					error: {
						code: "runtime_unavailable",
						message: "Desktop is restarting",
						retryable: true,
					},
				});
			const value =
				command.operation === "bootstrap"
					? {
							workspaces: [record.workspace],
							sessions: [record],
							activeSessionId: record.id,
						}
					: snapshot;
			return Response.json({
				protocolVersion: 1,
				id: command.id,
				ok: true,
				atSequence: sequence,
				value,
			});
		});
		const transport = new BrowserChatTransport(
			{
				accessToken: "fixture-token",
				expiresAt: Date.now() + 60_000,
				scopes: GRADIVUS_CHAT_INITIAL_SCOPES,
			},
			{
				onStatus: (status) => statuses.push(status),
				requestDesktopPermission: async () => {
					throw new Error("Permission was not requested by this journey");
				},
			},
		);
		transports.push(transport);
		const api = createBrowserChatApi(transport);
		const received: HostedChatEvent[] = [];
		api.onEvent((event) => received.push(event));
		const emit = (text: string): void => {
			sequence += 1;
			stream.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({ type: "chat_event", epoch: "epoch", sequence, event: { type: "timeline", sessionId: "one", item: { id: text, kind: "assistant", text, status: "complete" } } })}\n\n`,
				),
			);
		};
		await transport.connect();
		emit("stale");
		await api.bootstrap();
		await api.openSession("one");
		emit("fresh");
		await vi.waitFor(() => expect(received).toHaveLength(1));
		expect(received[0]).toMatchObject({
			type: "timeline",
			item: { text: "fresh" },
		});
		const resync = vi.fn();
		api.onReconnect?.(resync);
		await transport.connect();
		expect(resync).toHaveBeenCalledWith({
			workspaces: [record.workspace],
			sessions: [record],
			activeSessionId: "one",
		});
		expect(received[1]).toMatchObject({
			type: "session_reset",
			sessionId: "one",
		});
		failBootstrap = true;
		await expect(transport.connect()).rejects.toThrow("Desktop is restarting");
		expect(statuses.at(-1)).toBe("interrupted");
		await expect(
			api.prompt("one", {
				parts: [{ type: "text", text: "Do not retry mutations" }],
			}),
		).rejects.toThrow("Reconnect");
		expect(commands).not.toContain("prompt");
		failAuthorization = true;
		await expect(transport.connect()).rejects.toThrow("Revoked in Desktop");
		expect(statuses.at(-1)).toBe("revoked");
		expect(transport.authorization.accessToken).toBe("");
	});
});

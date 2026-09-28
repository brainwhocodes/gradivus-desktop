import type { HostedStreamMessage } from "@gradivus/chat/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopChatEventListener, DesktopHost } from "../src/main/desktop-host";
import { HostedEventSequencer } from "../src/main/hosted-event-sequencer";
import { HostedGrantCapabilityStore } from "../src/main/hosted-grant-capabilities";
import { HostedProjection } from "../src/main/hosted-projection";
import { LOCAL_CHAT_OWNER } from "../src/main/local-chat-oauth";
import type { VerifiedLocalAccess } from "../src/main/local-chat-tokens";
import type { GradivusEvent, SessionRecordV1 } from "../src/shared/contracts";

const sequencers: HostedEventSequencer[] = [];

function record(): SessionRecordV1 {
	return {
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
}

function access(): VerifiedLocalAccess {
	const now = Math.floor(Date.now() / 1_000);
	return {
		claims: {
			iss: "http://127.0.0.1:47832",
			aud: "gradivus-chat-api",
			sub: LOCAL_CHAT_OWNER.id,
			cid: "gradivus-chat-web",
			scope: "chat.read agent.execute sessions.manage files.read",
			jti: "token-1",
			iat: now,
			nbf: now,
			exp: now + 3_600,
		},
		grant: {
			id: "grant-1",
			clientId: "gradivus-chat-web",
			origin: "https://gradivus.brainwhocodes.rocks",
			scopes: ["chat.read", "agent.execute", "sessions.manage", "files.read"],
			status: "active",
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
			expiresAt: Date.now() + 3_600_000,
		},
		jtiHash: "token-hash",
	};
}

async function harness() {
	const session = record();
	let listener: DesktopChatEventListener | undefined;
	const host = {
		subscribeChatEvents: (value: DesktopChatEventListener) => {
			listener = value;
			return () => {
				listener = undefined;
			};
		},
		resolveHostedChatSessionAuthority: () => ({ record: session, state: "ready" as const }),
	} as unknown as DesktopHost;
	const projection = await HostedProjection.create();
	const capabilities = new HostedGrantCapabilityStore();
	capabilities.allowSession("grant-1", await projection.projectHostedSessionRecord(session));
	const sequencer = new HostedEventSequencer({ host, projection, capabilities });
	sequencers.push(sequencer);
	return {
		sequencer,
		emit: (events: readonly GradivusEvent[]) => {
			if (!listener) throw new Error("event listener is unavailable");
			listener(events);
		},
	};
}

async function nextMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<HostedStreamMessage> {
	const result = await reader.read();
	if (result.done) throw new Error("SSE stream ended before a message arrived");
	const text = new TextDecoder().decode(result.value);
	if (!text.startsWith("data: ") || !text.endsWith("\n\n")) throw new Error("SSE message framing is invalid");
	return JSON.parse(text.slice(6, -2)) as HostedStreamMessage;
}

afterEach(() => {
	for (const sequencer of sequencers.splice(0)) sequencer.close();
});

describe("HostedEventSequencer", () => {
	it("subscribes before hydration, projects visible events, and assigns one monotonic sequence", async () => {
		const { sequencer, emit } = await harness();
		const response = sequencer.open(access());
		expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
		const reader = response.body!.getReader();
		const ready = await nextMessage(reader);
		expect(ready).toMatchObject({ type: "stream_ready", currentSequence: 0 });

		emit([
			{ sessionId: "session-1", type: "browser_inventory", browserInventory: [] },
			{ sessionId: "session-1", type: "warning", message: `Failure under ${process.cwd()}/secret.txt` },
		]);
		const event = await nextMessage(reader);
		expect(event).toMatchObject({
			type: "chat_event",
			sequence: 1,
			event: { type: "warning", sessionId: "session-1" },
		});
		if (event.type !== "chat_event" || event.event.type !== "warning")
			throw new Error("warning event was not projected");
		expect(event.event.message).not.toContain(process.cwd());
		expect(sequencer.currentSequence).toBe(1);
		await reader.cancel();
	});

	it("lets the newest grant stream supersede the old stream", async () => {
		const { sequencer } = await harness();
		const first = sequencer.open(access()).body!.getReader();
		await nextMessage(first);
		const second = sequencer.open(access()).body!.getReader();
		await expect(first.read()).resolves.toMatchObject({ done: true });
		await expect(nextMessage(second)).resolves.toMatchObject({ type: "stream_ready", currentSequence: 0 });
		sequencer.closeGrant("grant-1");
		await expect(second.read()).resolves.toMatchObject({ done: true });
	});

	it("reserves reset_required when a stalled stream exceeds 512 pending events", async () => {
		const { sequencer } = await harness();
		const reader = sequencer.open(access()).body!.getReader();
		for (let index = 0; index < 513; index += 1) {
			sequencer.publishDesktopAction("grant-1", {
				type: "desktop_action",
				action: { actionId: `action-${index}`, kind: "open_file", state: "completed" },
			});
		}
		expect(await nextMessage(reader)).toMatchObject({ type: "stream_ready", currentSequence: 0 });
		expect(await nextMessage(reader)).toMatchObject({ type: "reset_required", currentSequence: 513 });
		await expect(reader.read()).resolves.toMatchObject({ done: true });
	});
});

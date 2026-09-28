import type { HostedChatEvent } from "@gradivus/chat/contracts";
import type { HostedStreamMessage } from "@gradivus/chat/protocol";
import type { GradivusEvent, SessionRecordV1 } from "../shared/contracts";
import type { DesktopHost } from "./desktop-host";
import type { HostedGrantCapabilityStore } from "./hosted-grant-capabilities";
import type { HostedProjection } from "./hosted-projection";
import type { VerifiedLocalAccess } from "./local-chat-tokens";

const MAX_PENDING_EVENTS = 512;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 15_000;

interface QueuedMessage {
	bytes: Uint8Array;
	counted: boolean;
}

function encodeMessage(message: HostedStreamMessage): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`);
}

class HostedEventConnection {
	readonly grantId: string;
	readonly stream: ReadableStream<Uint8Array>;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	#queue: QueuedMessage[] = [];
	#pendingEvents = 0;
	#pendingBytes = 0;
	#closed = false;
	#heartbeat: NodeJS.Timeout;
	#expiry: NodeJS.Timeout;
	#currentSequence: () => number;
	#epoch: string;
	#onClose: () => void;

	constructor(options: {
		grantId: string;
		epoch: string;
		currentSequence: () => number;
		expiresAt: number;
		onClose: () => void;
	}) {
		this.grantId = options.grantId;
		this.#epoch = options.epoch;
		this.#currentSequence = options.currentSequence;
		this.#onClose = options.onClose;
		this.stream = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
			pull: () => this.#flush(),
			cancel: () => this.close(),
		});
		this.#heartbeat = setInterval(() => {
			this.enqueue({ type: "heartbeat", epoch: this.#epoch, currentSequence: this.#currentSequence() }, false);
		}, HEARTBEAT_INTERVAL_MS);
		const expiryDelay = Math.max(0, options.expiresAt - Date.now());
		this.#expiry = setTimeout(() => this.close(), expiryDelay);
	}

	enqueue(message: HostedStreamMessage, counted: boolean): void {
		if (this.#closed) return;
		const bytes = encodeMessage(message);
		if (
			counted &&
			(this.#pendingEvents + 1 > MAX_PENDING_EVENTS || this.#pendingBytes + bytes.byteLength > MAX_PENDING_BYTES)
		) {
			this.#resetAndClose();
			return;
		}
		this.#queue.push({ bytes, counted });
		if (counted) {
			this.#pendingEvents += 1;
			this.#pendingBytes += bytes.byteLength;
		}
		this.#flush();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#heartbeat);
		clearTimeout(this.#expiry);
		this.#queue = [];
		this.#pendingEvents = 0;
		this.#pendingBytes = 0;
		try {
			this.#controller?.close();
		} catch {}
		this.#onClose();
	}

	#flush(): void {
		if (this.#closed || !this.#controller) return;
		while (this.#queue.length > 0 && (this.#controller.desiredSize ?? 0) > 0) {
			const item = this.#queue.shift();
			if (!item) break;
			if (item.counted) {
				this.#pendingEvents -= 1;
				this.#pendingBytes -= item.bytes.byteLength;
			}
			this.#controller.enqueue(item.bytes);
		}
	}

	#resetAndClose(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#heartbeat);
		clearTimeout(this.#expiry);
		this.#queue = [];
		this.#pendingEvents = 0;
		this.#pendingBytes = 0;
		try {
			this.#controller?.enqueue(
				encodeMessage({ type: "reset_required", epoch: this.#epoch, currentSequence: this.#currentSequence() }),
			);
			this.#controller?.close();
		} catch {}
		this.#onClose();
	}
}

interface CapturedEvent {
	record: SessionRecordV1;
	event: GradivusEvent;
}

export class HostedEventSequencer {
	readonly #epoch = crypto.randomUUID();
	readonly #host: DesktopHost;
	readonly #projection: HostedProjection;
	readonly #capabilities: HostedGrantCapabilityStore;
	readonly #connections = new Map<string, HostedEventConnection>();
	#sequence = 0;
	#projectionTail = Promise.resolve();
	#unsubscribe: () => void = () => {};
	#closed = false;

	constructor(options: { host: DesktopHost; projection: HostedProjection; capabilities: HostedGrantCapabilityStore }) {
		this.#host = options.host;
		this.#projection = options.projection;
		this.#capabilities = options.capabilities;
		this.#unsubscribe = this.#host.subscribeChatEvents(events => this.#capture(events));
	}

	get currentSequence(): number {
		return this.#sequence;
	}

	open(access: VerifiedLocalAccess, onReady?: () => void): Response {
		if (this.#closed) throw new Error("Hosted event sequencer is closed");
		const connection = new HostedEventConnection({
			grantId: access.grant.id,
			epoch: this.#epoch,
			currentSequence: () => this.#sequence,
			expiresAt: Math.min(access.grant.expiresAt, access.claims.exp * 1_000),
			onClose: () => {
				if (this.#connections.get(access.grant.id) === connection) {
					this.#connections.delete(access.grant.id);
				}
			},
		});
		connection.enqueue({ type: "stream_ready", epoch: this.#epoch, currentSequence: this.#sequence }, false);
		try {
			onReady?.();
		} catch (error) {
			connection.close();
			throw error;
		}
		const previous = this.#connections.get(access.grant.id);
		this.#connections.set(access.grant.id, connection);
		previous?.close();
		return new Response(connection.stream, {
			headers: {
				"Cache-Control": "no-store",
				Connection: "keep-alive",
				"Content-Type": "text/event-stream; charset=utf-8",
				"X-Accel-Buffering": "no",
			},
		});
	}

	publishDesktopAction(grantId: string, event: HostedChatEvent): void {
		const connection = this.#connections.get(grantId);
		if (!connection) return;
		const sequence = ++this.#sequence;
		connection.enqueue({ type: "chat_event", epoch: this.#epoch, sequence, event }, true);
	}

	closeGrant(grantId: string): void {
		this.#connections.get(grantId)?.close();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		for (const connection of this.#connections.values()) connection.close();
		this.#connections.clear();
	}

	#capture(events: readonly GradivusEvent[]): void {
		if (this.#closed) return;
		const captured: CapturedEvent[] = [];
		for (const event of events) {
			try {
				captured.push({ record: this.#host.resolveHostedChatSessionAuthority(event.sessionId).record, event });
			} catch {}
		}
		if (captured.length === 0) return;
		this.#projectionTail = this.#projectionTail.then(() => this.#project(captured)).catch(() => undefined);
	}

	async #project(captured: readonly CapturedEvent[]): Promise<void> {
		for (const { record, event } of captured) {
			let projected: HostedChatEvent | undefined;
			try {
				projected = await this.#projection.projectHostedEvent(record, event);
			} catch {
				continue;
			}
			if (!projected) continue;
			const recipients = [...this.#connections.values()].filter(connection =>
				this.#capabilities.ownsSession(connection.grantId, event.sessionId),
			);
			if (recipients.length === 0) continue;
			const sequence = ++this.#sequence;
			const message = { type: "chat_event", epoch: this.#epoch, sequence, event: projected } as const;
			for (const connection of recipients) connection.enqueue(message, true);
		}
	}
}

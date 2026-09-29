import type { HostedStreamMessage } from "../lib/protocol";

const MAX_EVENT_CHARS = 64 * 1024 * 1024;

function parseMessage(data: string): HostedStreamMessage {
	const value: unknown = JSON.parse(data);
	if (typeof value !== "object" || value === null)
		throw new Error("Invalid Desktop event.");
	const message = value as Record<string, unknown>;
	if (typeof message.epoch !== "string" || !message.epoch)
		throw new Error("Invalid Desktop event epoch.");
	if (message.type === "chat_event") {
		if (
			!Number.isSafeInteger(message.sequence) ||
			(message.sequence as number) < 0 ||
			typeof message.event !== "object" ||
			message.event === null
		)
			throw new Error("Invalid Desktop chat event.");
	} else if (
		["stream_ready", "heartbeat", "reset_required"].includes(
			String(message.type),
		)
	) {
		if (
			!Number.isSafeInteger(message.currentSequence) ||
			(message.currentSequence as number) < 0
		)
			throw new Error("Invalid Desktop event sequence.");
	} else throw new Error("Unknown Desktop event.");
	return value as HostedStreamMessage;
}

/** Desktop emits JSON SSE data frames. Use Web Streams here; pi-utils/stream requires Node buffers. */
export async function* readDesktopEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<HostedStreamMessage> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let data: string[] = [];
	let frameSize = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				if (buffer.length || data.length)
					throw new Error("Desktop event stream ended inside a frame.");
				return;
			}
			buffer += decoder.decode(chunk.value, { stream: true });
			if (buffer.length + frameSize > MAX_EVENT_CHARS)
				throw new Error("Desktop event is too large.");
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line) {
					if (data.length) yield parseMessage(data.join("\n"));
					data = [];
					frameSize = 0;
				} else if (line.startsWith("data:")) {
					const value = line.slice(5).replace(/^ /, "");
					frameSize += value.length;
					data.push(value);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

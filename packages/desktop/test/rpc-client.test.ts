import {
	OMP_GRPC_MAX_MESSAGE_BYTES,
	OMP_GRPC_PROTOCOL_VERSION,
	type OmpGrpcClientConnection,
	type OmpGrpcClientFrame,
	type OmpGrpcServerFrame,
} from "@oh-my-pi/pi-grpc";
import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/main/rpc-client";

class FakeConnection implements OmpGrpcClientConnection {
	#frames: OmpGrpcServerFrame[] = [];
	#waiter: ((result: IteratorResult<OmpGrpcServerFrame>) => void) | undefined;
	#ended = false;
	#responses: OmpGrpcServerFrame[] = [];
	sent: OmpGrpcClientFrame[] = [];
	frames: AsyncIterable<OmpGrpcServerFrame> = {
		[Symbol.asyncIterator]: () => ({ next: () => this.#next() }),
	};

	push(frame: OmpGrpcServerFrame): void {
		if (this.#ended) return;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = undefined;
			waiter({ done: false, value: frame });
		} else {
			this.#frames.push(frame);
		}
	}

	async send(frame: OmpGrpcClientFrame): Promise<void> {
		this.sent.push(frame);
		if (frame.kind === "push") return;
		const response: OmpGrpcServerFrame = {
			kind: "response",
			id: frame.command.id,
			command: frame.command.command,
			success: true,
			...(frame.command.command === "prompt" ? { data: { agentInvoked: true } } : {}),
			...(frame.command.command === "alpha" || frame.command.command === "beta"
				? { data: frame.command.command }
				: {}),
		};
		if (frame.command.command === "alpha" || frame.command.command === "beta") this.#responses.push(response);
		else if (frame.command.command !== "never") this.push(response);
	}

	flushResponsesReverse(): void {
		for (const response of this.#responses.reverse()) this.push(response);
		this.#responses = [];
	}

	async close(): Promise<void> {
		this.end();
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.({ done: true, value: undefined });
	}

	#next(): Promise<IteratorResult<OmpGrpcServerFrame>> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve({ done: false, value: frame });
		if (this.#ended) return Promise.resolve({ done: true, value: undefined });
		const pending = Promise.withResolvers<IteratorResult<OmpGrpcServerFrame>>();
		this.#waiter = pending.resolve;
		return pending.promise;
	}
}

function readyFrame(): OmpGrpcServerFrame {
	return {
		kind: "ready",
		protocolVersion: OMP_GRPC_PROTOCOL_VERSION,
		maxMessageBytes: OMP_GRPC_MAX_MESSAGE_BYTES,
	};
}

describe("RpcClient", () => {
	it("correlates out-of-order gRPC responses by id", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();

		const alphaPromise = client.request({ type: "alpha" });
		const betaPromise = client.request({ type: "beta" });
		await Promise.resolve();
		connection.flushResponsesReverse();
		const [alpha, beta] = await Promise.all([alphaPromise, betaPromise]);
		expect(alpha.data).toBe("alpha");
		expect(beta.data).toBe("beta");
		expect(connection.sent.map(frame => (frame.kind === "command" ? frame.command.command : frame.type))).toEqual([
			"alpha",
			"beta",
		]);
		await client.close();
	});

	it("acknowledges prompts without waiting for a terminal agent event", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();

		await expect(client.prompt("keep the editor responsive")).resolves.toMatch(/^gradivus-\d+$/);
		expect(connection.sent).toMatchObject([
			{
				kind: "command",
				command: {
					command: "prompt",
					payload: { message: "keep the editor responsive" },
				},
			},
		]);
		await client.close();
	});
	it("forwards image arrays for prompts while preserving command payloads", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();

		const images = [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" as const }];
		await expect(client.prompt("describe the screenshot", images)).resolves.toMatch(/^gradivus-\d+$/);
		expect(connection.sent.at(-1)).toMatchObject({
			kind: "command",
			command: {
				command: "prompt",
				payload: { message: "describe the screenshot", images },
			},
		});
		await client.close();
	});

	it("delivers prompt_result even when it arrives before the prompt acknowledgement", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();
		const events: unknown[] = [];
		client.onEvent(event => events.push(event));
		const prompt = client.prompt("recover provider");
		connection.push({
			kind: "push",
			type: "prompt_result",
			payload: { id: "gradivus-1", agentInvoked: false, error: { message: "account locked", code: "AUTH" } },
		});
		await expect(prompt).resolves.toBe("gradivus-1");
		expect(events).toEqual([
			{
				type: "prompt_result",
				id: "gradivus-1",
				agentInvoked: false,
				error: { message: "account locked", code: "AUTH" },
			},
		]);
		await client.close();
	});

	it("rejects pending requests when the gRPC stream closes", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();
		const pending = client.request({ type: "never" });
		await Promise.resolve();
		connection.end();
		await expect(pending).rejects.toThrow(/stream closed/);
	});

	it("rejects a stream whose first frame is not Ready", async () => {
		const connection = new FakeConnection();
		const client = new RpcClient(connection);
		connection.push({ kind: "push", type: "agent_start", payload: {} });

		await expect(client.start()).rejects.toThrow(/did not begin with Ready/);
		await client.close();
	});

	it("rejects duplicate Ready frames and pending requests", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();
		const pending = client.request({ type: "never" });
		await Promise.resolve();

		connection.push(readyFrame());
		await expect(pending).rejects.toThrow(/duplicate Ready/);
		await client.close();
	});

	it("requires the response command to match its correlated request", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();
		const pending = client.request({ id: "correlated", type: "never" });
		await Promise.resolve();

		connection.push({
			kind: "response",
			id: "correlated",
			command: "different",
			success: true,
		});
		await expect(pending).rejects.toThrow(/response command mismatch/);
		await client.close();
	});

	it("uses the push envelope type for extension UI dispatch", async () => {
		const connection = new FakeConnection();
		connection.push(readyFrame());
		const client = new RpcClient(connection);
		await client.start();
		const extensions: unknown[] = [];
		client.onExtension(request => extensions.push(request));

		connection.push({
			kind: "push",
			type: "extension_ui_request",
			payload: { type: "spoofed", id: "extension-1", method: "input" },
		});
		await Promise.resolve();
		expect(extensions).toEqual([{ type: "extension_ui_request", id: "extension-1", method: "input" }]);
		await client.close();
	});
});

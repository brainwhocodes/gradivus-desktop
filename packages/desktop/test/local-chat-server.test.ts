import * as http from "node:http";
import * as net from "node:net";
import { GRADIVUS_CHAT_DEV_ORIGIN, GRADIVUS_CHAT_ORIGIN } from "@gradivus/chat/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_CHAT_HOST, LocalChatServer, type LocalChatServerState } from "../src/main/local-chat-server";

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

async function rawRequest(
	port: number,
	pathname: string,
	headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
	const result = Promise.withResolvers<{ status: number; headers: http.IncomingHttpHeaders }>();
	const request = http.request({ host: LOCAL_CHAT_HOST, port, path: pathname, method: "GET", headers }, response => {
		response.resume();
		response.once("end", () => result.resolve({ status: response.statusCode ?? 0, headers: response.headers }));
	});
	request.once("error", result.reject);
	request.end();
	return result.promise;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.stop()));
});

describe("LocalChatServer lifecycle", () => {
	it("binds only to loopback, reports readiness, serves Elysia requests, and stops accepting", async () => {
		const states: LocalChatServerState[] = [];
		const server = new LocalChatServer({ port: await availablePort(), onState: state => states.push(state) });
		servers.push(server);

		await expect(server.start()).resolves.toBe(true);
		expect(server.state).toEqual({ status: "listening", origin: `http://${LOCAL_CHAT_HOST}:${server.port}` });
		expect(server.port).toBeGreaterThan(0);
		expect(server.acceptingRequests).toBe(true);
		expect(states.map(state => state.status)).toEqual(["starting", "listening"]);

		const response = await fetch(`http://${LOCAL_CHAT_HOST}:${server.port}/not-exposed`);
		expect(response.status).toBe(404);

		await server.stop();
		expect(server.acceptingRequests).toBe(false);
		expect(server.state.status).toBe("stopped");
		expect(states.map(state => state.status)).toEqual(["starting", "listening", "stopping", "stopped"]);
	});

	it("leaves the first server usable when a second server cannot bind", async () => {
		const first = new LocalChatServer({ port: await availablePort() });
		servers.push(first);
		await expect(first.start()).resolves.toBe(true);

		const collisionStates: LocalChatServerState[] = [];
		const collision = new LocalChatServer({ port: first.port, onState: state => collisionStates.push(state) });
		servers.push(collision);
		await expect(collision.start()).resolves.toBe(false);

		expect(collision.acceptingRequests).toBe(false);
		expect(collision.state.status).toBe("unavailable");
		expect(collision.state.error).toContain("Gradivus local chat could not start");
		expect(collisionStates.map(state => state.status)).toEqual(["starting", "unavailable"]);
		expect((await fetch(`http://${LOCAL_CHAT_HOST}:${first.port}/still-listening`)).status).toBe(404);
	});

	it("rejects non-loopback Host values and enforces packaged origins on protected requests", async () => {
		const port = await availablePort();
		const server = new LocalChatServer({ port, isPackaged: true });
		servers.push(server);
		await expect(server.start()).resolves.toBe(true);
		const url = `http://${LOCAL_CHAT_HOST}:${port}/v1/events`;

		const wrongHost = await rawRequest(port, "/v1/events", {
			Host: `localhost:${port}`,
			Origin: GRADIVUS_CHAT_ORIGIN,
		});
		expect(wrongHost.status).toBe(403);
		expect(wrongHost.headers["access-control-allow-origin"]).toBeUndefined();

		for (const origin of [GRADIVUS_CHAT_DEV_ORIGIN, "null", "not-an-origin", "https://unexpected.example"]) {
			const response = await fetch(url, { headers: { Origin: origin } });
			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
		}
		const missingOrigin = await fetch(url);
		expect(missingOrigin.status).toBe(403);
		const allowed = await fetch(url, { headers: { Origin: GRADIVUS_CHAT_ORIGIN } });
		expect(allowed.status).toBe(404);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(GRADIVUS_CHAT_ORIGIN);
		expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
		expect(allowed.headers.get("cache-control")).toBe("no-store");
	});

	it("answers exact private-network preflights without credentials or unrelated headers", async () => {
		const port = await availablePort();
		const server = new LocalChatServer({ port, isPackaged: false });
		servers.push(server);
		await expect(server.start()).resolves.toBe(true);
		const url = `http://${LOCAL_CHAT_HOST}:${port}/v1/command`;
		const response = await fetch(url, {
			method: "OPTIONS",
			headers: {
				Origin: GRADIVUS_CHAT_DEV_ORIGIN,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "authorization, content-type",
				"Access-Control-Request-Private-Network": "true",
			},
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(GRADIVUS_CHAT_DEV_ORIGIN);
		expect(response.headers.get("access-control-allow-methods")).toBe("POST");
		expect(response.headers.get("access-control-allow-headers")).toBe("Authorization, Content-Type");
		expect(response.headers.get("access-control-allow-private-network")).toBe("true");
		expect(response.headers.get("access-control-allow-credentials")).toBeNull();
		expect(response.headers.get("vary")).toBe(
			"Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
		);

		const disallowedHeader = await fetch(url, {
			method: "OPTIONS",
			headers: {
				Origin: GRADIVUS_CHAT_DEV_ORIGIN,
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "x-secret",
			},
		});
		expect(disallowedHeader.status).toBe(403);
		expect(disallowedHeader.headers.get("access-control-allow-private-network")).toBeNull();

		const wrongMethod = await fetch(url, {
			method: "OPTIONS",
			headers: {
				Origin: GRADIVUS_CHAT_DEV_ORIGIN,
				"Access-Control-Request-Method": "DELETE",
			},
		});
		expect(wrongMethod.status).toBe(405);
	});
});

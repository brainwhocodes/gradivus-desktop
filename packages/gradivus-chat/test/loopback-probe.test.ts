import { describe, expect, it, vi } from "vitest";
import { probeLoopbackDesktop } from "../src/connection/loopback-probe";
import {
	GRADIVUS_CHAT_CLIENT_ID,
	GRADIVUS_CHAT_LOCAL_ORIGIN,
	GRADIVUS_CHAT_PROTOCOL_VERSION,
} from "../src/lib/protocol";

class SupportedLoopbackRequest extends Request {
	readonly targetAddressSpace: string;

	constructor(input: RequestInfo | URL, init: RequestInit & { targetAddressSpace: "loopback" }) {
		super(input, init);
		this.targetAddressSpace = init.targetAddressSpace;
	}
}

function metadata(overrides: Record<string, unknown> = {}) {
	return {
		issuer: GRADIVUS_CHAT_LOCAL_ORIGIN,
		authorization_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/authorize`,
		token_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/token`,
		revocation_endpoint: `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/revoke`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code"],
		code_challenge_methods_supported: ["S256"],
		scopes_supported: ["chat.read", "agent.execute", "sessions.manage", "files.read", "desktop.present"],
		protocol_versions_supported: [GRADIVUS_CHAT_PROTOCOL_VERSION],
		client_id: GRADIVUS_CHAT_CLIENT_ID,
		desktop_version: "0.1.0",
		...overrides,
	};
}

describe("probeLoopbackDesktop", () => {
	it("requires the browser to preserve targetAddressSpace on the constructed Request", async () => {
		const fetchRequest = vi.fn();
		await expect(probeLoopbackDesktop({ fetch: fetchRequest })).resolves.toEqual({ state: "unsupported" });
		expect(fetchRequest).not.toHaveBeenCalled();
	});

	it("returns a proven permission denial without probing Desktop", async () => {
		const fetchRequest = vi.fn();
		const result = await probeLoopbackDesktop({
			requestConstructor: SupportedLoopbackRequest,
			fetch: fetchRequest,
			permissions: { query: async () => ({ state: "denied" }) },
		});
		expect(result).toEqual({ state: "denied" });
		expect(fetchRequest).not.toHaveBeenCalled();
	});

	it("does not classify a generic fetch failure as permission denial", async () => {
		const result = await probeLoopbackDesktop({
			requestConstructor: SupportedLoopbackRequest,
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
			permissions: { query: async () => ({ state: "prompt" }) },
		});
		expect(result).toEqual({ state: "unavailable" });
	});

	it("recognizes a denial proven after a failed browser fetch", async () => {
		let queryCount = 0;
		const result = await probeLoopbackDesktop({
			requestConstructor: SupportedLoopbackRequest,
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
			permissions: {
				query: async () => ({ state: queryCount++ === 0 ? "prompt" : "denied" }),
			},
		});
		expect(result).toEqual({ state: "denied" });
	});

	it("accepts only exact versioned Gradivus metadata over a loopback-targeted CORS request", async () => {
		const fetchRequest = vi.fn(async (request: Request) => {
			expect(request).toBeInstanceOf(SupportedLoopbackRequest);
			expect((request as SupportedLoopbackRequest).targetAddressSpace).toBe("loopback");
			expect(request.mode).toBe("cors");
			expect(request.credentials).toBe("omit");
			return Response.json(metadata());
		});
		const result = await probeLoopbackDesktop({
			requestConstructor: SupportedLoopbackRequest,
			fetch: fetchRequest,
			permissions: { query: async () => ({ state: "granted" }) },
		});
		expect(result).toEqual({ state: "available", metadata: metadata() });
		expect(fetchRequest).toHaveBeenCalledTimes(1);
	});

	it("rejects a mismatched issuer, client, endpoint, scope, S256 method, or protocol version", async () => {
		for (const invalid of [
			metadata({ issuer: "http://localhost:47832" }),
			metadata({ client_id: "gradivus-chat-web-dev" }),
			metadata({ token_endpoint: "http://127.0.0.1:47832/token" }),
			metadata({ scopes_supported: ["chat.read"] }),
			metadata({ code_challenge_methods_supported: ["plain"] }),
			metadata({ protocol_versions_supported: [2] }),
		]) {
			await expect(
				probeLoopbackDesktop({
					requestConstructor: SupportedLoopbackRequest,
					fetch: async () => Response.json(invalid),
					permissions: { query: async () => ({ state: "granted" }) },
				}),
			).resolves.toEqual({ state: "protocol-mismatch" });
		}
	});
});

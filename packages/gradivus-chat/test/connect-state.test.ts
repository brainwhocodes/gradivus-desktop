import { describe, expect, it } from "vitest";
import { stateForProbe } from "../src/connection/connect-state";
import type { HostedAuthorizationServerMetadata } from "../src/lib/protocol";

const metadata = {
	issuer: "http://127.0.0.1:47832",
	authorization_endpoint: "http://127.0.0.1:47832/oauth/authorize",
	token_endpoint: "http://127.0.0.1:47832/oauth/token",
	revocation_endpoint: "http://127.0.0.1:47832/oauth/revoke",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code"],
	code_challenge_methods_supported: ["S256"],
	scopes_supported: ["chat.read", "agent.execute", "sessions.manage", "files.read", "desktop.present"],
	protocol_versions_supported: [1],
	client_id: "gradivus-chat-web",
	desktop_version: "0.1.0",
} as HostedAuthorizationServerMetadata;

describe("stateForProbe", () => {
	it("maps only proven browser and Desktop outcomes to distinct connection states", () => {
		expect(stateForProbe({ state: "denied" })).toEqual({ status: "browser-access-denied" });
		expect(stateForProbe({ state: "unsupported" })).toEqual({ status: "browser-access-unsupported" });
		expect(stateForProbe({ state: "unavailable" })).toEqual({ status: "desktop-unavailable" });
		expect(stateForProbe({ state: "protocol-mismatch" })).toEqual({ status: "protocol-mismatch" });
		expect(stateForProbe({ state: "available", metadata })).toEqual({
			status: "awaiting-desktop-consent",
			metadata,
		});
	});
});

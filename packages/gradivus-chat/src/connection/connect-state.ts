import type { HostedAuthorizationServerMetadata } from "../lib/protocol";
import type { LoopbackProbeResult } from "./loopback-probe";

export type HostedConnectionState =
	| { status: "disconnected" }
	| { status: "checking-browser-access" }
	| { status: "browser-access-denied" }
	| { status: "browser-access-unsupported" }
	| { status: "desktop-unavailable" }
	| { status: "protocol-mismatch" }
	| { status: "awaiting-desktop-consent"; metadata: HostedAuthorizationServerMetadata };

export function stateForProbe(result: LoopbackProbeResult): HostedConnectionState {
	switch (result.state) {
		case "available":
			return { status: "awaiting-desktop-consent", metadata: result.metadata };
		case "denied":
			return { status: "browser-access-denied" };
		case "unsupported":
			return { status: "browser-access-unsupported" };
		case "unavailable":
			return { status: "desktop-unavailable" };
		case "protocol-mismatch":
			return { status: "protocol-mismatch" };
	}
}

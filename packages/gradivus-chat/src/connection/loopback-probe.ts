import type { HostedAuthorizationServerMetadata } from "../lib/protocol";
import {
	GRADIVUS_CHAT_CLIENT_ID,
	type GRADIVUS_CHAT_DEV_CLIENT_ID,
	GRADIVUS_CHAT_INITIAL_SCOPES,
	GRADIVUS_CHAT_LOCAL_ORIGIN,
	GRADIVUS_CHAT_PROTOCOL_VERSION,
} from "../lib/protocol";

const PROBE_TIMEOUT_MS = 5_000;
const METADATA_URL = `${GRADIVUS_CHAT_LOCAL_ORIGIN}/.well-known/oauth-authorization-server`;

interface LoopbackRequestInit extends RequestInit {
	targetAddressSpace: "loopback";
}

interface LoopbackRequest extends Request {
	readonly targetAddressSpace?: string;
}

interface LoopbackRequestConstructor {
	new (input: RequestInfo | URL, init: LoopbackRequestInit): LoopbackRequest;
}

interface LoopbackPermissionStatus {
	state: PermissionState;
}

interface LoopbackPermissions {
	query(descriptor: { name: "loopback-network" }): Promise<LoopbackPermissionStatus>;
}

interface LoopbackFetch {
	(request: LoopbackRequest): Promise<Response>;
}

export type LoopbackProbeResult =
	| { state: "available"; metadata: HostedAuthorizationServerMetadata }
	| { state: "denied" }
	| { state: "unsupported" }
	| { state: "unavailable" }
	| { state: "protocol-mismatch" };

export interface LoopbackProbeOptions {
	clientId?: typeof GRADIVUS_CHAT_CLIENT_ID | typeof GRADIVUS_CHAT_DEV_CLIENT_ID;
	requestConstructor?: LoopbackRequestConstructor;
	fetch?: LoopbackFetch;
	permissions?: LoopbackPermissions;
	timeoutMs?: number;
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

function validMetadata(
	value: unknown,
	clientId: typeof GRADIVUS_CHAT_CLIENT_ID | typeof GRADIVUS_CHAT_DEV_CLIENT_ID,
): value is HostedAuthorizationServerMetadata {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const metadata = value as Record<string, unknown>;
	return (
		metadata.issuer === GRADIVUS_CHAT_LOCAL_ORIGIN &&
		metadata.authorization_endpoint === `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/authorize` &&
		metadata.token_endpoint === `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/token` &&
		metadata.revocation_endpoint === `${GRADIVUS_CHAT_LOCAL_ORIGIN}/oauth/revoke` &&
		exactStringArray(metadata.response_types_supported, ["code"]) &&
		exactStringArray(metadata.grant_types_supported, ["authorization_code"]) &&
		exactStringArray(metadata.code_challenge_methods_supported, ["S256"]) &&
		Array.isArray(metadata.protocol_versions_supported) &&
		metadata.protocol_versions_supported.length === 1 &&
		metadata.protocol_versions_supported[0] === GRADIVUS_CHAT_PROTOCOL_VERSION &&
		exactStringArray(metadata.scopes_supported, [...GRADIVUS_CHAT_INITIAL_SCOPES, "desktop.present"]) &&
		metadata.client_id === clientId &&
		typeof metadata.desktop_version === "string" &&
		metadata.desktop_version.length > 0
	);
}

async function permissionState(permissions: LoopbackPermissions | undefined): Promise<PermissionState | undefined> {
	if (!permissions) return undefined;
	try {
		return (await permissions.query({ name: "loopback-network" })).state;
	} catch {
		return undefined;
	}
}

export async function probeLoopbackDesktop(options: LoopbackProbeOptions = {}): Promise<LoopbackProbeResult> {
	const RequestClass = options.requestConstructor ?? (Request as unknown as LoopbackRequestConstructor);
	const fetchRequest: LoopbackFetch = options.fetch ?? (request => globalThis.fetch(request));
	const permissions =
		options.permissions ??
		(typeof navigator === "undefined" ? undefined : (navigator.permissions as unknown as LoopbackPermissions));
	const clientId = options.clientId ?? GRADIVUS_CHAT_CLIENT_ID;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
	let request: LoopbackRequest;
	try {
		request = new RequestClass(METADATA_URL, {
			method: "GET",
			mode: "cors",
			cache: "no-store",
			credentials: "omit",
			signal: timeout,
			targetAddressSpace: "loopback",
		});
	} catch {
		return { state: "unsupported" };
	}
	if (request.targetAddressSpace !== "loopback") return { state: "unsupported" };
	if ((await permissionState(permissions)) === "denied") return { state: "denied" };
	let response: Response;
	try {
		response = await fetchRequest(request);
	} catch {
		if ((await permissionState(permissions)) === "denied") return { state: "denied" };
		return { state: "unavailable" };
	}
	if (!response.ok) return { state: "unavailable" };
	let metadata: unknown;
	try {
		metadata = await response.json();
	} catch {
		return { state: "protocol-mismatch" };
	}
	if (!validMetadata(metadata, clientId)) return { state: "protocol-mismatch" };
	return { state: "available", metadata };
}

import { GRADIVUS_CHAT_LOCAL_ORIGIN } from "../lib/protocol";

interface LoopbackRequestInit extends RequestInit {
	targetAddressSpace: "loopback";
}

/** All authenticated browser traffic goes directly to the fixed Desktop listener. */
export function fetchDesktop(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	if (!path.startsWith("/") || path.startsWith("//"))
		throw new Error("Invalid Desktop API path.");
	const request: LoopbackRequestInit = {
		...init,
		mode: "cors",
		credentials: "omit",
		cache: "no-store",
		redirect: "error",
		targetAddressSpace: "loopback",
	};
	return fetch(new Request(`${GRADIVUS_CHAT_LOCAL_ORIGIN}${path}`, request));
}

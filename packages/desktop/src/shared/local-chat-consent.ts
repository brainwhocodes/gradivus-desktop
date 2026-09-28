import type { HostedScope } from "@gradivus/chat/contracts";

export interface LocalChatConsentScopeView {
	scope: HostedScope;
	label: string;
}

export interface LocalChatConsentRequest {
	requestId: string;
	clientId: string;
	clientName: string;
	origin: string;
	scopes: LocalChatConsentScopeView[];
	title: "Allow Gradivus Chat to use this Desktop?";
	riskNotice: string;
	securityNote: string;
	allowLabel: "Allow coding chat access";
	denyLabel: "Deny";
	expiresAt: number;
}

export type LocalChatConsentDecision =
	| { requestId: string; decision: "allow" }
	| { requestId: string; decision: "deny" }
	| { requestId: string; decision: "unavailable" };

export interface LocalChatConnectionView {
	grantId: string;
	clientName: string;
	origin: string;
	scopes: LocalChatConsentScopeView[];
	createdAt: number;
	lastUsedAt: number;
	expiresAt: number;
	activeTokenCount: number;
	status: "active" | "revoking" | "revoked";
}

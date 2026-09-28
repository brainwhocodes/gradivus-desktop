import type { AuthStorage, OAuthAccountIdentity } from "../../session/auth-storage";
import { sanitizeOAuthAccountLabel } from "./active-oauth-account";
import { toSessionPinAccounts } from "./session-pin";

export interface OAuthAccountRoutingDisplay {
	automaticRouting: boolean;
	selectedAccountLabel?: string;
	selectionUnavailable: boolean;
	allowSiblingFailover: boolean;
	actualAccount?: OAuthAccountIdentity;
	actualAccountIsFailover: boolean;
}

export type OAuthAccountRoutingDisplayResolver = (provider: string) => OAuthAccountRoutingDisplay | undefined;

type OAuthAccountRoutingStorage = Pick<AuthStorage, "getOAuthAccountSelection"> & {
	oauth: Pick<AuthStorage["oauth"], "accounts" | "identity">;
};

/** Resolve configured OAuth routing intent and the account that served this session. */
export function buildOAuthAccountRoutingDisplay(
	authStorage: OAuthAccountRoutingStorage,
	provider: string,
	sessionId: string,
): OAuthAccountRoutingDisplay {
	const selection = authStorage.getOAuthAccountSelection(provider);
	const accounts = authStorage.oauth.accounts(provider, sessionId);
	const selected =
		selection?.credentialId === undefined
			? undefined
			: accounts.find(account => account.credentialId === selection.credentialId);
	const activeAccount = accounts.find(account => account.active);
	const actualAccount = authStorage.oauth.identity(provider, sessionId);
	return {
		automaticRouting: selection === undefined,
		selectedAccountLabel: selected ? toSessionPinAccounts([selected])[0]?.label : undefined,
		selectionUnavailable: selection !== undefined && (!selection.available || selected === undefined),
		allowSiblingFailover: selection?.allowSiblingFailover ?? false,
		actualAccount,
		actualAccountIsFailover: Boolean(
			selection?.allowSiblingFailover && activeAccount && activeAccount.credentialId !== selection.credentialId,
		),
	};
}

/** Format the configured OAuth routing policy for `/usage`. */
export function formatOAuthAccountSelectionLine(display: OAuthAccountRoutingDisplay): string | undefined {
	if (display.selectionUnavailable) return "Locked account unavailable; choose another in /settings";
	const selectedAccountLabel = display.selectedAccountLabel
		? sanitizeOAuthAccountLabel(display.selectedAccountLabel)
		: undefined;
	if (!selectedAccountLabel) return undefined;
	const mode = display.allowSiblingFailover ? "failover enabled" : "strict";
	return `Locked account: ${selectedAccountLabel} (${mode})`;
}

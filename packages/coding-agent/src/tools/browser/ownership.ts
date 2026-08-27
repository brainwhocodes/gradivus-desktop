import type { ToolSession } from "../index";
import { ToolError } from "../tool-errors";

/** The main agent retains the historical process-global default tab. */
export const DEFAULT_TAB_NAME = "main";

/** Resolve an omitted name without making unrelated subagents share `main`. */
export function resolveBrowserTabName(name: string | undefined, session?: Pick<ToolSession, "getAgentId">): string {
	if (name !== undefined) return name;
	const agentId = session?.getAgentId?.();
	if (!agentId || agentId === "Main") return DEFAULT_TAB_NAME;
	return `agent:${agentId}:main`;
}

/** Session identity used for retained leases; anonymous SDK callers stay compatible. */
export function resolveBrowserSessionKey(
	session?: Pick<ToolSession, "getSessionId" | "getAgentId">,
): string | undefined {
	return session?.getSessionId?.() ?? session?.getAgentId?.() ?? undefined;
}

/** Non-sensitive label suitable for inventory display. */
export function resolveBrowserAgentLabel(session?: Pick<ToolSession, "getAgentId">): string {
	return session?.getAgentId?.() || "anonymous";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Browser calls made by code currently executing on a tab must not enqueue onto
 * that same tab: doing so would deadlock the outer run. Other tools and tabs are
 * deliberately allowed, and inventory is always safe.
 */
export function assertNoBrowserTabRecursion(
	activeTabName: string,
	toolName: string,
	args: unknown,
	session?: ToolSession,
): void {
	if (toolName !== "browser" || !isRecord(args)) return;
	const action = args.action;
	if (action === "list") return;
	if (action !== "open" && action !== "run" && action !== "close") return;
	if (action === "close" && args.all === true) {
		throw new ToolError(
			`Browser deadlock prevented: browser close --all cannot run from inside active tab ${JSON.stringify(activeTabName)}. Target another tab or return first.`,
		);
	}
	const nestedName = resolveBrowserTabName(typeof args.name === "string" ? args.name : undefined, session);
	if (nestedName === activeTabName) {
		throw new ToolError(
			`Browser deadlock prevented: browser ${JSON.stringify(action)} on active tab ${JSON.stringify(activeTabName)} cannot be queued from inside its run. Target another tab or return first.`,
		);
	}
}

import type { WorkspacePaneKind } from "../shared/contracts";

export type WorkspaceLayout = "columns" | "rows" | "grid";

export type AgentProcessStatus = "idle" | "ready" | "running" | "working" | "stopped" | "error";

export interface WorkspaceAgent {
	id: string;
	name: string;
	agent: string;
	status: AgentProcessStatus | string;
	swatch: string;
	workspaceId?: string;
	sessionId?: string;
	deliverable: boolean;
	task?: string;
	assignment?: string;
	lastIntent?: string;
	currentTool?: string;
	terminalId?: string;
	paneId?: string;
	profileId?: string;
}

export interface WorkspacePane {
	id: string;
	kind: WorkspacePaneKind;
	title: string;
	url?: string;
	cwd?: string;
	status?: "starting" | "ready" | "exited" | "error";
	error?: string;
	workspaceId?: string;
	tabId?: string;
	agentId?: string;
	agent?: WorkspaceAgent;
}

export interface WorkspaceTab {
	kind: WorkspacePaneKind;
	id: string;
	title: string;
	panes: WorkspacePane[];
	layout: WorkspaceLayout;
	ratio: number;
	activePaneId: string;
	workspaceId?: string;
}

export function isLocalUrl(urlString?: string): boolean {
	if (!urlString) return false;
	try {
		const parsed = new URL(urlString);
		const host = parsed.hostname.toLowerCase();
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "0.0.0.0" ||
			host === "::1" ||
			host === "[::1]" ||
			host.endsWith(".localhost") ||
			host.endsWith(".local") ||
			host.startsWith("local.") ||
			host.includes(".local.") ||
			host.endsWith(".internal") ||
			host.endsWith(".test") ||
			host.endsWith(".example")
		);
	} catch {
		return false;
	}
}

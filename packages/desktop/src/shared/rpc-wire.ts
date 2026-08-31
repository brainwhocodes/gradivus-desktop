export interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	loadMode?: "essential" | "discoverable" | "deferred";
}

export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

export type RpcHostToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface RpcHostToolResultBody {
	content: RpcHostToolContent[];
	details?: unknown;
}

export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: RpcHostToolResultBody;
	isError?: boolean;
}

export interface RpcExtensionUIRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "cancel"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text"
		| "open_url";
	targetId?: string;
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	sensitive?: boolean;
	prefill?: string;
	text?: string;
	url?: string;
	launchUrl?: string;
	instructions?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
}

export interface RpcExtensionUIResponse {
	type: "extension_ui_response";
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: true;
	timedOut?: boolean;
}

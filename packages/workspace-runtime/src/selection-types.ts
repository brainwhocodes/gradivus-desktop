import type {
	AddClassPatchOp,
	BaseDeclarativePatchOp,
	DeclarativePatchOperation,
	DeclarativePatchOpType,
	DeclarativePreviewPatch,
	DeclarativePreviewResult,
	RemoveAttributePatchOp,
	RemoveClassPatchOp,
	RemoveStylePatchOp,
	ReplaceTextPatchOp,
	SetAttributePatchOp,
	SetStylePatchOp,
} from "@oh-my-pi/pi-browser-runtime";

export type {
	AddClassPatchOp,
	BaseDeclarativePatchOp,
	DeclarativePatchOperation,
	DeclarativePatchOpType,
	DeclarativePreviewPatch,
	DeclarativePreviewResult,
	RemoveAttributePatchOp,
	RemoveClassPatchOp,
	RemoveStylePatchOp,
	ReplaceTextPatchOp,
	SetAttributePatchOp,
	SetStylePatchOp,
};

export type ElementEditPhase =
	| "idle"
	| "picking"
	| "selected"
	| "sending"
	| "analyzing"
	| "working"
	| "ready"
	| "error"
	| "preview";

export type SelectionCaptureMode = "dom" | "screenshot";

export type ElementTaskAction = "inline" | "chat" | "queue";

export interface SelectionTargetAgent {
	id: string;
	name: string;
	swatch: string;
}

export type QueuedElementTaskStatus = "pending" | "running" | "completed" | "error";

export interface QueuedElementTask {
	id: string;
	taskIndex: number;
	paneId: string;
	targetAgentId: string;
	targetAgentName: string;
	agentSwatch: string;
	instruction: string;
	tagName: string;
	selector: string;
	agentType?: string;
	captureMode?: SelectionCaptureMode;
	url?: string;
	summary?: string;
	domHtml?: string;
	domSnapshot?: ElementDomSnapshot;
	screenshot?: string;
	screenshotWidth?: number;
	screenshotHeight?: number;
	createdAt: number;
	status: QueuedElementTaskStatus;
	response?: string;
	error?: string;
}

export interface ElementBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

export interface ElementDomNode {
	selector: string;
	role?: string;
	name?: string;
	tagName: string;
	text?: string;
	attributes?: Record<string, string>;
	bounds?: ElementBoundingBox;
	depth: number;
	children?: ElementDomNode[];
}

export interface ElementDomSnapshot {
	selector: string;
	role?: string;
	name?: string;
	tagName?: string;
	text?: string;
	attributes?: Record<string, string>;
	bounds?: ElementBoundingBox;
	hierarchy?: string[];
	depth?: number;
	nodes?: ElementDomNode[];
	html?: string;
	summary?: string;
}

export interface ElementScreenshot {
	dataUrl?: string;
	base64?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	byteLength: number;
}

export interface ElementSelectionV1 {
	id: string;
	readonly principalId: string;
	readonly workspaceId: string;
	readonly tabId: string;
	readonly paneId: string;
	readonly documentEpoch: number;
	readonly locationGeneration: number;
	locationId: string;
	agentId: string;
	sessionId: string;
	browserSessionId?: string;
	frameId?: string;
	backendNodeId?: number;
	captureMode?: SelectionCaptureMode;
	url?: string;
	selector?: string;
	domSnapshot?: ElementDomSnapshot;
	screenshot?: ElementScreenshot;
	previewPatch?: DeclarativePreviewPatch;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
	byteSize: number;
}

export interface ElementEditResultV1 {
	id: string;
	selectionId: string;
	workspaceId: string;
	paneId: string;
	agentId: string;
	target: string;
	operation: "insert" | "replace" | "delete" | "move";
	value?: string;
	from?: number;
	to?: number;
	applied: boolean;
	previewPatch?: DeclarativePreviewPatch;
	summary?: string;
	createdAt: number;
}

export interface ElementEditState {
	phase: ElementEditPhase;
	selectionId?: string;
	workspaceId?: string;
	paneId?: string;
	locationId?: string;
	locationGeneration?: number;
	browserSessionId?: string;
	agentId?: string;
	captureMode?: SelectionCaptureMode;
	url?: string;
	selector?: string;
	selectedElement?: ElementDomSnapshot;
	domSnapshot?: ElementDomSnapshot;
	screenshot?: ElementScreenshot;
	previewPatch?: DeclarativePreviewPatch;
	preview?: DeclarativePreviewPatch;
	error?: {
		code: string;
		message: string;
	};
	workingMessage?: string;
	action?: ElementTaskAction;
	response?: string;
	instruction?: string;
	queuedTasks?: QueuedElementTask[];
	queueRunning?: boolean;
	result?: ElementEditResultV1;
	updatedAt: number;
}

export interface ElementSelectionLimits {
	readonly maxImageBytes: number;
	readonly maxDomBytes: number;
	readonly maxPreviewBytes: number;
	readonly maxSummaryBytes: number;
	readonly maxRequestStorageBytes: number;
	readonly maxTotalRequestBytes: number;
	readonly maxLiveRequests: number;
	readonly maxStorageBytes: number;
	readonly maxTotalStorageBytes: number;
	readonly maxLifetimeMs: number;
	readonly maxDepth: number;
	readonly maxDomRecords: number;
	readonly screenshotPaddingPx: number;
	readonly maxScreenshotDimension: number;
}

export interface SelectionAuthContext {
	agentWorkspaceId: string;
	selectionWorkspaceId: string;
	paneWorkspaceId: string;
}

export interface SelectionAuthScope {
	readonly principalId: string;
	readonly workspaceId: string;
	readonly tabId: string;
	readonly paneId: string;
	readonly documentEpoch: number;
	readonly locationGeneration: number;
	readonly locationId: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly frameId?: string;
	readonly backendNodeId?: number;
}

export interface StartSelectionOptions {
	selectionId?: string;
	captureMode?: SelectionCaptureMode;
	url?: string;
	target?: SelectionTargetAgent;
}

export interface UpdateSelectionOptions {
	frameId?: string;
	backendNodeId?: number;
	selector?: string;
	domSnapshot?: ElementDomSnapshot;
	screenshot?: ElementScreenshot;
	previewPatch?: DeclarativePreviewPatch;
	url?: string;
	captureMode?: SelectionCaptureMode;
}

export interface CommitSelectionPayload {
	frameId?: string;
	backendNodeId?: number;
	target?: string;
	selector?: string;
	instruction?: string;
	action?: ElementTaskAction;
	agentId?: string;
	domSnapshot?: ElementDomSnapshot;
	screenshot?: ElementScreenshot;
}

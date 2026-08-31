import { SELECTION_LIMITS } from "@oh-my-pi/pi-workspace-runtime/selection";
import type { WebContents } from "electron";
import type {
	PaneAutomationAccess,
	PaneAutomationLeaseView,
	PaneAutomationState,
	SessionRecordV1,
} from "../shared/contracts";
import type { RpcHostToolDefinition, RpcHostToolResultBody } from "../shared/rpc-wire";
import paneToolDescription from "./prompts/gradivus-pane.md" with { type: "text" };

export interface PaneBrokerContext {
	paneId: string;
	tabId: string;
	browserId: string;
	workspaceId: string;
	locationId: string;
	locationGeneration: number;
	documentEpoch: number;
	url: string;
	title: string;
	visible: boolean;
	navigationPending: boolean;
	webContents: WebContents;
}

export interface PaneBrokerExecution {
	details: Record<string, unknown>;
	image?: { data: string; mimeType: string };
}

export interface PaneBrokerAdapter {
	list(sessionId: string): PaneBrokerContext[];
	resolve(sessionId: string, paneId: string): PaneBrokerContext;
	session(
		sessionId: string,
	): { record: SessionRecordV1; incarnation: string; automationUnavailableReason?: string } | undefined;
	confirm(context: PaneBrokerContext, record: SessionRecordV1, access: PaneAutomationAccess): Promise<boolean>;
	execute(
		paneId: string,
		action: "snapshot" | "navigate" | "click" | "fill" | "press" | "hover" | "scroll" | "screenshot",
		args: { url?: string; selector?: string; ref?: string; text?: string; key?: string },
		signal: AbortSignal,
	): Promise<PaneBrokerExecution>;
}

type Lease = PaneAutomationLeaseView & {
	sessionId: string;
	incarnation: string;
	tabId: string;
	browserId: string;
	workspaceId: string;
	locationId: string;
	locationGeneration: number;
	webContentsId: number;
	refs: Map<string, string>;
};

type DebuggerOwnership = {
	state: "attaching" | "owned" | "detaching" | "lost";
	webContents: WebContents;
	detach: (event: Electron.Event, reason: string) => void;
};
type QueuedPaneOperation = {
	sessionId: string;
	paneId: string;
	controller: AbortController;
	started: boolean;
	run: (signal: AbortSignal) => Promise<RpcHostToolResultBody>;
	resolve: (value: RpcHostToolResultBody) => void;
	reject: (reason: unknown) => void;
	abort: () => void;
	cleanup: () => void;
};

const MAX_PANE_QUEUE_DEPTH = 16;
const MAX_GLOBAL_OPERATIONS = 8;

const OBSERVE_ACTIONS = new Set(["list", "observe", "screenshot"]);
const ACTIONS = ["list", "observe", "act", "navigate", "screenshot"] as const;
const ACT_OPS = ["click", "fill", "press", "hover", "scroll"] as const;

class PaneBrokerError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "PaneBrokerError";
		this.code = code;
	}
}

function boundedText(value: unknown, label: string, maximum: number, required = false): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string") throw new PaneBrokerError("invalid_params", `${label} must be text`);
	const text = value.trim();
	if (!text || text.length > maximum) throw new PaneBrokerError("invalid_params", `${label} is invalid`);
	return text;
}

function leaseKey(sessionId: string, incarnation: string, paneId: string): string {
	return `${sessionId}\u0000${incarnation}\u0000${paneId}`;
}

export class PaneBroker {
	#adapter: PaneBrokerAdapter;
	#leases = new Map<string, Lease>();
	#debuggers = new Map<string, DebuggerOwnership>();
	#paneQueues = new Map<string, QueuedPaneOperation[]>();
	#operations = new Set<QueuedPaneOperation>();
	#runningPanes = new Set<string>();
	#runningOperations = 0;

	constructor(adapter: PaneBrokerAdapter) {
		this.#adapter = adapter;
	}

	definitionFor(sessionId: string, incarnation: string): RpcHostToolDefinition | undefined {
		const session = this.#adapter.session(sessionId);
		if (!session || session.incarnation !== incarnation || this.#adapter.list(sessionId).length === 0)
			return undefined;
		return {
			name: "gradivus_pane",
			label: "Gradivus Pane",
			description: paneToolDescription,
			loadMode: "discoverable",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["action"],
				properties: {
					action: { type: "string", enum: [...ACTIONS] },
					paneId: { type: "string" },
					documentEpoch: { type: "number" },
					op: { type: "string", enum: [...ACT_OPS] },
					selector: { type: "string", maxLength: 2_048 },
					ref: { type: "string", maxLength: 64 },
					value: { type: "string", maxLength: 8_192 },
					key: { type: "string", maxLength: 32 },
					url: { type: "string", maxLength: 4_096 },
					timeoutMs: { type: "number", minimum: 1, maximum: 120_000 },
				},
			},
		};
	}

	state(sessionId: string, paneId: string): PaneAutomationState {
		const session = this.#adapter.session(sessionId);
		if (!session) return { available: false, reason: "OMP runtime is not ready." };
		if (session.automationUnavailableReason) return { available: false, reason: session.automationUnavailableReason };
		let context: PaneBrokerContext;
		try {
			context = this.#adapter.resolve(sessionId, paneId);
		} catch (error) {
			return { available: false, reason: error instanceof Error ? error.message : String(error) };
		}
		const lease = this.#leases.get(leaseKey(sessionId, session.incarnation, paneId));
		return {
			available: true,
			...(lease ? { lease: this.#leaseView(lease, context) } : {}),
		};
	}

	async authorize(sessionId: string, paneId: string, access: PaneAutomationAccess): Promise<PaneAutomationState> {
		if (access !== "observe" && access !== "control") throw new PaneBrokerError("invalid_params", "invalid access");
		const session = this.#adapter.session(sessionId);
		if (!session) return { available: false, reason: "OMP runtime is not ready." };
		if (session.automationUnavailableReason) return { available: false, reason: session.automationUnavailableReason };
		const before = this.#adapter.resolve(sessionId, paneId);
		if (!before.visible) return { available: false, reason: "The pane must be visible to authorize automation." };
		if (!(await this.#adapter.confirm(before, session.record, access))) return this.state(sessionId, paneId);
		const after = this.#adapter.resolve(sessionId, paneId);
		if (!this.#sameContext(before, after) || !after.visible) {
			return { available: false, reason: "The pane changed while authorization was open." };
		}
		for (const lease of this.#leases.values()) {
			if (lease.paneId === paneId && (lease.sessionId !== sessionId || lease.incarnation !== session.incarnation)) {
				return { available: false, reason: "Another OMP runtime already owns this pane." };
			}
		}
		await this.#ensureDebugger(after, sessionId, session.incarnation);
		const lease: Lease = {
			sessionId,
			incarnation: session.incarnation,
			paneId,
			access,
			documentEpoch: after.documentEpoch,
			url: after.url,
			title: after.title,
			healthy: true,
			tabId: after.tabId,
			browserId: after.browserId,
			workspaceId: after.workspaceId,
			locationId: after.locationId,
			locationGeneration: after.locationGeneration,
			webContentsId: after.webContents.id,
			refs: new Map(),
		};
		this.#leases.set(leaseKey(sessionId, session.incarnation, paneId), lease);
		return { available: true, lease: this.#leaseView(lease, after) };
	}

	async revoke(sessionId: string, paneId: string): Promise<PaneAutomationState> {
		const session = this.#adapter.session(sessionId);
		if (session) this.#leases.delete(leaseKey(sessionId, session.incarnation, paneId));
		this.#cancelOperations(sessionId, paneId);
		if (![...this.#leases.values()].some(lease => lease.paneId === paneId)) await this.#detachDebugger(paneId);
		return this.state(sessionId, paneId);
	}

	async revokeSession(sessionId: string): Promise<void> {
		const paneIds = new Set<string>();
		for (const [key, lease] of this.#leases) {
			if (lease.sessionId !== sessionId) continue;
			paneIds.add(lease.paneId);
			this.#leases.delete(key);
		}
		this.#cancelOperations(sessionId);
		for (const paneId of paneIds) await this.#detachDebugger(paneId);
	}

	async execute(
		sessionId: string,
		incarnation: string,
		argumentsValue: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<RpcHostToolResultBody> {
		if (signal.aborted) throw new PaneBrokerError("cancelled", "call was cancelled");
		if (Buffer.byteLength(JSON.stringify(argumentsValue), "utf8") > SELECTION_LIMITS.maxTotalRequestBytes) {
			throw new PaneBrokerError("invalid_params", `call exceeds ${SELECTION_LIMITS.maxTotalRequestBytes} bytes`);
		}
		const action = argumentsValue.action;
		if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
			throw new PaneBrokerError("invalid_params", "invalid action");
		}
		if (action === "list") {
			const panes = this.#adapter.list(sessionId).map(context => {
				const lease = this.#leases.get(leaseKey(sessionId, incarnation, context.paneId));
				return {
					paneId: context.paneId,
					url: context.url,
					title: context.title,
					documentEpoch: context.documentEpoch,
					visible: context.visible,
					...(lease ? { access: lease.access, healthy: lease.healthy } : {}),
				};
			});
			return this.#result({ action, panes });
		}
		const paneId = boundedText(argumentsValue.paneId, "paneId", 100, true)!;
		const documentEpoch = argumentsValue.documentEpoch;
		if (!Number.isSafeInteger(documentEpoch) || (documentEpoch as number) < 1) {
			throw new PaneBrokerError("invalid_params", "documentEpoch is required");
		}
		const requestedTimeout = argumentsValue.timeoutMs;
		if (
			requestedTimeout !== undefined &&
			(!Number.isSafeInteger(requestedTimeout) ||
				(requestedTimeout as number) < 1 ||
				(requestedTimeout as number) > 120_000)
		) {
			throw new PaneBrokerError("invalid_params", "timeoutMs must be an integer from 1 to 120000");
		}
		const operationSignal = AbortSignal.any([
			signal,
			AbortSignal.timeout((requestedTimeout as number | undefined) ?? 30_000),
		]);
		return this.#enqueue(sessionId, paneId, operationSignal, queuedSignal =>
			this.#executePaneAction(
				sessionId,
				incarnation,
				action,
				paneId,
				documentEpoch as number,
				argumentsValue,
				queuedSignal,
			),
		);
	}

	async #executePaneAction(
		sessionId: string,
		incarnation: string,
		action: string,
		paneId: string,
		documentEpoch: number,
		argumentsValue: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<RpcHostToolResultBody> {
		if (signal.aborted) throw new PaneBrokerError("cancelled", "call was cancelled");
		const context = this.#validateLease(sessionId, incarnation, paneId, documentEpoch, action);
		if (context.navigationPending) throw new PaneBrokerError("navigation_pending", "navigation is in progress");
		const lease = this.#leases.get(leaseKey(sessionId, incarnation, paneId))!;
		let execution: PaneBrokerExecution;
		if (action === "observe") {
			execution = await this.#adapter.execute(paneId, "snapshot", {}, signal);
			lease.refs.clear();
			const aria = typeof execution.details.aria === "string" ? execution.details.aria : "";
			for (const match of aria.matchAll(/\[ref=(e\d+)\]/g)) {
				const ref = match[1]!;
				lease.refs.set(ref, ref);
				if (lease.refs.size >= SELECTION_LIMITS.maxDomRecords) break;
			}
			if (lease.refs.size === 0) {
				const interactive = Array.isArray(execution.details.interactive) ? execution.details.interactive : [];
				for (let index = 0; index < interactive.length; index++) {
					const item = interactive[index];
					if (item && typeof item === "object" && "selector" in item && typeof item.selector === "string") {
						lease.refs.set(`e${index + 1}`, item.selector);
						(item as Record<string, unknown>).ref = `e${index + 1}`;
					}
				}
			}
		} else if (action === "screenshot") {
			execution = await this.#adapter.execute(paneId, "screenshot", {}, signal);
		} else if (action === "navigate") {
			this.#requireControl(lease);
			const url = boundedText(argumentsValue.url, "url", 4_096, true)!;
			execution = await this.#adapter.execute(paneId, "navigate", { url }, signal);
		} else {
			this.#requireControl(lease);
			const op = argumentsValue.op;
			if (typeof op !== "string" || !(ACT_OPS as readonly string[]).includes(op)) {
				throw new PaneBrokerError("invalid_params", "act op is required");
			}
			const ref = boundedText(argumentsValue.ref, "ref", 64);
			const resolvedRef = ref ? lease.refs.get(ref) : undefined;
			const selector = ref ? undefined : boundedText(argumentsValue.selector, "selector", 2_048);
			if (ref && !resolvedRef) throw new PaneBrokerError("stale_ref", `unknown ref ${ref}`);
			if ((op === "click" || op === "fill" || op === "hover") && !resolvedRef && !selector) {
				throw new PaneBrokerError("invalid_params", "selector or ref is required");
			}
			execution = await this.#adapter.execute(
				paneId,
				op as "click" | "fill" | "press" | "hover" | "scroll",
				{
					selector,
					ref: resolvedRef,
					...(op === "fill" || op === "scroll"
						? { text: boundedText(argumentsValue.value, "value", 8_192, true) }
						: {}),
					...(op === "press" ? { key: boundedText(argumentsValue.key, "key", 32, true) } : {}),
				},
				signal,
			);
		}
		const after = this.#adapter.resolve(sessionId, paneId);
		if (signal.aborted) throw new PaneBrokerError("cancelled", "call was cancelled");
		const clickMayNavigate = action === "act" && argumentsValue.op === "click";
		if (after.documentEpoch !== context.documentEpoch && action !== "navigate" && !clickMayNavigate) {
			throw new PaneBrokerError("stale_epoch", "the page changed during the call");
		}
		lease.documentEpoch = after.documentEpoch;
		lease.url = after.url;
		lease.title = after.title;
		return this.#result({ ...execution.details, paneId, documentEpoch: after.documentEpoch }, execution.image);
	}

	#enqueue(
		sessionId: string,
		paneId: string,
		signal: AbortSignal,
		run: (signal: AbortSignal) => Promise<RpcHostToolResultBody>,
	): Promise<RpcHostToolResultBody> {
		const queue = this.#paneQueues.get(paneId) ?? [];
		if (queue.length >= MAX_PANE_QUEUE_DEPTH) {
			throw new PaneBrokerError("busy", `pane queue is limited to ${MAX_PANE_QUEUE_DEPTH} calls`);
		}
		const controller = new AbortController();
		const deferred = Promise.withResolvers<RpcHostToolResultBody>();
		let settled = false;
		const resolve = (value: RpcHostToolResultBody): void => {
			if (settled) return;
			settled = true;
			deferred.resolve(value);
		};
		const reject = (reason: unknown): void => {
			if (settled) return;
			settled = true;
			deferred.reject(reason);
		};
		const forwardAbort = (): void => controller.abort(signal.reason);
		const operation: QueuedPaneOperation = {
			sessionId,
			paneId,
			controller,
			started: false,
			run,
			resolve,
			reject,
			abort: () => {
				const reason = controller.signal.reason;
				reject(reason instanceof PaneBrokerError ? reason : new PaneBrokerError("cancelled", "call was cancelled"));
				if (operation.started) return;
				const pending = this.#paneQueues.get(paneId);
				const index = pending?.indexOf(operation) ?? -1;
				if (index >= 0) pending!.splice(index, 1);
				operation.cleanup();
				if (pending?.length === 0) this.#paneQueues.delete(paneId);
				this.#drainQueues();
			},
			cleanup: () => {
				signal.removeEventListener("abort", forwardAbort);
				controller.signal.removeEventListener("abort", operation.abort);
				this.#operations.delete(operation);
			},
		};
		signal.addEventListener("abort", forwardAbort, { once: true });
		controller.signal.addEventListener("abort", operation.abort, { once: true });
		this.#operations.add(operation);
		queue.push(operation);
		this.#paneQueues.set(paneId, queue);
		if (signal.aborted) forwardAbort();
		else this.#drainQueues();
		return deferred.promise;
	}

	#drainQueues(): void {
		if (this.#runningOperations >= MAX_GLOBAL_OPERATIONS) return;
		for (const [paneId, queue] of this.#paneQueues) {
			if (this.#runningOperations >= MAX_GLOBAL_OPERATIONS) return;
			if (this.#runningPanes.has(paneId)) continue;
			const operation = queue.shift();
			if (!operation) {
				this.#paneQueues.delete(paneId);
				continue;
			}
			if (queue.length === 0) this.#paneQueues.delete(paneId);
			if (operation.controller.signal.aborted) {
				operation.abort();
				continue;
			}
			operation.started = true;
			this.#runningPanes.add(paneId);
			this.#runningOperations++;
			void operation
				.run(operation.controller.signal)
				.then(operation.resolve, operation.reject)
				.finally(() => {
					operation.cleanup();
					this.#runningPanes.delete(paneId);
					this.#runningOperations--;
					this.#drainQueues();
				});
		}
	}

	#cancelOperations(
		sessionId?: string,
		paneId?: string,
		reason = new PaneBrokerError("cancelled", "authorization was revoked"),
	): void {
		for (const operation of this.#operations) {
			if (sessionId !== undefined && operation.sessionId !== sessionId) continue;
			if (paneId !== undefined && operation.paneId !== paneId) continue;
			operation.controller.abort(reason);
		}
	}

	#validateLease(
		sessionId: string,
		incarnation: string,
		paneId: string,
		documentEpoch: number,
		action: string,
	): PaneBrokerContext {
		const lease = this.#leases.get(leaseKey(sessionId, incarnation, paneId));
		if (!lease?.healthy) throw new PaneBrokerError("unauthorized_pane", "authorize this pane in Gradivus");
		if (!OBSERVE_ACTIONS.has(action) && lease.access !== "control") this.#requireControl(lease);
		let context: PaneBrokerContext;
		try {
			context = this.#adapter.resolve(sessionId, paneId);
		} catch (error) {
			throw new PaneBrokerError("pane_closed", error instanceof Error ? error.message : String(error));
		}
		if (!context.visible) throw new PaneBrokerError("pane_hidden", "the pane is not operationally visible");
		if (!this.#matchesLease(lease, context)) {
			this.#leases.delete(leaseKey(sessionId, incarnation, paneId));
			throw new PaneBrokerError("unauthorized_pane", "pane identity changed; authorize it again");
		}
		if (context.documentEpoch !== documentEpoch) throw new PaneBrokerError("stale_epoch", "document epoch changed");
		return context;
	}

	#requireControl(lease: Lease): void {
		if (lease.access !== "control") throw new PaneBrokerError("insufficient_scope", "Control access is required");
	}

	async #ensureDebugger(context: PaneBrokerContext, sessionId: string, incarnation: string): Promise<void> {
		const existing = this.#debuggers.get(context.paneId);
		if (existing?.state === "owned" && existing.webContents === context.webContents) return;
		if (context.webContents.debugger.isAttached()) {
			throw new PaneBrokerError("debugger_busy", "another debugger owns this pane");
		}
		const ownership: DebuggerOwnership = {
			state: "attaching",
			webContents: context.webContents,
			detach: () => {
				const current = this.#debuggers.get(context.paneId);
				if (current !== ownership || current.state === "detaching") return;
				current.state = "lost";
				for (const [key, lease] of this.#leases) {
					if (lease.paneId === context.paneId) this.#leases.delete(key);
				}
				this.#debuggers.delete(context.paneId);
				this.#cancelOperations(
					undefined,
					context.paneId,
					new PaneBrokerError("debugger_lost", "browser debugger ownership was lost"),
				);
			},
		};
		this.#debuggers.set(context.paneId, ownership);
		context.webContents.debugger.on("detach", ownership.detach);
		try {
			context.webContents.debugger.attach("1.3");
			ownership.state = "owned";
		} catch (error) {
			context.webContents.debugger.removeListener("detach", ownership.detach);
			this.#debuggers.delete(context.paneId);
			throw new PaneBrokerError("debugger_busy", error instanceof Error ? error.message : String(error));
		}
		void sessionId;
		void incarnation;
	}

	async #detachDebugger(paneId: string): Promise<void> {
		const ownership = this.#debuggers.get(paneId);
		if (!ownership) return;
		ownership.state = "detaching";
		try {
			if (ownership.webContents.debugger.isAttached()) ownership.webContents.debugger.detach();
		} finally {
			ownership.webContents.debugger.removeListener("detach", ownership.detach);
			this.#debuggers.delete(paneId);
		}
	}

	#sameContext(left: PaneBrokerContext, right: PaneBrokerContext): boolean {
		return (
			left.paneId === right.paneId &&
			left.tabId === right.tabId &&
			left.browserId === right.browserId &&
			left.workspaceId === right.workspaceId &&
			left.locationId === right.locationId &&
			left.locationGeneration === right.locationGeneration &&
			left.documentEpoch === right.documentEpoch &&
			left.webContents.id === right.webContents.id
		);
	}

	#matchesLease(lease: Lease, context: PaneBrokerContext): boolean {
		return (
			lease.tabId === context.tabId &&
			lease.browserId === context.browserId &&
			lease.workspaceId === context.workspaceId &&
			lease.locationId === context.locationId &&
			lease.locationGeneration === context.locationGeneration &&
			lease.webContentsId === context.webContents.id
		);
	}

	#leaseView(lease: Lease, context: PaneBrokerContext): PaneAutomationLeaseView {
		return {
			paneId: lease.paneId,
			access: lease.access,
			documentEpoch: context.documentEpoch,
			url: context.url,
			title: context.title,
			healthy: lease.healthy,
		};
	}

	#result(details: Record<string, unknown>, image?: { data: string; mimeType: string }): RpcHostToolResultBody {
		const serialized = JSON.stringify(details);
		if (Buffer.byteLength(serialized, "utf8") > SELECTION_LIMITS.maxPreviewBytes) {
			throw new PaneBrokerError("invalid_params", `result exceeds ${SELECTION_LIMITS.maxPreviewBytes} bytes`);
		}
		return {
			content: [
				{ type: "text", text: serialized },
				...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : []),
			],
			details,
		};
	}
}

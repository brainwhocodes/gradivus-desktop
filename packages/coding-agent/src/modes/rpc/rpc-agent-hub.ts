import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { type AgentProgress, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../task";
import type { EventBus } from "../../utils/event-bus";
import { type RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcAgentHubActionResult,
	RpcAgentHubAgent,
	RpcAgentHubMessagePage,
	RpcAgentHubSnapshot,
	RpcAgentHubUpdateFrame,
} from "./rpc-types";

export interface RpcAgentHubDeps {
	output: (frame: RpcAgentHubUpdateFrame) => void;
	registry?: AgentRegistry;
	lifecycle?: AgentLifecycleManager;
	eventBus?: EventBus;
	subagentRegistry?: RpcSubagentRegistry;
}

/** Process-local Agent Hub facade. All transcript access is resolved through
 * AgentRegistry refs; callers never provide a session-file path. */
export class RpcAgentHub {
	readonly #registry: AgentRegistry;
	readonly #lifecycle: AgentLifecycleManager;
	readonly #eventBus: EventBus | undefined;
	readonly #subagentRegistry: RpcSubagentRegistry | undefined;
	readonly #output: (frame: RpcAgentHubUpdateFrame) => void;
	readonly #unsubscribers: Array<() => void> = [];
	#ready = false;

	constructor(deps: RpcAgentHubDeps) {
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#lifecycle = deps.lifecycle ?? AgentLifecycleManager.global();
		this.#eventBus = deps.eventBus;
		this.#subagentRegistry = deps.subagentRegistry;
		this.#output = deps.output;
	}

	/** Hydrate retained refs before exposing the first roster snapshot. */
	async initialize(sessionFile: string | null | undefined): Promise<void> {
		if (this.#ready) return;
		await registerPersistedSubagents(this.#registry, sessionFile);
		this.#ready = true;
		this.#unsubscribers.push(this.#registry.onChange(() => this.#emitUpdate()));
		if (this.#eventBus) {
			this.#unsubscribers.push(this.#eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, () => this.#emitUpdate()));
		}
		this.#emitUpdate();
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		this.#ready = false;
	}

	getSnapshot(): RpcAgentHubSnapshot {
		const progressById = new Map<string, AgentProgress>();
		for (const snapshot of this.#subagentRegistry?.getSubagents() ?? []) {
			if (snapshot.progress) progressById.set(snapshot.id, snapshot.progress);
		}
		const agents = this.#registry
			.list()
			.filter(
				(ref): ref is AgentRef & { kind: "sub" | "advisor" } => ref.id !== MAIN_AGENT_ID && ref.kind !== "main",
			)
			.map(ref => this.#toAgent(ref, ref.status === "running" ? progressById.get(ref.id) : undefined))
			.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
		return { agents };
	}

	async getMessages(agentId: string, fromByte?: number): Promise<RpcAgentHubMessagePage> {
		if (fromByte !== undefined && !Number.isFinite(fromByte)) throw new Error("fromByte must be a finite number");
		const ref = this.#requireRef(agentId);
		if (!ref.sessionFile) throw new Error(`Agent "${agentId}" has no transcript available`);
		const page = await readRpcSubagentTranscript(ref.sessionFile, fromByte);
		return {
			fromByte: page.fromByte,
			nextByte: page.nextByte,
			reset: page.reset,
			entries: page.entries,
			messages: page.messages,
		};
	}

	async message(agentId: string, text: string): Promise<RpcAgentHubActionResult> {
		const message = typeof text === "string" ? text.trim() : "";
		if (!message) throw new Error("message must not be empty");
		const ref = this.#requireRef(agentId);
		this.#assertMessageable(ref);
		let session = ref.session;
		if (ref.status === "parked" || this.#lifecycle.isParking(agentId, ref)) {
			session = await this.#lifecycle.ensureLive(agentId);
		}
		if (!session) throw new Error(`Agent "${agentId}" has no live session`);
		await session.prompt(message, { streamingBehavior: "steer" });
		return { agentId };
	}

	async kill(agentId: string): Promise<RpcAgentHubActionResult> {
		const ref = this.#requireRef(agentId);
		if (ref.kind === "advisor")
			throw new Error(`Agent "${agentId}" is a read-only advisor transcript and cannot be killed`);
		if (ref.status === "aborted") throw new Error(`Agent "${agentId}" is already aborted`);
		if (ref.status === "running" && ref.session) await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		const released = await this.#lifecycle.release(agentId, ref, { tombstone: true });
		if (!released) throw new Error(`Agent "${agentId}" changed before it could be killed`);
		return { agentId };
	}

	async revive(agentId: string): Promise<RpcAgentHubActionResult> {
		const ref = this.#requireRef(agentId);
		if (ref.kind === "advisor")
			throw new Error(`Agent "${agentId}" is a read-only advisor transcript and cannot be revived`);
		if (ref.status === "aborted") throw new Error(`Agent "${agentId}" is aborted and cannot be revived`);
		if (ref.status !== "parked")
			throw new Error(`Agent "${agentId}" is ${ref.status} — only parked agents can be revived`);
		await this.#lifecycle.ensureLive(agentId);
		return { agentId };
	}

	#requireRef(agentId: string): AgentRef {
		if (!agentId || agentId === MAIN_AGENT_ID)
			throw new Error(`Unknown Agent Hub agent: ${agentId || MAIN_AGENT_ID}`);
		const ref = this.#registry.get(agentId);
		if (!ref || ref.kind === "main") throw new Error(`Unknown Agent Hub agent: ${agentId}`);
		return ref;
	}

	#assertMessageable(ref: AgentRef): void {
		if (ref.kind === "advisor")
			throw new Error(`Agent "${ref.id}" is a read-only advisor transcript and cannot be messaged`);
		if (ref.status === "aborted") throw new Error(`Agent "${ref.id}" is aborted and cannot be messaged`);
	}

	#toAgent(ref: AgentRef & { kind: "sub" | "advisor" }, progress: AgentProgress | undefined): RpcAgentHubAgent {
		const history = ref.history;
		const sourceMetrics = progress
			? {
					tokens: progress.tokens,
					requests: progress.requests,
					tools: progress.toolCount,
					cost: progress.cost,
					durationMs: progress.durationMs,
					contextTokens: progress.contextTokens,
					contextWindow: progress.contextWindow,
				}
			: history?.metrics;
		const metrics = sourceMetrics
			? {
					tokens: sourceMetrics.tokens,
					requests: sourceMetrics.requests,
					tools: sourceMetrics.tools,
					cost: sourceMetrics.cost,
					durationMs: sourceMetrics.durationMs,
					...(sourceMetrics.contextTokens === undefined ? {} : { contextTokens: sourceMetrics.contextTokens }),
					...(sourceMetrics.contextWindow === undefined ? {} : { contextWindow: sourceMetrics.contextWindow }),
				}
			: undefined;
		const safeProgress = progress
			? {
					...(progress.currentTool === undefined ? {} : { currentTool: progress.currentTool }),
					...(progress.lastIntent === undefined ? {} : { lastIntent: progress.lastIntent }),
					tokens: progress.tokens,
					...(progress.contextTokens === undefined ? {} : { contextTokens: progress.contextTokens }),
					...(progress.contextWindow === undefined ? {} : { contextWindow: progress.contextWindow }),
					cost: progress.cost,
					durationMs: progress.durationMs,
					recentOutput: progress.recentOutput,
					...(progress.resolvedModel === undefined ? {} : { resolvedModel: progress.resolvedModel }),
					requests: progress.requests,
				}
			: undefined;
		const activity = ref.activity ?? progress?.lastIntent ?? progress?.currentTool ?? progress?.task;
		const agent = progress?.agent ?? history?.agent;
		const modelRole = progress?.modelRole ?? history?.modelRole;
		const resolvedModel = progress?.resolvedModel ?? history?.resolvedModel;
		return {
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			...(ref.parentId === undefined ? {} : { parentId: ref.parentId }),
			status: ref.status,
			...(activity === undefined ? {} : { activity }),
			createdAt: ref.createdAt,
			lastActivity: ref.lastActivity,
			transcriptAvailable: Boolean(ref.sessionFile),
			readOnly: ref.kind === "advisor" || history?.readOnly === true,
			...(agent === undefined ? {} : { agent }),
			...(modelRole === undefined ? {} : { modelRole }),
			...(resolvedModel === undefined ? {} : { resolvedModel }),
			...(metrics ? { metrics } : {}),
			...(safeProgress ? { progress: safeProgress } : {}),
		};
	}

	#emitUpdate(): void {
		if (!this.#ready) return;
		this.#output({ type: "agent_hub_update", ...this.getSnapshot() });
	}
}

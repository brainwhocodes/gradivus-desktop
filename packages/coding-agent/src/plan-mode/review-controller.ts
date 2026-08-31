import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { isRecord, logger, type PlanReviewAnnotationState, prompt, writeTextFileAtomic } from "@oh-my-pi/pi-utils";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls";
import planFilenamePrompt from "../prompts/system/plan-filename.md" with { type: "text" };
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { AgentSession, ResolvedRoleModel } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type { ConfiguredThinkingLevel } from "../thinking";
import { humanizePlanTitle, type PlanApprovalDetails, resolvePlanTitle } from "./approved-plan";
import { listPlanFiles, readPlanFile } from "./plan-files";
import { planSaveFileName, planSaveTitleExcerpt } from "./plan-save";
import type { PlanModeReviewMarker, PlanModeState, PlanReviewPhase, PlanReviewStatus } from "./state";

const KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;
const REVIEW_SIDECAR_VERSION = 1;
const REVIEW_SIDECAR_DIR = "local://.plan-review";
const PLAN_REVIEW_PROMPT_ADMITTED = "plan-review-prompt-admitted";
const PLAN_FILENAME_SYSTEM_PROMPT = prompt.render(planFilenamePrompt);

export interface ApprovedPlanDocument {
	title: string;
	planFilePath: string;
	content: string;
}

export type PlanCompactionOutcome = "ok" | "cancelled" | "failed";

export interface PlanReviewExecutionModel {
	role: string;
	provider: string;
	modelId: string;
	label: string;
	thinkingLevel?: ConfiguredThinkingLevel;
}

export interface PlanReviewContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export type PlanReviewDecision =
	| { kind: "approve"; context: "fresh" | "compact" | "keep"; executionRole?: string }
	| { kind: "refine"; feedback: string; images?: ImageContent[] }
	| { kind: "save"; outputPath: string };

export interface PlanReviewUpdate {
	reviewId: string;
	content: string;
	expectedRevision: string;
	annotationState: PlanReviewAnnotationState;
}

export interface PlanReviewResolution {
	reviewId: string;
	expectedRevision: string;
	decision: PlanReviewDecision;
}

export interface PlanReviewResolutionResult {
	accepted: true;
	awaitingRefinement?: true;
}

export interface PlanReviewCompletion {
	dispatched: boolean;
	sessionReset: boolean;
	savedPath?: string;
}

export interface PlanReviewSessionReset {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
}

export interface PlanReviewState extends PlanModeReviewMarker {
	content: string;
	annotationState: PlanReviewAnnotationState;
	suggestedSaveName: string;
	contextUsage?: PlanReviewContextUsage;
	keepContextDisabled: boolean;
	executionModels: PlanReviewExecutionModel[];
	defaultExecutionRole?: string;
	error?: string;
}

export interface PlanModeReviewHost {
	session: AgentSession;
	resetForApprovedPlan(document: ApprovedPlanDocument): Promise<void>;
	compactForApprovedPlan(
		internalGuidance: string,
		beforeFlush: (outcome: PlanCompactionOutcome) => void | Promise<void>,
	): Promise<PlanCompactionOutcome>;
	submitRefinement(input: {
		text: string;
		images?: ImageContent[];
		reviewId: string;
	}): Promise<{ admittedEntryId: string; completion: Promise<void> }>;
	afterPlanSaved(outputPath: string): Promise<{ sessionReset: boolean }>;
	beforeExecutionDispatch(): void;
	emitReview(state: PlanReviewState | undefined, options?: { sessionReset?: PlanReviewSessionReset }): void;
	notifyConfigChanged(): void | Promise<void>;
	report(level: "status" | "warning" | "error", message: string): void;
}

interface PlanReviewSidecar {
	version: 1;
	id: string;
	title: string;
	planFilePath: string;
	revision: string;
	status: PlanReviewStatus;
	phase: PlanReviewPhase;
	annotationState: PlanReviewAnnotationState;
	suggestedSaveName: string;
	decision?: PlanReviewDecision;
	error?: string;
}

interface PreviousModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

interface TransitionData {
	active: PlanReviewSidecar | undefined;
	previousTools: string[] | undefined;
	previousModel: PreviousModelState | undefined;
	planModeHasEntered: boolean;
}

const transitionTokenBrand: unique symbol = Symbol("planReviewTransitionToken");
export type PlanReviewTransitionToken = { readonly [transitionTokenBrand]: true };
const transitionTokens = new WeakMap<PlanReviewTransitionToken, TransitionData>();

export class PlanReviewError extends Error {
	constructor(
		message: string,
		readonly code: "plan_review_stale" | "plan_review_conflict" | "plan_review_busy" | "plan_review_invalid",
	) {
		super(message);
		this.name = "PlanReviewError";
	}
}

function emptyAnnotationState(): PlanReviewAnnotationState {
	return { annotations: [], deletedSections: [], additionalFeedback: "" };
}

function isAnnotationState(value: unknown): value is PlanReviewAnnotationState {
	if (!isRecord(value)) return false;
	return (
		Array.isArray(value.annotations) &&
		Array.isArray(value.deletedSections) &&
		value.deletedSections.every(entry => typeof entry === "string") &&
		typeof value.additionalFeedback === "string"
	);
}

function isReviewStatus(value: unknown): value is PlanReviewStatus {
	return value === "ready" || value === "awaiting_refinement" || value === "applying" || value === "failed";
}

function isReviewPhase(value: unknown): value is PlanReviewPhase {
	return (
		value === "ready" ||
		value === "awaiting_refinement" ||
		value === "accepted" ||
		value === "mode_exited" ||
		value === "session_reset" ||
		value === "compaction_finished" ||
		value === "prompt_admitted" ||
		value === "failed"
	);
}

function isSidecar(value: unknown): value is PlanReviewSidecar {
	if (!isRecord(value)) return false;
	return (
		value.version === REVIEW_SIDECAR_VERSION &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.planFilePath === "string" &&
		typeof value.revision === "string" &&
		isReviewStatus(value.status) &&
		isReviewPhase(value.phase) &&
		isAnnotationState(value.annotationState) &&
		typeof value.suggestedSaveName === "string" &&
		(value.error === undefined || typeof value.error === "string")
	);
}

function markerFromSidecar(sidecar: PlanReviewSidecar): PlanModeReviewMarker {
	return {
		id: sidecar.id,
		title: sidecar.title,
		planFilePath: sidecar.planFilePath,
		revision: sidecar.revision,
		status: sidecar.status,
		phase: sidecar.phase,
		sidecar: `${REVIEW_SIDECAR_DIR}/${sidecar.id}.json`,
	};
}

function revisionFor(content: string): string {
	return Bun.SHA256.hash(content, "hex");
}

export class PlanModeReviewController {
	readonly #host: PlanModeReviewHost;
	#active: PlanReviewSidecar | undefined;
	#previousTools: string[] | undefined;
	#previousModel: PreviousModelState | undefined;
	#planModeHasEntered = false;
	#resolvedExecutionModels = new Map<string, ResolvedRoleModel>();
	#deferredModelTransitionApplied = false;

	constructor(host: PlanModeReviewHost) {
		this.#host = host;
	}

	get #session(): AgentSession {
		return this.#host.session;
	}

	#localProtocolOptions(): LocalProtocolOptions {
		return {
			getArtifactsDir: () => this.#session.sessionManager.getArtifactsDir(),
			getSessionId: () => this.#session.sessionManager.getSessionId(),
		};
	}

	#resolveLocal(url: string): string {
		return resolveLocalUrlToPath(url, this.#localProtocolOptions());
	}

	async #readPlan(planFilePath: string): Promise<string | null> {
		return await readPlanFile(planFilePath, {
			localProtocolOptions: this.#localProtocolOptions(),
			cwd: this.#session.sessionManager.getCwd(),
		});
	}

	async enter(options?: {
		planFilePath?: string;
		workflow?: "parallel" | "iterative";
		preserveRestoredModel?: boolean;
	}): Promise<PlanModeState> {
		const current = this.#session.getPlanModeState();
		if (current?.enabled) {
			this.#installProposalHandler();
			return current;
		}
		const mode = this.#session.sessionManager.buildSessionContext().mode;
		if (mode !== "none" && mode !== "plan" && mode !== "plan_paused") {
			throw new PlanReviewError(`Exit ${mode.replaceAll("_", " ")} mode first.`, "plan_review_invalid");
		}

		const planFilePath = options?.planFilePath ?? "local://PLAN.md";
		const previousTools = this.#session.getEnabledToolNames();
		const planTools = this.#session.hasBuiltInTool("write")
			? [...new Set([...previousTools, "write"])]
			: previousTools;
		this.#previousTools = previousTools;
		this.#previousModel = this.#session.model
			? { model: this.#session.model, thinkingLevel: this.#session.configuredThinkingLevel() }
			: undefined;

		const state: PlanModeState = {
			enabled: true,
			planFilePath,
			workflow: options?.workflow ?? "parallel",
			reentry: this.#planModeHasEntered,
		};
		this.#session.setPlanModeState(state);
		try {
			await this.#session.setActiveToolsByName(planTools);
		} catch (error) {
			this.#session.setPlanModeState(current);
			this.#previousTools = undefined;
			this.#previousModel = undefined;
			throw error;
		}
		this.#installProposalHandler();
		if (this.#session.isStreaming) await this.#session.sendPlanModeContext({ deliverAs: "steer" });
		this.#planModeHasEntered = true;
		if (!options?.preserveRestoredModel) await this.#applyPlanModel();
		this.#session.sessionManager.appendModeChange("plan", { planFilePath });
		this.#host.report("status", `Plan mode enabled. Plan file: ${planFilePath}`);
		await this.#host.notifyConfigChanged();
		return state;
	}

	async exit(options?: {
		paused?: boolean;
		deferModelRestore?: boolean;
		interruptActiveTurn?: boolean;
	}): Promise<void> {
		if (!this.#session.getPlanModeState()?.enabled) return;
		const teardown = async (): Promise<void> => {
			if (options?.interruptActiveTurn && this.#session.isStreaming) {
				await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
			}
			await this.#tearDown(options);
		};
		if (options?.interruptActiveTurn && this.#session.isStreaming) {
			await this.#session.runModeExitTeardown(teardown);
		} else {
			await teardown();
		}
	}

	async #tearDown(options?: { paused?: boolean; deferModelRestore?: boolean }): Promise<void> {
		const state = this.#session.getPlanModeState();
		const planTools = this.#session.getEnabledToolNames();
		const mountedTools = this.#session.getMountedXdevToolNames();
		const planModel = this.#session.model
			? { model: this.#session.model, thinkingLevel: this.#session.configuredThinkingLevel() }
			: undefined;
		this.#session.setPlanModeState(undefined);
		try {
			if (this.#previousTools) await this.#session.setActiveToolsByName(this.#previousTools);
			if (this.#previousModel && !options?.deferModelRestore) await this.#restoreModel(this.#previousModel);
		} catch (error) {
			this.#session.setPlanModeState(state);
			if (planModel) await this.#restoreModel(planModel).catch(() => {});
			await this.#session.setActiveToolPresentation(planTools, mountedTools).catch(() => {});
			throw error;
		}
		this.#session.setPlanProposalHandler(null);
		this.#previousTools = undefined;
		if (!options?.deferModelRestore) this.#previousModel = undefined;
		this.#session.sessionManager.appendModeChange(options?.paused ? "plan_paused" : "none");
		await this.#host.notifyConfigChanged();
	}

	async stage(details: PlanApprovalDetails): Promise<PlanReviewState> {
		if (!this.#session.getPlanModeState()?.enabled) {
			throw new PlanReviewError("Plan mode is not active.", "plan_review_invalid");
		}
		this.#session.markPlanInternalAbortPending();
		try {
			await this.#session.abort();
		} finally {
			this.#session.clearPlanInternalAbortPending();
		}

		const planState = this.#session.getPlanModeState();
		const planFilePath = details.planFilePath || planState?.planFilePath || "local://PLAN.md";
		const content = await this.#readPlan(planFilePath);
		if (!content?.trim()) throw new PlanReviewError(`Plan file not found at ${planFilePath}`, "plan_review_invalid");
		const revision = revisionFor(content);
		if (
			this.#active &&
			this.#active.planFilePath === planFilePath &&
			this.#active.revision === revision &&
			this.#active.status !== "applying"
		) {
			const existing = await this.#buildState(this.#active, content);
			this.#host.emitReview(existing);
			return existing;
		}

		const title = details.title || resolvePlanTitle({ planContent: content, planFilePath }).title;
		const sidecar: PlanReviewSidecar = {
			version: REVIEW_SIDECAR_VERSION,
			id: `plan-${Bun.randomUUIDv7()}`,
			title,
			planFilePath,
			revision,
			status: "ready",
			phase: "ready",
			annotationState: emptyAnnotationState(),
			suggestedSaveName: planSaveFileName(title),
		};
		await this.#writeSidecar(sidecar);
		this.#active = sidecar;
		this.#setReviewMarker(sidecar, true);
		const state = await this.#buildState(sidecar, content);
		this.#host.emitReview(state);
		this.#updateSuggestedSaveName(sidecar, content);
		return state;
	}

	async requestReview(): Promise<PlanReviewState> {
		await this.#restoreActive();
		if (this.#active) {
			const content = await this.#readPlan(this.#active.planFilePath);
			if (!content?.trim()) {
				throw new PlanReviewError(`Plan file not found at ${this.#active.planFilePath}`, "plan_review_invalid");
			}
			if (!this.#session.getPlanModeState()?.enabled) {
				await this.enter({ planFilePath: this.#active.planFilePath });
			}
			if (revisionFor(content) === this.#active.revision && this.#active.status !== "failed") {
				const state = await this.#buildState(this.#active, content);
				this.#host.emitReview(state);
				return state;
			}
			return await this.stage({
				planFilePath: this.#active.planFilePath,
				title: this.#active.title,
				planExists: true,
			});
		}

		if (!this.#session.getPlanModeState()?.enabled) {
			throw new PlanReviewError("Plan mode is not active.", "plan_review_invalid");
		}
		const [planFilePath] = await listPlanFiles({ localProtocolOptions: this.#localProtocolOptions() });
		if (!planFilePath) {
			throw new PlanReviewError(
				"No plan to review yet — write one to a local://<slug>-plan.md file first.",
				"plan_review_invalid",
			);
		}
		const content = await this.#readPlan(planFilePath);
		if (!content?.trim()) throw new PlanReviewError(`Plan file not found at ${planFilePath}`, "plan_review_invalid");
		const { title } = resolvePlanTitle({ planContent: content, planFilePath });
		return await this.stage({ planFilePath, title, planExists: true });
	}

	async update(input: PlanReviewUpdate): Promise<PlanReviewState> {
		const active = await this.#requireActive(input.reviewId);
		if (active.status === "applying")
			throw new PlanReviewError("The plan action is already applying.", "plan_review_busy");
		if (active.status === "failed")
			throw new PlanReviewError("Retry review setup before editing this plan.", "plan_review_busy");
		const currentContent = await this.#readPlan(active.planFilePath);
		if (
			currentContent === null ||
			revisionFor(currentContent) !== input.expectedRevision ||
			active.revision !== input.expectedRevision
		) {
			throw new PlanReviewError("The plan changed outside the review.", "plan_review_conflict");
		}

		let revision = active.revision;
		if (input.content !== currentContent) {
			await writeTextFileAtomic(this.#resolvePlanPath(active.planFilePath), input.content);
			revision = revisionFor(input.content);
		}
		active.revision = revision;
		active.annotationState = input.annotationState;
		delete active.error;
		await this.#writeSidecar(active);
		this.#setReviewMarker(active, false);
		const state = await this.#buildState(active, input.content);
		this.#host.emitReview(state);
		return state;
	}

	async resolve(input: PlanReviewResolution): Promise<{
		result: PlanReviewResolutionResult;
		completion?: Promise<PlanReviewCompletion>;
	}> {
		const active = await this.#requireActive(input.reviewId);
		if (active.status === "applying")
			throw new PlanReviewError("The plan action is already applying.", "plan_review_busy");
		if (active.status === "failed")
			throw new PlanReviewError("Retry review setup before resolving this plan.", "plan_review_busy");
		const content = await this.#readPlan(active.planFilePath);
		if (
			content === null ||
			active.revision !== input.expectedRevision ||
			revisionFor(content) !== input.expectedRevision
		) {
			throw new PlanReviewError("The plan changed outside the review.", "plan_review_conflict");
		}
		this.#validateDecision(input.decision);

		if (input.decision.kind === "refine" && input.decision.feedback.trim().length === 0) {
			active.status = "awaiting_refinement";
			active.phase = "awaiting_refinement";
			active.decision = input.decision;
			delete active.error;
			await this.#writeSidecar(active);
			this.#setReviewMarker(active, true);
			this.#host.emitReview(await this.#buildState(active, content));
			return { result: { accepted: true, awaitingRefinement: true } };
		}

		active.status = "applying";
		active.phase = "accepted";
		active.decision = input.decision;
		delete active.error;
		await this.#writeSidecar(active);
		this.#setReviewMarker(active, true);
		this.#host.emitReview(await this.#buildState(active, content));
		const completion = this.#completeResolution(active, content, input.decision);
		return { result: { accepted: true }, completion };
	}

	async snapshot(): Promise<PlanReviewState | undefined> {
		await this.#restoreActive();
		if (!this.#active) return undefined;
		const content = await this.#readPlan(this.#active.planFilePath);
		if (content === null) {
			return await this.#failActive(`Plan file not found at ${this.#active.planFilePath}`, "error");
		}
		return await this.#buildState(this.#active, content);
	}

	suspendForSessionTransition(): PlanReviewTransitionToken {
		const token = { [transitionTokenBrand]: true } as PlanReviewTransitionToken;
		transitionTokens.set(token, {
			active: this.#active,
			previousTools: this.#previousTools,
			previousModel: this.#previousModel,
			planModeHasEntered: this.#planModeHasEntered,
		});
		this.#session.setPlanProposalHandler(null);
		this.#active = undefined;
		this.#previousTools = undefined;
		this.#previousModel = undefined;
		return token;
	}

	async restoreAfterSessionTransition(token: PlanReviewTransitionToken, changed: boolean): Promise<void> {
		const data = transitionTokens.get(token);
		transitionTokens.delete(token);
		if (!data) throw new Error("Invalid plan review transition token.");
		if (!changed) {
			this.#active = data.active;
			this.#previousTools = data.previousTools;
			this.#previousModel = data.previousModel;
			this.#planModeHasEntered = data.planModeHasEntered;
		} else {
			this.#active = undefined;
			this.#previousTools = undefined;
			this.#previousModel = undefined;
			this.#planModeHasEntered = false;
			await this.#restoreActive();
		}
		if (this.#session.getPlanModeState()?.enabled) this.#installProposalHandler();
		this.#host.emitReview(await this.snapshot());
	}

	async #completeResolution(
		sidecar: PlanReviewSidecar,
		content: string,
		decision: PlanReviewDecision,
	): Promise<PlanReviewCompletion> {
		try {
			if (decision.kind === "save") return await this.#completeSave(sidecar, content, decision.outputPath);
			if (decision.kind === "refine") return await this.#completeRefinement(sidecar, decision);
			return await this.#completeApproval(sidecar, content, decision);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.#active?.id === sidecar.id) await this.#failActive(message, "error");
			throw error;
		}
	}

	async #completeSave(sidecar: PlanReviewSidecar, content: string, outputPath: string): Promise<PlanReviewCompletion> {
		await writeTextFileAtomic(outputPath, content);
		await this.exit();
		const { sessionReset } = await this.#host.afterPlanSaved(outputPath);
		await this.#clearReview(sidecar);
		this.#host.report("status", `Saved plan to ${outputPath}.`);
		return { dispatched: false, sessionReset, savedPath: outputPath };
	}

	async #completeRefinement(
		sidecar: PlanReviewSidecar,
		decision: Extract<PlanReviewDecision, { kind: "refine" }>,
	): Promise<PlanReviewCompletion> {
		try {
			const admission = await this.#host.submitRefinement({
				text: decision.feedback,
				images: decision.images,
				reviewId: sidecar.id,
			});
			await this.#markPromptAdmitted(sidecar);
			await this.#clearReview(sidecar);
			await admission.completion;
			return { dispatched: true, sessionReset: false };
		} catch (error) {
			sidecar.status = "ready";
			sidecar.phase = "ready";
			delete sidecar.decision;
			sidecar.error = error instanceof Error ? error.message : String(error);
			await this.#writeSidecar(sidecar);
			this.#active = sidecar;
			this.#setReviewMarker(sidecar, true);
			const content = (await this.#readPlan(sidecar.planFilePath)) ?? "";
			this.#host.emitReview(await this.#buildState(sidecar, content));
			throw error;
		}
	}

	async #completeApproval(
		sidecar: PlanReviewSidecar,
		content: string,
		decision: Extract<PlanReviewDecision, { kind: "approve" }>,
	): Promise<PlanReviewCompletion> {
		const document = { title: sidecar.title, planFilePath: sidecar.planFilePath, content };
		const executionModel = decision.executionRole
			? this.#resolvedExecutionModels.get(decision.executionRole)
			: undefined;
		const previousTools = this.#previousTools ?? this.#session.getEnabledToolNames();
		const previousModel = this.#previousModel;
		const oldSidecarPath = this.#sidecarPath(sidecar.id);
		let sessionReset = false;
		let compactOutcome: PlanCompactionOutcome | undefined;
		this.#deferredModelTransitionApplied = false;

		if (decision.context === "compact") this.#session.markPlanInternalAbortPending();
		try {
			await this.exit({ deferModelRestore: decision.context === "compact" });
			await this.#advancePhase(sidecar, "mode_exited");
			if (decision.context === "fresh") {
				await this.#host.resetForApprovedPlan(document);
				sessionReset = true;
				await this.#migrateSidecar(sidecar, oldSidecarPath);
				await this.#advancePhase(sidecar, "session_reset", this.#currentSessionReset());
			} else if (decision.context === "compact") {
				this.#session.setPlanReferencePath(sidecar.planFilePath);
				compactOutcome = await this.#host.compactForApprovedPlan(
					prompt.render(planModeCompactInstructionsPrompt, { planFilePath: sidecar.planFilePath }),
					outcome => this.#applyDeferredModelTransition(outcome, executionModel, previousModel),
				);
				await this.#advancePhase(sidecar, "compaction_finished");
			}
		} finally {
			this.#session.clearPlanInternalAbortPending();
		}

		const executionTools = previousTools.includes("read") ? previousTools : [...previousTools, "read"];
		await this.#session.setActiveToolsByName(executionTools);
		this.#session.setPlanReferencePath(sidecar.planFilePath);
		if (decision.context === "compact") {
			await this.#applyDeferredModelTransition(compactOutcome, executionModel, previousModel);
		} else if (executionModel) {
			await this.#session.applyRoleModel(executionModel);
		} else if (previousModel) {
			await this.#restoreModel(previousModel);
		}

		if (compactOutcome === "cancelled") {
			this.#host.report(
				"warning",
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			await this.#clearReview(sidecar);
			return { dispatched: false, sessionReset };
		}

		const seededName = humanizePlanTitle(sidecar.title);
		if (seededName && !this.#session.sessionManager.getSessionName()) {
			await this.#session.sessionManager.setSessionName(seededName, "auto");
		}
		this.#host.beforeExecutionDispatch();
		const approvedPrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: sidecar.planFilePath,
			contextPreserved: decision.context !== "fresh",
		});
		const admission = await this.#session.dispatchPlanReviewPrompt({
			kind: "approved",
			reviewId: sidecar.id,
			planFilePath: sidecar.planFilePath,
			content: approvedPrompt,
		});
		await this.#markPromptAdmitted(sidecar);
		await this.#clearReview(sidecar);
		await admission.completion;
		return { dispatched: true, sessionReset };
	}

	async #applyPlanModel(): Promise<void> {
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		if (modelsAreEqual(this.#session.model, resolved.model)) {
			if (resolved.explicitThinkingLevel) this.#session.setThinkingLevel(resolved.thinkingLevel);
			return;
		}
		if (this.#session.isStreaming) return;
		try {
			await this.#session.setModelTemporary(
				resolved.model,
				resolved.explicitThinkingLevel ? resolved.thinkingLevel : undefined,
			);
		} catch (error) {
			this.#host.report(
				"warning",
				`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #restoreModel(previous: PreviousModelState): Promise<void> {
		if (modelsAreEqual(this.#session.model, previous.model)) {
			this.#session.setThinkingLevel(previous.thinkingLevel);
			return;
		}
		if (this.#session.isStreaming) return;
		await this.#session.setModelTemporary(previous.model, previous.thinkingLevel);
	}

	async #applyDeferredModelTransition(
		outcome: PlanCompactionOutcome | undefined,
		executionModel: ResolvedRoleModel | undefined,
		previousModel: PreviousModelState | undefined,
	): Promise<void> {
		if (this.#deferredModelTransitionApplied || outcome === "failed") return;
		this.#deferredModelTransitionApplied = true;
		this.#previousModel = undefined;
		if (executionModel) await this.#session.applyRoleModel(executionModel);
		else if (previousModel) await this.#restoreModel(previousModel);
	}

	#validateDecision(decision: PlanReviewDecision): void {
		if (decision.kind === "approve") {
			if (!this.#session.getPlanModeState()?.enabled) {
				throw new PlanReviewError("Plan mode is not active.", "plan_review_invalid");
			}
			const usage = this.#contextUsage();
			if (decision.context === "keep" && usage && usage.percent > KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT) {
				throw new PlanReviewError("Context usage is too high to keep the planning context.", "plan_review_invalid");
			}
			this.#refreshExecutionModels();
			if (decision.executionRole && !this.#resolvedExecutionModels.has(decision.executionRole)) {
				throw new PlanReviewError(`Unknown execution role: ${decision.executionRole}`, "plan_review_invalid");
			}
		}
		if (decision.kind === "save" && !path.isAbsolute(decision.outputPath)) {
			throw new PlanReviewError("Plan save destination must be an absolute path.", "plan_review_invalid");
		}
	}

	async #requireActive(reviewId: string): Promise<PlanReviewSidecar> {
		await this.#restoreActive();
		if (!this.#active || this.#active.id !== reviewId) {
			throw new PlanReviewError("This plan review is no longer current.", "plan_review_stale");
		}
		return this.#active;
	}

	async #buildState(sidecar: PlanReviewSidecar, content: string): Promise<PlanReviewState> {
		const contextUsage = this.#contextUsage();
		const { rows, defaultRole } = this.#refreshExecutionModels();
		return {
			...markerFromSidecar(sidecar),
			content,
			annotationState: sidecar.annotationState,
			suggestedSaveName: sidecar.suggestedSaveName,
			...(contextUsage ? { contextUsage } : {}),
			keepContextDisabled:
				contextUsage !== undefined && contextUsage.percent > KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT,
			executionModels: rows,
			...(defaultRole ? { defaultExecutionRole: defaultRole } : {}),
			...(sidecar.error ? { error: sidecar.error } : {}),
		};
	}

	#contextUsage(): PlanReviewContextUsage | undefined {
		const contextWindow = this.#previousModel?.model.contextWindow;
		return typeof contextWindow === "number"
			? this.#session.getContextUsage({ contextWindow })
			: this.#session.getContextUsage();
	}

	#refreshExecutionModels(): { rows: PlanReviewExecutionModel[]; defaultRole?: string } {
		this.#resolvedExecutionModels.clear();
		const cycle = this.#session.getRoleModelCycle(this.#session.settings.get("cycleOrder"));
		if (!cycle) return { rows: [] };
		for (const entry of cycle.models) this.#resolvedExecutionModels.set(entry.role, entry);
		const defaultRole =
			cycle.models.find(entry => entry.role === "default")?.role ?? cycle.models[cycle.currentIndex]?.role;
		return {
			rows: cycle.models.map(entry => ({
				role: entry.role,
				provider: entry.model.provider,
				modelId: entry.model.id,
				label: entry.model.name || entry.model.id,
				...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
			})),
			...(defaultRole ? { defaultRole } : {}),
		};
	}

	#installProposalHandler(): void {
		this.#session.setPlanProposalHandler(title => this.#session.preparePlanForReview(title));
	}

	#resolvePlanPath(planFilePath: string): string {
		if (planFilePath.startsWith("local:")) return this.#resolveLocal(planFilePath);
		return path.resolve(this.#session.sessionManager.getCwd(), planFilePath);
	}

	#sidecarPath(reviewId: string): string {
		return this.#resolveLocal(`${REVIEW_SIDECAR_DIR}/${reviewId}.json`);
	}

	async #writeSidecar(sidecar: PlanReviewSidecar): Promise<void> {
		await writeTextFileAtomic(this.#sidecarPath(sidecar.id), `${JSON.stringify(sidecar)}\n`);
	}

	#setReviewMarker(sidecar: PlanReviewSidecar, appendModeChange: boolean): void {
		const state = this.#session.getPlanModeState();
		if (!state?.enabled) return;
		const marker = markerFromSidecar(sidecar);
		this.#session.setPlanModeState({ ...state, planFilePath: sidecar.planFilePath, review: marker });
		if (appendModeChange) {
			this.#session.sessionManager.appendModeChange("plan", {
				planFilePath: sidecar.planFilePath,
				review: marker,
			});
		}
	}

	async #advancePhase(
		sidecar: PlanReviewSidecar,
		phase: PlanReviewPhase,
		sessionReset?: PlanReviewSessionReset,
	): Promise<void> {
		sidecar.phase = phase;
		await this.#writeSidecar(sidecar);
		this.#setReviewMarker(sidecar, true);
		const content = (await this.#readPlan(sidecar.planFilePath)) ?? "";
		this.#host.emitReview(await this.#buildState(sidecar, content), sessionReset ? { sessionReset } : undefined);
	}

	async #markPromptAdmitted(sidecar: PlanReviewSidecar): Promise<void> {
		sidecar.phase = "prompt_admitted";
		await this.#writeSidecar(sidecar);
	}

	async #clearReview(sidecar: PlanReviewSidecar): Promise<void> {
		await fs.rm(this.#sidecarPath(sidecar.id), { force: true });
		if (this.#active?.id === sidecar.id) this.#active = undefined;
		const state = this.#session.getPlanModeState();
		if (state?.review?.id === sidecar.id) {
			const { review: _review, ...withoutReview } = state;
			this.#session.setPlanModeState(withoutReview);
		}
		this.#host.emitReview(undefined);
		await this.#host.notifyConfigChanged();
	}

	async #failActive(message: string, level: "warning" | "error"): Promise<PlanReviewState> {
		if (!this.#active) throw new Error(message);
		this.#active.status = "failed";
		this.#active.phase = "failed";
		this.#active.error = message;
		await this.#writeSidecar(this.#active);
		this.#setReviewMarker(this.#active, true);
		this.#host.report(level, message);
		const content = (await this.#readPlan(this.#active.planFilePath)) ?? "";
		const state = await this.#buildState(this.#active, content);
		this.#host.emitReview(state);
		return state;
	}

	async #restoreActive(): Promise<void> {
		if (this.#active) return;
		const marker = this.#session.getPlanModeState()?.review;
		if (marker) {
			const restored = await this.#readSidecar(marker.id);
			if (restored) {
				this.#active = restored;
				return;
			}
		}
		const sidecars = await this.#readAllSidecars();
		const applying = sidecars.filter(sidecar => sidecar.status === "applying");
		if (applying.length === 0) return;
		if (applying.length > 1) {
			for (const sidecar of applying) {
				sidecar.status = "failed";
				sidecar.phase = "failed";
				sidecar.error = "Multiple interrupted plan actions were found; reopen the intended session branch.";
				await this.#writeSidecar(sidecar);
			}
			this.#host.report(
				"error",
				"Multiple interrupted plan actions were found; reopen the intended session branch.",
			);
			return;
		}
		const sidecar = applying[0]!;
		if (this.#hasAdmissionMarker(sidecar.id)) {
			await fs.rm(this.#sidecarPath(sidecar.id), { force: true });
			return;
		}
		sidecar.status = "failed";
		sidecar.phase = "failed";
		sidecar.error = "The previous plan action was interrupted. Review the plan before retrying.";
		await this.#writeSidecar(sidecar);
		this.#active = sidecar;
	}

	async #readSidecar(reviewId: string): Promise<PlanReviewSidecar | undefined> {
		try {
			const parsed: unknown = await Bun.file(this.#sidecarPath(reviewId)).json();
			return isSidecar(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	async #readAllSidecars(): Promise<PlanReviewSidecar[]> {
		const directory = this.#resolveLocal(REVIEW_SIDECAR_DIR);
		let names: string[];
		try {
			names = await fs.readdir(directory);
		} catch {
			return [];
		}
		const sidecars = await Promise.all(
			names
				.filter(name => name.endsWith(".json"))
				.map(async name => {
					try {
						const parsed: unknown = await Bun.file(path.join(directory, name)).json();
						return isSidecar(parsed) ? parsed : undefined;
					} catch {
						return undefined;
					}
				}),
		);
		return sidecars.filter((sidecar): sidecar is PlanReviewSidecar => sidecar !== undefined);
	}

	#hasAdmissionMarker(reviewId: string): boolean {
		return this.#session.sessionManager.getBranch().some(entry => {
			if (entry.type !== "custom" || entry.customType !== PLAN_REVIEW_PROMPT_ADMITTED || !isRecord(entry.data)) {
				return false;
			}
			return entry.data.reviewId === reviewId && typeof entry.data.admittedEntryId === "string";
		});
	}

	async #migrateSidecar(sidecar: PlanReviewSidecar, oldPath: string): Promise<void> {
		const newPath = this.#sidecarPath(sidecar.id);
		await writeTextFileAtomic(newPath, `${JSON.stringify(sidecar)}\n`);
		if (path.resolve(oldPath) !== path.resolve(newPath)) await fs.rm(oldPath, { force: true });
	}

	#currentSessionReset(): PlanReviewSessionReset {
		return {
			sessionId: this.#session.sessionId,
			...(this.#session.sessionFile ? { sessionFile: this.#session.sessionFile } : {}),
			...(this.#session.sessionName ? { sessionName: this.#session.sessionName } : {}),
		};
	}

	#updateSuggestedSaveName(sidecar: PlanReviewSidecar, content: string): void {
		const excerpt = planSaveTitleExcerpt(content);
		if (!excerpt) return;
		void this.#session
			.generateTitle(excerpt, PLAN_FILENAME_SYSTEM_PROMPT)
			.then(async title => {
				if (!title || this.#active?.id !== sidecar.id || sidecar.status === "applying") return;
				sidecar.suggestedSaveName = planSaveFileName(title);
				await this.#writeSidecar(sidecar);
				const currentContent = (await this.#readPlan(sidecar.planFilePath)) ?? content;
				this.#host.emitReview(await this.#buildState(sidecar, currentContent));
			})
			.catch(error => {
				logger.debug("plan-review: filename generation failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}
}

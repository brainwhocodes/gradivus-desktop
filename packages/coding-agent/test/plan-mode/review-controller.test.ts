import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	PlanModeReviewController,
	type PlanModeReviewHost,
	PlanReviewError,
	type PlanReviewState,
} from "@oh-my-pi/pi-coding-agent/plan-mode/review-controller";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface Harness {
	controller: PlanModeReviewController;
	planPath: string;
	root: string;
	getPlanState(): PlanModeState | undefined;
	emitted: Array<PlanReviewState | undefined>;
	submitRefinement: Mock<PlanModeReviewHost["submitRefinement"]>;
	setContextPercent(percent: number): void;
}

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

async function createHarness(): Promise<Harness> {
	const sessionId = `plan-review-${Bun.randomUUIDv7()}`;
	const localOptions = { getSessionId: () => sessionId, getArtifactsDir: () => null };
	const root = resolveLocalUrlToPath("local://", localOptions);
	roots.push(root);
	await fs.mkdir(root, { recursive: true });
	const planPath = resolveLocalUrlToPath("local://feature-plan.md", localOptions);
	await Bun.write(planPath, "# Feature\n\nShip the safe path.\n");

	let planState: PlanModeState | undefined = {
		enabled: true,
		planFilePath: "local://feature-plan.md",
		workflow: "parallel",
	};
	let contextPercent = 20;
	const modeChanges: unknown[] = [];
	const branch: Array<{
		type: "custom";
		customType: string;
		data: unknown;
		id: string;
		parentId: string | null;
		timestamp: string;
	}> = [];
	const sessionManager = {
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getCwd: () => root,
		buildSessionContext: () => ({ mode: planState?.enabled ? "plan" : "none" }),
		appendModeChange: (...args: unknown[]) => modeChanges.push(args),
		getBranch: () => branch,
		appendCustomEntry: (customType: string, data: unknown) => {
			const id = `entry-${branch.length + 1}`;
			branch.push({ type: "custom", customType, data, id, parentId: null, timestamp: new Date().toISOString() });
			return id;
		},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	};
	const session = {
		sessionManager,
		settings: { get: () => [] },
		model: undefined,
		isStreaming: false,
		sessionId,
		sessionFile: undefined,
		sessionName: undefined,
		getPlanModeState: () => planState,
		setPlanModeState: (state: PlanModeState | undefined) => {
			planState = state;
		},
		markPlanInternalAbortPending: vi.fn(),
		clearPlanInternalAbortPending: vi.fn(),
		abort: vi.fn(async () => {}),
		getEnabledToolNames: () => ["read", "write"],
		getMountedXdevToolNames: () => [],
		hasBuiltInTool: () => true,
		setActiveToolsByName: vi.fn(async () => {}),
		setActiveToolPresentation: vi.fn(async () => {}),
		setPlanProposalHandler: vi.fn(),
		preparePlanForReview: vi.fn(),
		sendPlanModeContext: vi.fn(async () => {}),
		configuredThinkingLevel: () => undefined,
		resolveRoleModelWithThinking: () => ({
			model: undefined,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
		}),
		getContextUsage: () => ({ tokens: contextPercent, contextWindow: 100, percent: contextPercent }),
		getRoleModelCycle: () => undefined,
		generateTitle: vi.fn(async () => undefined),
		setPlanReferencePath: vi.fn(),
		setThinkingLevel: vi.fn(),
		setModelTemporary: vi.fn(async () => {}),
		applyRoleModel: vi.fn(async () => {}),
		runModeExitTeardown: async (teardown: () => Promise<void>) => teardown(),
		dispatchPlanReviewPrompt: vi.fn(),
	} as unknown as AgentSession;

	const emitted: Array<PlanReviewState | undefined> = [];
	const submitRefinement = vi.fn(async () => ({ admittedEntryId: "refinement-entry", completion: Promise.resolve() }));
	const host: PlanModeReviewHost = {
		session,
		resetForApprovedPlan: async () => {},
		compactForApprovedPlan: async () => "ok",
		submitRefinement,
		afterPlanSaved: async () => ({ sessionReset: false }),
		beforeExecutionDispatch: () => {},
		emitReview: state => emitted.push(state),
		notifyConfigChanged: () => {},
		report: () => {},
	};
	return {
		controller: new PlanModeReviewController(host),
		planPath,
		root,
		getPlanState: () => planState,
		emitted,
		submitRefinement,
		setContextPercent: percent => {
			contextPercent = percent;
		},
	};
}

async function stage(harness: Harness): Promise<PlanReviewState> {
	return await harness.controller.stage({
		planFilePath: "local://feature-plan.md",
		title: "FEATURE",
		planExists: true,
	});
}

describe("PlanModeReviewController", () => {
	it("stages the plan only after owning the internal abort and persists a review marker", async () => {
		const harness = await createHarness();
		const review = await stage(harness);
		expect(review).toMatchObject({
			title: "FEATURE",
			planFilePath: "local://feature-plan.md",
			status: "ready",
			phase: "ready",
			content: "# Feature\n\nShip the safe path.\n",
		});
		expect(review.id).toStartWith("plan-");
		expect(harness.getPlanState()?.review).toMatchObject({ id: review.id, revision: review.revision });
		expect(await Bun.file(path.join(harness.root, ".plan-review", `${review.id}.json`)).exists()).toBe(true);
		expect(harness.emitted.at(-1)?.id).toBe(review.id);
	});

	it("atomically updates content and annotations and rejects an external revision conflict", async () => {
		const harness = await createHarness();
		const review = await stage(harness);
		const updated = await harness.controller.update({
			reviewId: review.id,
			expectedRevision: review.revision,
			content: "# Feature\n\nShip with rollback.\n",
			annotationState: {
				annotations: [],
				deletedSections: ["Legacy path"],
				additionalFeedback: "Keep the rollout reversible.",
			},
		});
		expect(await Bun.file(harness.planPath).text()).toBe("# Feature\n\nShip with rollback.\n");
		expect(updated.revision).not.toBe(review.revision);
		expect(updated.annotationState.deletedSections).toEqual(["Legacy path"]);

		await Bun.write(harness.planPath, "# Feature\n\nChanged elsewhere.\n");
		await expect(
			harness.controller.update({
				reviewId: review.id,
				expectedRevision: updated.revision,
				content: updated.content,
				annotationState: updated.annotationState,
			}),
		).rejects.toMatchObject({ code: "plan_review_conflict" });
	});

	it("keeps empty refinement nonterminal before accepting one terminal refinement", async () => {
		const harness = await createHarness();
		const review = await stage(harness);
		const waiting = await harness.controller.resolve({
			reviewId: review.id,
			expectedRevision: review.revision,
			decision: { kind: "refine", feedback: "" },
		});
		expect(waiting).toEqual({ result: { accepted: true, awaitingRefinement: true } });
		expect((await harness.controller.snapshot())?.status).toBe("awaiting_refinement");
		expect(harness.submitRefinement).not.toHaveBeenCalled();

		const accepted = await harness.controller.resolve({
			reviewId: review.id,
			expectedRevision: review.revision,
			decision: { kind: "refine", feedback: "Add a rollback step." },
		});
		expect(accepted.result).toEqual({ accepted: true });
		await accepted.completion;
		expect(harness.submitRefinement).toHaveBeenCalledWith({
			text: "Add a rollback step.",
			images: undefined,
			reviewId: review.id,
		});
		expect(await harness.controller.snapshot()).toBeUndefined();
	});

	it("rejects keep-context approval above the server-side usage threshold", async () => {
		const harness = await createHarness();
		harness.setContextPercent(96);
		const review = await stage(harness);
		try {
			await harness.controller.resolve({
				reviewId: review.id,
				expectedRevision: review.revision,
				decision: { kind: "approve", context: "keep" },
			});
			throw new Error("Expected keep-context validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(PlanReviewError);
			expect(error).toMatchObject({ code: "plan_review_invalid" });
		}
		expect((await harness.controller.snapshot())?.status).toBe("ready");
	});
});

export type PlanReviewStatus = "ready" | "awaiting_refinement" | "applying" | "failed";

export type PlanReviewPhase =
	| "ready"
	| "awaiting_refinement"
	| "accepted"
	| "mode_exited"
	| "session_reset"
	| "compaction_finished"
	| "prompt_admitted"
	| "failed";

export interface PlanModeReviewMarker {
	id: string;
	title: string;
	planFilePath: string;
	revision: string;
	status: PlanReviewStatus;
	phase: PlanReviewPhase;
	sidecar: string;
}

export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	review?: PlanModeReviewMarker;
}

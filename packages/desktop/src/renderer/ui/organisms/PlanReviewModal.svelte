<script lang="ts">
	import { buildPlanRefinementFeedback, joinPlanSections, parsePlanSections, sectionDeletionSpan } from "@oh-my-pi/pi-utils/plan-review";
	import type { PlanReviewAnnotationState } from "@oh-my-pi/pi-utils/plan-review";
	import { onDestroy, onMount } from "svelte";
	import type {
		PlanReviewDecisionInput,
		PlanReviewResolutionResult,
		PlanReviewView,
	} from "../../../shared/contracts";
	import MarkdownBody from "../molecules/MarkdownBody.svelte";
	import ModalShell from "../molecules/ModalShell.svelte";

	interface UpdateInput {
		reviewId: string;
		content: string;
		expectedRevision: string;
		annotationState: PlanReviewAnnotationState;
	}

	interface Props {
		review: PlanReviewView;
		disabledReason?: string;
		returnFocus?: HTMLElement | null;
		onclose: () => void;
		onupdate: (input: UpdateInput) => Promise<PlanReviewView>;
		onresolve: (decision: PlanReviewDecisionInput) => Promise<PlanReviewResolutionResult>;
		onreload: () => Promise<PlanReviewView>;
		oncopy: (content: string) => Promise<void>;
		onaccepted: (result: PlanReviewResolutionResult) => void;
	}

	let {
		review,
		disabledReason,
		returnFocus,
		onclose,
		onupdate,
		onresolve,
		onreload,
		oncopy,
		onaccepted,
	}: Props = $props();

	let loadedReviewId = $state("");
	let content = $state("");
	let revision = $state("");
	let annotationState = $state<PlanReviewAnnotationState>({
		annotations: [],
		deletedSections: [],
		additionalFeedback: "",
	});
	let dirty = $state(false);
	let draftVersion = $state(0);
	let activeSection = $state(0);
	let selectedRole = $state("");
	let copyStatus = $state("");
	let updateError = $state("");
	let conflict = $state(false);
	let submitting = $state("");
	let editingTarget = $state<
		| { kind: "section"; sectionIndex: number }
		| { kind: "line"; sectionIndex: number; row: number; context: string }
		| undefined
	>();
	let noteDraft = $state("");
	let documentScroller: HTMLElement;
	let feedbackTimer: number | undefined;
	let mutationTail: Promise<void> = Promise.resolve();
	let undoStack = $state<Array<{ content: string; annotationState: PlanReviewAnnotationState }>>([]);
	let outlineOpen = $state(false);

	const sections = $derived(parsePlanSections(content));
	const outlineSections = $derived.by(() => {
		const headingSections = sections
			.map((section, index) => ({ section, index }))
			.filter(entry => entry.section.level > 0);
		if (headingSections.length === 1 && headingSections[0]?.section.level === 1) return [];
		return headingSections;
	});
	const decisionsDisabled = $derived(
		Boolean(disabledReason) || conflict || review.status === "applying" || review.status === "failed" || Boolean(submitting),
	);

	function cloneAnnotations(value: PlanReviewAnnotationState): PlanReviewAnnotationState {
		return {
			annotations: value.annotations.map(annotation => ({
				section: {
					...annotation.section,
					...(annotation.section.path ? { path: [...annotation.section.path] } : {}),
				},
				target:
					annotation.target.kind === "section"
						? { kind: "section" }
						: {
								kind: "line",
								row: annotation.target.row,
								context: annotation.target.context,
								...(annotation.target.contextTruncated ? { contextTruncated: true } : {}),
							},
				note: annotation.note,
			})),
			deletedSections: [...value.deletedSections],
			additionalFeedback: value.additionalFeedback,
		};
	}

	function loadReview(next: PlanReviewView): void {
		loadedReviewId = next.id;
		content = next.content;
		revision = next.revision;
		annotationState = cloneAnnotations(next.annotationState);
		selectedRole = next.defaultExecutionRole ?? next.executionModels[0]?.role ?? "";
		draftVersion = 0;
		dirty = false;
		conflict = false;
		updateError = next.error ?? "";
		activeSection = 0;
		undoStack = [];
	}

	$effect(() => {
		if (review.id !== loadedReviewId || (!dirty && review.revision !== revision)) loadReview(review);
	});

	function markDirty(): void {
		draftVersion += 1;
		dirty = true;
		updateError = "";
	}

	function classifyUpdateError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		updateError = message;
		if (/changed outside|conflict|plan_review_conflict/i.test(message)) conflict = true;
	}

	function enqueueUpdate(): Promise<void> {
		const nextContent = content;
		const nextAnnotations = cloneAnnotations(annotationState);
		const version = draftVersion;
		const task = mutationTail.catch(() => {}).then(async () => {
			const updated = await onupdate({
				reviewId: loadedReviewId,
				content: nextContent,
				expectedRevision: revision,
				annotationState: nextAnnotations,
			});
			revision = updated.revision;
			if (version === draftVersion) {
				content = updated.content;
				annotationState = cloneAnnotations(updated.annotationState);
				dirty = false;
				updateError = "";
			}
		});
		mutationTail = task.catch(error => {
			classifyUpdateError(error);
			throw error;
		});
		return mutationTail;
	}

	function scheduleFeedbackUpdate(): void {
		clearTimeout(feedbackTimer);
		feedbackTimer = window.setTimeout(() => {
			feedbackTimer = undefined;
			void enqueueUpdate().catch(() => {});
		}, 500);
	}

	async function flushDraft(): Promise<void> {
		clearTimeout(feedbackTimer);
		feedbackTimer = undefined;
		if (dirty) await enqueueUpdate();
		else await mutationTail;
	}

	function beginSectionAnnotation(sectionIndex: number): void {
		editingTarget = { kind: "section", sectionIndex };
		noteDraft = "";
	}

	function beginLineAnnotation(sectionIndex: number, anchor: { row: number; context: string }): void {
		editingTarget = { kind: "line", sectionIndex, row: anchor.row, context: anchor.context };
		noteDraft = "";
	}

	function cancelAnnotation(): void {
		editingTarget = undefined;
		noteDraft = "";
	}

	function saveAnnotation(): void {
		const target = editingTarget;
		const note = noteDraft.trim();
		if (!target || !note) return;
		const section = sections[target.sectionIndex];
		if (!section) return;
		annotationState = {
			...annotationState,
			annotations: [
				...annotationState.annotations,
				{
					section: { index: target.sectionIndex, title: section.title },
					target:
						target.kind === "section"
							? { kind: "section" }
							: { kind: "line", row: target.row, context: target.context },
					note,
				},
			],
		};
		markDirty();
		cancelAnnotation();
		void enqueueUpdate().catch(() => {});
	}

	function removeAnnotation(index: number): void {
		annotationState = {
			...annotationState,
			annotations: annotationState.annotations.filter((_, annotationIndex) => annotationIndex !== index),
		};
		markDirty();
		void enqueueUpdate().catch(() => {});
	}

	function deleteSection(sectionIndex: number): void {
		const span = sectionDeletionSpan(sections, sectionIndex);
		if (span.length === 0) return;
		undoStack.push({ content, annotationState: cloneAnnotations(annotationState) });
		const removed = new Set(span);
		const removedTitles = span
			.map(index => sections[index])
			.filter(section => section?.level && section.title)
			.map(section => section!.title);
		const survivors = sections.filter((_, index) => !removed.has(index));
		const oldToNew = new Map<number, number>();
		let nextIndex = 0;
		for (let index = 0; index < sections.length; index++) {
			if (!removed.has(index)) oldToNew.set(index, nextIndex++);
		}
		content = joinPlanSections(survivors);
		annotationState = {
			...annotationState,
			annotations: annotationState.annotations.flatMap(annotation => {
				const mapped = oldToNew.get(annotation.section.index);
				return mapped === undefined
					? []
					: [{ ...annotation, section: { ...annotation.section, index: mapped } }];
			}),
			deletedSections: [...annotationState.deletedSections, ...removedTitles],
		};
		activeSection = Math.min(activeSection, Math.max(0, survivors.length - 1));
		markDirty();
		void enqueueUpdate().catch(() => {});
	}

	function undoDelete(): void {
		const snapshot = undoStack.pop();
		if (!snapshot) return;
		content = snapshot.content;
		annotationState = cloneAnnotations(snapshot.annotationState);
		markDirty();
		void enqueueUpdate().catch(() => {});
	}

	function notesForSection(sectionIndex: number): Array<{ annotation: PlanReviewAnnotationState["annotations"][number]; index: number }> {
		return annotationState.annotations.flatMap((annotation, index) =>
			annotation.section.index === sectionIndex ? [{ annotation, index }] : [],
		);
	}

	function scrollToSection(sectionIndex: number): void {
		activeSection = sectionIndex;
		const target = document.getElementById(`plan-review-section-${loadedReviewId}-${sectionIndex}`);
		target?.scrollIntoView({ block: "start", behavior: "smooth" });
		target?.focus({ preventScroll: true });
	}

	function updateVisibleSection(): void {
		const threshold = documentScroller.scrollTop + 56;
		let current = 0;
		for (let index = 0; index < sections.length; index++) {
			const target = document.getElementById(`plan-review-section-${loadedReviewId}-${index}`);
			if (target && target.offsetTop <= threshold) current = index;
		}
		activeSection = current;
	}

	async function copyMarkdown(value = content): Promise<void> {
		copyStatus = "Copying…";
		try {
			await oncopy(value);
			copyStatus = "Copied";
		} catch {
			copyStatus = "Copy failed";
		}
	}

	async function reloadLatest(): Promise<void> {
		updateError = "";
		try {
			loadReview(await onreload());
		} catch (error) {
			classifyUpdateError(error);
		}
	}

	async function decide(label: string, decision: PlanReviewDecisionInput): Promise<void> {
		if (decisionsDisabled) return;
		submitting = label;
		updateError = "";
		try {
			await flushDraft();
			const result = await onresolve(decision);
			if (!result.accepted) {
				submitting = "";
				return;
			}
			onaccepted(result);
		} catch (error) {
			classifyUpdateError(error);
			submitting = "";
		}
	}

	function updateAdditionalFeedback(value: string): void {
		annotationState = { ...annotationState, additionalFeedback: value };
		markDirty();
		scheduleFeedbackUpdate();
	}

	function handleAnnotationKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			cancelAnnotation();
		} else if (event.key === "Enter" && event.ctrlKey) {
			event.preventDefault();
			saveAnnotation();
		}
	}

	onDestroy(() => clearTimeout(feedbackTimer));
	onMount(() => {
		const media = window.matchMedia("(min-width: 901px)");
		const update = (): void => {
			outlineOpen = media.matches;
		};
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	});
</script>

<ModalShell
	backdrop
	backdropClass="plan-review-backdrop"
	dialogClass="plan-review-dialog"
	role="dialog"
	labelledbyId="plan-review-title"
	cancelable
	trapFocus
	initialFocusId="plan-review-title"
	{returnFocus}
	onclose={onclose}
>
	<header class="plan-review-header">
		<div class="plan-review-heading">
			<span class="eyebrow">Plan Review</span>
			<h2 id="plan-review-title" tabindex="-1">{review.title.replaceAll("-", " ")}</h2>
			<div class="plan-review-meta">
				<code>{review.planFilePath}</code>
				<span class={`plan-review-status status-${review.status}`}>{review.status.replaceAll("_", " ")}</span>
			</div>
		</div>
		<div class="plan-review-header-actions">
			<button type="button" class="plan-review-button quiet" onclick={() => void copyMarkdown()}>Copy Markdown</button>
			<button type="button" class="plan-review-close" aria-label="Close plan review" onclick={onclose}>×</button>
			<span class="sr-only" role="status" aria-live="polite">{copyStatus}</span>
		</div>
	</header>

	{#if updateError || disabledReason || review.error}
		<div class={`plan-review-alert${conflict ? " conflict" : ""}`} role="status">
			<strong>{conflict ? "The plan changed outside Gradivus." : "Plan review needs attention."}</strong>
			<p>{disabledReason || updateError || review.error}</p>
			<div class="plan-review-alert-actions">
				{#if conflict || review.status === "failed"}
					<button type="button" class="plan-review-button" onclick={() => void reloadLatest()}>
						{review.status === "failed" ? "Retry review setup" : "Reload latest"}
					</button>
				{/if}
				<button type="button" class="plan-review-button quiet" onclick={() => void copyMarkdown()}>Copy draft</button>
			</div>
		</div>
	{/if}

	<div class="plan-review-workspace">
		<aside class="plan-review-outline" aria-label="Plan sections">
			<details bind:open={outlineOpen}>
				<summary>Sections</summary>
				<nav>
					{#each outlineSections as entry}
						<button
							type="button"
							class:active={activeSection === entry.index}
							style={`--outline-depth: ${Math.max(0, entry.section.level - 1)}`}
							aria-current={activeSection === entry.index ? "location" : undefined}
							onclick={() => scrollToSection(entry.index)}
						>
							{entry.section.title}
						</button>
					{/each}
				</nav>
			</details>
		</aside>

		<main class="plan-review-document" bind:this={documentScroller} onscroll={updateVisibleSection}>
			{#if undoStack.length > 0}
				<div class="plan-review-undo" role="status">
					Section deleted. <button type="button" onclick={undoDelete} disabled={Boolean(submitting)}>Undo</button>
				</div>
			{/if}
			{#each sections as section, sectionIndex}
				<section
					class="plan-review-document-section"
					id={`plan-review-section-${loadedReviewId}-${sectionIndex}`}
					tabindex="-1"
				>
					{#if section.level > 0}
						<div class="plan-review-section-tools">
							<span>Line {section.startLine}</span>
							<button type="button" onclick={() => beginSectionAnnotation(sectionIndex)} disabled={decisionsDisabled}>Annotate</button>
							<button type="button" onclick={() => deleteSection(sectionIndex)} disabled={decisionsDisabled}>Delete section</button>
						</div>
					{/if}
					{#if editingTarget?.sectionIndex === sectionIndex}
						<div class="plan-review-note-editor">
							<label for={`plan-review-note-${sectionIndex}`}>
								{editingTarget.kind === "line" ? `Note on line ${editingTarget.row}: ${editingTarget.context}` : `Note on ${section.title || "plan preamble"}`}
							</label>
							<textarea
								id={`plan-review-note-${sectionIndex}`}
								rows="3"
								bind:value={noteDraft}
								onkeydown={handleAnnotationKeydown}
							></textarea>
							<div>
								<button type="button" class="plan-review-button primary" onclick={saveAnnotation} disabled={!noteDraft.trim()}>Save note</button>
								<button type="button" class="plan-review-button quiet" onclick={cancelAnnotation}>Cancel</button>
								<span>Ctrl+Enter to save · Escape to cancel</span>
							</div>
						</div>
					{/if}
					<MarkdownBody
						value={section.raw}
						className="plan-review-markdown"
						lineOffset={section.startLine - 1}
						onAnnotateLine={anchor => beginLineAnnotation(sectionIndex, anchor)}
					/>
					{#if notesForSection(sectionIndex).length > 0}
						<ul class="plan-review-notes" aria-label={`Notes on ${section.title || "plan preamble"}`}>
							{#each notesForSection(sectionIndex) as note}
								<li>
									<span>{note.annotation.target.kind === "line" ? `Line ${note.annotation.target.row}` : "Section"}</span>
									<p>{note.annotation.note}</p>
									<button type="button" onclick={() => removeAnnotation(note.index)} disabled={decisionsDisabled}>Remove</button>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/each}
		</main>

		<aside class="plan-review-decision" aria-label="Plan decision">
			<div class="plan-review-feedback">
				<label for="plan-review-additional-feedback">Additional refinement feedback</label>
				<textarea
					id="plan-review-additional-feedback"
					rows="5"
					value={annotationState.additionalFeedback}
					disabled={Boolean(submitting)}
					oninput={event => updateAdditionalFeedback(event.currentTarget.value)}
					onblur={() => void flushDraft().catch(() => {})}
				></textarea>
			</div>

			{#if review.executionModels.length >= 2}
				<fieldset class="plan-review-models" disabled={Boolean(submitting)}>
					<legend>Continue with</legend>
					<div class="plan-review-segments">
						{#each review.executionModels as model}
							<label>
								<input type="radio" name="plan-execution-role" value={model.role} bind:group={selectedRole} />
								<span>{model.role}</span>
								<small>{model.label}</small>
							</label>
						{/each}
					</div>
				</fieldset>
			{/if}

			<div class="plan-review-actions">
				<button type="button" class="plan-review-button primary" disabled={decisionsDisabled} onclick={() => void decide("Approve and execute", { kind: "approve", context: "fresh", ...(selectedRole ? { executionRole: selectedRole } : {}) })}>Approve and execute</button>
				<button type="button" class="plan-review-button" disabled={decisionsDisabled} onclick={() => void decide("Approve and compact context", { kind: "approve", context: "compact", ...(selectedRole ? { executionRole: selectedRole } : {}) })}>Approve and compact context</button>
				<button type="button" class="plan-review-button" disabled={decisionsDisabled || review.keepContextDisabled} aria-describedby={review.keepContextDisabled ? "plan-review-keep-warning" : undefined} onclick={() => void decide("Approve and keep context", { kind: "approve", context: "keep", ...(selectedRole ? { executionRole: selectedRole } : {}) })}>
					{review.contextUsage ? `Approve and keep context (~${Math.round(review.contextUsage.tokens).toLocaleString()} / ${Math.round(review.contextUsage.contextWindow).toLocaleString()})` : "Approve and keep context"}
				</button>
				{#if review.keepContextDisabled}<p id="plan-review-keep-warning" class="plan-review-warning">Context is above 95%; compact or start fresh before execution.</p>{/if}
				<button type="button" class="plan-review-button" disabled={decisionsDisabled} onclick={() => void decide("Refine plan", { kind: "refine", feedback: buildPlanRefinementFeedback(annotationState) })}>Refine plan</button>
				<button type="button" class="plan-review-button quiet" disabled={decisionsDisabled} onclick={() => void decide("Save and quit", { kind: "save" })}>Save and quit</button>
			</div>
			{#if submitting}<div class="plan-review-applying" role="status" aria-live="polite">{submitting} — applying…</div>{/if}
		</aside>
	</div>
</ModalShell>

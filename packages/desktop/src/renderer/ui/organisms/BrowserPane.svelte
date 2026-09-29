<script lang="ts">
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import { onMount, tick } from "svelte";
	import {
		type BrowserFindState,
		type BrowserNavigationAction,
		type BrowserViewState,
		type PaneAutomationState,
		type ElementEditState,
	} from "../../../shared/contracts";
	import { BROWSER_SELECTION_AGENT_PROFILE_ID } from "../../../shared/selection-agent";
	import { isDeliverableWorkspaceAgent } from "../../agent-projection";
	import BrowserSurface from "../atoms/BrowserSurface.svelte";
	import BrowserToolbar from "../molecules/BrowserToolbar.svelte";
	import BrowserFindBar from "../molecules/BrowserFindBar.svelte";
	import BrowserAutomationPane from "./BrowserAutomationPane.svelte";
	import { IconButton } from "@gradivus/chat";
	import SelectionQueuePane from "./SelectionQueuePane.svelte";
	import type { WorkspaceAgent, WorkspaceLayout, WorkspacePane } from "../../workspace-types";

	interface Props {
		pane: WorkspacePane;
		tabId: string;
		workspaceId: string;
		sessionId: string;
		focused: boolean;
		active: boolean;
		canSplit: boolean;
		browserState: BrowserViewState | undefined;
		findOpen: boolean;
		findState?: BrowserFindState;
		automationState?: PaneAutomationState;
		selectionState: ElementEditState | undefined;
		agents: WorkspaceAgent[];
		isSelecting: boolean;
		selectionPending: boolean;
		defaultUrl: string;
		onactivate: () => void;
		onnavigate: (address: string) => void;
		oncontrol: (action: BrowserNavigationAction) => void;
		onopenfind: () => void;
		onfind: (query: string, forward: boolean) => void;
		onstopfind: () => void;
		onautomationstate: (state: PaneAutomationState) => void;
		ontoggleselection: () => void;
		onrunqueue: () => void;
		onclearqueue: () => void;
		onsplit: (layout: WorkspaceLayout) => void;
		onclosepane: () => void;
		oncreated: (state: BrowserViewState) => void;
		onerror: (message: string) => void;
	}

	let {
		pane,
		tabId,
		findOpen,
		findState,
		sessionId,
		workspaceId,
		focused,
		active,
		canSplit,
		browserState,
		selectionState,
		automationState,
		agents,
		isSelecting,
		selectionPending,
		defaultUrl,
		onactivate,
		onopenfind,
		onfind,
		onstopfind,
		onnavigate,
		onautomationstate,
		oncontrol,
		ontoggleselection,
		onrunqueue,
		onclearqueue,
		onsplit,
		onclosepane,
		oncreated,
		onerror,
	}: Props = $props();

	const addressValue = $derived(browserState?.url ?? pane.url ?? defaultUrl);
	const surfaceUrl = $derived(pane.url ?? defaultUrl);
	const queuedTasks = $derived(selectionState?.queuedTasks ?? []);
	const queueRunning = $derived(selectionState?.queueRunning ?? false);
	const pageAgents = $derived(
		agents.filter(
			agent =>
				agent.profileId === BROWSER_SELECTION_AGENT_PROFILE_ID &&
				isDeliverableWorkspaceAgent(agent, workspaceId),
		),
	);
	const agentHubId = $derived(`browser-agent-hub-${pane.id}`);
	const agentHubTitleId = $derived(`${agentHubId}-title`);
	let agentHubOpen = $state(false);
	let paneElement = $state<HTMLDivElement>();
	let paneContent = $state<HTMLDivElement>();
	let panelReturnFocus: HTMLElement | undefined;
	let queueOpen = $state(false);
	let findQuery = $state("");
	let automationOpen = $state(false);
	let previousQueueCount = 0;

	$effect(() => {
		const queueCount = queuedTasks.length;
		if (previousQueueCount === 0 && queueCount > 0) {
			closePanels(false);
			queueOpen = true;
		} else if (queueCount === 0) {
			queueOpen = false;
		}
		previousQueueCount = queueCount;
	});

	$effect(() => {
		if (!sessionId) return;
		void window.gradivus.getPaneAutomation(sessionId, pane.id).then(onautomationstate).catch(() => {});
	});

	onMount(() =>
		window.gradivus.onEvent(event => {
			if (event.type !== "browser_inventory" || event.sessionId !== sessionId || !event.browserInventory) return;
			onautomationstate({
				...(automationState ?? { available: true }),
				tabs: event.browserInventory,
			});
		}),
	);

	function closePanels(restoreFocus = true): void {
		const returnFocus = panelReturnFocus ?? paneElement?.querySelector<HTMLElement>(".browser-more-actions");
		agentHubOpen = false;
		automationOpen = false;
		queueOpen = false;
		panelReturnFocus = undefined;
		if (restoreFocus) void tick().then(() => returnFocus?.focus());
	}

	function openPanel(panel: "automation" | "agents" | "queue", trigger: HTMLButtonElement): void {
		const wasOpen = panel === "automation" ? automationOpen : panel === "agents" ? agentHubOpen : queueOpen;
		closePanels(false);
		if (wasOpen) return;
		panelReturnFocus = trigger;
		automationOpen = panel === "automation";
		agentHubOpen = panel === "agents";
		queueOpen = panel === "queue";
		void tick().then(() => {
			paneContent?.querySelector<HTMLElement>("aside .selection-queue-close, .browser-automation-pane > header button")?.focus();
		});
	}

	function handlePanelKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
		if (!active || (!agentHubOpen && !automationOpen && !queueOpen)) return;
		const target = event.target;
		// Other panes and editable controls own their Escape behavior (drafts, find, IME).
		if (!(target instanceof HTMLElement) || !paneElement?.contains(target)) return;
		if (target.closest("input, textarea, select, [role='menu'], [contenteditable]:not([contenteditable='false'])")) return;
		event.preventDefault();
		event.stopPropagation();
		closePanels();
	}
</script>
<svelte:window onkeydown={handlePanelKeydown} />


<div bind:this={paneElement} class="browser-pane" class:is-focused={focused} class:has-find={findOpen} role="group" aria-label="Browser pane" onpointerdown={onactivate}>
	<BrowserToolbar
		canGoBack={browserState?.canGoBack}
		canGoForward={browserState?.canGoForward}
		loading={browserState?.loading}
		isSelecting={isSelecting}
		selectionPending={selectionPending}
		addressValue={addressValue}
		canSplit={canSplit}
		agentCount={pageAgents.length}
		agentHubId={agentHubId}
		agentHubOpen={agentHubOpen}
		queueCount={queuedTasks.length}
		queueOpen={queueOpen}
		automationOpen={automationOpen}
		automationAccess={automationState?.lease?.healthy ? automationState.lease.access : undefined}
		oncontrol={oncontrol}
		ontoggleselection={ontoggleselection}
		onopenfind={onopenfind}
		onopenagenthub={(trigger) => openPanel("agents", trigger)}
		onopenautomation={(trigger) => openPanel("automation", trigger)}
		onopenqueue={(trigger) => openPanel("queue", trigger)}
		onnavigate={onnavigate}
		onsplit={onsplit}
		onclosepane={onclosepane}
	/>
	{#if findOpen}
		<BrowserFindBar bind:value={findQuery} findState={findState} {onfind} onclose={onstopfind} />
	{/if}

	<div bind:this={paneContent} class="browser-pane-content">
		<div class="browser-surface-host">
			<BrowserSurface
				paneId={pane.id}
				url={surfaceUrl}
				workspaceId={workspaceId}
				tabId={tabId}
				active={active}
				onCreated={(browserState) => oncreated(browserState)}
				onError={(message) => onerror(message)}
			/>
		</div>

		{#if automationOpen}
			<BrowserAutomationPane
				{sessionId}
				paneId={pane.id}
				automationState={automationState}
				onstate={onautomationstate}
				onclose={closePanels}
			/>
		{:else if agentHubOpen}
			<aside
				id={agentHubId}
				class="selection-queue-pane browser-agent-hub-pane"
				aria-labelledby={agentHubTitleId}
			>
				<header class="selection-queue-header browser-agent-hub-header">
					<div class="selection-queue-heading">
						<div class="browser-agent-hub-heading-copy">
							<span class="eyebrow">Page targeting</span>
							<h2 id={agentHubTitleId}>Agent Hub</h2>
						</div>
						<IconButton class="selection-queue-close" icon={CloseCircle} size={15} label="Close browser Agent Hub" onclick={closePanels} />
					</div>
					<p class="browser-agent-hub-target">
						{#if pageAgents.length === 0}
							Use the target tool to create the first Page Agent.
						{:else}
							{pageAgents.length} Page Agent{pageAgents.length === 1 ? "" : "s"} created by element targeting.
						{/if}
					</p>
				</header>
				<div class="browser-agent-hub-content">
					{#if pageAgents.length === 0}
						<div class="browser-agent-hub-empty" role="status">
							<strong>No Page Agents yet</strong>
							<p>Select a page element from the toolbar. Gradivus creates the Page Agent automatically.</p>
						</div>
					{:else}
						<ul class="browser-page-agent-list" aria-label="Page Agents created by element targeting">
							{#each pageAgents as agent (agent.id)}
								<li class="browser-page-agent-row" class:is-current={selectionState?.agentId === agent.id}>
									<span
										class="browser-agent-swatch"
										style={`--queue-agent-swatch: ${agent.swatch}`}
										aria-hidden="true"
									></span>
									<span class="browser-page-agent-copy">
										<strong>{agent.name}</strong>
										<small>{agent.currentTool ?? agent.lastIntent ?? agent.assignment ?? agent.task ?? "Ready for page-element work"}</small>
										<span>{agent.agent}</span>
									</span>
									<span class="browser-page-agent-status">{selectionState?.agentId === agent.id && isSelecting ? "targeting" : agent.status}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</aside>
		{:else if queueOpen}
			<SelectionQueuePane
				tasks={queuedTasks}
				running={queueRunning}
				onrun={onrunqueue}
				onclear={onclearqueue}
				onclose={closePanels}
			/>
		{/if}
	</div>
</div>

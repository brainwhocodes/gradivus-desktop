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
	import IconButton from "../molecules/IconButton.svelte";
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
	let agentHubPane = $state<HTMLElement>();
	let agentHubReturnFocus = $state<HTMLElement>();
	let queueOpen = $state(false);
	let findQuery = $state("");
	let automationOpen = $state(false);
	let previousQueueCount = 0;

	$effect(() => {
		const queueCount = queuedTasks.length;
		if (previousQueueCount === 0 && queueCount > 0) {
			agentHubOpen = false;
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

	function toggleAutomation(): void {
		automationOpen = !automationOpen;
		if (automationOpen) {
			closeAgentHub(false);
			queueOpen = false;
		}
	}


	function closeAgentHub(restoreFocus = true): void {
		if (!agentHubOpen) return;
		const returnFocus = agentHubReturnFocus;
		agentHubOpen = false;
		agentHubReturnFocus = undefined;
		if (restoreFocus) void tick().then(() => returnFocus?.focus());
	}

	function toggleAgentHub(trigger: HTMLButtonElement): void {
		if (agentHubOpen) {
			closeAgentHub();
			return;
		}
		queueOpen = false;
		automationOpen = false;
		agentHubReturnFocus = trigger;
		agentHubOpen = true;
		void tick().then(() => {
			agentHubPane?.querySelector<HTMLElement>(".selection-queue-close")?.focus();
		});
	}


	function handleAgentHubKeydown(event: KeyboardEvent): void {
		if (!agentHubOpen || event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		closeAgentHub();
	}
</script>
<svelte:window onkeydown={handleAgentHubKeydown} />


<div class="browser-pane" class:is-focused={focused} role="group" aria-label="Browser pane" onpointerdown={onactivate}>
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
		automationAccess={automationState?.lease?.access}
		oncontrol={oncontrol}
		ontoggleselection={ontoggleselection}
		onopenfind={onopenfind}
		onopenagenthub={toggleAgentHub}
		onopenautomation={toggleAutomation}
		onopenqueue={() => {
			closeAgentHub(false);
			automationOpen = false;
			queueOpen = true;
		}}
		onnavigate={onnavigate}
		onsplit={onsplit}
		onclosepane={onclosepane}
	/>
	{#if findOpen}
		<BrowserFindBar bind:value={findQuery} findState={findState} {onfind} onclose={onstopfind} />
	{/if}

	<div class="browser-pane-content">
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
				onclose={() => { automationOpen = false; }}
			/>
		{:else if agentHubOpen}
			<aside
				bind:this={agentHubPane}
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
						<IconButton class="selection-queue-close" icon={CloseCircle} size={15} label="Close browser Agent Hub" onclick={closeAgentHub} />
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
				onclose={() => { queueOpen = false; }}
			/>
		{/if}
	</div>
</div>

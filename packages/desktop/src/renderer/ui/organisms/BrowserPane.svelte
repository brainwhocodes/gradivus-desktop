<script lang="ts">
	import type {
		BrowserNavigationAction,
		BrowserViewState,
		ElementEditState,
	} from "../../../shared/contracts";
	import BrowserSurface from "../atoms/BrowserSurface.svelte";
	import BrowserToolbar from "../molecules/BrowserToolbar.svelte";
	import SelectionQueuePane from "./SelectionQueuePane.svelte";
	import type { WorkspaceAgent, WorkspaceLayout, WorkspacePane } from "../../workspace-types";

	interface Props {
		pane: WorkspacePane;
		tabId: string;
		workspaceId: string;
		focused: boolean;
		active: boolean;
		canSplit: boolean;
		browserState: BrowserViewState | undefined;
		selectionState: ElementEditState | undefined;
		agents: WorkspaceAgent[];
		selectedAgentId?: string;
		isSelecting: boolean;
		defaultUrl: string;
		onactivate: () => void;
		onnavigate: (address: string) => void;
		oncontrol: (action: BrowserNavigationAction) => void;
		ontoggleselection: () => void;
		onagentchange: (agentId: string) => void;
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
		workspaceId,
		focused,
		active,
		canSplit,
		browserState,
		selectionState,
		agents,
		selectedAgentId,
		isSelecting,
		defaultUrl,
		onactivate,
		onnavigate,
		oncontrol,
		ontoggleselection,
		onagentchange,
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
	let queueOpen = $state(false);
	let previousQueueCount = 0;

	$effect(() => {
		const queueCount = queuedTasks.length;
		if (previousQueueCount === 0 && queueCount > 0) queueOpen = true;
		else if (queueCount === 0) queueOpen = false;
		previousQueueCount = queueCount;
	});
</script>

<div class="browser-pane" class:is-focused={focused} role="group" aria-label="Browser pane" onpointerdown={onactivate}>
	<BrowserToolbar
		canGoBack={browserState?.canGoBack}
		canGoForward={browserState?.canGoForward}
		loading={browserState?.loading}
		isSelecting={isSelecting}
		addressValue={addressValue}
		canSplit={canSplit}
		agents={agents}
		workspaceId={workspaceId}
		selectedAgentId={selectedAgentId}
		queueCount={queuedTasks.length}
		queueOpen={queueOpen}
		oncontrol={oncontrol}
		ontoggleselection={ontoggleselection}
		onagentchange={onagentchange}
		onopenqueue={() => { queueOpen = true; }}
		onnavigate={onnavigate}
		onsplit={onsplit}
		onclosepane={onclosepane}
	/>

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

		{#if queueOpen}
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

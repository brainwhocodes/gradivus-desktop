<script lang="ts">
	import type { Snippet } from "svelte";
	import AddSquare from "@solar-icons/svelte/linear/add-square";
	import Global from "@solar-icons/svelte/linear/global";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import type { BrowserViewState } from "../../../shared/contracts";
	import type { WorkspaceTab } from "../../workspace-types";
	import GradivusMark from "../atoms/GradivusMark.svelte";
	import IconButton from "../molecules/IconButton.svelte";
	import WindowControls from "../molecules/WindowControls.svelte";
	import WorkspaceTabMolecule from "../molecules/WorkspaceTab.svelte";

	interface Props {
		maximized: boolean;
		hydrated: boolean;
		activeTabId: string;
		chatTabId: string;
		browserTabs: WorkspaceTab[];
		browserStates: ReadonlyMap<string, BrowserViewState>;
		chatAttentionCount: number;
		onminimize: () => void;
		canReopen: boolean;
		ontogglemaximize: () => void;
		onclose: () => void;
		onactivatechat: () => void;
		onactivatetab: (tabId: string) => void;
		onclosetab: (tabId: string) => void;
		onreordertab: (tabId: string, beforeTabId?: string) => void;
		onduplicatetab: (tabId: string) => void;
		onmovetab: (tabId: string, direction: "left" | "right") => void;
		onaddbrowser: () => void;
		children: Snippet;
		onreopen: () => void;
	}

	let {
		maximized,
		hydrated,
		activeTabId,
		chatTabId,
		browserTabs,
		browserStates,
		chatAttentionCount,
		onminimize,
		canReopen,
		ontogglemaximize,
		onclose,
		onactivatechat,
		onactivatetab,
		onclosetab,
		onreordertab,
		onaddbrowser,
		onreopen,
		onduplicatetab,
		onmovetab,
		children,
	}: Props = $props();
	let draggedTabId = $state("");

	function handleTabKeydown(event: KeyboardEvent): void {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
			return;
		}
		const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
		const tabs = Array.from(tablist?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
		const currentIndex = tabs.indexOf(event.currentTarget as HTMLElement);
		if (currentIndex < 0 || tabs.length === 0) return;
		event.preventDefault();
		const targetIndex = event.key === "Home"
			? 0
			: event.key === "End"
				? tabs.length - 1
				: (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
		tabs[targetIndex].focus();
		tabs[targetIndex].click();
	}

	function dropTab(event: DragEvent, targetTabId: string, targetIndex: number): void {
		event.preventDefault();
		const sourceTabId = draggedTabId || event.dataTransfer?.getData("text/plain") || "";
		draggedTabId = "";
		if (!sourceTabId || sourceTabId === targetTabId) return;
		const target = event.currentTarget as HTMLElement;
		const beforeTabId = event.clientX > target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2
			? browserTabs[targetIndex + 1]?.id
			: targetTabId;
		if (beforeTabId === sourceTabId) return;
		onreordertab(sourceTabId, beforeTabId);
	}
</script>

<header class="shell-titlebar" aria-label="Window bar">
	<div class="shell-brand window-drag" aria-label="Gradivus">
		<GradivusMark size={21} />
	</div>
	<div class="window-controls">
		<WindowControls maximized={maximized} onminimize={onminimize} ontogglemaximize={ontogglemaximize} onclose={onclose} />
	</div>
</header>

<div class="tab-strip">
	<div class="workspace-tabs" role="tablist" aria-label="Workspace tabs">
		<WorkspaceTabMolecule
			variant="chat"
			active={activeTabId === chatTabId}
			title="Gradivus"
			tabId="workspace-tab-chat"
			controlsId="workspace-panel-chat"
			pill="native"
			attentionLabel={chatAttentionCount > 0 ? `${chatAttentionCount} pending plan ${chatAttentionCount === 1 ? "review" : "reviews"}` : undefined}
			tabindex={activeTabId === chatTabId ? 0 : -1}
			onactivate={onactivatechat}
			onkeydown={handleTabKeydown}
		/>
		{#each browserTabs as tab, tabIndex (tab.id)}
			{@const activePane = tab.panes.find(pane => pane.id === tab.activePaneId) ?? tab.panes[0]}
			{@const browserState = activePane ? browserStates.get(activePane.id) : undefined}
			{@const title = browserState?.title && browserState.title !== "New browser" ? browserState.title : tab.title || activePane?.title || "Browser"}
			<WorkspaceTabMolecule
				variant="browser"
				active={activeTabId === tab.id}
				{title}
				faviconUrl={browserState?.faviconUrl}
				tabId={`workspace-tab-${tab.id}`}
				controlsId={`workspace-panel-${tab.id}`}
				icon={Global}
				tabindex={activeTabId === tab.id ? 0 : -1}
				draggable={true}
				onactivate={() => onactivatetab(tab.id)}
				onclose={() => onclosetab(tab.id)}
				onduplicate={() => onduplicatetab(tab.id)}
				onmoveleft={tabIndex > 0 ? () => onmovetab(tab.id, "left") : undefined}
				onmoveright={tabIndex < browserTabs.length - 1 ? () => onmovetab(tab.id, "right") : undefined}
				onkeydown={handleTabKeydown}
				ondragstart={(event) => {
					draggedTabId = tab.id;
					event.dataTransfer?.setData("text/plain", tab.id);
					if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
				}}
				ondragend={() => draggedTabId = ""}
				ondragover={(event) => {
					event.preventDefault();
					if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
				}}
				ondrop={(event) => dropTab(event, tab.id, tabIndex)}
			/>
		{/each}
	</div>
	<IconButton class="new-browser" icon={AddSquare} size={18} label="Open browser tab" title="Open browser tab (Ctrl+T)" disabled={!hydrated} onclick={onaddbrowser} />
	<IconButton class="reopen-browser" icon={Refresh} size={17} label="Reopen closed browser tab" title="Reopen closed browser tab (Ctrl+Shift+T)" disabled={!canReopen} onclick={onreopen} />
</div>
<main class="workspace-stage">
	{@render children()}
</main>

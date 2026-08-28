<script lang="ts">
	import type { Snippet } from "svelte";
	import AddSquare from "@solar-icons/svelte/linear/add-square";
	import Global from "@solar-icons/svelte/linear/global";
	import GradivusMark from "../atoms/GradivusMark.svelte";
	import IconButton from "../molecules/IconButton.svelte";
	import WindowControls from "../molecules/WindowControls.svelte";
	import WorkspaceTabMolecule from "../molecules/WorkspaceTab.svelte";
	import type { WorkspaceTab } from "../../workspace-types";

	interface Props {
		maximized: boolean;
		hydrated: boolean;
		activeTabId: string;
		chatTabId: string;
		browserTabs: WorkspaceTab[];
		onminimize: () => void;
		ontogglemaximize: () => void;
		onclose: () => void;
		onactivatechat: () => void;
		onactivatetab: (tabId: string) => void;
		onclosetab: (tabId: string) => void;
		onaddbrowser: () => void;
		children: Snippet;
	}

	let {
		maximized,
		hydrated,
		activeTabId,
		chatTabId,
		browserTabs,
		onminimize,
		ontogglemaximize,
		onclose,
		onactivatechat,
		onactivatetab,
		onclosetab,
		onaddbrowser,
		children,
	}: Props = $props();
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
		<WorkspaceTabMolecule variant="chat" active={activeTabId === chatTabId} title="Gradivus" pill="native" onactivate={onactivatechat} />
		{#each browserTabs as tab (tab.id)}
			<WorkspaceTabMolecule
				variant="browser"
				active={activeTabId === tab.id}
				title={tab.title || tab.panes[0]?.title || "Browser"}
				icon={Global}
				onactivate={() => onactivatetab(tab.id)}
				onclose={() => onclosetab(tab.id)}
			/>
		{/each}
	</div>
	<IconButton class="new-browser" icon={AddSquare} size={18} label="Open browser tab" title="Open browser tab (Ctrl+T)" disabled={!hydrated} onclick={onaddbrowser} />
</div>
<main class="workspace-stage">
	{@render children()}
</main>

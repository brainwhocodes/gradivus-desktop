<script lang="ts">
	import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
	import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import Stop from "@solar-icons/svelte/linear/stop";
	import Target from "@solar-icons/svelte/linear/target";
	import TransferHorizontal from "@solar-icons/svelte/linear/transfer-horizontal";
	import TransferVertical from "@solar-icons/svelte/linear/transfer-vertical";
	import type { BrowserNavigationAction } from "../../../shared/contracts";
	import type { WorkspaceLayout } from "../../workspace-types";
	import AddressForm from "./AddressForm.svelte";
	import IconButton from "./IconButton.svelte";

	interface Props {
		canGoBack?: boolean;
		canGoForward?: boolean;
		loading?: boolean;
		isSelecting: boolean;
		selectionPending: boolean;
		addressValue: string;
		canSplit: boolean;
		agentCount: number;
		agentHubId: string;
		agentHubOpen: boolean;
		automationOpen: boolean;
		automationAccess?: "observe" | "control";
		queueCount: number;
		queueOpen: boolean;
		oncontrol: (action: BrowserNavigationAction) => void;
		ontoggleselection: () => void;
		onopenagenthub: (trigger: HTMLButtonElement) => void;
		onopenqueue: () => void;
		onopenautomation: (trigger: HTMLButtonElement) => void;
		onnavigate: (address: string) => void;
		onopenfind: () => void;
		onsplit: (layout: WorkspaceLayout) => void;
		onclosepane: () => void;
	}

	let {
		canGoBack,
		canGoForward,
		loading,
		isSelecting,
		selectionPending,
		addressValue,
		canSplit,
		agentCount,
		agentHubId,
		agentHubOpen,
		queueCount,
		automationOpen,
		automationAccess,
		queueOpen,
		oncontrol,
		ontoggleselection,
		onopenagenthub,
		onopenqueue,
		onnavigate,
		onopenautomation,
		onsplit,
		onopenfind,
		onclosepane,
	}: Props = $props();

</script>

<header class="browser-toolbar">
	<div class="browser-controls">
		<IconButton icon={AltArrowLeft} size={16} label="Back" disabled={!canGoBack} onclick={() => oncontrol("back")} />
		<IconButton icon={AltArrowRight} size={16} label="Forward" disabled={!canGoForward} onclick={() => oncontrol("forward")} />
		{#if loading}<IconButton icon={Stop} size={14} label="Stop loading" onclick={() => oncontrol("stop")} />{:else}<IconButton icon={Refresh} size={15} label="Reload" onclick={() => oncontrol("reload")} />{/if}
		<IconButton
			class="target-button"
			active={isSelecting || selectionPending}
			icon={Target}
			size={16}
			label={selectionPending ? "Creating Page Agent" : isSelecting ? "Cancel element selection" : "Select page element with Page Agent"}
			title={selectionPending ? "Creating a Page Agent and preparing element selection…" : isSelecting ? "Cancel element selection (Esc)" : "Select a page element; Gradivus creates the Page Agent automatically (Ctrl+Shift+C)"}
			disabled={selectionPending}
			onclick={ontoggleselection}
		/>
	</div>
	<AddressForm value={addressValue} onnavigate={onnavigate} />
	<div class="browser-pane-actions">
		<button
			type="button"
			class="browser-automation-button"
			class:is-active={automationOpen}
			aria-label={`${automationOpen ? "Close" : "Open"} Agent access${automationAccess ? `, ${automationAccess}` : ""}`}
			aria-expanded={automationOpen}
			onclick={(event) => onopenautomation(event.currentTarget)}
		>
			Agent access{#if automationAccess}<span>{automationAccess === "control" ? "Control" : "Read"}</span>{/if}
		</button>
		<button
			type="button"
			class="browser-agent-hub-button"
			class:is-active={agentHubOpen}
			aria-label={`${agentHubOpen ? "Close" : "Open"} browser Agent Hub, ${agentCount} Page ${agentCount === 1 ? "Agent" : "Agents"}`}
			aria-controls={agentHubId}
			aria-expanded={agentHubOpen}
			onclick={(event) => onopenagenthub(event.currentTarget)}
		>
			<span class="browser-agent-hub-label">Agent Hub</span>
			<span class="browser-agent-count" aria-label={`${agentCount} Page ${agentCount === 1 ? "Agent" : "Agents"}`}>{agentCount}</span>
		</button>
		{#if queueCount > 0}
			<button
				type="button"
				class="queue-count-button"
				class:is-active={queueOpen}
				aria-label={`Open selection queue, ${queueCount} ${queueCount === 1 ? "item" : "items"}`}
				aria-expanded={queueOpen}
				onclick={onopenqueue}
			>
				<span aria-hidden="true">Queue</span>
				<span>{queueCount}</span>
			</button>
		{/if}
		<details class="browser-more-actions">
			<summary aria-label="More browser actions">•••</summary>
			<div class="browser-more-menu">
				<button type="button" onclick={onopenfind}>Find in page</button>
				<button type="button" onclick={() => oncontrol("hard-reload")}>Hard reload</button>
				<button type="button" onclick={() => oncontrol("zoom-out")}>Zoom out</button>
				<button type="button" onclick={() => oncontrol("zoom-reset")}>Actual size</button>
				<button type="button" onclick={() => oncontrol("zoom-in")}>Zoom in</button>
			</div>
		</details>
		<IconButton icon={TransferHorizontal} size={16} label="Split browser right" title="Split right" disabled={!canSplit} onclick={() => onsplit("columns")} />
		<IconButton icon={TransferVertical} size={16} label="Split browser below" title="Split below" disabled={!canSplit} onclick={() => onsplit("rows")} />
		<IconButton icon={CloseCircle} size={16} label="Close browser pane" title="Close pane" onclick={onclosepane} />
	</div>
</header>

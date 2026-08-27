<script lang="ts">
	import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
	import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import Stop from "@solar-icons/svelte/linear/stop";
	import Target from "@solar-icons/svelte/linear/target";
	import type { BrowserNavigationAction } from "../../../shared/contracts";
	import type { DropdownOption } from "../../settings-types";
	import type { WorkspaceAgent, WorkspaceLayout } from "../../workspace-types";
	import CustomDropdown from "../atoms/CustomDropdown.svelte";
	import AddressForm from "./AddressForm.svelte";
	import IconButton from "./IconButton.svelte";

	interface Props {
		canGoBack?: boolean;
		canGoForward?: boolean;
		loading?: boolean;
		isSelecting: boolean;
		addressValue: string;
		canSplit: boolean;
		agents: WorkspaceAgent[];
		workspaceId: string;
		selectedAgentId?: string;
		queueCount: number;
		queueOpen: boolean;
		oncontrol: (action: BrowserNavigationAction) => void;
		ontoggleselection: () => void;
		onagentchange: (agentId: string) => void;
		onopenqueue: () => void;
		onnavigate: (address: string) => void;
		onsplit: (layout: WorkspaceLayout) => void;
		onclosepane: () => void;
	}

	let {
		canGoBack,
		canGoForward,
		loading,
		isSelecting,
		addressValue,
		canSplit,
		agents,
		workspaceId,
		selectedAgentId,
		queueCount,
		queueOpen,
		oncontrol,
		ontoggleselection,
		onagentchange,
		onopenqueue,
		onnavigate,
		onsplit,
		onclosepane,
	}: Props = $props();

	const eligibleAgents = $derived(
		agents.filter(agent => {
			const status = String(agent.status).toLowerCase();
			const active = status !== "stopped" && status !== "error" && status !== "failed" && status !== "exited";
			const sameWorkspace = !agent.workspaceId || agent.workspaceId === workspaceId;
			return active && sameWorkspace && agent.deliverable !== false;
		}),
	);
	const agentOptions = $derived(
		eligibleAgents.map(
			(agent): DropdownOption => ({
				key: agent.id,
				value: agent.id,
				label: agent.name,
				description: agent.agent,
			}),
		),
	);
	const selectedAgent = $derived(eligibleAgents.find(agent => agent.id === selectedAgentId));

	function selectAgent(option: DropdownOption): void {
		if (typeof option.value === "string") onagentchange(option.value);
	}
</script>

<header class="browser-toolbar">
	<div class="browser-controls">
		<IconButton icon={AltArrowLeft} size={16} label="Back" disabled={!canGoBack} onclick={() => oncontrol("back")} />
		<IconButton icon={AltArrowRight} size={16} label="Forward" disabled={!canGoForward} onclick={() => oncontrol("forward")} />
		{#if loading}<IconButton icon={Stop} size={14} label="Stop loading" onclick={() => oncontrol("stop")} />{:else}<IconButton icon={Refresh} size={15} label="Reload" onclick={() => oncontrol("reload")} />{/if}
		<IconButton
			class="target-button"
			active={isSelecting}
			icon={Target}
			size={16}
			label={isSelecting ? "Cancel element selection" : "Select page element for agent"}
			title={isSelecting ? "Cancel element selection (Esc)" : "Select page element for agent (Ctrl+Shift+C)"}
			disabled={!selectedAgent}
			onclick={ontoggleselection}
		/>
	</div>
	<div class="browser-agent-picker">
		{#if selectedAgent}
			<span
				class="browser-agent-swatch"
				style={`--queue-agent-swatch: ${selectedAgent.swatch}`}
				aria-hidden="true"
			></span>
		{/if}
		<CustomDropdown
			options={agentOptions}
			selectedKey={selectedAgent?.id}
			ariaLabel="Target workspace agent"
			placeholder="No target agent"
			disabled={agentOptions.length === 0}
			onSelect={selectAgent}
			onOpenChange={() => undefined}
		/>
	</div>
	<AddressForm value={addressValue} onnavigate={onnavigate} />
	<div class="browser-pane-actions">
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
		<IconButton glyph="↔" label="Split browser right" title="Split right" disabled={!canSplit} onclick={() => onsplit("columns")} />
		<IconButton glyph="↕" label="Split browser below" title="Split below" disabled={!canSplit} onclick={() => onsplit("rows")} />
		<IconButton glyph="×" label="Close browser pane" title="Close pane" onclick={onclosepane} />
	</div>
</header>

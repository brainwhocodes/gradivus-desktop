<script lang="ts">
	import AltArrowLeft from "@solar-icons/svelte/linear/alt-arrow-left";
	import AltArrowRight from "@solar-icons/svelte/linear/alt-arrow-right";
	import Refresh from "@solar-icons/svelte/linear/refresh";
	import Stop from "@solar-icons/svelte/linear/stop";
	import Target from "@solar-icons/svelte/linear/target";
	import { tick } from "svelte";
	import type { BrowserNavigationAction } from "../../../shared/contracts";
	import type { WorkspaceLayout } from "../../workspace-types";
	import AddressForm from "./AddressForm.svelte";
	import { IconButton } from "@gradivus/chat";

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
		onopenqueue: (trigger: HTMLButtonElement) => void;
		onopenautomation: (trigger: HTMLButtonElement) => void;
		onnavigate: (address: string) => void;
		onopenfind: () => void;
		onsplit: (layout: WorkspaceLayout) => void;
		onclosepane: () => void;
	}

	let {
		canGoBack, canGoForward, loading, isSelecting, selectionPending, addressValue,
		canSplit, agentCount, agentHubId, agentHubOpen, queueCount, automationOpen,
		automationAccess, queueOpen, oncontrol, ontoggleselection, onopenagenthub,
		onopenqueue, onnavigate, onopenautomation, onsplit, onopenfind, onclosepane,
	}: Props = $props();

	const accessLabel = $derived(automationAccess === "control" ? "Control" : automationAccess === "observe" ? "Read" : "Off");
	const menuId = $derived(`${agentHubId}-actions`);
	let menuOpen = $state(false);
	let menu: HTMLDivElement | undefined = $state();
	let menuTrigger: HTMLButtonElement | undefined = $state();

	function closeMenu(restoreFocus = true): void {
		if (!menuOpen) return;
		menuOpen = false;
		if (restoreFocus) menuTrigger?.focus();
	}

	function menuItems(): HTMLButtonElement[] {
		return Array.from(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
	}

	async function openMenu(last = false): Promise<void> {
		menuOpen = true;
		await tick();
		const items = menuItems();
		items[last ? items.length - 1 : 0]?.focus();
	}

	function choose(action: () => void): void {
		closeMenu();
		action();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (!menuOpen || event.isComposing || event.defaultPrevented) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
			return;
		}
		if (!menu?.contains(event.target as Node)) return;
		const items = menuItems();
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === "ArrowDown" ? (index + 1) % items.length
			: event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
			: event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
		if (next < 0) return;
		event.preventDefault();
		items[next]?.focus();
	}

	function outsideMenu(target: EventTarget | null): boolean {
		return target instanceof Node && !menu?.contains(target) && !menuTrigger?.contains(target);
	}
</script>

<svelte:window
	onkeydown={handleKeydown}
	onpointerdown={(event) => { if (outsideMenu(event.target)) closeMenu(false); }}
	onfocusin={(event) => { if (outsideMenu(event.target)) closeMenu(false); }}
	onblur={() => closeMenu(false)}
/>

<header class="browser-toolbar">
	<div class="browser-toolbar-row">
		<div class="browser-controls">
			<IconButton icon={AltArrowLeft} size={16} label="Back" disabled={!canGoBack} onclick={() => oncontrol("back")} />
			<IconButton icon={AltArrowRight} size={16} label="Forward" disabled={!canGoForward} onclick={() => oncontrol("forward")} />
			{#if loading}<IconButton icon={Stop} size={14} label="Stop loading" onclick={() => oncontrol("stop")} />{:else}<IconButton icon={Refresh} size={15} label="Reload" onclick={() => oncontrol("reload")} />{/if}
		</div>
		<AddressForm value={addressValue} {loading} {onnavigate} />
		<div class="browser-pane-actions">
			<button
				type="button"
				class="target-button"
				class:is-active={isSelecting || selectionPending}
				aria-pressed={isSelecting}
				aria-label={selectionPending ? "Creating Page Agent" : isSelecting ? "Cancel element selection" : "Select page element with Page Agent"}
				title={selectionPending ? "Creating a Page Agent and preparing element selection…" : isSelecting ? "Cancel element selection (Esc)" : "Select a page element; Gradivus creates the Page Agent automatically (Ctrl+Shift+C)"}
				disabled={selectionPending}
				onclick={ontoggleselection}
			>
				<Target size={16} aria-hidden="true" />
				{#if isSelecting || selectionPending}<span>{selectionPending ? "Preparing" : "Selecting"}</span>{/if}
			</button>
			<button
				type="button"
				class="browser-automation-button"
				class:is-active={automationOpen}
				aria-label={`${automationOpen ? "Close" : "Open"} Agent access, ${accessLabel}`}
				aria-expanded={automationOpen}
				title={`Agent access: ${accessLabel}. Manage what the agent can do on this page.`}
				onclick={(event) => onopenautomation(event.currentTarget)}
			>
				<span>Agent</span><strong>{accessLabel}</strong>
			</button>
			<span id={`${menuId}-counts`} hidden>{agentCount} Page {agentCount === 1 ? "Agent" : "Agents"}; {queueCount} queued {queueCount === 1 ? "task" : "tasks"}</span>
			<button
				bind:this={menuTrigger}
				type="button"
				class="browser-more-actions"
				class:is-active={menuOpen}
				aria-label="More browser actions"
				aria-describedby={`${menuId}-counts`}
				title="More browser actions"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				aria-controls={menuId}
				onclick={() => { if (menuOpen) closeMenu(); else void openMenu(); }}
				onkeydown={(event) => {
					if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
					event.preventDefault();
					void openMenu(event.key === "ArrowUp");
				}}
			>•••{#if queueCount > 0 || agentCount > 0}<span class="browser-more-count">{queueCount || agentCount}</span>{/if}</button>
		</div>
	</div>
	{#if menuOpen}
		<!-- Keep actions in layout: native BrowserView bounds must never overlap this menu. -->
		<div bind:this={menu} id={menuId} class="browser-more-menu" role="menu" aria-label="Browser actions">
			<button type="button" role="menuitem" aria-controls={agentHubId} aria-expanded={agentHubOpen} aria-label={`${agentHubOpen ? "Close" : "Open"} browser Agent Hub, ${agentCount} Page ${agentCount === 1 ? "Agent" : "Agents"}`} onclick={() => choose(() => onopenagenthub(menuTrigger!))}>Agent Hub <span>{agentCount}</span></button>
			{#if queueCount > 0}<button type="button" role="menuitem" aria-expanded={queueOpen} aria-label={`Open selection queue, ${queueCount} ${queueCount === 1 ? "item" : "items"}`} onclick={() => choose(() => onopenqueue(menuTrigger!))}>Selection queue <span>{queueCount}</span></button>{/if}
			<button type="button" role="menuitem" onclick={() => choose(onopenfind)}>Find in page</button>
			<button type="button" role="menuitem" onclick={() => choose(() => oncontrol("hard-reload"))}>Hard reload</button>
			<button type="button" role="menuitem" onclick={() => choose(() => oncontrol("zoom-out"))}>Zoom out</button>
			<button type="button" role="menuitem" onclick={() => choose(() => oncontrol("zoom-reset"))}>Actual size</button>
			<button type="button" role="menuitem" onclick={() => choose(() => oncontrol("zoom-in"))}>Zoom in</button>
			<button type="button" role="menuitem" disabled={!canSplit} onclick={() => choose(() => onsplit("columns"))}>Split browser right</button>
			<button type="button" role="menuitem" disabled={!canSplit} onclick={() => choose(() => onsplit("rows"))}>Split browser below</button>
			<button type="button" role="menuitem" onclick={() => choose(onclosepane)}>Close browser pane</button>
		</div>
	{/if}
</header>

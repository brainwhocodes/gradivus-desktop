<script lang="ts">
	import { onMount, tick } from "svelte";
	import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
	import type {
		GradivusEvent,
		GradivusSettings,
		BrowserNavigationAction,
		BrowserViewState,
		ElementEditState,
		UpdateGradivusSettingsInput,
		WorkspaceEvent,
	} from "../../../shared/contracts";
	import Toast from "../molecules/Toast.svelte";
	import BrowserPane from "../organisms/BrowserPane.svelte";
	import WorkspaceShell from "../templates/WorkspaceShell.svelte";
	import OmpChat from "./OmpChat.svelte";
	import { reconcileWorkspaceAgents } from "../../agent-projection";
	import { projectWorkspaceTabs } from "../../workspace-projection";
	import { getAgentSwatch } from "../../../shared/agent-swatch";
	import {
		type AgentProcessStatus,
		type WorkspaceAgent,
		type WorkspaceLayout,
		type WorkspacePane,
		type WorkspaceTab,
	} from "../../workspace-types";
	import { type ResolvedTheme, resolveTheme } from "../../../shared/theme-palette";
	import type { SettingsCategoryId, SettingsRoute } from "../../settings-types";
	const CHAT_TAB_ID = "omp-chat";
	const DEFAULT_BROWSER_URL = "https://omp.sh";
	const MAX_BROWSER_PANES = 4;

	function id(prefix: string): string {
		return `${prefix}-${crypto.randomUUID()}`;
	}
	let browserTabs: WorkspaceTab[] = [];
	let activeTabId = CHAT_TAB_ID;
	let activeWorkspaceId = "";
	let browserStates = new Map<string, BrowserViewState>();
	let selectionStatesByPane = new Map<string, ElementEditState>();
	let selectedAgentIdsByPane = new Map<string, string>();
	type SelectorLatch = { paneId: string; operationToken: number; selectionId?: string };
	let selectorLatch: SelectorLatch | undefined;
	let selectionOperationSequence = 0;
	let agents: WorkspaceAgent[] = [];
	let settingsRoute: SettingsRoute = { open: false, activeCategory: "app-appearance", query: "" };
	let settingsReturnFocus: HTMLElement | undefined;
	let titleSettingsButton: HTMLButtonElement | undefined;
	let visibilityWriteQueue: Promise<void> = Promise.resolve();
	let visibilityRevision = 0;
	let appSettings: GradivusSettings | undefined;
	let appSettingsPendingCount = 0;
	let appSettingsBusy = new Set<string>();
	let appSettingsStatus:
		| { key: string; tone: "saving" | "success" | "error"; message: string }
		| undefined;
	let appSettingsWriteQueue: Promise<void> = Promise.resolve();
	let appSettingsPendingByKey = new Map<string, number>();
	let appSettingsMutationId = 0;
	let resolvedTheme: ResolvedTheme = "dark";
	let notice = "";
	let noticeTimer: number | undefined;
	let errorMessage = "";
	let errorTimer: number | undefined;
	let runtimeRetryExhausted = false;
	let hydrated = false;
	let maximized = false;
	let unsubscribeWorkspace: (() => void) | undefined;
	let unsubscribeWorkspaceDocument: (() => void) | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeSelection: (() => void) | undefined;
	function deliverableAgentsForWorkspace(): WorkspaceAgent[] {
		return agents.filter(agent => {
			const status = String(agent.status).toLowerCase();
			const isStatusActive = status !== "stopped" && status !== "error" && status !== "failed" && status !== "exited";
			const matchesWorkspace = !agent.workspaceId || agent.workspaceId === activeWorkspaceId;
			return isStatusActive && matchesWorkspace && agent.deliverable !== false;
		});
	}

	function selectedAgentForPane(paneId: string): WorkspaceAgent | undefined {
		const selectedId = selectedAgentIdsByPane.get(paneId);
		return deliverableAgentsForWorkspace().find(agent => agent.id === selectedId);
	}

	function reconcileSelectedAgentIds(validPaneIds: ReadonlySet<string>): void {
		const eligibleAgents = deliverableAgentsForWorkspace();
		const eligibleIds = new Set(eligibleAgents.map(agent => agent.id));
		const fallbackId = eligibleAgents[0]?.id;
		const next = new Map<string, string>();
		for (const paneId of validPaneIds) {
			const selectedId = selectedAgentIdsByPane.get(paneId);
			if (selectedId && eligibleIds.has(selectedId)) next.set(paneId, selectedId);
			else if (fallbackId) next.set(paneId, fallbackId);
		}
		selectedAgentIdsByPane = next;
	}

	function mergeSelectionState(state: ElementEditState): void {
		const paneId = state.paneId;
		if (!paneId) return;
		const current = selectionStatesByPane.get(paneId);
		if (current && current.updatedAt > state.updatedAt) return;
		selectionStatesByPane.set(paneId, state);
		selectionStatesByPane = new Map(selectionStatesByPane);

		const latch = selectorLatch;
		if (
			state.phase === "idle" &&
			latch !== undefined &&
			latch.paneId === paneId &&
			(!state.selectionId || !latch.selectionId || latch.selectionId === state.selectionId)
		) {
			selectorLatch = undefined;
		}
	}

	$: activeBrowserTab = browserTabs.find(tab => tab.id === activeTabId);
	$: activeBrowserPane = activeBrowserTab?.panes.find(pane => pane.id === activeBrowserTab.activePaneId)
		?? activeBrowserTab?.panes[0];
	$: activeTitle = activeTabId === CHAT_TAB_ID
		? "Gradivus"
		: activeBrowserTab?.title || activeBrowserPane?.title || "Browser";
	$: documentTitle = `${activeTitle} · Gradivus`;

	onMount(() => {
		unsubscribeWorkspace = window.gradivus.onWorkspaceEvent(handleWorkspaceEvent);
		unsubscribeWorkspaceDocument = window.gradivus.onWorkspaceDocument(document => {
			void applyWorkspaceDocument(document);
		});
		if (typeof window.gradivus.onEvent === "function") {
			unsubscribeEvents = window.gradivus.onEvent(handleGradivusEvent);
		}
		if (typeof window.gradivus.onSelectionStateChanged === "function") {
			unsubscribeSelection = window.gradivus.onSelectionStateChanged(mergeSelectionState);
		}

		const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
		const handleMediaChange = (): void => {
			if (appSettings?.theme === "system") applyAppSettings(appSettings);
		};
		mediaQuery?.addEventListener?.("change", handleMediaChange);
		void (async () => {
			try {
				const [settings, document] = await Promise.all([
					window.gradivus.getAppSettings(),
					window.gradivus.getWorkspaceDocument(),
				]);
				applyAppSettings(settings);
				if (!document) throw new Error("Workspace runtime returned no document");
				await applyWorkspaceDocument(document);
			} catch (error) {
				showError(error);
			}
		})();

		return () => {
			unsubscribeWorkspace?.();
			unsubscribeWorkspaceDocument?.();
			unsubscribeSelection?.();
			mediaQuery?.removeEventListener?.("change", handleMediaChange);
		};
	});
	function applyTheme(theme: GradivusSettings["theme"]): void {
		const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
		resolvedTheme = resolveTheme(theme, systemDark);
		document.documentElement.dataset.theme = resolvedTheme;
	}
	
	function applyAppSettings(settings: GradivusSettings): void {
		appSettings = settings;
		applyTheme(settings.theme);
		document.documentElement.dataset.density = settings.ui.density;
		document.documentElement.dataset.reduceMotion = settings.ui.reduceMotion ? "true" : "false";
	}

	function beginAppSettingsMutation(key: string, label: string): number {
		const mutationId = ++appSettingsMutationId;
		appSettingsPendingCount += 1;
		appSettingsPendingByKey.set(key, (appSettingsPendingByKey.get(key) ?? 0) + 1);
		appSettingsPendingByKey = new Map(appSettingsPendingByKey);
		const busy = new Set(appSettingsBusy);
		busy.add(key);
		appSettingsBusy = busy;
		appSettingsStatus = { key, tone: "saving", message: `Saving ${label}…` };
		return mutationId;
	}

	function finishAppSettingsMutation(
		key: string,
		mutationId: number,
		status: { tone: "success" | "error"; message: string },
	): void {
		appSettingsPendingCount = Math.max(0, appSettingsPendingCount - 1);
		const remaining = (appSettingsPendingByKey.get(key) ?? 1) - 1;
		if (remaining > 0) {
			appSettingsPendingByKey.set(key, remaining);
		} else {
			appSettingsPendingByKey.delete(key);
			const busy = new Set(appSettingsBusy);
			busy.delete(key);
			appSettingsBusy = busy;
		}
		appSettingsPendingByKey = new Map(appSettingsPendingByKey);
		if (mutationId === appSettingsMutationId) {
			appSettingsStatus = { key, ...status };
		}
	}

	async function updateAppSetting(
		key: string,
		updates: UpdateGradivusSettingsInput,
		label: string,
	): Promise<void> {
		const mutationId = beginAppSettingsMutation(key, label);
		const operation = appSettingsWriteQueue.then(async () => {
			try {
				const settings = await window.gradivus.updateAppSettings(updates);
				applyAppSettings(settings);
				finishAppSettingsMutation(key, mutationId, {
					tone: "success",
					message: `${label} updated.`,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showError(error);
				finishAppSettingsMutation(key, mutationId, {
					tone: "error",
					message: `${label} failed: ${message}`,
				});
			}
		});
		appSettingsWriteQueue = operation;
		await operation;
	}

	async function resetAppSettings(): Promise<void> {
		const key = "reset";
		const mutationId = ++appSettingsMutationId;
		if (appSettingsPendingCount > 0) {
			appSettingsStatus = {
				key,
				tone: "error",
				message: "Wait for pending application settings changes to finish.",
			};
			return;
		}
		appSettingsPendingCount += 1;
		appSettingsPendingByKey.set(key, (appSettingsPendingByKey.get(key) ?? 0) + 1);
		appSettingsPendingByKey = new Map(appSettingsPendingByKey);
		const busy = new Set(appSettingsBusy);
		busy.add(key);
		appSettingsBusy = busy;
		appSettingsStatus = { key, tone: "saving", message: "Saving application defaults…" };
		const operation = appSettingsWriteQueue.then(async () => {
			try {
				const settings = await window.gradivus.resetAppSettings();
				applyAppSettings(settings);
				finishAppSettingsMutation(key, mutationId, {
					tone: "success",
					message: "Application settings reset to defaults.",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showError(error);
				finishAppSettingsMutation(key, mutationId, {
					tone: "error",
					message: `Reset application defaults failed: ${message}`,
				});
			}
		});
		appSettingsWriteQueue = operation;
		await operation;
	}

	async function applyWorkspaceDocument(document: WorkspaceDocumentV1): Promise<void> {
		const projection = projectWorkspaceTabs(document, activeWorkspaceId || undefined, activeTabId);
		activeWorkspaceId = projection.workspaceId;
		browserTabs = projection.tabs.filter(tab => tab.kind === "browser");
		agents = reconcileWorkspaceAgents(document, agents, activeWorkspaceId);
		hydrated = true;

		if (activeTabId !== CHAT_TAB_ID && !browserTabs.some(tab => tab.id === activeTabId)) {
			activeTabId = CHAT_TAB_ID;
		}

		const validPaneIds = new Set(browserTabs.flatMap(tab => tab.panes.map(pane => pane.id)));
		if (selectorLatch && !validPaneIds.has(selectorLatch.paneId)) selectorLatch = undefined;
		browserStates = new Map([...browserStates].filter(([paneId]) => validPaneIds.has(paneId)));
		selectionStatesByPane = new Map(
			[...selectionStatesByPane].filter(([paneId]) => validPaneIds.has(paneId)),
		);
		reconcileSelectedAgentIds(validPaneIds);

		await Promise.all(
			[...validPaneIds].map(async paneId => {
				try {
					mergeSelectionState(await window.gradivus.getSelectionState(paneId));
				} catch (error) {
					showError(error);
				}
			}),
		);
		await syncVisibleBrowsers();
	}

	function beginSelectionOperation(): number {
		return ++selectionOperationSequence;
	}

	function isCurrentSelectionOperation(paneId: string, token: number): boolean {
		return selectorLatch?.paneId === paneId && selectorLatch.operationToken === token;
	}

	async function toggleSelectionForPane(paneId: string): Promise<void> {
		const targetAgent = selectedAgentForPane(paneId);
		if (!targetAgent) {
			showNotice("No deliverable workspace agent is available for selection");
			return;
		}

		const current = selectorLatch;
		if (current) {
			await cancelSelectionForPane(current.paneId);
			if (selectorLatch) return;
			if (current.paneId === paneId) return;
		}

		const operationToken = beginSelectionOperation();
		selectorLatch = { paneId, operationToken };
		try {
			if (typeof window.gradivus.startSelection !== "function") {
				throw new Error("Element selection is unavailable");
			}
			const result = await window.gradivus.startSelection(paneId, targetAgent.id);
			mergeSelectionState(result);
			if (!isCurrentSelectionOperation(paneId, operationToken)) return;
			if (result.selectionId) selectorLatch = { paneId, operationToken, selectionId: result.selectionId };
			if (result.phase === "idle") selectorLatch = undefined;
		} catch (error) {
			if (!isCurrentSelectionOperation(paneId, operationToken)) return;
			selectorLatch = undefined;
			selectionOperationSequence += 1;
			showError(error);
		}
	}

	async function cancelSelectionForPane(paneId: string): Promise<number> {
		if (selectorLatch?.paneId !== paneId) return selectionOperationSequence;
		const operationToken = beginSelectionOperation();
		selectorLatch = undefined;
		try {
			if (typeof window.gradivus.cancelSelection === "function") {
				mergeSelectionState(await window.gradivus.cancelSelection(paneId));
			}
		} catch (error) {
			showError(error);
		}
		return operationToken;
	}

	async function changeSelectionTarget(paneId: string, agentId: string): Promise<void> {
		const eligible = deliverableAgentsForWorkspace().some(agent => agent.id === agentId);
		if (!eligible) return;
		const wasSelecting = selectorLatch?.paneId === paneId;
		selectedAgentIdsByPane.set(paneId, agentId);
		selectedAgentIdsByPane = new Map(selectedAgentIdsByPane);
		if (!wasSelecting) return;
		await cancelSelectionForPane(paneId);
		if (selectedAgentIdsByPane.get(paneId) === agentId) await toggleSelectionForPane(paneId);
	}

	async function runSelectionQueue(paneId: string): Promise<void> {
		try {
			mergeSelectionState(await window.gradivus.runQueuedTasks(paneId));
		} catch (error) {
			showError(error);
		}
	}

	async function clearSelectionQueue(paneId: string): Promise<void> {
		try {
			mergeSelectionState(await window.gradivus.clearQueuedTasks(paneId));
		} catch (error) {
			showError(error);
		}
	}

	function handleGradivusEvent(event: GradivusEvent): void {
		if (event.type !== "subagents") return;
		const incomingIds = new Set((event.subagents ?? []).map(sub => sub.id));
		const preservedAgents = agents.filter(
			agent => !agent.sessionId || agent.sessionId !== event.sessionId || !incomingIds.has(agent.id),
		);
		const newSubagents: WorkspaceAgent[] = (event.subagents ?? []).map(sub => {
			const status = (sub.status || "ready") as AgentProcessStatus;
			const existing = agents.find(a => a.id === sub.id);
			return {
				id: sub.id,
				name: existing?.name || (sub.agent ? `${sub.agent.charAt(0).toUpperCase() + sub.agent.slice(1)} Agent` : sub.id),
				agent: sub.agent || existing?.agent || "task",
				status,
				swatch: existing?.swatch || getAgentSwatch(sub.id),
				workspaceId: activeWorkspaceId,
				sessionId: event.sessionId,
				deliverable: true,
				task: sub.task ?? existing?.task,
				assignment: sub.assignment ?? existing?.assignment,
				lastIntent: sub.progress?.lastIntent ?? existing?.lastIntent,
				currentTool: sub.progress?.currentTool ?? existing?.currentTool,
			};
		});
		agents = [...preservedAgents, ...newSubagents];
		reconcileSelectedAgentIds(new Set(browserTabs.flatMap(tab => tab.panes.map(pane => pane.id))));
	}


	function activateChat(): void {
		activeTabId = CHAT_TAB_ID;
		void syncVisibleBrowsers();
	}

	function activateBrowser(tabId: string): void {
		if (!browserTabs.some(tab => tab.id === tabId)) return;
		activeTabId = tabId;
		void syncVisibleBrowsers();
	}

	async function addBrowserTab(url?: string): Promise<void> {
		if (!hydrated || !activeWorkspaceId) {
			showNotice("Workspace is still loading");
			return;
		}
		const tabId = id("tab-browser");
		const paneId = id("browser");
		activeTabId = tabId;
		try {
			await window.gradivus.createBrowser({
				id: paneId,
				tabId,
				workspaceId: activeWorkspaceId,
				url: url ?? appSettings?.browser.defaultUrl ?? DEFAULT_BROWSER_URL,
			});
		} catch (error) {
			activeTabId = CHAT_TAB_ID;
			showError(error);
		}
	}

	async function splitBrowser(tab: WorkspaceTab, sourcePaneId: string, layout: WorkspaceLayout): Promise<void> {
		if (!activeWorkspaceId || tab.panes.length >= MAX_BROWSER_PANES) return;
		if (!tab.panes.some(pane => pane.id === sourcePaneId)) return;
		const paneId = id("browser");
		const requestedLayout = tab.panes.length + 1 > 2 ? "grid" : layout;
		try {
			await window.gradivus.createBrowser({
				id: paneId,
				tabId: tab.id,
				workspaceId: activeWorkspaceId,
				url: appSettings?.browser.defaultUrl ?? DEFAULT_BROWSER_URL,
				layout: requestedLayout,
			});
		} catch (error) {
			showError(error);
		}
	}
	function isFocusableTrigger(element: HTMLElement | undefined): boolean {
		if (!element || !element.isConnected) return false;
		const style = window.getComputedStyle(element);
		return style.visibility !== "hidden" && style.display !== "none" && !element.hasAttribute("disabled");
	}

	function openSettings(category: SettingsCategoryId, trigger: HTMLElement): void {
		settingsReturnFocus = trigger;
		settingsRoute = { ...settingsRoute, open: true, activeCategory: category, query: "" };
		void syncVisibleBrowsers();
	}

	function openApplicationSettings(): void {
		if (titleSettingsButton) openSettings("app-appearance", titleSettingsButton);
	}

	function updateSettingsRoute(updates: Partial<Pick<SettingsRoute, "activeCategory" | "query">>): void {
		settingsRoute = { ...settingsRoute, ...updates };
	}

	function closeSettings(): void {
		if (!settingsRoute.open) return;
		settingsRoute = { ...settingsRoute, open: false };
		void syncVisibleBrowsers();
		void tick().then(() => {
			const target = isFocusableTrigger(settingsReturnFocus) ? settingsReturnFocus : titleSettingsButton;
			if (isFocusableTrigger(target)) target?.focus();
			else document.querySelector<HTMLElement>(".workspace-tab.is-active")?.focus();
			settingsReturnFocus = undefined;
		});
	}


	async function closeBrowserTab(tabId: string): Promise<void> {
		const tab = browserTabs.find(item => item.id === tabId);
		if (!tab) return;
		if (appSettings?.confirmCloseTab && !window.confirm(`Close tab “${tab.title || "Browser"}”?`)) return;
		try {
			await window.gradivus.closeTab(tabId);
			for (const pane of tab.panes) browserStates.delete(pane.id);
			browserStates = new Map(browserStates);
			if (activeTabId === tabId) activeTabId = CHAT_TAB_ID;
			await syncVisibleBrowsers();
		} catch (error) {
			showError(error);
		}
	}

	async function closeBrowserPane(tab: WorkspaceTab, paneId: string): Promise<void> {
		if (tab.panes.length === 1) {
			await closeBrowserTab(tab.id);
			return;
		}
		try {
			await window.gradivus.closePane(paneId);
			browserStates.delete(paneId);
			browserStates = new Map(browserStates);
		} catch (error) {
			showError(error);
		}
	}

	function activatePane(tab: WorkspaceTab, paneId: string): void {
		activeTabId = tab.id;
		void window.gradivus.updateTab(tab.id, { activePaneId: paneId }).catch(showError);
		void syncVisibleBrowsers();
	}

	function browserCreated(pane: WorkspacePane, state: BrowserViewState): void {
		browserStates.set(pane.id, state);
		browserStates = new Map(browserStates);
	}

	function updateBrowserState(paneId: string, state: BrowserViewState): void {
		browserStates.set(paneId, state);
		browserStates = new Map(browserStates);
	}

	async function navigateBrowser(paneId: string, address: string): Promise<void> {
		try {
			updateBrowserState(paneId, await window.gradivus.navigateBrowser(paneId, address));
		} catch (error) {
			showError(error);
		}
	}

	function controlBrowser(paneId: string, action: BrowserNavigationAction): void {
		void window.gradivus.controlBrowser(paneId, action).catch(showError);
	}

	async function syncVisibleBrowsers(): Promise<void> {
		await tick();
		const tab = browserTabs.find(item => item.id === activeTabId);
		const desired = settingsRoute.open
			? []
			: (tab?.panes.map(pane => pane.id) ?? []);
		const revision = ++visibilityRevision;
		visibilityWriteQueue = visibilityWriteQueue
			.catch(() => undefined)
			.then(async () => {
				if (revision !== visibilityRevision) return;
				await window.gradivus.setVisibleBrowsers(desired);
			});
		await visibilityWriteQueue;
	}

	function handleWorkspaceEvent(event: WorkspaceEvent): void {
		if (event.type === "browser-state") updateBrowserState(event.paneId, event.state);
		else if (event.type === "browser-focus") {
			const tab = browserTabs.find(item => item.panes.some(pane => pane.id === event.paneId));
			if (tab) activatePane(tab, event.paneId);
		} else if (event.type === "browser-new-window") {
			void addBrowserTab(event.url);
		} else if (event.type === "selection-state") {
			mergeSelectionState(event.state);
		} else if (event.type === "connection-state") {
			if (event.state === "connected") {
				runtimeRetryExhausted = false;
				clearNotice();
			} else if (event.state === "reconnecting") {
				showNotice("Reconnecting to the workspace runtime…");
			} else if (event.retryExhausted) {
				runtimeRetryExhausted = true;
				clearNotice();
			} else {
				showNotice("Workspace runtime disconnected");
			}
		}
	}

	function clearNotice(): void {
		notice = "";
		window.clearTimeout(noticeTimer);
	}

	function layoutClass(tab: WorkspaceTab): string {
		if (tab.panes.length <= 1) return "single";
		if (tab.panes.length >= 3 || tab.layout === "grid") return "grid";
		return tab.layout;
	}

	function showNotice(message: string): void {
		notice = message;
		window.clearTimeout(noticeTimer);
		noticeTimer = window.setTimeout(() => {
			if (notice === message) notice = "";
		}, 5_000);
	}

	function showError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		errorMessage = message;
		window.clearTimeout(errorTimer);
		errorTimer = window.setTimeout(() => {
			if (errorMessage === message) errorMessage = "";
		}, 7_000);
	}

	async function retryRuntimeConnection(): Promise<void> {
		runtimeRetryExhausted = false;
		showNotice("Reconnecting to the workspace runtime…");
		try {
			await window.gradivus.reconnectRuntime();
		} catch (error) {
			showError(error);
		}
	}

	function minimizeWindow(): void {
		void window.gradivus.minimizeWindow().catch(showError);
	}

	async function toggleMaximizeWindow(): Promise<void> {
		try {
			maximized = await window.gradivus.toggleMaximizeWindow();
		} catch (error) {
			showError(error);
		}
	}

	function closeWindow(): void {
		void window.gradivus.closeWindow().catch(showError);
	}

	function isDropdownEscape(event: KeyboardEvent): boolean {
		if (document.querySelector(".custom-dropdown[data-open='true']") !== null) return true;
		return event.composedPath().some(target => target instanceof HTMLElement && target.closest(".custom-dropdown") !== null);
	}

	function handleKeyboard(event: KeyboardEvent): void {
		if (event.key === "Escape" && isDropdownEscape(event)) return;
		if (settingsRoute.open) {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				event.preventDefault();
				if (settingsRoute.query) updateSettingsRoute({ query: "" });
				else closeSettings();
			}
			return;
		}
		if (event.key === "Escape" && selectorLatch) {
			event.preventDefault();
			void cancelSelectionForPane(selectorLatch.paneId);
			return;
		}
		if (
			(event.ctrlKey || event.metaKey) &&
			event.shiftKey &&
			event.key.toLowerCase() === "c" &&
			activeBrowserPane
		) {
			event.preventDefault();
			void toggleSelectionForPane(activeBrowserPane.id);
			return;
		}
		if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
			if (event.key.toLowerCase() === "t") {
				event.preventDefault();
				void addBrowserTab();
			} else if (event.key.toLowerCase() === "w" && activeBrowserTab) {
				event.preventDefault();
				void closeBrowserTab(activeBrowserTab.id);
			}
		}
	}
</script>
<svelte:head><title>{documentTitle}</title></svelte:head>
<svelte:window onkeydown={handleKeyboard} />

<div class="workspace-app">
	<WorkspaceShell
		maximized={maximized}
		settingsOpen={settingsRoute.open}
		hydrated={hydrated}
		activeTabId={activeTabId}
		chatTabId={CHAT_TAB_ID}
		browserTabs={browserTabs}
		titleSettingsRef={(node) => { titleSettingsButton = node; }}
		ontogglesettings={() => settingsRoute.open ? closeSettings() : openApplicationSettings()}
		onminimize={minimizeWindow}
		ontogglemaximize={() => void toggleMaximizeWindow()}
		onclose={closeWindow}
		onactivatechat={activateChat}
		onactivatetab={activateBrowser}
		onclosetab={(tabId) => void closeBrowserTab(tabId)}
		onaddbrowser={() => void addBrowserTab()}
	>
		<section
			class="chat-stage"
			class:is-active={activeTabId === CHAT_TAB_ID || settingsRoute.open}
			aria-hidden={settingsRoute.open ? undefined : activeTabId !== CHAT_TAB_ID}
		>
			<OmpChat
				appSettings={appSettings}
				theme={resolvedTheme}
				settingsRoute={settingsRoute}
				onOpenSettings={openSettings}
				onSettingsRouteChange={updateSettingsRoute}
				onCloseSettings={closeSettings}
				onUpdateAppSetting={updateAppSetting}
				onResetAppSettings={resetAppSettings}
				appSettingsBusy={appSettingsBusy}
				appSettingsStatus={appSettingsStatus}
			/>
		</section>

		{#each browserTabs as tab (tab.id)}
			<section
				class="browser-tab-stage"
				class:is-active={!settingsRoute.open && activeTabId === tab.id}
				aria-hidden={settingsRoute.open || activeTabId !== tab.id}
				inert={settingsRoute.open || activeTabId !== tab.id}
			>

				<div class="browser-stage-layout">
					<div class={`browser-pane-grid ${layoutClass(tab)}`} style={tab.panes.length === 2 && tab.layout === "columns" ? `grid-template-columns: ${tab.ratio}% ${100 - tab.ratio}%` : tab.panes.length === 2 && tab.layout === "rows" ? `grid-template-rows: ${tab.ratio}% ${100 - tab.ratio}%` : ""}>
						{#each tab.panes as pane (pane.id)}
							{@const state = browserStates.get(pane.id)}
							{@const selectionState = selectionStatesByPane.get(pane.id)}
							{@const selectedAgentId = selectedAgentIdsByPane.get(pane.id)}
							{@const isSelecting = selectorLatch?.paneId === pane.id}
							<BrowserPane
								pane={pane}
								tabId={tab.id}
								workspaceId={activeWorkspaceId}
								focused={tab.activePaneId === pane.id}
								active={!settingsRoute.open && activeTabId === tab.id}
								canSplit={tab.panes.length < MAX_BROWSER_PANES}
								browserState={state}
								selectionState={selectionState}
								agents={agents}
								selectedAgentId={selectedAgentId}
								isSelecting={isSelecting}
								defaultUrl={DEFAULT_BROWSER_URL}
								onactivate={() => activatePane(tab, pane.id)}
								onnavigate={(address) => void navigateBrowser(pane.id, address)}
								oncontrol={(action) => controlBrowser(pane.id, action)}
								ontoggleselection={() => void toggleSelectionForPane(pane.id)}
								onagentchange={(agentId) => void changeSelectionTarget(pane.id, agentId)}
								onrunqueue={() => void runSelectionQueue(pane.id)}
								onclearqueue={() => void clearSelectionQueue(pane.id)}
								onsplit={(layout) => void splitBrowser(tab, pane.id, layout)}
								onclosepane={() => void closeBrowserPane(tab, pane.id)}
								oncreated={(browserState) => browserCreated(pane, browserState)}
								onerror={showError}
							/>
						{/each}
					</div>

				</div>
			</section>
		{/each}

		{#if notice}<Toast variant="notice-toast tone-info" role="status" message={notice} />{/if}
		{#if runtimeRetryExhausted}
			<Toast
				variant="error-toast"
				role="alert"
				title="Workspace runtime unreachable"
				message="Gradivus could not reconnect to the workspace runtime."
				dismissLabel="Dismiss error"
				ondismiss={() => (runtimeRetryExhausted = false)}
				actionLabel="Retry"
				onaction={() => void retryRuntimeConnection()}
			/>
		{:else if errorMessage}
			<Toast
				variant="error-toast"
				role="alert"
				title="Action failed"
				message={errorMessage}
				dismissLabel="Dismiss error"
				ondismiss={() => (errorMessage = "")}
			/>
		{/if}

		{#if !hydrated}
			<div class="workspace-loading" role="status"><span></span>Connecting to the workspace runtime…</div>
		{/if}
	</WorkspaceShell>
</div>


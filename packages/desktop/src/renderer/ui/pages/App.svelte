<script lang="ts">
	import { onMount, tick } from "svelte";
	import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
	import type {
		GradivusSettings,
		BrowserNavigationAction,
		BrowserFindState,
		BrowserShortcut,
		BrowserViewState,
		PaneAutomationState,
		ElementEditState,
		UpdateGradivusSettingsInput,
		WorkspaceEvent,
	} from "../../../shared/contracts";
	import ModalShell from "../molecules/ModalShell.svelte";
	import Toast from "../molecules/Toast.svelte";
	import BrowserPane from "../organisms/BrowserPane.svelte";
	import WorkspaceShell from "../templates/WorkspaceShell.svelte";
	import OmpChat from "./OmpChat.svelte";
	import { reconcileWorkspaceAgents } from "../../agent-projection";
	import { projectWorkspaceTabs } from "../../workspace-projection";
	import {
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
	let terminalTabs: WorkspaceTab[] = [];
	let activeTabId = CHAT_TAB_ID;
	let chatPresentationReady = false;
	let chatAttentionCount = 0;
	let observedPresentationTab = "";
	let presentationRevision = 0;
	let activeWorkspaceId = "";
	let browserStates = new Map<string, BrowserViewState>();
	let paneAutomationStates = new Map<string, PaneAutomationState>();
	let activeSessionId = "";
	let browserFindStates = new Map<string, BrowserFindState>();
	let openBrowserFindPanes = new Set<string>();
	let selectionStatesByPane = new Map<string, ElementEditState>();
	type SelectorLatch = { paneId: string; operationToken: number; selectionId?: string };
	let selectorLatch: SelectorLatch | undefined;
	let selectionOperationSequence = 0;
	let agents: WorkspaceAgent[] = [];
	let settingsRoute: SettingsRoute = { open: false, activeCategory: "app-appearance", query: "" };
	let settingsReturnFocus: HTMLElement | undefined;
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
	interface ClosedBrowserTabDescriptor {
		title: string;
		layout: WorkspaceLayout;
		activePaneIndex: number;
		paneUrls: string[];
	}
	let closedBrowserTabs: ClosedBrowserTabDescriptor[] = [];
	let pendingBrowserClose:
		| {
				title: string;
				paneCount: number;
				returnFocus?: HTMLElement;
				resolve: (confirmed: boolean) => void;
		  }
		| undefined;
	let browserCloseCancelButton: HTMLButtonElement | undefined;
	let unsubscribeWorkspace: (() => void) | undefined;
	let unsubscribeWorkspaceDocument: (() => void) | undefined;
	let unsubscribeSelection: (() => void) | undefined;

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
			latch?.selectionId !== undefined &&
			latch.paneId === paneId &&
			(!state.selectionId || latch.selectionId === state.selectionId)
		) {
			selectorLatch = undefined;
		}
	}

	$: activeBrowserTab = browserTabs.find(tab => tab.id === activeTabId);
	$: activeBrowserPane = activeBrowserTab?.panes.find(pane => pane.id === activeBrowserTab.activePaneId)
		?? activeBrowserTab?.panes[0];
	$: activeBrowserState = activeBrowserPane ? browserStates.get(activeBrowserPane.id) : undefined;
	$: activeTitle = activeTabId === CHAT_TAB_ID
		? "Gradivus"
		: activeBrowserState?.title || activeBrowserTab?.title || activeBrowserPane?.title || "Browser";
	$: documentTitle = `${activeTitle} · Gradivus`;

	onMount(() => {
		unsubscribeWorkspace = window.gradivus.onWorkspaceEvent(handleWorkspaceEvent);
		unsubscribeWorkspaceDocument = window.gradivus.onWorkspaceDocument(document => {
			void applyWorkspaceDocument(document);
		});
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
		terminalTabs = projection.tabs.filter(tab => tab.kind === "terminal");
		agents = reconcileWorkspaceAgents(document, agents, activeWorkspaceId);
		hydrated = true;

		if (activeTabId !== CHAT_TAB_ID && !browserTabs.some(tab => tab.id === activeTabId)) {
			activeTabId = CHAT_TAB_ID;
		}

		const validPaneIds = new Set(browserTabs.flatMap(tab => tab.panes.map(pane => pane.id)));
		if (selectorLatch && !validPaneIds.has(selectorLatch.paneId)) selectorLatch = undefined;
		browserStates = new Map([...browserStates].filter(([paneId]) => validPaneIds.has(paneId)));
		paneAutomationStates = new Map([...paneAutomationStates].filter(([paneId]) => validPaneIds.has(paneId)));
		browserFindStates = new Map([...browserFindStates].filter(([paneId]) => validPaneIds.has(paneId)));
		openBrowserFindPanes = new Set([...openBrowserFindPanes].filter(paneId => validPaneIds.has(paneId)));
		selectionStatesByPane = new Map(
			[...selectionStatesByPane].filter(([paneId]) => validPaneIds.has(paneId)),
		);

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
			const result = await window.gradivus.startSelection(paneId);
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



	async function reconcileChatPresentation(tabId: string): Promise<void> {
		const revision = ++presentationRevision;
		chatPresentationReady = false;
		await syncVisibleBrowsers();
		if (revision !== presentationRevision || activeTabId !== tabId) return;
		if (tabId === CHAT_TAB_ID) {
			window.focus();
			chatPresentationReady = true;
		}
	}

	$: if (activeTabId !== observedPresentationTab) {
		observedPresentationTab = activeTabId;
		void reconcileChatPresentation(activeTabId);
	}

	function activateChat(): void {
		activeTabId = CHAT_TAB_ID;
	}

	function activateBrowser(tabId: string): void {
		if (!browserTabs.some(tab => tab.id === tabId)) return;
		activeTabId = tabId;
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

	function browserTabDescriptor(tab: WorkspaceTab): ClosedBrowserTabDescriptor {
		const activePaneIndex = Math.max(0, tab.panes.findIndex(pane => pane.id === tab.activePaneId));
		return {
			title: browserStates.get(tab.activePaneId)?.title || tab.title || "Browser",
			layout: tab.layout,
			activePaneIndex,
			paneUrls: tab.panes.map(pane => browserStates.get(pane.id)?.url || pane.url || DEFAULT_BROWSER_URL),
		};
	}

	async function createBrowserFromDescriptor(descriptor: ClosedBrowserTabDescriptor): Promise<boolean> {
		if (!hydrated || !activeWorkspaceId || descriptor.paneUrls.length === 0) return false;
		const tabId = id("tab-browser");
		const paneIds: string[] = [];
		activeTabId = tabId;
		try {
			for (let index = 0; index < descriptor.paneUrls.length; index++) {
				const paneId = id("browser");
				paneIds.push(paneId);
				await window.gradivus.createBrowser({
					id: paneId,
					tabId,
					workspaceId: activeWorkspaceId,
					url: descriptor.paneUrls[index],
					...(index === 1
						? { layout: descriptor.layout === "rows" ? "rows" as const : "columns" as const }
						: index >= 2
							? { layout: "grid" as const }
							: {}),
				});
			}
			await window.gradivus.updateTab(tabId, {
				name: descriptor.title,
				layout: paneIds.length >= 3 ? "grid" : paneIds.length === 2 ? descriptor.layout : "columns",
				activePaneId: paneIds[Math.min(descriptor.activePaneIndex, paneIds.length - 1)],
			});
			return true;
		} catch (error) {
			await window.gradivus.closeTab(tabId).catch(() => {});
			activeTabId = CHAT_TAB_ID;
			showError(error);
			return false;
		}
	}

	async function duplicateBrowserTab(tabId: string): Promise<void> {
		const tab = browserTabs.find(candidate => candidate.id === tabId);
		if (tab) await createBrowserFromDescriptor(browserTabDescriptor(tab));
	}

	function moveBrowserTab(tabId: string, direction: "left" | "right"): void {
		const index = browserTabs.findIndex(tab => tab.id === tabId);
		if (index < 0) return;
		if (direction === "left" && index > 0) {
			void reorderBrowserTab(tabId, browserTabs[index - 1].id);
		} else if (direction === "right" && index < browserTabs.length - 1) {
			void reorderBrowserTab(tabId, browserTabs[index + 2]?.id);
		}
	}

	async function reopenBrowserTab(): Promise<void> {
		const descriptor = closedBrowserTabs.at(-1);
		if (!descriptor) return;
		if (await createBrowserFromDescriptor(descriptor)) closedBrowserTabs = closedBrowserTabs.slice(0, -1);
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
				url: browserStates.get(sourcePaneId)?.url ?? tab.panes.find(pane => pane.id === sourcePaneId)?.url ?? DEFAULT_BROWSER_URL,
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


	function updateSettingsRoute(updates: Partial<Pick<SettingsRoute, "activeCategory" | "query">>): void {
		settingsRoute = { ...settingsRoute, ...updates };
	}

	function closeSettings(): void {
		if (!settingsRoute.open) return;
		settingsRoute = { ...settingsRoute, open: false };
		void syncVisibleBrowsers();
		void tick().then(() => {
			const target = isFocusableTrigger(settingsReturnFocus) ? settingsReturnFocus : undefined;
			if (target) target.focus();
			else document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
			settingsReturnFocus = undefined;
		});
	}


	function settleBrowserClose(confirmed: boolean): void {
		const request = pendingBrowserClose;
		if (!request) return;
		pendingBrowserClose = undefined;
		request.resolve(confirmed);
		if (!confirmed) {
			void tick().then(() => request.returnFocus?.focus({ preventScroll: true }));
		}
	}

	async function confirmBrowserClose(title: string, paneCount: number): Promise<boolean> {
		if (!appSettings?.confirmCloseTab) return true;
		const gate = Promise.withResolvers<boolean>();
		pendingBrowserClose = {
			title,
			paneCount,
			returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
			resolve: gate.resolve,
		};
		await tick();
		browserCloseCancelButton?.focus({ preventScroll: true });
		return gate.promise;
	}

	async function closeBrowserTab(tabId: string): Promise<void> {
		const closingIndex = browserTabs.findIndex(item => item.id === tabId);
		const tab = browserTabs[closingIndex];
		if (!tab) return;
		const descriptor = browserTabDescriptor(tab);
		if (!(await confirmBrowserClose(descriptor.title, tab.panes.length))) return;
		const nextActiveId = browserTabs[closingIndex + 1]?.id ?? browserTabs[closingIndex - 1]?.id ?? CHAT_TAB_ID;
		if (activeTabId === tabId) activeTabId = nextActiveId;
		try {
			await window.gradivus.closeTab(tabId);
			for (const pane of tab.panes) browserStates.delete(pane.id);
			browserStates = new Map(browserStates);
			closedBrowserTabs = [...closedBrowserTabs.slice(-9), descriptor];
			await syncVisibleBrowsers();
			await tick();
			document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
		} catch (error) {
			if (activeTabId === nextActiveId) activeTabId = tabId;
			showError(error);
		}
	}

	async function reorderBrowserTab(tabId: string, beforeTabId?: string): Promise<void> {
		const sourceIndex = browserTabs.findIndex(tab => tab.id === tabId);
		if (sourceIndex < 0 || beforeTabId === tabId) return;
		const previous = browserTabs;
		const next = [...browserTabs];
		const [moved] = next.splice(sourceIndex, 1);
		const targetIndex = beforeTabId ? next.findIndex(tab => tab.id === beforeTabId) : next.length;
		if (targetIndex < 0) return;
		next.splice(targetIndex, 0, moved);
		browserTabs = next;
		try {
			await window.gradivus.reorderTab(tabId, beforeTabId);
		} catch (error) {
			browserTabs = previous;
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
		void syncVisibleBrowsers(paneId);
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

	function openBrowserFind(paneId: string): void {
		const next = new Set(openBrowserFindPanes);
		next.add(paneId);
		openBrowserFindPanes = next;
	}

	function findInBrowser(paneId: string, query: string, forward: boolean): void {
		void window.gradivus.findBrowser(paneId, query, forward).catch(showError);
	}

	function closeBrowserFind(paneId: string): void {
		const next = new Set(openBrowserFindPanes);
		next.delete(paneId);
		openBrowserFindPanes = next;
		browserFindStates.delete(paneId);
		browserFindStates = new Map(browserFindStates);
		void window.gradivus.stopBrowserFind(paneId).catch(showError);
	}

	function handleBrowserShortcut(paneId: string, shortcut: BrowserShortcut): void {
		const tab = browserTabs.find(candidate => candidate.panes.some(pane => pane.id === paneId));
		if (!tab) return;
		if (shortcut === "new-tab") void addBrowserTab();
		else if (shortcut === "reopen-tab") void reopenBrowserTab();
		else if (shortcut === "close-tab") void closeBrowserTab(tab.id);
		else if (shortcut === "next-tab") cycleWorkspaceTab(false);
		else if (shortcut === "previous-tab") cycleWorkspaceTab(true);
		else if (shortcut === "focus-address") {
			activatePane(tab, paneId);
			void tick().then(focusActiveBrowserAddress);
		} else if (shortcut === "find") {
			activatePane(tab, paneId);
			openBrowserFind(paneId);
		} else {
			controlBrowser(
				paneId,
				shortcut === "back"
					? "back"
					: shortcut === "forward"
						? "forward"
						: shortcut,
			);
		}
	}

	async function syncVisibleBrowsers(activePaneOverride?: string): Promise<void> {
		await tick();
		const tab = browserTabs.find(item => item.id === activeTabId);
		const desired = settingsRoute.open
			? []
			: (tab?.panes.map(pane => pane.id) ?? []);
		const activePaneId = settingsRoute.open ? undefined : activePaneOverride ?? tab?.activePaneId;
		const revision = ++visibilityRevision;
		visibilityWriteQueue = visibilityWriteQueue
			.catch(() => undefined)
			.then(async () => {
				if (revision !== visibilityRevision) return;
				await window.gradivus.setVisibleBrowsers(desired, activePaneId);
			});
		await visibilityWriteQueue;
	}

	function handleWorkspaceEvent(event: WorkspaceEvent): void {
		if (event.type === "browser-state") updateBrowserState(event.paneId, event.state);
		else if (event.type === "browser-find") {
			browserFindStates.set(event.paneId, event.state);
			browserFindStates = new Map(browserFindStates);
		} else if (event.type === "browser-warning") {
			showNotice(event.message);
		} else if (event.type === "browser-shortcut") {
			handleBrowserShortcut(event.paneId, event.shortcut);
		} else if (event.type === "browser-focus") {
			const tab = browserTabs.find(item => item.panes.some(pane => pane.id === event.paneId));
			if (tab) activatePane(tab, event.paneId);
		} else if (event.type === "browser-new-window") {
			void addBrowserTab(event.url);
		} else if (event.type === "pane-context-action") {
			const tab = browserTabs.find(item => item.panes.some(pane => pane.id === event.paneId));
			if (!tab) return;
			if (event.action === "close") void closeBrowserPane(tab, event.paneId);
			else void splitBrowser(tab, event.paneId, event.action === "split-columns" ? "columns" : "rows");
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

	function cycleWorkspaceTab(reverse: boolean): void {
		const ids = [CHAT_TAB_ID, ...browserTabs.map(tab => tab.id)];
		const currentIndex = Math.max(0, ids.indexOf(activeTabId));
		const nextIndex = (currentIndex + (reverse ? -1 : 1) + ids.length) % ids.length;
		const nextId = ids[nextIndex];
		if (nextId === CHAT_TAB_ID) activateChat();
		else activateBrowser(nextId);
	}

	function focusActiveBrowserAddress(): void {
		const input = document.querySelector<HTMLInputElement>(
			".browser-tab-stage.is-active .browser-pane.is-focused input[aria-label='Address']",
		);
		if (!input) return;
		input.focus();
		input.select();
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
		if (document.querySelector("dialog[open]")) return;
		if (
			(event.ctrlKey || event.metaKey) &&
			event.shiftKey &&
			event.key.toLowerCase() === "t" &&
			closedBrowserTabs.length > 0
		) {
			event.preventDefault();
			void reopenBrowserTab();
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
		if (
			(event.ctrlKey || event.metaKey) &&
			event.shiftKey &&
			event.key.toLowerCase() === "r" &&
			activeBrowserPane
		) {
			event.preventDefault();
			controlBrowser(activeBrowserPane.id, "hard-reload");
			return;
		}
		const commandModifier = event.ctrlKey || event.metaKey;
		if (commandModifier && !event.altKey && event.key === "Tab") {
			event.preventDefault();
			cycleWorkspaceTab(event.shiftKey);
			return;
		}
		if (commandModifier && !event.shiftKey && !event.altKey) {
			const key = event.key.toLowerCase();
			if (key === "t") {
				event.preventDefault();
				void addBrowserTab();
				return;
			}
			if (key === "w" && activeBrowserTab) {
				event.preventDefault();
				void closeBrowserTab(activeBrowserTab.id);
				return;
			}
			if (key === "l" && activeBrowserPane) {
				event.preventDefault();
				focusActiveBrowserAddress();
				return;
			}
			if (key === "f" && activeBrowserPane) {
				event.preventDefault();
				openBrowserFind(activeBrowserPane.id);
				return;
			}
			if ((key === "+" || key === "=" || key === "-" || key === "0") && activeBrowserPane) {
				event.preventDefault();
				controlBrowser(
					activeBrowserPane.id,
					key === "-" ? "zoom-out" : key === "0" ? "zoom-reset" : "zoom-in",
				);
				return;
			}
		}
		if (!commandModifier && event.altKey && activeBrowserPane) {
			if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
				event.preventDefault();
				controlBrowser(activeBrowserPane.id, event.key === "ArrowLeft" ? "back" : "forward");
			}
		}
	}
</script>
<svelte:head><title>{documentTitle}</title></svelte:head>
<svelte:window onkeydown={handleKeyboard} />

<div class="workspace-app">
	<WorkspaceShell
		maximized={maximized}
		hydrated={hydrated}
		activeTabId={activeTabId}
		chatTabId={CHAT_TAB_ID}
		browserTabs={browserTabs}
		chatAttentionCount={chatAttentionCount}
		canReopen={closedBrowserTabs.length > 0}
		onminimize={minimizeWindow}
		browserStates={browserStates}
		ontogglemaximize={() => void toggleMaximizeWindow()}
		onclose={closeWindow}
		onactivatechat={activateChat}
		onactivatetab={activateBrowser}
		onclosetab={(tabId) => void closeBrowserTab(tabId)}
		onduplicatetab={(tabId) => void duplicateBrowserTab(tabId)}
		onmovetab={moveBrowserTab}
		onaddbrowser={() => void addBrowserTab()}
		onreopen={() => void reopenBrowserTab()}
		onreordertab={(tabId, beforeTabId) => void reorderBrowserTab(tabId, beforeTabId)}
	>
		<div
			class="chat-stage"
			id="workspace-panel-chat"
			role="tabpanel"
			aria-labelledby="workspace-tab-chat"
			class:is-active={activeTabId === CHAT_TAB_ID || settingsRoute.open}
			aria-hidden={settingsRoute.open ? undefined : activeTabId !== CHAT_TAB_ID}
			inert={!settingsRoute.open && activeTabId !== CHAT_TAB_ID}
		>
			<OmpChat
				appSettings={appSettings}
				theme={resolvedTheme}
				terminalTabs={terminalTabs}
				workspaceId={activeWorkspaceId}
				active={activeTabId === CHAT_TAB_ID && !settingsRoute.open}
				{chatPresentationReady}
				onPlanReviewCountChange={(count) => { chatAttentionCount = count; }}
				onActiveSessionChange={(sessionId) => { activeSessionId = sessionId; }}
				settingsRoute={settingsRoute}
				onOpenSettings={openSettings}
				onSettingsRouteChange={updateSettingsRoute}
				onCloseSettings={closeSettings}
				onUpdateAppSetting={updateAppSetting}
				onResetAppSettings={resetAppSettings}
				appSettingsBusy={appSettingsBusy}
				appSettingsStatus={appSettingsStatus}
			/>
		</div>

		{#each browserTabs as tab (tab.id)}
			<div
				id={`workspace-panel-${tab.id}`}
				role="tabpanel"
				aria-labelledby={`workspace-tab-${tab.id}`}
				class="browser-tab-stage"
				class:is-active={!settingsRoute.open && activeTabId === tab.id}
				aria-hidden={settingsRoute.open || activeTabId !== tab.id}
				inert={settingsRoute.open || activeTabId !== tab.id}
			>

				<div class="browser-stage-layout">
					<div class={`browser-pane-grid ${layoutClass(tab)}`} style={tab.panes.length === 2 && tab.layout === "columns" ? `grid-template-columns: ${tab.ratio}% ${100 - tab.ratio}%` : tab.panes.length === 2 && tab.layout === "rows" ? `grid-template-rows: ${tab.ratio}% ${100 - tab.ratio}%` : ""}>
						{#each tab.panes as pane (pane.id)}
							{@const state = browserStates.get(pane.id)}
							{@const findState = browserFindStates.get(pane.id)}
							{@const selectionState = selectionStatesByPane.get(pane.id)}
							{@const selectionPending = selectorLatch?.paneId === pane.id && !selectorLatch.selectionId}
							{@const isSelecting = selectorLatch?.paneId === pane.id && Boolean(selectorLatch.selectionId)}
							<BrowserPane
								pane={pane}
								tabId={tab.id}
								workspaceId={activeWorkspaceId}
								focused={tab.activePaneId === pane.id}
								active={!settingsRoute.open && activeTabId === tab.id}
								canSplit={tab.panes.length < MAX_BROWSER_PANES}
								browserState={state}
								sessionId={activeSessionId}
								automationState={paneAutomationStates.get(pane.id)}
								findOpen={openBrowserFindPanes.has(pane.id)}
								findState={findState}
								selectionState={selectionState}
								agents={agents}
								isSelecting={isSelecting}
								selectionPending={selectionPending}
								defaultUrl={DEFAULT_BROWSER_URL}
								onactivate={() => activatePane(tab, pane.id)}
								onnavigate={(address) => void navigateBrowser(pane.id, address)}
								oncontrol={(action) => controlBrowser(pane.id, action)}
								onopenfind={() => openBrowserFind(pane.id)}
								onfind={(query, forward) => findInBrowser(pane.id, query, forward)}
								onstopfind={() => closeBrowserFind(pane.id)}
								onautomationstate={(automationState) => {
									paneAutomationStates.set(pane.id, automationState);
									paneAutomationStates = new Map(paneAutomationStates);
								}}
								ontoggleselection={() => void toggleSelectionForPane(pane.id)}
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
			</div>
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
	{#if pendingBrowserClose}
		<ModalShell
			backdrop={true}
			backdropClass="browser-close-backdrop"
			dialogClass="browser-close-dialog"
			labelledbyId="browser-close-title"
			onclose={() => settleBrowserClose(false)}
			cancelable={true}
		>
			<h2 id="browser-close-title">Close “{pendingBrowserClose.title}”?</h2>
			<p>
				{pendingBrowserClose.paneCount === 1
					? "This closes its browser pane."
					: `This closes all ${pendingBrowserClose.paneCount} panes in the tab.`}
			</p>
			<div class="dialog-actions">
				<button bind:this={browserCloseCancelButton} type="button" class="secondary-button" onclick={() => settleBrowserClose(false)}>Cancel</button>
				<button type="button" class="danger-button" onclick={() => settleBrowserClose(true)}>Close tab</button>
			</div>
		</ModalShell>
	{/if}
</div>


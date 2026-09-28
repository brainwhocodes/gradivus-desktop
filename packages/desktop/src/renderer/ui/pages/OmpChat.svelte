<script lang="ts">
	import { ChatWorkspace, ModalShell, type HostedAppearanceSettings } from "@gradivus/chat";
	import { onMount } from "svelte";
	import type { GradivusSettings, UpdateGradivusSettingsInput } from "../../../shared/contracts";
	import type { ResolvedTheme } from "../../../shared/theme-palette";
	import type {
		LocalChatConnectionView,
		LocalChatConsentDecision,
		LocalChatConsentRequest,
	} from "../../../shared/local-chat-consent";
	import { createElectronChatApi } from "../../electron-chat-api";
	import type {
		SettingsCategoryId,
	} from "../../settings-types";
	import type { WorkspaceTab } from "../../workspace-types";
	import ChatTerminalDrawer from "../organisms/ChatTerminalDrawer.svelte";
	import LocalAppConnectionsPanel from "../organisms/LocalAppConnectionsPanel.svelte";

	export let appSettings: GradivusSettings | undefined = undefined;
	export let terminalTabs: WorkspaceTab[] = [];
	export let workspaceId = "";
	export let theme: ResolvedTheme = "dark";
	export let onActiveSessionChange: (sessionId: string) => void = () => undefined;
	export let onOpenSettings: (category: SettingsCategoryId, trigger: HTMLElement) => void = () => undefined;
	export let onCloseSettings: () => void = () => undefined;
	export let onUpdateAppSetting: (
		key: string,
		updates: UpdateGradivusSettingsInput,
		label: string,
	) => Promise<void> = async () => undefined;
	export let active = true;
	export let chatPresentationReady = true;
	export let onPlanReviewCountChange: (count: number) => void = () => undefined;

	let activeSessionId = "";
	let terminalOpen = false;
	let accountsButton: HTMLButtonElement | undefined;
	let desktopRoot: HTMLDivElement | undefined;
	let settingsRequest: { category: SettingsCategoryId; requestId: number } | undefined;
	let connections: LocalChatConnectionView[] = [];
	let connectionsLoading = true;
	let connectionsError = "";
	let busyGrantIds = new Set<string>();
	let consentRequest: LocalChatConsentRequest | undefined;
	let consentBusy = false;
	let consentError = "";
	let consentExpiryTimer: number | undefined;

	const api = createElectronChatApi(window.gradivus, {
		openAccounts: () => openAccounts(),
	});

	onMount(() => {
		void refreshConnections();
		const stopConsent = window.gradivus.onLocalChatConsentRequest(request => {
			consentRequest = request;
			consentError = "";
			window.clearTimeout(consentExpiryTimer);
			consentExpiryTimer = window.setTimeout(
				() => {
					if (consentRequest?.requestId === request.requestId) consentRequest = undefined;
				},
				Math.max(0, request.expiresAt - Date.now()),
			);
		});
		const stopConnections = window.gradivus.onLocalChatConnectionsChanged(value => {
			connections = value;
			connectionsLoading = false;
			connectionsError = "";
		});
		const stopOpenAccounts = window.gradivus.onOpenDesktopAccounts(() => openAccounts());
		return () => {
			stopConsent();
			stopConnections();
			stopOpenAccounts();
			window.clearTimeout(consentExpiryTimer);
		};
	});

	function settingsTrigger(): HTMLElement | undefined {
		return document.activeElement instanceof HTMLElement ? document.activeElement : accountsButton ?? desktopRoot;
	}

	function handleSettingsOpenChange(open: boolean, category: SettingsCategoryId): void {
		if (open) {
			const trigger = settingsTrigger();
			if (trigger) onOpenSettings(category, trigger);
		} else {
			onCloseSettings();
		}
	}

	function openAccounts(): void {
		settingsRequest = { category: "accounts", requestId: (settingsRequest?.requestId ?? 0) + 1 };
	}

	async function refreshConnections(): Promise<void> {
		connectionsLoading = true;
		connectionsError = "";
		try {
			connections = await window.gradivus.getLocalChatConnections();
		} catch (error) {
			connectionsError = error instanceof Error ? error.message : String(error);
		} finally {
			connectionsLoading = false;
		}
	}

	async function revokeConnection(grantId: string): Promise<void> {
		if (busyGrantIds.has(grantId)) return;
		busyGrantIds = new Set([...busyGrantIds, grantId]);
		connectionsError = "";
		try {
			connections = await window.gradivus.revokeLocalChatConnection(grantId);
		} catch (error) {
			connectionsError = error instanceof Error ? error.message : String(error);
		} finally {
			const next = new Set(busyGrantIds);
			next.delete(grantId);
			busyGrantIds = next;
		}
	}

	async function respondToConsent(decision: LocalChatConsentDecision["decision"]): Promise<void> {
		const request = consentRequest;
		if (!request || consentBusy) return;
		consentBusy = true;
		consentError = "";
		try {
			const accepted = await window.gradivus.respondLocalChatConsent({ requestId: request.requestId, decision });
			if (!accepted) throw new Error("This connection request is no longer active.");
			consentRequest = undefined;
		} catch (error) {
			consentError = error instanceof Error ? error.message : String(error);
		} finally {
			consentBusy = false;
		}
	}

	$: appearance = {
		theme: appSettings?.theme ?? "system",
		density: appSettings?.ui.density ?? "comfortable",
		reduceMotion: appSettings?.ui.reduceMotion ?? false,
		showToolDetails: appSettings?.ui.showToolDetails ?? true,
	} satisfies HostedAppearanceSettings;

	function updateAppearance(next: HostedAppearanceSettings): void {
		void onUpdateAppSetting(
			"hostedAppearance",
			{
				theme: next.theme,
				ui: {
					density: next.density,
					reduceMotion: next.reduceMotion,
					showToolDetails: next.showToolDetails,
				},
			},
			"Appearance",
		);
	}

	function handleActiveSession(sessionId: string): void {
		activeSessionId = sessionId;
		onActiveSessionChange(sessionId);
		if (!sessionId) terminalOpen = false;
	}

</script>

<div class="desktop-chat-adapter" bind:this={desktopRoot}>
	{#snippet desktopSettings(category: SettingsCategoryId, _visibleSettingIds: ReadonlySet<string>)}
		{#if category === "accounts"}
			<LocalAppConnectionsPanel
				{connections}
				loading={connectionsLoading}
				error={connectionsError}
				{busyGrantIds}
				onRevoke={revokeConnection}
			/>
		{/if}
	{/snippet}
	<ChatWorkspace
		{api}
		{appearance}
		{theme}
		{active}
		{chatPresentationReady}
		settingsContent={desktopSettings}
		{settingsRequest}
		onSettingsOpenChange={handleSettingsOpenChange}
		onAppearanceChange={updateAppearance}
		onActiveSessionChange={handleActiveSession}
		onPlanReviewCountChange={onPlanReviewCountChange}
	/>

	{#if activeSessionId}
		<div class="desktop-chat-controls" aria-label="Desktop chat controls">
			<button
				type="button"
				class="secondary-button terminal-toggle-btn"
				aria-expanded={terminalOpen}
				aria-controls="chat-terminal-drawer"
				onclick={() => (terminalOpen = !terminalOpen)}
			>
				{terminalOpen ? "Hide Local terminal" : "Local terminal"}
			</button>
			<button
				bind:this={accountsButton}
				type="button"
				class="secondary-button"
				onclick={() => openAccounts()}
			>
				Accounts
			</button>
		</div>
		<div class="chat-terminal-panel" class:is-open={terminalOpen}>
			<ChatTerminalDrawer
				{workspaceId}
				tabs={terminalTabs}
				open={terminalOpen}
				confirmClose={appSettings?.confirmCloseTab ?? true}
				{theme}
				terminalSettings={appSettings?.terminal}
			/>
		</div>
	{/if}

	{#if consentRequest}
		<ModalShell
			backdrop
			dialogClass="local-chat-consent-dialog"
			labelledbyId="local-chat-consent-title"
			trapFocus
			initialFocusId="local-chat-consent-deny"
			cancelable={!consentBusy}
			onclose={() => void respondToConsent("deny")}
		>
			<header class="local-chat-consent-heading">
				<p class="eyebrow">Local app connection</p>
				<h2 id="local-chat-consent-title">{consentRequest.title}</h2>
				<p><strong>{consentRequest.clientName}</strong> at <code>{consentRequest.origin}</code></p>
			</header>
			<section aria-labelledby="local-chat-consent-access">
				<h3 id="local-chat-consent-access">Requested access</h3>
				<ul class="local-chat-consent-scopes">
					{#each consentRequest.scopes as scope (scope.scope)}
						<li>{scope.label}</li>
					{/each}
				</ul>
			</section>
			<p class="local-chat-risk-notice">{consentRequest.riskNotice}</p>
			<p class="local-chat-security-note">{consentRequest.securityNote}</p>
			{#if consentError}<p class="settings-feedback settings-feedback-error" role="alert">{consentError}</p>{/if}
			<div class="dialog-actions">
				<button
					type="button"
					class="secondary-button"
					disabled={consentBusy}
					id="local-chat-consent-deny"
					onclick={() => void respondToConsent("deny")}
				>
					{consentRequest.denyLabel}
				</button>
				<button
					type="button"
					class="primary-button"
					disabled={consentBusy}
					aria-busy={consentBusy}
					onclick={() => void respondToConsent("allow")}
				>
					{consentBusy ? "Allowing…" : consentRequest.allowLabel}
				</button>
			</div>
		</ModalShell>
	{/if}
</div>

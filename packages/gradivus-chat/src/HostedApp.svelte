<script lang="ts">
	import { onMount } from "svelte";
	import ChatWorkspace from "./lib/ChatWorkspace.svelte";
	import GradivusMark from "./lib/components/GradivusMark.svelte";
	import type { ChatApi } from "./lib/chat-api";
	import type { HostedAppearanceSettings } from "./lib/contracts";
	import { BrowserChatTransport, createBrowserChatApi, type DesktopTransportStatus } from "./lib/browser-chat-api";
	import { stateForProbe, type HostedConnectionState } from "./connection/connect-state";
	import { probeLoopbackDesktop } from "./connection/loopback-probe";
	import { authorizeDesktop, DesktopAuthorizationError, revokeDesktopAuthorization } from "./connection/desktop-oauth";

	let connection: HostedConnectionState = { status: "disconnected" };
	let transport: BrowserChatTransport | undefined;
	let api: ChatApi | undefined;
	let transportStatus: DesktopTransportStatus = "interrupted";
	let popup: Window | null = null;
	let pending: AbortController | undefined;
	let connecting = false;
	let expanding = false;
	let errorMessage = "";
	let accountMessage = "";
	let accountBusy = false;
	let disconnecting = false;
	let hasDesktopPermission = false;
	let settingsRequest: { category: "accounts"; requestId: number } | undefined;
	let appearance: HostedAppearanceSettings = { theme: "light", density: "comfortable", reduceMotion: false, showToolDetails: true };
	let prefersDark = false;
	$: theme = appearance.theme === "system" ? (prefersDark ? "dark" : "light") : appearance.theme;
	$: document.documentElement.dataset.theme = api ? theme : "light";
	$: busy = connecting || connection.status === "checking-browser-access";
	$: awaiting = connection.status === "awaiting-desktop-consent" && connecting;
	$: recovery = transportStatus === "expired" ? "Your connection expired. Approve access in Desktop to continue." : transportStatus === "revoked" ? "Desktop access was revoked. Connect again if you want to continue." : "Connection to Desktop was interrupted. Keep Desktop open on this computer, then reconnect.";

	onMount(() => {
		const query = window.matchMedia("(prefers-color-scheme: dark)");
		const updateTheme = (): void => { prefersDark = query.matches; };
		updateTheme();
		query.addEventListener("change", updateTheme);
		return () => {
			pending?.abort();
			popup?.close();
			void transport?.destroy();
			query.removeEventListener("change", updateTheme);
		};
	});

	function cancelConnection(): void {
		pending?.abort();
		popup?.close();
		connection = { status: "disconnected" };
	}

	async function connect(expand = false): Promise<void> {
		if (connecting || disconnecting) throw new Error("A Desktop connection request is already in progress.");
		errorMessage = "";
		accountMessage = "";
		popup = window.open("about:blank", `gradivus-chat-connect-${crypto.randomUUID()}`, "popup,width=560,height=720");
		if (!popup) {
			errorMessage = "Allow pop-ups for this site, then connect again.";
			throw new DesktopAuthorizationError("popup_blocked", errorMessage);
		}
		popup.document.title = "Connect to Gradivus Desktop";
		popup.document.body.textContent = "Checking for Gradivus Desktop on this computer…";
		connecting = true;
		expanding = expand;
		const controller = new AbortController();
		pending = controller;
		const previous = expand ? transport?.authorization : undefined;
		try {
			connection = { status: "checking-browser-access" };
			// Discovery identifies Desktop; it always advertises its production client.
			// OAuth selects the exact registered production or development browser origin.
			connection = stateForProbe(await probeLoopbackDesktop());
			controller.signal.throwIfAborted();
			if (connection.status !== "awaiting-desktop-consent") throw new Error("Desktop could not be reached securely.");
			const authorization = await authorizeDesktop(popup, controller.signal, previous);
			controller.signal.throwIfAborted();
			if (!transport) {
				transport = new BrowserChatTransport(authorization, {
					onStatus: status => { transportStatus = status; },
					requestDesktopPermission: () => connect(true),
				});
			}
			await transport.connect(authorization);
			hasDesktopPermission = authorization.scopes.includes("desktop.present");
			api ??= createBrowserChatApi(transport);
			connection = { status: "disconnected" };
		} catch (error) {
			if (connection.status === "awaiting-desktop-consent" || controller.signal.aborted) connection = { status: "disconnected" };
			if (connection.status === "disconnected") errorMessage = error instanceof Error ? error.message : "Could not connect to Desktop. Try again.";
			if (previous && transport && transportStatus !== "connected") await transport.connect(previous).catch(() => undefined);
			throw error;
		} finally {
			controller.abort();
			popup?.close();
			popup = null;
			pending = undefined;
			connecting = false;
			expanding = false;
		}
	}

	function beginConnection(): void { void connect().catch(() => undefined); }

	async function reconnect(): Promise<void> {
		if (!transport || transportStatus === "expired" || transportStatus === "revoked") { beginConnection(); return; }
		connecting = true;
		errorMessage = "";
		try { await transport.connect(); }
		catch (error) { errorMessage = error instanceof Error ? error.message : "Desktop is still unavailable."; }
		finally { connecting = false; }
	}

	async function disconnect(): Promise<void> {
		if (!transport || disconnecting) return;
		disconnecting = true;
		const authorization = transport.authorization;
		void transport.destroy();
		transport = undefined;
		api = undefined;
		hasDesktopPermission = false;
		connection = { status: "disconnected" };
		errorMessage = "";
		try { await revokeDesktopAuthorization(authorization); }
		catch { errorMessage = "This tab is disconnected. Desktop was unavailable; remove the connection in Desktop → Accounts to revoke its grant."; }
		finally { disconnecting = false; }
	}

	async function openAccounts(): Promise<void> {
		if (!api || accountBusy) return;
		accountBusy = true;
		accountMessage = "";
		try {
			const result = await api.openDesktopAccounts();
			accountMessage = result.action.state === "cancelled" ? "Opening Accounts was cancelled in Desktop." : result.action.state === "failed" ? result.action.message ?? "Desktop could not open Accounts." : "Continue in Gradivus Desktop → Accounts.";
		} catch (error) { accountMessage = error instanceof Error ? error.message : "Could not open Desktop Accounts."; }
		finally { accountBusy = false; }
	}

	$: presentation = (() => {
		switch (connection.status) {
			case "checking-browser-access": return { title: "Checking for Desktop…", detail: "Confirming that this browser can reach apps on this computer.", action: "Checking for Desktop…" };
			case "browser-access-denied": return { title: "Browser access is blocked", detail: "Allow access to apps on this device in this browser’s Site settings, then try again.", action: "Try again" };
			case "browser-access-unsupported": return { title: "Use a supported browser", detail: "A current Chrome or Edge browser is required to connect securely to Desktop on this computer.", action: "Check again" };
			case "desktop-unavailable": return { title: "Desktop is unavailable", detail: "Open Gradivus Desktop on this computer, then try again.", action: "Try again" };
			case "protocol-mismatch": return { title: "Desktop needs an update", detail: "Update Gradivus Desktop before connecting this browser.", action: "Check again" };
			case "awaiting-desktop-consent": return { title: "Approve in Desktop", detail: "Review the request in Gradivus Desktop. This tab will continue after you allow access.", action: undefined };
			default: return { title: "Your Desktop.\nIn this browser.", detail: "Connect to Gradivus Desktop to continue your coding chats on this computer.", action: "Connect to Desktop" };
		}
	})();
</script>

<svelte:head><title>Gradivus Chat</title></svelte:head>

{#snippet accountsContent()}
	<section class="hosted-accounts" aria-labelledby="hosted-accounts-title">
		<p class="hosted-eyebrow">Accounts & connection</p>
		<h3 id="hosted-accounts-title">Managed by Desktop</h3>
		<p>Provider sign-in and credentials stay in Gradivus Desktop. Your browser uses Desktop’s connected accounts to run your chats.</p>
		<div class="hosted-accounts__row"><div><strong>Provider accounts</strong><p>Connect, switch, or remove providers in Desktop.</p></div><span>Desktop-managed</span></div>
		<div class="hosted-accounts__row"><div><strong>Browser connection</strong><p>This browser connects to Desktop on the same computer.</p></div><span>{transportStatus === "connected" ? "Connected" : "Interrupted"}</span></div>
		<div class="hosted-accounts__permission"><strong>{hasDesktopPermission ? "Desktop actions allowed" : "Desktop actions need extra permission"}</strong><p>{hasDesktopPermission ? "This tab can request Desktop pickers, files, and Accounts. Revoke access at any time in Desktop." : "Opening Accounts, choosing a folder, or opening a file asks Desktop for an additional approval. Coding chat does not require this permission."}</p></div>
		<button type="button" class="hosted-primary" disabled={accountBusy || transportStatus !== "connected"} onclick={() => void openAccounts()}>{accountBusy ? "Waiting for Desktop…" : "Manage accounts in Desktop"}</button>
		{#if accountMessage}<p role="status">{accountMessage}</p>{/if}
	</section>
{/snippet}

<div class:hosted-shell--connected={api} class="hosted-shell">
	<header class="hosted-header">
		<div class="hosted-brand"><GradivusMark size={32} /><span>Gradivus <span class="hosted-brand__suffix">Chat</span></span></div>
		<div class="hosted-header__end">
			<span class:hosted-connection-label--offline={api && transportStatus !== "connected"} class="hosted-connection-label"><span class="hosted-status-dot" aria-hidden="true"></span>{api ? transportStatus === "connected" ? "Connected to Desktop" : "Desktop disconnected" : "Runs on this computer"}</span>
			{#if api}<button class="hosted-quiet" type="button" disabled={transportStatus !== "connected" || busy} onclick={() => { settingsRequest = { category: "accounts", requestId: Date.now() }; }}>Accounts</button><button class="hosted-quiet" type="button" disabled={busy || disconnecting} onclick={() => void disconnect()}>Disconnect</button>{/if}
		</div>
	</header>
	{#if api}
		{#if busy || transportStatus !== "connected" || errorMessage}
			<div class="hosted-recovery" role="status">
				<div><strong>{expanding ? "Allow Desktop actions" : awaiting ? "Approve in Desktop" : busy ? "Reconnecting…" : transportStatus !== "connected" ? "Connection paused" : "Connection notice"}</strong><p>{expanding ? "Approve the optional permission in Desktop to open native pickers, files, and Accounts." : busy ? "Keep this tab open while Desktop connects." : errorMessage || recovery}</p></div>
				{#if awaiting}<button type="button" class="hosted-quiet" onclick={cancelConnection}>Cancel</button>{:else if !busy && transportStatus !== "connected"}<button type="button" class="hosted-primary" onclick={() => void reconnect()}>Reconnect</button>{:else if !busy}<button type="button" class="hosted-quiet" onclick={() => { errorMessage = ""; }}>Dismiss</button>{/if}
			</div>
		{/if}
		<div class="hosted-workspace" inert={transportStatus !== "connected" || expanding}>
			<ChatWorkspace {api} {theme} {appearance} {settingsRequest} settingsContent={accountsContent} onAppearanceChange={next => { appearance = next; }} />
		</div>
	{:else}
		<main class="hosted-connect" aria-labelledby="hosted-connect-title">
			<section class="hosted-connect__intro" aria-busy={busy}>
				<p class="hosted-eyebrow">Your local coding workspace</p>
				<h1 id="hosted-connect-title">{presentation.title}</h1>
				<p class="hosted-connect__detail" role={connection.status === "disconnected" ? undefined : "status"}>{presentation.detail}</p>
				{#if errorMessage}<p class="hosted-error" role="alert">{errorMessage}</p>{/if}
				{#if presentation.action}<button type="button" class="hosted-primary hosted-connect__action" disabled={busy || disconnecting} onclick={beginConnection}>{presentation.action}<span aria-hidden="true">↗</span></button>{/if}
				{#if awaiting || connection.status === "checking-browser-access"}<button type="button" class="hosted-quiet" onclick={cancelConnection}>Cancel</button>{/if}
				<p class="hosted-connect__hint">You’ll approve access in Gradivus Desktop.</p>
			</section>
			<section class="hosted-connect__explanation" aria-labelledby="hosted-local-title">
				<div class="hosted-connection-diagram" aria-hidden="true"><span>Browser</span><i></i><span>Desktop</span></div>
				<h2 id="hosted-local-title">One computer.<br />One workspace.</h2>
				<ul><li><span aria-hidden="true">01</span><div><strong>Desktop runs your coding chats</strong><p>Sessions, tools, and file access are managed on your computer.</p></div></li><li><span aria-hidden="true">02</span><div><strong>Your provider accounts stay in Desktop</strong><p>Provider sign-in and credentials are managed by Desktop.</p></div></li><li><span aria-hidden="true">03</span><div><strong>You choose when to connect</strong><p>Review permissions in Desktop before this browser gets access.</p></div></li></ul>
			</section>
			<footer class="hosted-connect__footer"><p>Open Gradivus Desktop before connecting. Browser and Desktop must be on the same computer.</p><ol aria-label="Connection steps"><li class:active={!awaiting}><span>1</span>Connect</li><li class:active={awaiting}><span>2</span>Approve in Desktop</li><li><span>3</span>Continue chatting</li></ol><small>Access tokens stay in this tab’s memory. Reloading requires a new connection.</small></footer>
		</main>
	{/if}
</div>

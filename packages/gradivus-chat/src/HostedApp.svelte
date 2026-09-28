<script lang="ts">
	import GradivusMark from "./lib/components/GradivusMark.svelte";
	import { stateForProbe, type HostedConnectionState } from "./connection/connect-state";
	import { probeLoopbackDesktop } from "./connection/loopback-probe";
	import { GRADIVUS_CHAT_DEV_CLIENT_ID, GRADIVUS_CHAT_DEV_ORIGIN } from "./lib/protocol";

	let connection: HostedConnectionState = { status: "disconnected" };
	let connectionPopup: Window | null = null;

	const expectedClientId =
		window.location.origin === GRADIVUS_CHAT_DEV_ORIGIN ? GRADIVUS_CHAT_DEV_CLIENT_ID : undefined;

	async function beginConnection(): Promise<void> {
		if (connection.status === "checking-browser-access") return;
		connectionPopup = window.open("", "gradivus-chat-connect", "popup,width=520,height=720");
		if (connectionPopup) {
			connectionPopup.document.title = "Connecting to Gradivus Desktop";
			connectionPopup.document.body.textContent = "Checking for Gradivus Desktop…";
		}
		connection = { status: "checking-browser-access" };
		const result = await probeLoopbackDesktop({ clientId: expectedClientId });
		connection = stateForProbe(result);
		if (connection.status === "awaiting-desktop-consent") {
			window.dispatchEvent(
				new CustomEvent("gradivus:desktop-probed", {
					detail: { metadata: connection.metadata, popup: connectionPopup },
				}),
			);
			return;
		}
		connectionPopup?.close();
		connectionPopup = null;
	}

	$: presentation = (() => {
		switch (connection.status) {
			case "disconnected":
				return {
				title: "Continue with Gradivus Desktop",
				detail:
					"Desktop keeps your coding sessions and provider credentials local. This tab connects only after you approve it in Gradivus.",
					action: "Connect to Gradivus Desktop",
				};
			case "checking-browser-access":
				return {
					title: "Checking for Gradivus Desktop…",
					detail: "Confirming that this browser can securely reach apps on this computer.",
					action: "Checking for Gradivus Desktop…",
				};
			case "browser-access-denied":
				return {
					title: "Access to apps on this device is blocked.",
					detail:
					"Allow loopback access for gradivus.brainwhocodes.rocks in this browser’s Site settings, then try again.",
					action: "Try again",
				};
			case "browser-access-unsupported":
				return {
					title: "This browser can’t connect securely to Gradivus Desktop.",
					detail: "Use a current Chrome or Edge browser on this computer.",
				};
			case "desktop-unavailable":
				return {
					title: "Gradivus Desktop isn’t available.",
					detail: "Open Gradivus Desktop on this computer, then try again.",
					action: "Try again",
				};
			case "protocol-mismatch":
				return {
					title: "Gradivus Desktop needs an update.",
					detail: "Install the current Gradivus Desktop release before connecting this browser.",
				};
			case "awaiting-desktop-consent":
				return {
					title: "Check Gradivus Desktop",
					detail: "Approve the request in Gradivus Desktop. This page will continue automatically.",
				};
		}
	})();
	$: messageRole =
		connection.status === "checking-browser-access"
			? "status"
			: connection.status === "browser-access-denied" ||
					connection.status === "browser-access-unsupported" ||
					connection.status === "desktop-unavailable" ||
					connection.status === "protocol-mismatch"
				? "alert"
				: undefined;
</script>

<svelte:head>
	<title>Gradivus Chat</title>
</svelte:head>

<main class="hosted-connect" aria-labelledby="hosted-connect-title">
	<section class="hosted-connect__panel" aria-busy={connection.status === "checking-browser-access"}>

		<div class="hosted-connect__brand" aria-label="Gradivus Chat">
			<GradivusMark />
			<span>Gradivus Chat</span>
		</div>
		<div class="hosted-connect__copy">
			<p class="hosted-connect__eyebrow">Coding chat on this computer</p>
			<h1 id="hosted-connect-title">{presentation.title}</h1>
			<p role={messageRole}>{presentation.detail}</p>
		</div>
		{#if presentation.action}
			<button
				type="button"
				class="hosted-connect__action"
				disabled={connection.status === "checking-browser-access"}
				aria-busy={connection.status === "checking-browser-access"}
				onclick={() => void beginConnection()}
			>
				{presentation.action}
			</button>
		{/if}
		<p class="hosted-connect__privacy">This browser tab does not store access tokens or Desktop session data.</p>
	</section>
</main>

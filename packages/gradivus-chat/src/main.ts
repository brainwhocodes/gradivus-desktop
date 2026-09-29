import "./styles/hosted.scss";
import { mount } from "svelte";
import { completeOAuthCallback } from "./connection/desktop-oauth";
import HostedApp from "./HostedApp.svelte";
import { GRADIVUS_CHAT_CALLBACK_PATH } from "./lib/protocol";

const target = document.getElementById("app");
if (!target) throw new Error("Gradivus Chat mount target is missing");

if (window.location.pathname === GRADIVUS_CHAT_CALLBACK_PATH) {
	document.documentElement.dataset.theme = "light";
	document.title = "Gradivus Desktop approval";
	const panel = document.createElement("main");
	panel.className = "hosted-callback";
	const title = document.createElement("h1");
	title.textContent = "Gradivus Desktop approval";
	const message = document.createElement("p");
	message.setAttribute("role", "status");
	message.textContent = completeOAuthCallback();
	panel.append(title, message);
	target.append(panel);
} else {
	mount(HostedApp, { target });
}

import { isRecord } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";

const paneName = process.argv[2];
const probeValue = process.argv[3];
if (!paneName || !probeValue) {
	throw new Error("Usage: gradivus-browser-probe.ts <pane-name> <probe-value>");
}

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.cdpUrl": "http://127.0.0.1:2",
		"browser.headless": true,
		"browser.relay": true,
		"browser.relayUrl": "http://127.0.0.1:1",
	}),
};
const browserTool = createBrowserPrelude(session);
const invokeBrowser = (toolCallId: string, parameters: unknown) =>
	browserTool.invoke(parameters, { session, toolCallId });
let browser: string | undefined;
try {
	const opened = await invokeBrowser("gradivus-probe-open", {
		action: "open",
		name: paneName,
		app: { relay: true },
	});
	const browserDetail = isRecord(opened.details) ? opened.details.browser : undefined;
	browser = typeof browserDetail === "string" ? browserDetail : undefined;
	if (browser !== "connected") {
		throw new Error(`Expected connected Gradivus browser, received ${browser ?? "unknown"}`);
	}
	await invokeBrowser("gradivus-probe-run", {
		action: "run",
		name: paneName,
		code: `
			const probeValue = ${JSON.stringify(probeValue)};
			return await tab.evaluate(value => {
				const output = document.querySelector("#fixture-output");
				if (!output) throw new Error("Browser fixture output is missing");
				output.textContent = value;
				return output.textContent;
			}, probeValue);
		`,
	});
} finally {
	await invokeBrowser("gradivus-probe-close", { action: "close", name: paneName });
}

process.stdout.write(`${JSON.stringify({ browser, name: paneName, probeValue })}\n`);

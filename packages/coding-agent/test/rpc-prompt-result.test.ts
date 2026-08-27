import { expect, test } from "bun:test";
import {
	RpcExtensionUserMessageTracker,
	reportPromptResult,
	watchAndReportPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

async function settle(prompt: Promise<unknown>): Promise<void> {
	await prompt.catch(() => undefined);
	await Promise.resolve();
	await Promise.resolve();
}

test("prompt_result reports local-only completion exactly once", async () => {
	const output: object[] = [];
	const prompt = Promise.resolve(false);
	reportPromptResult({ id: "req-local", prompt, output: frame => output.push(frame) });
	await settle(prompt);
	expect(output).toEqual([{ type: "prompt_result", id: "req-local", agentInvoked: false }]);
});

test("prompt_result reports an agent-invoked completion", async () => {
	const output: object[] = [];
	const prompt = Promise.resolve(true);
	reportPromptResult({ id: "req-agent", prompt, output: frame => output.push(frame) });
	await settle(prompt);
	expect(output).toEqual([{ type: "prompt_result", id: "req-agent", agentInvoked: true }]);
});

test("prompt_result reports provider failures without emitting a second response", async () => {
	const output: object[] = [];
	const error = Object.assign(new Error("No credentials for openai-codex"), { code: "AUTH_REQUIRED" });
	const prompt = Promise.reject(error);
	reportPromptResult({ id: "req-provider", prompt, output: frame => output.push(frame) });
	await settle(prompt);
	expect(output).toEqual([
		{
			type: "prompt_result",
			id: "req-provider",
			agentInvoked: false,
			error: { message: "No credentials for openai-codex", code: "AUTH_REQUIRED" },
		},
	]);
	const first = output[0];
	expect(typeof first === "object" && first !== null && "type" in first && first.type === "response").toBe(false);
});

test("prompt_result preserves unavailable-account and invalid-model errors", async () => {
	const output: object[] = [];
	const errors = [
		Object.assign(new Error("The selected account is locked"), { code: "ACCOUNT_UNAVAILABLE" }),
		Object.assign(new Error("Unknown model: invalid-model"), { code: "INVALID_MODEL" }),
	];
	for (const [index, error] of errors.entries()) {
		const prompt = Promise.reject(error);
		reportPromptResult({ id: `req-error-${index}`, prompt, output: frame => output.push(frame) });
		await settle(prompt);
	}
	expect(output).toEqual([
		{
			type: "prompt_result",
			id: "req-error-0",
			agentInvoked: false,
			error: { message: "The selected account is locked", code: "ACCOUNT_UNAVAILABLE" },
		},
		{
			type: "prompt_result",
			id: "req-error-1",
			agentInvoked: false,
			error: { message: "Unknown model: invalid-model", code: "INVALID_MODEL" },
		},
	]);
});

test("prompt_result reports AgentBusyError with its runtime message", async () => {
	const output: object[] = [];
	const prompt = Promise.reject(
		Object.assign(new Error("Agent is already processing a prompt"), { code: "AGENT_BUSY" }),
	);
	reportPromptResult({ id: "req-busy", prompt, output: frame => output.push(frame) });
	await settle(prompt);
	expect(output).toEqual([
		{
			type: "prompt_result",
			id: "req-busy",
			agentInvoked: false,
			error: { message: "Agent is already processing a prompt", code: "AGENT_BUSY" },
		},
	]);
});

test("watched prompt correlates local-only completion and extension-triggered work", async () => {
	const output: object[] = [];
	const tracker = new RpcExtensionUserMessageTracker();
	const local = tracker.watchPrompt(() => Promise.resolve(false));
	watchAndReportPromptResult({
		id: "req-watched-local",
		startPrompt: () => local.prompt,
		output: frame => output.push(frame),
		extensionUserMessageTracker: tracker,
	});
	await settle(local.prompt);
	expect(output).toEqual([{ type: "prompt_result", id: "req-watched-local", agentInvoked: false }]);

	watchAndReportPromptResult({
		id: "req-watched-agent",
		startPrompt: () => {
			tracker.markAgentMessageTask();
			return Promise.resolve(false);
		},
		output: frame => output.push(frame),
		extensionUserMessageTracker: tracker,
	});
	await settle(Promise.resolve());
	expect(output.at(-1)).toEqual({ type: "prompt_result", id: "req-watched-agent", agentInvoked: true });
});

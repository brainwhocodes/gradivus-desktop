import type { HostedChatOperation } from "@gradivus/chat/protocol";
import { HOSTED_CHAT_OPERATION_NAMES } from "@gradivus/chat/protocol";
import { describe, expect, it } from "vitest";
import { CHAT_COMMAND_POLICY } from "../src/main/hosted-command-policy";

const ALL_STATES = ["stopped", "starting", "ready", "running", "stopping", "error"];
const READY_RUNNING = ["ready", "running"];
const READY = ["ready"];
const RUNNING = ["running"];

function expectGroup(
	operations: readonly HostedChatOperation[],
	requiredScopes: readonly string[],
	allowedStates: readonly string[],
): void {
	for (const operation of operations) {
		expect(CHAT_COMMAND_POLICY[operation].requiredScopes, `${operation} scopes`).toEqual(requiredScopes);
		expect(CHAT_COMMAND_POLICY[operation].allowedStates, `${operation} states`).toEqual(allowedStates);
	}
}

describe("CHAT_COMMAND_POLICY", () => {
	it("contains one explicit policy for every closed hosted operation", () => {
		expect(Object.keys(CHAT_COMMAND_POLICY).sort()).toEqual(Object.keys(HOSTED_CHAT_OPERATION_NAMES).sort());
		for (const [operation, policy] of Object.entries(CHAT_COMMAND_POLICY)) {
			expect(policy.requiresActiveGrant, `${operation} active grant`).toBe(true);
			expect(policy.requiredScopes.length, `${operation} scope count`).toBeGreaterThan(0);
			expect(policy.payloadType, `${operation} payload`).not.toBe("");
			expect(policy.resultType, `${operation} result`).not.toBe("");
			expect(policy.validator, `${operation} validator`).not.toBe("");
			expect(policy.projector, `${operation} projector`).not.toBe("");
			expect(policy.requiresDesktopPresent, `${operation} Desktop presentation`).toBe(
				policy.requiredScopes.includes("desktop.present"),
			);
		}
	});

	it("assigns the exact read and file-read scope sets to every read operation", () => {
		expectGroup(["bootstrap"], ["chat.read"], []);
		expectGroup(
			["openSession", "loadTimelinePage", "loadTimelineItem", "loadTimelineToolDetail"],
			["chat.read"],
			ALL_STATES,
		);
		expectGroup(
			[
				"getAvailableCommands",
				"getAvailableModels",
				"getOpenRouterModelRouting",
				"getSessionStats",
				"getAgentSettings",
				"getAgentPrompts",
				"getSubagentMessages",
				"getAgentHub",
				"getAgentHubMessages",
			],
			["chat.read"],
			READY_RUNNING,
		);
		expectGroup(["loadFileDiff", "loadWorkspaceImage"], ["chat.read", "files.read"], READY_RUNNING);
	});

	it("assigns exact execution states to prompt, runtime, todo, and Agent Hub mutations", () => {
		expectGroup(
			["stagePromptText", "stagePromptAttachments", "releasePromptAttachments"],
			["agent.execute"],
			READY_RUNNING,
		);
		expectGroup(["prompt", "editMessage"], ["agent.execute"], READY);
		expectGroup(["steer", "steerQueued", "queueFollowUp", "abort"], ["agent.execute"], RUNNING);
		expectGroup(
			[
				"setModel",
				"setThinking",
				"setFastMode",
				"setQueueMode",
				"setInterruptMode",
				"setAutoCompaction",
				"setAutoRetry",
				"setOpenRouterProviderEnabled",
				"compact",
				"handoff",
				"retry",
				"abortRetry",
				"togglePlanMode",
				"requestPlanReview",
				"updatePlanReview",
				"resolvePlanReview",
				"setAgentSetting",
				"saveAgentPrompt",
				"resetAgentPrompt",
			],
			["agent.execute"],
			READY,
		);
		expectGroup(
			["setTodos", "agentHubMessage", "agentHubKill", "agentHubClear", "agentHubRevive"],
			["agent.execute"],
			READY_RUNNING,
		);
	});

	it("keeps session management and Desktop presentation scopes on only their intended actions", () => {
		expectGroup(["createInWorkspace"], ["sessions.manage"], []);
		expectGroup(["rename", "deleteSession"], ["sessions.manage"], ALL_STATES);
		expectGroup(["resume"], ["sessions.manage"], ["stopped", "error"]);
		expectGroup(["stop"], ["sessions.manage"], ["starting", "ready", "running", "error"]);
		expectGroup(["restart"], ["sessions.manage"], ["stopped", "ready", "running", "error"]);
		expectGroup(["chooseWorkspaceAndCreate"], ["sessions.manage", "desktop.present"], []);
		expectGroup(["exportHtml"], ["chat.read", "desktop.present"], READY_RUNNING);
		expectGroup(["openWorkspaceFile"], ["files.read", "desktop.present"], READY_RUNNING);
		expectGroup(["openDesktopAccounts"], ["desktop.present"], []);
		expectGroup(["reconnectRuntime"], ["sessions.manage", "desktop.present"], []);
		expect(CHAT_COMMAND_POLICY.deleteSession.confirmation).toBe("object-delete");
		for (const operation of [
			"chooseWorkspaceAndCreate",
			"exportHtml",
			"openWorkspaceFile",
			"openDesktopAccounts",
			"reconnectRuntime",
		] as const) {
			expect(CHAT_COMMAND_POLICY[operation].confirmation).toBe("desktop");
		}
	});
});

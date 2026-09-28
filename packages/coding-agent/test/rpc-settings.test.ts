import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getRpcSettings, setRpcSetting } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-settings";
import type { SamplingParameters } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

function schemaExpression(tool: BashTool): string {
	const parameters = tool.parameters;
	if (!("expression" in parameters) || typeof parameters.expression !== "string") {
		throw new Error("Expected an ArkType schema expression");
	}
	return parameters.expression;
}

function rpcSettingValue(settings: Settings, path: string): unknown {
	const setting = getRpcSettings(settings).find(candidate => candidate.path === path);
	if (!setting) throw new Error(`Expected RPC setting ${path}`);
	return setting.value;
}

describe("RPC settings", () => {
	test("exposes registered provider and memory settings with safe control shapes", () => {
		const settings = getRpcSettings(Settings.isolated());
		const byPath = new Map(settings.map(setting => [setting.path, setting]));

		expect(byPath.get("providers.oauthAccountLocks")).toMatchObject({
			tab: "providers",
			group: "OAuth Accounts",
			control: "json",
			value: {},
		});
		expect(byPath.get("providers.oauthAccountFailover")).toMatchObject({
			tab: "providers",
			group: "OAuth Accounts",
			control: "toggle",
			value: false,
		});
		expect(byPath.get("providers.maxInFlightRequests")).toMatchObject({
			tab: "providers",
			control: "provider-limits",
			value: {},
		});
		expect(byPath.has("memory.backend")).toBe(true);
		expect(settings.some(setting => setting.tab === "memory")).toBe(true);
		expect(settings.some(setting => setting.tab === "providers")).toBe(true);
		expect(byPath.has("hindsight.apiToken")).toBe(false);
		expect(byPath.has("auth.apiKey")).toBe(false);
		expect(byPath.has("providers.openrouterIgnoredProviders")).toBe(false);
	});

	test("persists nested provider JSON settings and rejects non-JSON values", async () => {
		const settings = Settings.isolated();
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => undefined,
		};
		const locks = { anthropic: "a".repeat(64) };

		const view = await setRpcSetting(session, "providers.oauthAccountLocks", locks);
		expect(view).toMatchObject({ control: "json", value: locks });
		expect(rpcSettingValue(settings, "providers.oauthAccountLocks")).toEqual(locks);
		await expect(
			setRpcSetting(session, "providers.oauthAccountLocks", { anthropic: { hash: Number.NaN } }),
		).rejects.toThrow("JSON object");
		expect(rpcSettingValue(settings, "providers.oauthAccountLocks")).toEqual(locks);
	});

	test("round-trips finite numeric and string options with original types", async () => {
		const settings = Settings.isolated();
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => undefined,
		};
		const numeric = getRpcSettings(settings).find(setting => setting.path === "edit.fuzzyThreshold");
		const numericOption = numeric?.options?.find(
			option => typeof option.value === "number" && !Object.is(option.value, numeric.value),
		);
		if (!numericOption || typeof numericOption.value !== "number")
			throw new Error("Expected a numeric fuzzy-threshold option");
		const numericResult = await setRpcSetting(session, "edit.fuzzyThreshold", numericOption.value);
		expect(numericResult.value).toBe(numericOption.value);
		expect(typeof numericResult.value).toBe("number");

		const stringResult = await setRpcSetting(session, "personality", "friendly");
		expect(stringResult.value).toBe("friendly");
		expect(typeof stringResult.value).toBe("string");
		const threshold = getRpcSettings(settings).find(setting => setting.path === "compaction.thresholdPercent");
		const defaultOption = threshold?.options?.find(option => option.label === "Default");
		if (!defaultOption || typeof defaultOption.value !== "number") {
			throw new Error("Expected a numeric compaction-default option");
		}
		expect(defaultOption.value).toBe(-1);
		const thresholdResult = await setRpcSetting(session, "compaction.thresholdPercent", defaultOption.value);
		expect(thresholdResult.value).toBe(-1);
	});
	test("applies named live effects and keeps construction-captured settings next-session only", async () => {
		const settings = Settings.isolated();
		const calls: string[] = [];
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => undefined,
			setThinkingLevel: () => calls.push("thinking"),
			setAdvisorEnabled: () => {
				calls.push("advisor");
				return true;
			},
			setOmitThinking: () => calls.push("omit"),
			setThinkToolEnabled: async () => {
				calls.push("think");
				return true;
			},
			setSamplingParameters: (parameters: SamplingParameters) =>
				calls.push(`sampling:${Object.keys(parameters)[0]}`),
			setSteeringMode: () => calls.push("steering"),
			setFollowUpMode: () => calls.push("follow-up"),
			setInterruptMode: () => calls.push("interrupt"),
			setAutoCompactionEnabled: () => calls.push("compaction"),
			setComputerToolEnabled: async () => {
				calls.push("computer");
				return true;
			},
		};

		await setRpcSetting(session, "defaultThinkingLevel", "low");
		await setRpcSetting(session, "advisor.enabled", true);
		await setRpcSetting(session, "omitThinking", true);
		await setRpcSetting(session, "externalThinking", true);
		const temperature = getRpcSettings(settings).find(setting => setting.path === "temperature");
		const temperatureOption = temperature?.options?.find(option => typeof option.value === "number");
		if (!temperatureOption || typeof temperatureOption.value !== "number")
			throw new Error("Expected a temperature option");
		await setRpcSetting(session, "temperature", temperatureOption.value);
		await setRpcSetting(session, "computer.enabled", !rpcSettingValue(settings, "computer.enabled"));
		await setRpcSetting(session, "compaction.enabled", !rpcSettingValue(settings, "compaction.enabled"));
		await setRpcSetting(session, "steeringMode", "all");
		await setRpcSetting(session, "followUpMode", "all");
		await setRpcSetting(session, "interruptMode", "wait");
		expect(calls).toEqual([
			"thinking",
			"advisor",
			"omit",
			"think",
			"sampling:temperature",
			"computer",
			"compaction",
			"steering",
			"follow-up",
			"interrupt",
		]);

		const inline = getRpcSettings(settings).find(setting => setting.path === "inlineToolDescriptors");
		const nextValue = inline?.options?.find(option => !Object.is(option.value, inline.value))?.value;
		if (nextValue === undefined) throw new Error("inlineToolDescriptors has no alternate finite option");
		await setRpcSetting(session, "inlineToolDescriptors", nextValue);
		expect(calls).toHaveLength(10);
	});

	test("live async setting updates constructed and newly created bash tools", async () => {
		const settings = Settings.isolated();
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => undefined,
		};
		const toolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			settings,
		} as unknown as ToolSession;
		const currentTool = new BashTool(toolSession);
		const currentExpression = schemaExpression(currentTool);
		expect(currentExpression).toContain("async?: boolean");

		await setRpcSetting(session, "async.enabled", false);
		const updatedCurrentExpression = schemaExpression(currentTool);
		expect(updatedCurrentExpression).not.toContain("async?: boolean");

		const nextTool = new BashTool(toolSession);
		expect(schemaExpression(nextTool)).toBe(updatedCurrentExpression);
		expect(rpcSettingValue(settings, "async.enabled")).toBe(false);
	});

	test("rejects false tool effects and rolls settings back", async () => {
		const settings = Settings.isolated();
		const calls: boolean[] = [];
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => undefined,
			setThinkToolEnabled: async (enabled: boolean) => {
				calls.push(enabled);
				return !enabled;
			},
		};

		await expect(setRpcSetting(session, "externalThinking", true)).rejects.toThrow("could not be applied");

		const computerSettings = Settings.isolated({ "computer.enabled": false });
		const computerCalls: boolean[] = [];
		const computerSession = {
			settings: computerSettings,
			refreshBaseSystemPrompt: async () => undefined,
			setComputerToolEnabled: async (enabled: boolean) => {
				computerCalls.push(enabled);
				return false;
			},
		};
		await expect(setRpcSetting(computerSession, "computer.enabled", true)).rejects.toThrow("could not be applied");
		expect(rpcSettingValue(computerSettings, "computer.enabled")).toBe(false);
		expect(computerCalls).toEqual([true, false]);
		expect(rpcSettingValue(settings, "externalThinking")).toBe(false);
		expect(calls).toEqual([true, false]);
	});

	test("rolls back a setting and its effect when application throws", async () => {
		const settings = Settings.isolated();
		const calls: string[] = [];
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => {
				calls.push(String(rpcSettingValue(settings, "personality")));
				throw new Error("prompt refresh failed");
			},
		};

		await expect(setRpcSetting(session, "personality", "friendly")).rejects.toThrow("prompt refresh failed");
		expect(rpcSettingValue(settings, "personality")).toBe("default");
		expect(calls).toEqual(["friendly", "default"]);
	});

	test("validates mutations and applies live prompt effects", async () => {
		const settings = Settings.isolated();
		let promptRefreshes = 0;
		const session = {
			settings,
			refreshBaseSystemPrompt: async () => {
				promptRefreshes++;
			},
		};

		const personality = await setRpcSetting(session, "personality", "pragmatic");
		expect(personality.value).toBe("pragmatic");
		expect(rpcSettingValue(settings, "personality")).toBe("pragmatic");
		expect(promptRefreshes).toBe(1);

		await expect(setRpcSetting(session, "inspect_image.mode", "on")).rejects.toThrow("not available over RPC");
		await expect(setRpcSetting(session, "personality", "reckless")).rejects.toThrow("not a supported value");
		await expect(setRpcSetting(session, "auth.apiKey", "secret")).rejects.toThrow("not available over RPC");
	});
});

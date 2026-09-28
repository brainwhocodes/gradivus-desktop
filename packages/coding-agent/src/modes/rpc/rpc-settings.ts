import { getAllSettingDefs, type SettingDef } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { lookup, type AnySetting } from "../../config/registry";
import { createSettingsHost } from "../../config/settings-ui";
import type { Settings } from "../../config/settings";
import type { SamplingParameters } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { RpcSettingOption, RpcSettingValue, RpcSettingView } from "./rpc-types";

export type RpcSettingsSession = {
	settings: Settings;
	refreshBaseSystemPrompt(): Promise<void>;
	setThinkingLevel?(level: ConfiguredThinkingLevel | undefined, persist?: boolean): void;
	setAdvisorEnabled?(enabled: boolean): boolean;
	setOmitThinking?(enabled: boolean): void;
	setThinkToolEnabled?(enabled: boolean): Promise<boolean>;
	setSamplingParameters?(parameters: SamplingParameters): void;
	setSteeringMode?(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode?(mode: "all" | "one-at-a-time"): void;
	setInterruptMode?(mode: "immediate" | "wait"): void;
	setAutoCompactionEnabled?(enabled: boolean): void;
	setComputerToolEnabled?(enabled: boolean): Promise<boolean>;
};

export type RpcSettingEffect = (session: RpcSettingsSession, value: RpcSettingValue) => Promise<void>;

const refreshPromptEffect: RpcSettingEffect = async session => {
	await session.refreshBaseSystemPrompt();
};

const defaultThinkingEffect: RpcSettingEffect = async (session, value) => {
	const setThinkingLevel = session.setThinkingLevel;
	if (!setThinkingLevel) throw new Error("The thinking-level effect is unavailable");
	setThinkingLevel.call(session, value as ConfiguredThinkingLevel, true);
};

const advisorEffect: RpcSettingEffect = async (session, value) => {
	const setAdvisorEnabled = session.setAdvisorEnabled;
	if (!setAdvisorEnabled) throw new Error("The advisor effect is unavailable");
	setAdvisorEnabled.call(session, value as boolean);
};

const omitThinkingEffect: RpcSettingEffect = async (session, value) => {
	const setOmitThinking = session.setOmitThinking;
	if (!setOmitThinking) throw new Error("The omit-thinking effect is unavailable");
	setOmitThinking.call(session, value as boolean);
};

const thinkToolEffect: RpcSettingEffect = async (session, value) => {
	const setThinkToolEnabled = session.setThinkToolEnabled;
	if (!setThinkToolEnabled) throw new Error("The external-thinking effect is unavailable");
	if (!(await setThinkToolEnabled.call(session, value as boolean))) {
		throw new Error("The external-thinking setting could not be applied to this session");
	}
};

const computerToolEffect: RpcSettingEffect = async (session, value) => {
	const setComputerToolEnabled = session.setComputerToolEnabled;
	if (!setComputerToolEnabled) throw new Error("The computer-tool effect is unavailable");
	if (!(await setComputerToolEnabled.call(session, value as boolean))) {
		throw new Error("The computer setting could not be applied to this session");
	}
};

const samplingEffect =
	(parameter: keyof SamplingParameters): RpcSettingEffect =>
	async (session, value) => {
		const setSamplingParameters = session.setSamplingParameters;
		if (!setSamplingParameters) throw new Error("The sampling effect is unavailable");
		setSamplingParameters.call(session, { [parameter]: value as number });
	};

const steeringEffect: RpcSettingEffect = async (session, value) => {
	const setSteeringMode = session.setSteeringMode;
	if (!setSteeringMode) throw new Error("The steering-mode effect is unavailable");
	setSteeringMode.call(session, value as "all" | "one-at-a-time");
};

const followUpEffect: RpcSettingEffect = async (session, value) => {
	const setFollowUpMode = session.setFollowUpMode;
	if (!setFollowUpMode) throw new Error("The follow-up-mode effect is unavailable");
	setFollowUpMode.call(session, value as "all" | "one-at-a-time");
};

const interruptEffect: RpcSettingEffect = async (session, value) => {
	const setInterruptMode = session.setInterruptMode;
	if (!setInterruptMode) throw new Error("The interrupt-mode effect is unavailable");
	setInterruptMode.call(session, value as "immediate" | "wait");
};

const autoCompactionEffect: RpcSettingEffect = async (session, value) => {
	const setAutoCompactionEnabled = session.setAutoCompactionEnabled;
	if (!setAutoCompactionEnabled) throw new Error("The auto-compaction effect is unavailable");
	setAutoCompactionEnabled.call(session, value as boolean);
};

const settingsHost = createSettingsHost();
const rpcSettingDefs = getAllSettingDefs(settingsHost.entries);

const rpcSettingEffects: ReadonlyMap<string, RpcSettingEffect> = new Map([
	["includeModelInPrompt", refreshPromptEffect],
	["personality", refreshPromptEffect],
	["temperature", samplingEffect("temperature")],
	["compaction.enabled", autoCompactionEffect],
	["tools.xdevDocs", refreshPromptEffect],
	["defaultThinkingLevel", defaultThinkingEffect],
	["advisor.enabled", advisorEffect],
	["omitThinking", omitThinkingEffect],
	["externalThinking", thinkToolEffect],
	["topP", samplingEffect("topP")],
	["topK", samplingEffect("topK")],
	["minP", samplingEffect("minP")],
	["presencePenalty", samplingEffect("presencePenalty")],
	["repetitionPenalty", samplingEffect("repetitionPenalty")],
	["computer.enabled", computerToolEffect],
	["steeringMode", steeringEffect],
	["followUpMode", followUpEffect],
	["interruptMode", interruptEffect],
]);

const MAX_RPC_SETTING_DEPTH = 16;
const MAX_RPC_SETTING_ENTRIES = 1_000;
const MAX_RPC_SETTING_TEXT_LENGTH = 2_048;

export function getRpcSettings(settings: Settings): RpcSettingView[] {
	const views: RpcSettingView[] = [];
	for (const definition of rpcSettingDefs) {
		if (definition.condition && !definition.condition()) continue;
		const setting = getRpcSettingHandle(definition);
		if (!setting) continue;
		const view = toRpcSetting(settings, definition, setting);
		if (view) views.push(view);
	}
	return views;
}

export async function setRpcSetting(
	session: RpcSettingsSession,
	pathInput: string,
	value: unknown,
): Promise<RpcSettingView> {
	const definition = rpcSettingDefs.find(candidate => candidate.path === pathInput);
	const setting =
		definition && (!definition.condition || definition.condition()) ? getRpcSettingHandle(definition) : undefined;
	if (!definition || !setting) throw new Error(`Setting is not available over RPC: ${pathInput}`);

	const nextValue = validateSettingValue(definition, value);
	const previousValue = setting.layered(session.settings);
	const previousView = toRpcSetting(session.settings, definition, setting);
	if (!previousView) throw new Error(`Setting value is not RPC-compatible: ${pathInput}`);
	const effect = rpcSettingEffects.get(pathInput);

	setting.set(session.settings, nextValue);
	try {
		if (effect) await effect(session, nextValue);
		await session.settings.flush();
	} catch (error) {
		if (previousValue === undefined) setting.unset(session.settings);
		else setting.set(session.settings, previousValue);
		try {
			await session.settings.flush();
		} catch {
			// Preserve the original application or persistence error.
		}
		if (effect) {
			try {
				await effect(session, previousView.value);
			} catch {
				// Preserve the original application error; rollback is best effort.
			}
		}
		throw error;
	}

	const view = toRpcSetting(session.settings, definition, setting);
	if (!view) throw new Error(`Setting value is not RPC-compatible: ${pathInput}`);
	return view;
}

function getRpcSettingHandle(definition: SettingDef): AnySetting | undefined {
	const setting = lookup(definition.path);
	return setting && !setting.isCredential ? setting : undefined;
}

function toRpcSetting(settings: Settings, definition: SettingDef, setting: AnySetting): RpcSettingView | undefined {
	const common = {
		path: definition.path,
		tab: definition.tab,
		group: definition.group,
		label: definition.label,
		description: definition.description,
		warning: definition.warning,
	};
	const value = setting.layered(settings);

	if (definition.type === "boolean") {
		if (typeof value !== "boolean") return undefined;
		return { ...common, control: "toggle", value };
	}

	if (definition.type === "enum") {
		if (definition.values.length === 0 || typeof value !== "string" || !definition.values.includes(value))
			return undefined;
		return {
			...common,
			control: "select",
			value,
			options: definition.values.map(option => ({ value: option, label: formatOptionLabel(option) })),
		};
	}

	if (definition.type === "submenu") {
		if (definition.options.length === 0 && definition.schemaType === "string") {
			if (value !== undefined && typeof value !== "string") return undefined;
			return { ...common, control: "text", value: value ?? "" };
		}
		const options = toRpcSettingOptions(
			definition.options,
			definition.schemaType,
			definition.path,
			definition.defaultValue,
		);
		if (
			options.length === 0 ||
			(typeof value !== "string" && typeof value !== "number") ||
			!options.some(option => Object.is(option.value, value))
		) {
			return undefined;
		}
		return { ...common, control: "select", value, options };
	}

	if (definition.type === "multiselect") {
		const options = toRpcSettingOptions(
			definition.options,
			definition.schemaType,
			definition.path,
			definition.defaultValue,
		);
		if (
			options.length === 0 ||
			!Array.isArray(value) ||
			!value.every(
				(entry): entry is string =>
					typeof entry === "string" &&
					entry.length <= MAX_RPC_SETTING_TEXT_LENGTH &&
					options.some(option => option.value === entry),
			)
		) {
			return undefined;
		}
		return { ...common, control: "multiselect", value, options, ordered: definition.ordered };
	}

	if (definition.type === "providerLimits") {
		if (!isPlainRecord(value)) return undefined;
		const limits = settingsHost.validateProviderLimits(value);
		if (!isRpcSettingJsonValue(limits)) return undefined;
		return { ...common, control: "provider-limits", value: limits };
	}

	if (definition.schemaType === "record") {
		if (!isPlainRecord(value) || !isRpcSettingJsonValue(value)) return undefined;
		return { ...common, control: "json", value };
	}
	if (definition.schemaType === "string") {
		if (value !== undefined && (typeof value !== "string" || value.length > MAX_RPC_SETTING_TEXT_LENGTH)) {
			return undefined;
		}
		return { ...common, control: "text", value: value ?? "" };
	}
	return undefined;
}

function toRpcSettingOptions(
	options: ReadonlyArray<{ value: string; label: string; description?: string }>,
	schemaType: string,
	path: string,
	defaultValue: unknown,
): RpcSettingOption[] {
	return options.map(option => ({
		value: schemaType === "number" ? parseNumberOption(path, option.value, defaultValue) : option.value,
		label: option.label,
		description: option.description,
	}));
}

function parseNumberOption(path: string, value: string, defaultValue: unknown): number {
	if (value === "default" && typeof defaultValue === "number" && Number.isFinite(defaultValue)) {
		return defaultValue;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric option for ${path}: ${value}`);
	return parsed;
}

function validateSettingValue(definition: SettingDef, value: unknown): RpcSettingValue {
	if (definition.type === "boolean") {
		if (typeof value !== "boolean") throw new TypeError(`${definition.path} must be boolean`);
		return value;
	}

	if (definition.type === "enum") {
		if (typeof value !== "string" || !definition.values.includes(value)) {
			throw new RangeError(`${String(value)} is not a supported value for ${definition.path}`);
		}
		return value;
	}

	if (definition.type === "submenu") {
		if (definition.options.length === 0 && definition.schemaType === "string") {
			if (typeof value !== "string" || value.length > MAX_RPC_SETTING_TEXT_LENGTH) {
				throw new TypeError(
					`${definition.path} must be a string of at most ${MAX_RPC_SETTING_TEXT_LENGTH} characters`,
				);
			}
			return value;
		}
		const options = toRpcSettingOptions(
			definition.options,
			definition.schemaType,
			definition.path,
			definition.defaultValue,
		);
		const matches = options.some(option => Object.is(option.value, value));
		if (!matches) throw new RangeError(`${String(value)} is not a supported value for ${definition.path}`);
		if (definition.schemaType === "number" && typeof value === "number") return value;
		if (definition.schemaType !== "number" && typeof value === "string") return value;
		throw new TypeError(`${definition.path} must match one of its scalar options`);
	}

	if (definition.type === "multiselect") {
		const options = toRpcSettingOptions(
			definition.options,
			definition.schemaType,
			definition.path,
			definition.defaultValue,
		);
		if (
			!Array.isArray(value) ||
			!value.every(
				(entry): entry is string =>
					typeof entry === "string" &&
					entry.length <= MAX_RPC_SETTING_TEXT_LENGTH &&
					options.some(option => option.value === entry),
			)
		) {
			throw new TypeError(`${definition.path} must contain only supported string options`);
		}
		return value;
	}

	if (definition.type === "providerLimits") {
		if (!isPlainRecord(value) || !isRpcSettingJsonValue(value)) {
			throw new TypeError(`${definition.path} must be a JSON object`);
		}
		const limits = settingsHost.validateProviderLimits(value);
		if (!isRpcSettingJsonValue(limits)) throw new TypeError(`${definition.path} is not RPC-compatible`);
		return limits;
	}

	if (definition.schemaType === "record") {
		if (!isPlainRecord(value) || !isRpcSettingJsonValue(value)) {
			throw new TypeError(`${definition.path} must be a JSON object`);
		}
		return value;
	}
	if (definition.schemaType === "string") {
		if (typeof value !== "string" || value.length > MAX_RPC_SETTING_TEXT_LENGTH) {
			throw new TypeError(
				`${definition.path} must be a string of at most ${MAX_RPC_SETTING_TEXT_LENGTH} characters`,
			);
		}
		return value;
	}
	throw new TypeError(`${definition.path} does not have an RPC-editable value`);
}

function isRpcSettingJsonValue(value: unknown): value is RpcSettingValue {
	let entries = 0;
	const visit = (candidate: unknown, depth: number): boolean => {
		if (depth > MAX_RPC_SETTING_DEPTH) return false;
		if (candidate === null || typeof candidate === "boolean") return true;
		if (typeof candidate === "string") return candidate.length <= MAX_RPC_SETTING_TEXT_LENGTH;
		if (typeof candidate === "number") return Number.isFinite(candidate);
		if (Array.isArray(candidate)) {
			for (const entry of candidate) {
				if (++entries > MAX_RPC_SETTING_ENTRIES || !visit(entry, depth + 1)) return false;
			}
			return true;
		}
		if (!isPlainRecord(candidate)) return false;
		for (const key of Object.keys(candidate)) {
			if (
				key.length > MAX_RPC_SETTING_TEXT_LENGTH ||
				++entries > MAX_RPC_SETTING_ENTRIES ||
				!visit(candidate[key], depth + 1)
			) {
				return false;
			}
		}
		return true;
	};
	return visit(value, 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function formatOptionLabel(value: string): string {
	return value
		.split("-")
		.map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

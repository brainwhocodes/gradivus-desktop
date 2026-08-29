import type { Settings } from "../../config/settings";
import {
	getEnumValues,
	getType,
	getUi,
	isCredential,
	type SettingPath,
	type SettingTab,
} from "../../config/settings-schema";
import type { SamplingParameters } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { RpcSettingOption, RpcSettingTab, RpcSettingValue, RpcSettingView } from "./rpc-types";

export type RpcSettingsSession = {
	settings: Settings;
	refreshBaseSystemPrompt(): Promise<void>;
	applyInspectImageModeChange(): Promise<boolean>;
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

type RpcSettingDescriptor = {
	readonly path: SettingPath;
	readonly apply: "immediate" | "next-session";
	readonly effect?: RpcSettingEffect;
};

const refreshPromptEffect: RpcSettingEffect = async session => {
	await session.refreshBaseSystemPrompt();
};

const inspectImageEffect: RpcSettingEffect = async session => {
	if (!(await session.applyInspectImageModeChange())) {
		throw new Error("The inspect_image tool could not be applied to this session");
	}
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

/**
 * Explicitly curated, credential-safe scalar settings. Schema entries are not
 * exported implicitly: a setting must be listed here before it is available to
 * RPC clients.
 */
export const RPC_SETTING_DESCRIPTORS: readonly RpcSettingDescriptor[] = [
	{ path: "images.autoResize", apply: "immediate" },
	{ path: "images.blockImages", apply: "immediate" },
	{ path: "images.describeForTextModels", apply: "immediate" },
	{ path: "includeModelInPrompt", apply: "immediate", effect: refreshPromptEffect },
	{ path: "personality", apply: "immediate", effect: refreshPromptEffect },
	{ path: "temperature", apply: "immediate", effect: samplingEffect("temperature") },
	{ path: "retry.maxRetries", apply: "immediate" },
	{ path: "retry.modelFallback", apply: "immediate" },
	{ path: "retry.usageAwareFallback", apply: "immediate" },
	{ path: "retry.fallbackRevertPolicy", apply: "immediate" },
	{ path: "compaction.midTurnEnabled", apply: "immediate" },
	{ path: "compaction.methodOrder", apply: "immediate" },
	{ path: "compaction.supersedeReads", apply: "immediate" },
	{ path: "compaction.dropUseless", apply: "immediate" },
	{ path: "compaction.enabled", apply: "immediate", effect: autoCompactionEffect },
	{ path: "tools.approvalMode", apply: "immediate" },
	{ path: "todo.enabled", apply: "next-session" },
	{ path: "launch.enabled", apply: "next-session" },
	{ path: "generate_image.enabled", apply: "next-session" },
	{ path: "inspect_image.mode", apply: "immediate", effect: inspectImageEffect },
	{ path: "tools.intentTracing", apply: "next-session" },
	{ path: "tools.abortOnFabricatedResult", apply: "next-session" },
	{ path: "async.enabled", apply: "next-session" },
	{ path: "tools.xdev", apply: "next-session" },
	{ path: "tools.xdevDocs", apply: "immediate", effect: refreshPromptEffect },
	{ path: "plan.enabled", apply: "next-session" },
	{ path: "goal.enabled", apply: "next-session" },
	{ path: "task.eager", apply: "next-session" },
	{ path: "task.batch", apply: "immediate" },
	{ path: "task.enableEffort", apply: "immediate" },
	{ path: "task.maxConcurrency", apply: "immediate" },
	{ path: "task.enableLsp", apply: "immediate" },
	{ path: "modelRoleStorage", apply: "immediate" },
	{ path: "defaultThinkingLevel", apply: "immediate", effect: defaultThinkingEffect },
	{ path: "advisor.enabled", apply: "immediate", effect: advisorEffect },
	{ path: "omitThinking", apply: "immediate", effect: omitThinkingEffect },
	{ path: "externalThinking", apply: "immediate", effect: thinkToolEffect },
	{ path: "model.loopGuard.enabled", apply: "immediate" },
	{ path: "model.loopGuard.checkAssistantContent", apply: "immediate" },
	{ path: "model.loopGuard.toolCallReminder", apply: "immediate" },
	{ path: "model.toolCallLoopGuard.enabled", apply: "immediate" },
	{ path: "inlineToolDescriptors", apply: "next-session" },
	{ path: "includeWorkspaceTree", apply: "next-session" },
	{ path: "topP", apply: "immediate", effect: samplingEffect("topP") },
	{ path: "topK", apply: "immediate", effect: samplingEffect("topK") },
	{ path: "minP", apply: "immediate", effect: samplingEffect("minP") },
	{ path: "presencePenalty", apply: "immediate", effect: samplingEffect("presencePenalty") },
	{ path: "repetitionPenalty", apply: "immediate", effect: samplingEffect("repetitionPenalty") },
	{ path: "textVerbosity", apply: "immediate" },
	{ path: "prewalk.enabled", apply: "next-session" },
	{ path: "steeringMode", apply: "immediate", effect: steeringEffect },
	{ path: "followUpMode", apply: "immediate", effect: followUpEffect },
	{ path: "interruptMode", apply: "immediate", effect: interruptEffect },
	{ path: "magicKeywords.enabled", apply: "immediate" },
	{ path: "magicKeywords.ultrathink", apply: "immediate" },
	{ path: "magicKeywords.orchestrate", apply: "immediate" },
	{ path: "magicKeywords.workflow", apply: "immediate" },
	{ path: "features.unexpectedStopDetection", apply: "immediate" },
	{ path: "contextPromotion.enabled", apply: "immediate" },
	{ path: "compaction.handoffSaveToDisk", apply: "immediate" },
	{ path: "snapcompact.systemPrompt", apply: "next-session" },
	{ path: "snapcompact.toolResults", apply: "next-session" },
	{ path: "snapcompact.shape", apply: "next-session" },
	{ path: "tools.format", apply: "next-session" },
	{ path: "edit.mode", apply: "next-session" },
	{ path: "edit.fuzzyMatch", apply: "next-session" },
	{ path: "edit.fuzzyThreshold", apply: "next-session" },
	{ path: "edit.streamingAbort", apply: "next-session" },
	{ path: "edit.blockAutoGenerated", apply: "next-session" },
	{ path: "edit.enforceSeenLines", apply: "next-session" },
	{ path: "readLineNumbers", apply: "next-session" },
	{ path: "read.defaultLimit", apply: "next-session" },
	{ path: "read.renderMarkdown", apply: "next-session" },
	{ path: "read.summarize.enabled", apply: "next-session" },
	{ path: "read.summarize.prose", apply: "next-session" },
	{ path: "read.toolResultPreview", apply: "next-session" },
	{ path: "lsp.enabled", apply: "next-session" },
	{ path: "lsp.lazy", apply: "next-session" },
	{ path: "lsp.shared", apply: "next-session" },
	{ path: "lsp.formatOnWrite", apply: "next-session" },
	{ path: "lsp.diagnosticsOnWrite", apply: "next-session" },
	{ path: "lsp.diagnosticsOnEdit", apply: "next-session" },
	{ path: "lsp.diagnosticsDeduplicate", apply: "next-session" },
	{ path: "bash.enabled", apply: "next-session" },
	{ path: "bash.autoBackground.enabled", apply: "next-session" },
	{ path: "bashInterceptor.enabled", apply: "next-session" },
	{ path: "bash.direnv", apply: "next-session" },
	{ path: "shellMinimizer.enabled", apply: "next-session" },
	{ path: "shellMinimizer.sourceOutlineLevel", apply: "next-session" },
	{ path: "eval.py", apply: "next-session" },
	{ path: "eval.js", apply: "next-session" },
	{ path: "eval.rb", apply: "next-session" },
	{ path: "eval.jl", apply: "next-session" },
	{ path: "python.kernelMode", apply: "next-session" },
	{ path: "tools.artifactSpillThreshold", apply: "immediate" },
	{ path: "tools.artifactTailBytes", apply: "immediate" },
	{ path: "tools.artifactHeadBytes", apply: "immediate" },
	{ path: "tools.outputMaxColumns", apply: "immediate" },
	{ path: "tools.artifactTailLines", apply: "immediate" },
	{ path: "todo.reminders", apply: "immediate" },
	{ path: "todo.remindersMax", apply: "immediate" },
	{ path: "grep.contextBefore", apply: "immediate" },
	{ path: "grep.contextAfter", apply: "immediate" },
	{ path: "inspect_image.timeoutMs", apply: "immediate" },
	{ path: "computer.enabled", apply: "immediate", effect: computerToolEffect },
	{ path: "fetch.enabled", apply: "immediate" },
	{ path: "security.enabled", apply: "immediate" },
	{ path: "tools.maxTimeout", apply: "immediate" },
	{ path: "async.pollWaitDuration", apply: "immediate" },
	{ path: "irc.timeoutMs", apply: "immediate" },
	{ path: "mcp.renderMarkdownResults", apply: "immediate" },
	{ path: "task.maxRecursionDepth", apply: "immediate" },
	{ path: "task.maxRuntimeMs", apply: "immediate" },
	{ path: "task.softRequestBudget", apply: "immediate" },
	{ path: "task.softRequestBudgetNotice", apply: "immediate" },
	{ path: "task.maxEffort", apply: "immediate" },
] as const;

type RpcSettingPath = (typeof RPC_SETTING_DESCRIPTORS)[number]["path"];
const RPC_SETTING_PATH_SET: Readonly<Record<string, true>> = Object.fromEntries(
	RPC_SETTING_DESCRIPTORS.map(descriptor => [descriptor.path, true]),
) as Readonly<Record<string, true>>;

export function getRpcSettings(settings: Settings): RpcSettingView[] {
	return RPC_SETTING_DESCRIPTORS.map(descriptor => toRpcSetting(settings, descriptor));
}

export async function setRpcSetting(
	session: RpcSettingsSession,
	pathInput: string,
	value: unknown,
): Promise<RpcSettingView> {
	if (!isRpcSettingPath(pathInput)) throw new Error(`Setting is not available over RPC: ${pathInput}`);
	const descriptor = RPC_SETTING_DESCRIPTORS.find(candidate => candidate.path === pathInput);
	if (!descriptor) throw new Error(`Setting is not available over RPC: ${pathInput}`);
	const path = descriptor.path;
	const nextValue = validateSettingValue(path, value);
	const previousValue = session.settings.get(path);
	if (!isRpcSettingValue(previousValue)) throw new Error(`Setting value is not RPC-compatible: ${path}`);

	session.settings.set(path, nextValue as never);
	try {
		if (descriptor.effect) await descriptor.effect(session, nextValue);
	} catch (error) {
		session.settings.set(path, previousValue as never);
		if (descriptor.effect) {
			try {
				await descriptor.effect(session, previousValue);
			} catch {
				// Preserve the original application error; rollback is best effort.
			}
		}
		throw error;
	}

	return toRpcSetting(session.settings, descriptor);
}

function isRpcSettingPath(path: string): path is RpcSettingPath {
	return Object.hasOwn(RPC_SETTING_PATH_SET, path);
}

function toRpcSetting(settings: Settings, descriptor: (typeof RPC_SETTING_DESCRIPTORS)[number]): RpcSettingView {
	const { path } = descriptor;
	if (isCredential(path)) throw new Error(`Credential setting cannot be exposed over RPC: ${path}`);
	const ui = getUi(path);
	if (!ui) throw new Error(`Setting has no UI metadata: ${path}`);
	const value = settings.get(path);
	if (!isRpcSettingValue(value)) throw new Error(`Setting value is not RPC-compatible: ${path}`);
	const type = getType(path);
	const options = type === "boolean" ? undefined : getSettingOptions(path);
	if (type !== "boolean" && (!options || options.length === 0)) {
		throw new Error(`Setting has no finite choices: ${path}`);
	}
	return {
		path,
		tab: normalizeRpcSettingTab(ui.tab),
		group: ui.group,
		label: ui.label,
		description: ui.description,
		control: type === "boolean" ? "toggle" : type === "array" ? "multiselect" : "select",
		value,
		options,
		...(type === "array" ? { ordered: ui.ordered === true } : {}),
		apply: descriptor.apply,
	};
}

function getSettingOptions(path: RpcSettingPath): RpcSettingOption[] | undefined {
	const configured = getUi(path)?.options;
	if (configured === "runtime") return undefined;
	const values = Array.isArray(configured)
		? configured
		: getEnumValues(path)?.map(value => ({ value, label: formatOptionLabel(value) }));
	if (!values) return undefined;
	const numberSetting = getType(path) === "number";
	return values.map(option => ({
		value: numberSetting ? parseNumberOption(path, option.value) : option.value,
		label: option.label,
		description: option.description,
	}));
}

function parseNumberOption(path: RpcSettingPath, value: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric option for ${path}: ${value}`);
	return parsed;
}

function validateSettingValue(path: RpcSettingPath, value: unknown): RpcSettingValue {
	const type = getType(path);
	if (type === "boolean") {
		if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean`);
		return value;
	}
	if (type === "array") {
		if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
			throw new TypeError(`${path} must be an array of strings`);
		}
		const options = getSettingOptions(path);
		if (!options?.length || value.some(entry => !options.some(option => option.value === entry))) {
			throw new RangeError(`${JSON.stringify(value)} is not a supported value for ${path}`);
		}
		return [...value];
	}
	if (!isRpcSettingValue(value) || Array.isArray(value)) throw new TypeError(`${path} must be a scalar value`);
	const options = getSettingOptions(path);
	if (!options?.some(option => Object.is(option.value, value))) {
		throw new RangeError(`${String(value)} is not a supported value for ${path}`);
	}
	return value;
}

function isRpcSettingValue(value: unknown): value is RpcSettingValue {
	return (
		typeof value === "boolean" ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value)) ||
		(Array.isArray(value) && value.every(entry => typeof entry === "string"))
	);
}

function normalizeRpcSettingTab(tab: SettingTab): RpcSettingTab {
	if (
		tab === "appearance" ||
		tab === "model" ||
		tab === "interaction" ||
		tab === "context" ||
		tab === "files" ||
		tab === "shell" ||
		tab === "tools" ||
		tab === "tasks"
	)
		return tab;
	throw new Error(`Setting tab is not available over RPC: ${tab}`);
}

function formatOptionLabel(value: string): string {
	return value
		.split("-")
		.map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

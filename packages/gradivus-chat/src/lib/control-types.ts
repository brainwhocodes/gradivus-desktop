import type { HostedAgentSettingOption, HostedAgentSettingValue } from "./contracts";

export type ApplicationSettingsCategoryId = "app-appearance" | "app-behavior" | "terminal" | "browser" | "workspace";

export type SettingsCategoryId =
	| "runtime"
	| "omp-appearance"
	| "omp-model"
	| "omp-interaction"
	| "omp-context"
	| "omp-memory"
	| "omp-files"
	| "omp-shell"
	| "omp-tools"
	| "omp-agents"
	| "omp-tasks"
	| "omp-providers"
	| "accounts"
	| ApplicationSettingsCategoryId;

export interface SettingsRoute {
	open: boolean;
	activeCategory: SettingsCategoryId;
	query: string;
}

export interface DropdownOption {
	key: string;
	value: HostedAgentSettingValue;
	label: string;
	description?: string;
	icon?: string;
	disabled?: boolean;
}

export function agentSettingValueKey(value: HostedAgentSettingValue): string {
	if (typeof value === "boolean") return `boolean:${value}`;
	if (typeof value === "string") return `string:${value}`;
	if (Array.isArray(value)) return `strings:${JSON.stringify(value)}`;
	if (typeof value === "object") return `json:${JSON.stringify(value)}`;
	if (Object.is(value, -0)) return "number:-0";
	return `number:${String(value)}`;
}

export function agentSettingOptionToDropdownOption(option: HostedAgentSettingOption): DropdownOption {
	return {
		key: agentSettingValueKey(option.value),
		value: option.value,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	};
}

import type {
	AgentSettingOption,
	AgentSettingValue,
	GradivusSettings,
	UpdateGradivusSettingsInput,
} from "../shared/contracts";

export type { AgentSettingValue };

export type ApplicationSettingsCategoryId = "app-appearance" | "app-behavior" | "terminal" | "browser" | "workspace";

export type SettingsCategoryId =
	| "runtime"
	| "omp-appearance"
	| "omp-model"
	| "omp-interaction"
	| "omp-context"
	| "omp-files"
	| "omp-shell"
	| "omp-tools"
	| "omp-agents"
	| "omp-tasks"
	| "accounts"
	| ApplicationSettingsCategoryId;

export interface SettingsRoute {
	open: boolean;
	activeCategory: SettingsCategoryId;
	query: string;
}

export interface ApplicationSettingsStatus {
	key: string;
	tone: "saving" | "success" | "error";
	message: string;
}

export interface ApplicationSettingsPanelProps {
	settings: GradivusSettings;
	activeCategory: ApplicationSettingsCategoryId;
	visibleSettingIds: ReadonlySet<string>;
	busyKeys: ReadonlySet<string>;
	status: ApplicationSettingsStatus | undefined;
	onUpdate: (key: string, updates: UpdateGradivusSettingsInput, label: string) => Promise<void>;
	onReset: () => Promise<void>;
}

export interface DropdownOption {
	key: string;
	value: AgentSettingValue;
	label: string;
	description?: string;
	icon?: string;
	disabled?: boolean;
}

export function agentSettingValueKey(value: AgentSettingValue): string {
	if (typeof value === "boolean") return `boolean:${value}`;
	if (typeof value === "string") return `string:${value}`;
	if (Object.is(value, -0)) return "number:-0";
	return `number:${String(value)}`;
}

export function agentSettingOptionToDropdownOption(option: AgentSettingOption): DropdownOption {
	return {
		key: agentSettingValueKey(option.value),
		value: option.value,
		label: option.label,
		...(option.description === undefined ? {} : { description: option.description }),
	};
}

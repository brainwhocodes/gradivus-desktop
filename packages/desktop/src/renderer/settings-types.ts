import type { ApplicationSettingsCategoryId } from "@gradivus/chat/control-types";
import type { GradivusSettings, UpdateGradivusSettingsInput } from "../shared/contracts";

export * from "@gradivus/chat/control-types";

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

<script lang="ts">
	import type { GradivusSettings, UpdateGradivusSettingsInput } from "../../../shared/contracts";
	import LabeledSelect from "../molecules/LabeledSelect.svelte";
	import ToggleField from "../molecules/ToggleField.svelte";
	import type {
		ApplicationSettingsCategoryId,
		ApplicationSettingsStatus,
		DropdownOption,
	} from "../../settings-types";

	const THEME_OPTIONS: readonly DropdownOption[] = [
		{ key: "dark", value: "dark", label: "Dark" },
		{ key: "light", value: "light", label: "Light" },
		{ key: "system", value: "system", label: "System" },
	];
	const DENSITY_OPTIONS: readonly DropdownOption[] = [
		{ key: "comfortable", value: "comfortable", label: "Comfortable" },
		{ key: "compact", value: "compact", label: "Compact" },
	];
	const CURSOR_STYLE_OPTIONS: readonly DropdownOption[] = [
		{ key: "bar", value: "bar", label: "Bar" },
		{ key: "block", value: "block", label: "Block" },
		{ key: "underline", value: "underline", label: "Underline" },
	];

	export let settings: GradivusSettings;
	export let activeCategory: ApplicationSettingsCategoryId;
	export let visibleSettingIds: ReadonlySet<string>;
	export let busyKeys: ReadonlySet<string>;
	export let status: ApplicationSettingsStatus | undefined;
	export let onUpdate: (
		key: string,
		updates: UpdateGradivusSettingsInput,
		label: string,
	) => Promise<void>;
	export let onReset: () => Promise<void>;

	function visible(id: string): boolean {
		return visibleSettingIds.size === 0 || visibleSettingIds.has(id);
	}

	function busy(key: string): boolean {
		return busyKeys.has(key);
	}

	function update(key: string, updates: UpdateGradivusSettingsInput, label: string): void {
		void onUpdate(key, updates, label);
	}
	function updateTheme(option: DropdownOption): void {
		if (typeof option.value === "string") {
			update("theme", { theme: option.value as GradivusSettings["theme"] }, "Theme");
		}
	}

	function updateDensity(option: DropdownOption): void {
		if (typeof option.value === "string") {
			update("density", { ui: { density: option.value as GradivusSettings["ui"]["density"] } }, "Interface density");
		}
	}

	function updateCursorStyle(option: DropdownOption): void {
		if (typeof option.value === "string") {
			update("terminal.cursorStyle", { terminal: { cursorStyle: option.value as GradivusSettings["terminal"]["cursorStyle"] } }, "Cursor style");
		}
	}
</script>

<section class="settings-section application-settings-panel" aria-labelledby="application-settings-title">
	<header class="settings-section-heading">
		<div>
			<h2 id="application-settings-title">Application settings</h2>
			<p>Preferences stored locally on this machine.</p>
		</div>
		<button
			type="button"
			class="secondary-button"
			disabled={busyKeys.size > 0}
			aria-busy={busyKeys.has("reset")}
			onclick={() => void onReset()}
		>
			{busy("reset") ? "Resetting…" : "Reset application defaults"}
		</button>
	</header>

	{#if status}
		<p class:settings-feedback-error={status.tone === "error"} class="settings-feedback" role={status.tone === "error" ? "alert" : "status"}>
			{status.message}
		</p>
	{/if}

	{#if activeCategory === "app-appearance"}
		<div class="agent-settings-group">
			<h3>Appearance</h3>
			<div class="settings-form-grid">
				{#if visible("theme")}
					<LabeledSelect
						tone="field"
						label="Theme"
						description="Color palette for the desktop window and controls."
						options={THEME_OPTIONS}
						selectedKey={settings.theme}
						ariaLabel="Theme"
						disabled={busy("theme")}
						onSelect={updateTheme}
						onOpenChange={() => undefined}
					/>
				{/if}
				{#if visible("density")}
					<LabeledSelect
						tone="field"
						label="Interface density"
						description="Choose the amount of spacing around controls and content."
						options={DENSITY_OPTIONS}
						selectedKey={settings.ui.density}
						ariaLabel="Interface density"
						disabled={busy("density")}
						onSelect={updateDensity}
						onOpenChange={() => undefined}
					/>
				{/if}
				{#if visible("reduceMotion")}
					<ToggleField
						label="Reduce motion"
						description="Limit interface animation in addition to the operating system preference."
						checked={settings.ui.reduceMotion}
						disabled={busy("reduceMotion")}
						onchange={(checked) => update("reduceMotion", { ui: { reduceMotion: checked } }, "Reduce motion")}
					/>
				{/if}
			</div>
		</div>
	{:else if activeCategory === "app-behavior"}
		<div class="agent-settings-group">
			<h3>Behavior</h3>
			<div class="settings-form-grid">
				{#if visible("confirmCloseTab")}
					<ToggleField
						label="Confirm before closing tabs"
						description="Prompt before closing a tab containing active panes."
						checked={settings.confirmCloseTab}
						disabled={busy("confirmCloseTab")}
						onchange={(checked) => update("confirmCloseTab", { confirmCloseTab: checked }, "Tab close confirmation")}
					/>
				{/if}
				{#if visible("showToolDetails")}
					<ToggleField
						label="Show tool details"
						description="Show tool previews and argument badges in the transcript."
						checked={settings.ui.showToolDetails}
						disabled={busy("showToolDetails")}
						onchange={(checked) => update("showToolDetails", { ui: { showToolDetails: checked } }, "Tool details")}
					/>
				{/if}
			</div>
		</div>
	{:else if activeCategory === "terminal"}
		<div class="agent-settings-group">
			<h3>Terminal</h3>
			<div class="settings-form-grid">
				{#if visible("terminal.shell")}
					<label class="settings-field"><span>Shell</span><small>Shell used for newly opened terminals.</small><input type="text" value={settings.terminal.shell} disabled={busy("terminal.shell")} onchange={(event) => update("terminal.shell", { terminal: { shell: event.currentTarget.value } }, "Shell")} /></label>
				{/if}
				{#if visible("terminal.fontFamily")}
					<label class="settings-field"><span>Font family</span><small>Font stack applied when the shell is next opened or restarted.</small><input type="text" value={settings.terminal.fontFamily} disabled={busy("terminal.fontFamily")} onchange={(event) => update("terminal.fontFamily", { terminal: { fontFamily: event.currentTarget.value } }, "Terminal font family")} /></label>
				{/if}
				{#if visible("terminal.fontSize")}
					<label class="settings-field"><span>Font size</span><small>Terminal font size from 8 to 48; applies when the shell is next opened or restarted.</small><input type="number" min="8" max="48" value={settings.terminal.fontSize} disabled={busy("terminal.fontSize")} onchange={(event) => update("terminal.fontSize", { terminal: { fontSize: Number(event.currentTarget.value) } }, "Terminal font size")} /></label>
				{/if}
				{#if visible("terminal.cursorStyle")}
					<LabeledSelect
						tone="field"
						label="Cursor style"
						description="Shape used by the terminal cursor."
						options={CURSOR_STYLE_OPTIONS}
						selectedKey={settings.terminal.cursorStyle}
						ariaLabel="Cursor style"
						disabled={busy("terminal.cursorStyle")}
						onSelect={updateCursorStyle}
						onOpenChange={() => undefined}
					/>
				{/if}
				{#if visible("terminal.cursorBlink")}
					<ToggleField
						label="Cursor blink"
						description="Animate the terminal cursor while focused."
						checked={settings.terminal.cursorBlink}
						disabled={busy("terminal.cursorBlink")}
						onchange={(checked) => update("terminal.cursorBlink", { terminal: { cursorBlink: checked } }, "Cursor blink")}
					/>
				{/if}
				{#if visible("terminal.scrollback")}
					<label class="settings-field"><span>Scrollback</span><small>Stored terminal lines from 500 to 100,000; applies when the shell is next opened or restarted.</small><input type="number" min="500" max="100000" value={settings.terminal.scrollback} disabled={busy("terminal.scrollback")} onchange={(event) => update("terminal.scrollback", { terminal: { scrollback: Number(event.currentTarget.value) } }, "Terminal scrollback")} /></label>
				{/if}
			</div>
		</div>
	{:else if activeCategory === "browser"}
		<div class="agent-settings-group">
			<h3>Browser</h3>
			<div class="settings-form-grid">
				{#if visible("browser.defaultUrl")}
					<label class="settings-field"><span>Default homepage URL</span><small>Address loaded when creating new browser tabs.</small><input type="url" value={settings.browser.defaultUrl} disabled={busy("browser.defaultUrl")} onchange={(event) => update("browser.defaultUrl", { browser: { defaultUrl: event.currentTarget.value } }, "Default homepage URL")} /></label>
				{/if}
				{#if visible("browser.searchEngine")}
					<label class="settings-field"><span>Search engine URL template</span><small>Use %s where the search query should be inserted.</small><input type="url" value={settings.browser.searchEngine} disabled={busy("browser.searchEngine")} onchange={(event) => update("browser.searchEngine", { browser: { searchEngine: event.currentTarget.value } }, "Search engine")} /></label>
				{/if}
			</div>
		</div>
	{:else if activeCategory === "workspace"}
		<div class="agent-settings-group">
			<h3>Workspace</h3>
			<div class="settings-form-grid">
				{#if visible("workspace.defaultPath")}
					<label class="settings-field"><span>Default root directory</span><small>Root folder used for new workspaces.</small><input type="text" value={settings.workspace.defaultPath} disabled={busy("workspace.defaultPath")} onchange={(event) => update("workspace.defaultPath", { workspace: { defaultPath: event.currentTarget.value } }, "Workspace path")} /></label>
				{/if}
			</div>
		</div>
	{/if}
</section>


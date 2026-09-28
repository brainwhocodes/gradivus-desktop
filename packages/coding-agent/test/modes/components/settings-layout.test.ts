import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { all } from "@oh-my-pi/pi-coding-agent/config/registry";

import { getSettingsForTab, SETTING_TABS, TAB_GROUPS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { OAuthAccountManagerComponent } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-account-manager";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { initTheme, setTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { cfgRetryUsageAwareFallback } from "@oh-my-pi/pi-coding-agent/session/settings";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";

beforeAll(async () => {
	await initTheme();
});

describe("settings layout", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("every UI setting declares a group registered in TAB_GROUPS for its tab", () => {
		const violations: string[] = [];
		for (const setting of all()) {
			const ui = setting.ui;
			if (!ui) continue;
			if (!ui.group) {
				violations.push(`${setting.id}: missing ui.group`);
			} else if (!TAB_GROUPS[ui.tab].includes(ui.group)) {
				violations.push(`${setting.id}: group "${ui.group}" not in TAB_GROUPS["${ui.tab}"]`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("getSettingsForTab returns contiguous groups in TAB_GROUPS order", () => {
		for (const tab of SETTING_TABS) {
			const defs = getSettingsForTab(createSettingsHost().entries, tab);
			expect(defs.length).toBeGreaterThan(0);

			// Collapse the def sequence into the order groups first appear.
			const sequence: string[] = [];
			for (const def of defs) {
				const group = def.group ?? "";
				if (sequence[sequence.length - 1] !== group) sequence.push(group);
			}

			// Contiguous: no group appears twice in the collapsed sequence.
			expect(new Set(sequence).size).toBe(sequence.length);

			// Ordered: grouped sections follow the TAB_GROUPS declaration order.
			const grouped = sequence.filter(group => group !== "");
			const expected = TAB_GROUPS[tab].filter(group => grouped.includes(group));
			expect(grouped).toEqual(expected);
		}
	});

	it("hides advisor dependent settings when advisor is disabled", () => {
		const advisorDependentPaths = ["advisor.syncBacklog", "advisor.immuneTurns"];
		const advisorDependentPathSet = new Set<string>(advisorDependentPaths);
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			advisorDependentPathSet.has(def.path),
		);

		expect(defs.map(def => def.path)).toEqual(advisorDependentPaths);
		for (const def of defs) {
			expect(def.condition?.()).toBe(false);
		}

		cfgAdvisorEnabled.set(Settings.instance, true);

		for (const def of defs) {
			expect(def.condition?.()).toBe(true);
		}
	});

	it("puts OAuth account routing first in the provider Accounts group", () => {
		expect(TAB_GROUPS.providers[0]).toBe("Accounts");

		const [locks, failover] = getSettingsForTab(createSettingsHost().entries, "providers");
		expect([locks?.path, failover?.path]).toEqual(["providers.oauthAccountLocks", "providers.oauthAccountFailover"]);
		expect(locks).toMatchObject({
			path: "providers.oauthAccountLocks",
			label: "OAuth Accounts",
			description: "Add, remove, and choose the stored OAuth account used by each provider.",
			type: "oauthAccounts",
			tab: "providers",
			group: "Accounts",
		});
		expect(locks?.type).not.toBe("text");
		expect(failover).toMatchObject({
			path: "providers.oauthAccountFailover",
			label: "Account Failover",
			description:
				"Allow a locked OAuth account to use another stored account when it is unavailable or rate-limited.",
			type: "boolean",
			tab: "providers",
			group: "Accounts",
		});
	});

	it("opens and closes the OAuth account manager from settings search", () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		try {
			const selector = new SettingsSelectorComponent(
				{
					availableThinkingLevels: [],
					thinkingLevel: undefined,
					availableThemes: ["dark", "light"],
					providers: [],
					settings: createSettingsHost(),
					plugins: createPluginSettingsHost(process.cwd()),
				},
				{
					onChange: () => {},
					onCancel: () => {},
					openOAuthAccountManager: onClose =>
						new OAuthAccountManagerComponent(
							{
								settings: Settings.instance,
								authStorage,
								tui: { requestRender: () => {} } as unknown as TUI,
								sessionId: "settings-test",
								getLoginMethods: () => [],
								isStreaming: () => false,
								installPolicy: () => {},
								invalidate: () => {},
								actions: {
									login: async () => ({ status: "cancelled" }),
									remove: async () => ({ status: "missing" }),
								},
							},
							{ onChange: () => {}, onClose },
						),
				},
			);

			for (const character of "OAuth Accounts") selector.handleInput(character);
			selector.handleInput("\n");
			const managerView = selector.render(120).join("\n");
			expect(managerView).toContain("No stored OAuth accounts.");

			selector.handleInput("\x1b");
			expect(selector.render(120).join("\n")).toContain("OAuth Accounts");
		} finally {
			authStorage.close();
		}
	});

	it("exposes unexpected-stop recovery modes in interaction settings", () => {
		const def = getSettingsForTab(createSettingsHost().entries, "interaction").find(
			item => item.path === "features.unexpectedStopDetection",
		);
		expect(def).toMatchObject({
			path: "features.unexpectedStopDetection",
			type: "submenu",
			tab: "interaction",
			group: "Agent",
			label: "Unexpected Stops",
		});
		if (def?.type !== "submenu") throw new Error("Unexpected Stops should expose recovery mode choices");
		expect(def.options.map(option => option.value)).toEqual(["none", "mechanical", "smart"]);
	});

	it("shows provider request limits as a providers services submenu setting", () => {
		const [def] = getSettingsForTab(createSettingsHost().entries, "providers").filter(
			item => item.path === "providers.maxInFlightRequests",
		);

		expect(def).toMatchObject({
			path: "providers.maxInFlightRequests",
			type: "providerLimits",
			tab: "providers",
			group: "Services",
		});
	});

	it("exposes retry fallback chains as editable JSON in the model settings", () => {
		const def = getSettingsForTab(createSettingsHost().entries, "model").find(
			item => item.path === "retry.fallbackChains",
		);

		expect(def).toMatchObject({
			path: "retry.fallbackChains",
			type: "text",
			tab: "model",
			group: "Retry & Fallback",
			label: "Retry Fallback Chains",
		});
		if (!def) throw new Error("retry.fallbackChains setting definition missing");

		const description = def.description.toLowerCase();
		expect(description).toContain("json");
		expect(description).toContain("fallback");
		expect(description).toContain("selector");
	});
	it("exposes usage-aware fallback as an opt-in advanced policy", () => {
		const defs = getSettingsForTab(createSettingsHost().entries, "model").filter(def =>
			def.path.startsWith("retry.usage"),
		);
		expect(defs.map(def => def.path)).toEqual([
			"retry.usageAwareFallback",
			"retry.usageReservePct",
			"retry.usageReservePolicy",
		]);
		expect(defs[0]).toMatchObject({ type: "boolean", label: "Usage-Aware Fallback" });
		expect(defs[1]?.condition?.()).toBe(false);
		expect(defs[2]?.condition?.()).toBe(false);
		cfgRetryUsageAwareFallback.set(Settings.instance, true);
		expect(defs[1]?.condition?.()).toBe(true);
		expect(defs[2]?.condition?.()).toBe(true);
	});

	it("renders preview inside SettingsSelectorComponent submenu without crashing", async () => {
		await setTheme("dark");
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark", "light"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
			},
			{
				onChange: () => {},
				onCancel: () => {},
			},
		);

		for (const ch of "composer shape") selector.handleInput(ch);
		// Open the composer.shape submenu
		selector.handleInput("\n");

		const rendered = selector.render(80).join("\n");
		expect(rendered).toContain("Composer Shape");
		expect(rendered).toContain("Preview:");
		expect(rendered).toContain("Ask anything");

		// Cycle down to claude
		selector.handleInput("\x1b[B");
		const nextRendered = selector.render(80).join("\n");
		expect(nextRendered).toContain("Claude Code");
		expect(nextRendered).toContain("Preview:");
	});
});

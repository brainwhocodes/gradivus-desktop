import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AuthStorage, UsageReport } from "@oh-my-pi/pi-ai";
import { renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { buildOAuthAccountRoutingDisplay } from "../../../src/slash-commands/helpers/oauth-account-routing-display";

type UsageRoutingAuthStorage = Pick<AuthStorage, "getOAuthAccountSelection"> & {
	oauth: Pick<AuthStorage["oauth"], "accounts" | "identity">;
};

function accountReport(
	provider: string,
	email: string,
	usedFraction: number,
	orgId?: string,
	orgName?: string,
): UsageReport {
	const accountKey = orgId ?? email;
	return {
		provider,
		fetchedAt: Date.now(),
		limits: [
			{
				id: `${provider}-${accountKey}`,
				label: "Monthly",
				scope: { provider, accountId: accountKey, windowId: "monthly" },
				window: { id: "monthly", label: "monthly" },
				amount: { usedFraction, unit: "percent" },
				status: "ok",
			},
		],
		metadata: {
			email,
			...(orgId ? { orgId } : {}),
			...(orgName ? { orgName } : {}),
		},
	};
}

function renderUsageForSession(
	reports: UsageReport[],
	authStorage: UsageRoutingAuthStorage,
	currentProvider: string,
	sessionId: string,
	width = 160,
): string {
	return stripVTControlCharacters(
		renderUsageReports(reports, theme, Date.now(), width, provider =>
			provider === currentProvider ? buildOAuthAccountRoutingDisplay(authStorage, provider, sessionId) : undefined,
		),
	);
}

function findUsageGroupRows(output: string, label: string): [string, string, string] {
	const lines = output.split("\n");
	const titleIndex = lines.findIndex(line => line.includes(label));
	if (titleIndex < 0) throw new Error(`Missing usage group: ${label}`);
	return [lines[titleIndex + 1] ?? "", lines[titleIndex + 2] ?? "", lines[titleIndex + 3] ?? ""];
}

describe("renderUsageReports content", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", () => {
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 98));
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", () => {
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders Claude banked reset availability and the next expiry", () => {
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					redeemableCount: 0,
					reason: "weekly cooldown",
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain("0 usable now");
		expect(output).toContain("unavailable: weekly cooldown");
		expect(output).not.toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("shows one prepaid balance for a provider whose keys share an account pool", () => {
		// Production shape: `fetchCharmHyperUsage` emits no accountId and marks
		// the limit shared, because Hyper's balance is account-wide — spending
		// through one key moves every key's reported balance. AuthStorage still
		// probes once per stored key, so two keys yield two identical rows.
		// Summing them would claim 200 credits the account never had.
		const now = Date.now();
		const keyReport = (remaining: number): UsageReport => ({
			provider: "charm-hyper",
			fetchedAt: now,
			limits: [
				{
					id: "charm-hyper:credits",
					label: "Credit balance",
					scope: { provider: "charm-hyper", windowId: "balance", shared: true },
					amount: { remaining, unit: "credits" },
				},
			],
		});

		const output = stripVTControlCharacters(renderUsageReports([keyReport(100), keyReport(100)], theme, now, 98));
		expect(output).toContain("100 credits left");
		expect(output).not.toContain("200 credits left");
		// The balance must reach the user at all: a remaining-only limit used
		// to fall through to a bare account count.
		expect(output).not.toContain("accts");
	});

	it("renders each marked Antigravity shared quota once in expanded details", () => {
		const quota = (
			counter: "google" | "anthropic" | "openai",
			windowId: "5h" | "weekly",
		): UsageReport["limits"][number] => {
			const sharedGroup = counter === "google" ? undefined : `3p-${windowId}`;
			return {
				id: `google-antigravity:${counter}:default:${counter === "google" ? "gemini" : "3p"}-${windowId}`,
				label: counter === "google" ? "Gemini" : "Claude & GPT (shared)",
				scope: {
					provider: "google-antigravity",
					accountId: "account",
					windowId,
					...(sharedGroup !== undefined ? { shared: true, sharedGroup } : {}),
				},
				window: { id: windowId, label: windowId === "5h" ? "5 Hour" : "Weekly" },
				amount: { unit: "percent", usedFraction: 0.25 },
				status: "ok",
			};
		};
		const reports: UsageReport[] = [
			{
				provider: "google-antigravity",
				fetchedAt: Date.now(),
				limits: [
					quota("google", "5h"),
					quota("google", "weekly"),
					quota("anthropic", "5h"),
					quota("openai", "5h"),
					quota("anthropic", "weekly"),
					quota("openai", "weekly"),
				],
				metadata: { email: "user@example.test" },
			},
		];

		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));

		expect(output.match(/Claude & GPT \(shared\)/g)).toHaveLength(2);
		expect(output.match(/Gemini/g)).toHaveLength(2);
	});
	it("shows the current Codex plan in interactive account and reset rows without a single-account UUID", () => {
		const now = Date.now();
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: now,
			limits: [
				{
					id: "codex-weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: "workspace-id" },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: {
				email: "user@example.test",
				accountId: "workspace-id",
				orgId: "workspace-id",
				orgName: "free",
				planType: "prolite",
			},
			resetCredits: { availableCount: 1 },
		};
		const output = stripVTControlCharacters(
			renderUsageReports([report], theme, now, 98, () => ({
				email: "user@example.test",
				accountId: "workspace-id",
				orgId: "workspace-id",
				orgName: "free",
			})),
		);
		expect(output).toContain("in use by this session: user@example.test (prolite)");
		expect(output).toContain("user@example.test (prolite): 1 saved reset");
		expect(output).toMatch(/^  ● user@example\.test \(prolite\)/m);
		expect(output).not.toContain("workspace-id");
		expect(output).not.toContain("(free)");
	});

	it("distinguishes same-email Codex accounts even if one has no current plan or limits", () => {
		const now = Date.now();
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map((orgId, index) => ({
			provider: "openai-codex",
			fetchedAt: now,
			limits: [],
			metadata: {
				email: "shared@example.test",
				orgId,
				orgName: "free",
				...(index === 0 ? { planType: "prolite" } : {}),
			},
		}));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, now, 98));
		expect(output).toContain("shared@example.test (workspace-one) (prolite) -- no limits");
		expect(output).toContain("shared@example.test (workspace-two) -- no limits");
		expect(output).not.toContain("(free)");
	});

	it("keeps colliding Codex accounts distinct in quota columns", () => {
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map(orgId => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: orgId },
					amount: { usedFraction: 0.25, unit: "percent" },
				},
			],
			metadata: { email: "shared@example.test", orgId, orgName: "free", planType: "prolite" },
		}));
		const output = stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120));
		expect(output).toMatch(
			/^  shared@example\.test \(workspace-one\) \(prolite\) +shared@example\.test \(workspace-two\) \(prolite\)$/m,
		);
		expect(output).not.toContain("(free)");
	});
	it("marks the matching legacy Codex workspace active when accounts share an email", () => {
		const reports: UsageReport[] = ["workspace-one", "workspace-two"].map(accountId => ({
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [],
			metadata: { email: "shared@example.test", accountId, orgName: "free" },
			resetCredits: { availableCount: 1 },
		}));
		const output = stripVTControlCharacters(
			renderUsageReports(reports, theme, Date.now(), 120, () => ({
				email: "shared@example.test",
				accountId: "workspace-two",
			})),
		);
		expect(output).toContain("in use by this session: shared@example.test (workspace-two)");
		expect(output).toContain("shared@example.test (workspace-two): 1 saved reset (active)");
		expect(output).toContain("shared@example.test (workspace-one): 1 saved reset\n");
	});

	it("renders strict lock intent below the provider", () => {
		const sessionId = "strict-routing-session";
		const provider = "openai-codex";
		const authStorage = {
			getOAuthAccountSelection: () => ({
				identityHash: "a".repeat(64),
				credentialId: 11,
				available: true,
				allowSiblingFailover: false,
			}),
			oauth: {
				accounts: () => [
					{
						position: 0,
						credentialId: 11,
						email: "locked@example.test",
						orgId: "org-locked",
						orgName: "Configured Org",
						active: true,
					},
					{
						position: 1,
						credentialId: 12,
						email: "sibling@example.test",
						orgId: "org-sibling",
						orgName: "Sibling Org",
						active: false,
					},
				],
				identity: () => ({
					email: "locked@example.test",
					orgId: "org-locked",
					orgName: "Configured Org",
				}),
			},
		} as unknown as UsageRoutingAuthStorage;
		const output = renderUsageForSession(
			[
				accountReport(provider, "locked@example.test", 0.8, "org-locked", "Configured Org"),
				accountReport(provider, "sibling@example.test", 0.2, "org-sibling", "Sibling Org"),
			],
			authStorage,
			provider,
			sessionId,
		);

		const lines = output.split("\n");
		const policyIndex = lines.findIndex(line =>
			line.includes("Locked account: locked@example.test (Configured Org) (strict)"),
		);
		expect(policyIndex).toBeGreaterThan(0);
		expect(lines[policyIndex - 1]?.trim()).toBe("Openai Codex");
		expect(output).toContain("in use by this session: locked@example.test");
		const [labelRow, barRow, valueRow] = findUsageGroupRows(output, "Monthly");
		expect(labelRow).toContain("locked@example.test");
		expect(labelRow).toContain("sibling@example.test");
		expect(barRow).not.toContain("% free");
		expect(valueRow.indexOf("20% free")).toBe(labelRow.search(/\S/));
		expect(valueRow.indexOf("80% free")).toBe(labelRow.indexOf("sibling@example.test"));
		expect(output).not.toContain("50% free");
		expect(output).not.toContain("in use by this session (failover):");
	});

	it("keeps the combined percentage for automatic account routing", () => {
		const provider = "openai-codex";
		const authStorage = {
			getOAuthAccountSelection: () => undefined,
			oauth: {
				accounts: () => [
					{ position: 0, credentialId: 11, email: "first@example.test", active: true },
					{ position: 1, credentialId: 12, email: "second@example.test", active: false },
				],
				identity: () => ({ email: "first@example.test" }),
			},
		} as unknown as UsageRoutingAuthStorage;
		const output = renderUsageForSession(
			[accountReport(provider, "first@example.test", 0.8), accountReport(provider, "second@example.test", 0.2)],
			authStorage,
			provider,
			"automatic-routing-session",
		);

		const [labelRow, barRow, followingRow] = findUsageGroupRows(output, "Monthly");
		expect(labelRow).toContain("first@example.test");
		expect(labelRow).toContain("second@example.test");
		expect(barRow).toContain("50% free");
		expect(followingRow).not.toContain("% free");
		expect(output).not.toContain("Locked account:");
	});

	it("distinguishes configured and org-qualified actual accounts during failover", () => {
		const provider = "anthropic";
		const authStorage = {
			getOAuthAccountSelection: () => ({
				identityHash: "b".repeat(64),
				credentialId: 21,
				available: true,
				allowSiblingFailover: true,
			}),
			oauth: {
				accounts: () => [
					{
						position: 0,
						credentialId: 21,
						email: "locked@example.test",
						orgId: "org-configured",
						orgName: "Configured Org",
						active: false,
					},
					{
						position: 1,
						credentialId: 22,
						email: "actual@example.test",
						orgId: "org-actual",
						orgName: "Actual Org",
						active: true,
					},
				],
				identity: () => ({
					email: "actual@example.test",
					orgId: "org-actual",
					orgName: "Actual Org",
				}),
			},
		} as unknown as UsageRoutingAuthStorage;
		const output = renderUsageForSession(
			[
				accountReport(provider, "locked@example.test", 0.9, "org-configured", "Configured Org"),
				accountReport(provider, "actual@example.test", 0.4, "org-actual", "Actual Org"),
			],
			authStorage,
			provider,
			"failover-routing-session",
		);

		expect(output).toContain("Locked account: locked@example.test (Configured Org) (failover enabled)");
		expect(output).toContain("in use by this session (failover): actual@example.test (Actual Org)");
		const [labelRow, barRow, valueRow] = findUsageGroupRows(output, "Monthly");
		expect(valueRow.indexOf("10% free")).toBe(labelRow.indexOf("locked@example.test"));
		expect(valueRow.indexOf("60% free")).toBe(labelRow.indexOf("● actual@example.test"));
		expect(barRow).not.toContain("% free");
		expect(output).not.toContain("35% free");
		expect(output).toContain("● actual@example.test (Actual Org)");
		expect(output).not.toContain("● locked@example.test (Configured Org)");
	});

	it("renders stale lock intent without inventing a selected account label", () => {
		const provider = "openai-codex";
		const authStorage = {
			getOAuthAccountSelection: () => ({
				identityHash: "c".repeat(64),
				credentialId: 404,
				available: false,
				allowSiblingFailover: false,
			}),
			oauth: {
				accounts: () => [{ position: 0, credentialId: 31, email: "remaining@example.test", active: false }],
				identity: () => undefined,
			},
		} as unknown as UsageRoutingAuthStorage;
		const output = renderUsageForSession(
			[accountReport(provider, "remaining@example.test", 0.3)],
			authStorage,
			provider,
			"stale-routing-session",
			120,
		);

		const lines = output.split("\n");
		const policyIndex = lines.findIndex(line =>
			line.includes("Locked account unavailable; choose another in /settings"),
		);
		expect(policyIndex).toBeGreaterThan(0);
		expect(lines[policyIndex - 1]?.trim()).toBe("Openai Codex");
		const [labelRow, barRow, valueRow] = findUsageGroupRows(output, "Monthly");
		expect(valueRow.indexOf("70% free")).toBe(labelRow.indexOf("remaining@example.test"));
		expect(barRow).not.toContain("% free");
		expect(output).not.toContain("Locked account:");
		expect(output).not.toContain("in use by this session:");
	});
});

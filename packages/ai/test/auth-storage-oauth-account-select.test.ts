import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { isOAuthAccountSelectionError, OAuthAccountSelectionError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { withEnv } from "./helpers";

const PROVIDER = "unit-oauth-select";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function storedOAuthAccounts(storage: AuthStorage) {
	return storage.credentials
		.list(PROVIDER)
		.flatMap(row =>
			row.credential.type === "oauth" ? [{ credentialId: row.id, accountId: row.credential.accountId }] : [],
		);
}

function selectionTarget(storage: AuthStorage, suffix: string) {
	const account = storedOAuthAccounts(storage).find(candidate => candidate.accountId === `acc-${suffix}`);
	if (!account) throw new Error(`expected stored OAuth account ${suffix}`);
	return { identityHash: `identity-${suffix}`, credentialId: account.credentialId };
}

async function expectSelectionError(
	promise: Promise<unknown>,
	provider: string,
	identityHash: string,
): Promise<OAuthAccountSelectionError> {
	try {
		await promise;
		throw new Error("expected OAuth account selection error");
	} catch (error) {
		expect(error).toBeInstanceOf(OAuthAccountSelectionError);
		expect(isOAuthAccountSelectionError(error)).toBe(true);
		expect(error).toMatchObject({ provider, identityHash });
		expect((error as Error).message).toBe(
			`Locked OAuth account for "${provider}" is unavailable. Choose another account in /settings > Providers > Accounts.`,
		);
		return error as OAuthAccountSelectionError;
	}
}

describe("AuthStorage OAuth account selection", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-select-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("oauth.accounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.oauth.accounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("sessions.pin selects and restores the exact stored account", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accounts = storage.oauth.accounts(PROVIDER, "session-pin");
		const target = accounts[1];
		if (!target) throw new Error("expected second OAuth account");

		expect(accounts.some(account => account.active)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", -1)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", target.credentialId)).toBe(true);
		expect(storage.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(
			storage.oauth
				.accounts(PROVIDER, "session-pin")
				.filter(account => account.active)
				.map(account => account.email),
		).toEqual(["b@example.com"]);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "session-pin",
			}),
		).toBe("b@example.com");

		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(restored.oauth.accounts(PROVIDER, "session-pin").find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("inherited session affinity keeps usage rotation on the selected account", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected second OAuth account");
		expect(storage.sessions.pin(PROVIDER, "parent-session", accountB.credentialId)).toBe(true);

		expect(storage.sessions.inherit("parent-session", "child-session")).toBe(1);
		expect(storage.oauth.accounts(PROVIDER, "child-session").find(account => account.active)?.email).toBe(
			"b@example.com",
		);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("b@example.com");

		const outcome = await storage.limits.markReached(PROVIDER, "child-session", { retryAfterMs: 60_000 });
		expect(outcome.switched).toBe(true);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("a@example.com");
	});

	test("resolves the account at the requested position by ID and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const account = storage.oauth.accounts(PROVIDER)[position];
			if (!account) throw new Error("expected OAuth account at position");
			const result = await storage.oauth.accessById(PROVIDER, account.credentialId);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("oauth.accessById refreshes only the durable requested row", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result?.ok).toBe(true);
		if (!result?.ok) throw new Error("expected ok resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(result.accessToken).toBe("access-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("oauth.accessById does not substitute a sibling on failure", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		expect(result.credentialId).toBe(target.credentialId);
		expect(result.accountId).toBe("acc-b");
		expect(seen).toEqual(["access-b"]);
	});

	test("resolving the selected account by ID fails without touching siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		// The targeted account (acc-b) fails definitively; siblings would refresh fine.
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.access === "access-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const account = storage.oauth.accounts(PROVIDER)[1];
		if (!account) throw new Error("expected second OAuth account");
		const result = await storage.oauth.accessById(PROVIDER, account.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});

	test("an empty policy leaves automatic routing and session stickiness unchanged", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);

		const before = await storage.keys.get(PROVIDER, "automatic-session");
		if (!before) throw new Error("expected automatic OAuth selection");
		expect(["access-a", "access-b"]).toContain(before);

		storage.setOAuthAccountSelectionPolicy({ selections: {}, allowSiblingFailover: true });

		expect(storage.getOAuthAccountSelection(PROVIDER)).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "automatic-session")).toBe(before);
		const another = await storage.keys.get(PROVIDER, "another-automatic-session");
		if (!another) throw new Error("expected another automatic OAuth selection");
		expect(["access-a", "access-b"]).toContain(another);
	});

	test("strict selection overrides stale stickiness across sessions, switches immediately, and clears to Automatic", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetA = selectionTarget(storage, "a");
		const targetB = selectionTarget(storage, "b");

		expect(storage.sessions.pin(PROVIDER, "stale-sticky", targetA.credentialId)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "stale-sticky")).toBe("access-a");

		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});
		for (const sessionId of ["stale-sticky", "fresh-session", undefined] as const) {
			expect(await storage.keys.get(PROVIDER, sessionId)).toBe("access-b");
		}
		expect(storage.getOAuthAccountSelection(PROVIDER)).toEqual({
			...targetB,
			available: true,
			allowSiblingFailover: false,
		});

		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetA },
			allowSiblingFailover: false,
		});
		expect(await storage.keys.get(PROVIDER, "stale-sticky")).toBe("access-a");
		expect(await storage.keys.get(PROVIDER, "fresh-session")).toBe("access-a");

		storage.setOAuthAccountSelectionPolicy({ selections: {}, allowSiblingFailover: false });
		expect(storage.getOAuthAccountSelection(PROVIDER)).toBeUndefined();
		expect(storage.sessions.pin(PROVIDER, "stale-sticky", targetB.credentialId)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "stale-sticky")).toBe("access-b");
	});

	test("a stale strict target remains explicit auth intent and throws an actionable typed error", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const provider = "unit-oauth-select-missing";
		const identityHash = "missing-identity";
		storage.setOAuthAccountSelectionPolicy({
			selections: { [provider]: { identityHash, credentialId: 999_999 } },
			allowSiblingFailover: false,
		});

		expect(storage.getOAuthAccountSelection(provider)).toEqual({
			identityHash,
			credentialId: 999_999,
			available: false,
			allowSiblingFailover: false,
		});
		await expectSelectionError(storage.keys.peek(provider), provider, identityHash);
		await expectSelectionError(storage.keys.get(provider, "missing-session"), provider, identityHash);
		await expectSelectionError(storage.oauth.access(provider, "missing-session"), provider, identityHash);
	});

	test("runtime and config keys outrank policy while stored-account diagnostics remain policy-neutral", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const staleTarget = { identityHash: "stale-override", credentialId: 999_999 };
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: staleTarget },
			allowSiblingFailover: false,
		});

		expect(storedOAuthAccounts(storage).map(account => account.accountId)).toEqual(["acc-a", "acc-b"]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		expect(await storage.keys.get(PROVIDER)).toBe("runtime-key");
		expect(await storage.keys.peek(PROVIDER)).toBe("runtime-key");
		expect(await storage.oauth.access(PROVIDER)).toBeUndefined();
		expect(storage.oauth.identity(PROVIDER)).toBeUndefined();
		// The current account listing honors runtime overrides; stored diagnostics do not.
		expect(storage.oauth.accounts(PROVIDER)).toEqual([]);
		expect(storedOAuthAccounts(storage).map(account => account.accountId)).toEqual(["acc-a", "acc-b"]);

		storage.keys.removeRuntime(PROVIDER);
		storage.keys.setConfig(PROVIDER, "config-key");
		expect(await storage.keys.get(PROVIDER)).toBe("config-key");
		expect(await storage.keys.peek(PROVIDER)).toBe("config-key");
		expect(storedOAuthAccounts(storage)).toHaveLength(2);

		storage.keys.removeConfig(PROVIDER);
		await expectSelectionError(
			storage.keys.get(PROVIDER, "selected-after-overrides"),
			PROVIDER,
			staleTarget.identityHash,
		);
	});

	test("strict unavailability cannot fall through to login, env, or stored keys", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		const provider = "anthropic";
		await storage.credentials.set(provider, [
			{ ...oauthCredential("a"), accountId: "anthropic-a" },
			{ type: "api_key", key: "login-key", source: "login" },
			{ type: "api_key", key: "stored-key" },
		]);
		const resolveConfigValue = vi.fn(async (value: string) => value);
		const guarded = new AuthStorage(credentialStore, { configValueResolver: resolveConfigValue });
		await guarded.credentials.reload();
		guarded.setOAuthAccountSelectionPolicy({
			selections: { [provider]: { identityHash: "stale-anthropic" } },
			allowSiblingFailover: false,
		});

		await withEnv({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			await expectSelectionError(guarded.keys.get(provider, "lower-precedence"), provider, "stale-anthropic");
			await expectSelectionError(guarded.keys.peek(provider), provider, "stale-anthropic");
		});
		expect(resolveConfigValue).not.toHaveBeenCalled();
	});

	test("peek and identity use the selected account before any session has served", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		expect(await storage.keys.peek(PROVIDER)).toBe("access-b");
		expect(storage.oauth.identity(PROVIDER, "not-served")).toMatchObject({
			accountId: "acc-b",
			email: "b@example.com",
		});
	});

	test("strict attempts only the selected row while failover tries it before ranked siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		await expectSelectionError(storage.keys.get(PROVIDER, "strict-only"), PROVIDER, targetB.identityHash);
		expect(seen[0]).toBe("access-b");
		expect(seen).not.toContain("access-a");

		seen.length = 0;
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: true,
		});
		expect(await storage.keys.get(PROVIDER, "failover-session")).toBe("access-a");
		expect(seen[0]).toBe("access-b");
		expect(seen).toContain("access-a");
		expect(storage.oauth.identity(PROVIDER, "failover-session")?.accountId).toBe("acc-a");
		expect(storage.getOAuthAccountSelection(PROVIDER)?.available).toBe(true);
	});

	test("a definitively disabled selected row never leaks to a sibling in strict mode", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.accountId === "acc-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		await expectSelectionError(storage.keys.get(PROVIDER, "disable-selected"), PROVIDER, targetB.identityHash);
		expect(seen).toEqual(["access-b"]);
		expect(storedOAuthAccounts(storage).map(account => account.accountId)).toEqual(["acc-a"]);
		expect(storage.getOAuthAccountSelection(PROVIDER)?.available).toBe(false);

		seen.length = 0;
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: true,
		});
		expect(await storage.keys.get(PROVIDER, "disable-selected")).toBe("access-a");
		expect(seen).toEqual(["access-a"]);
	});

	test("a selected-row refresh failure blocks strict fallback but permits an existing sibling in failover mode", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSeen: string[] = [];
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			refreshSeen.push(credential.accountId ?? "unknown");
			if (credential.accountId === "acc-b") throw new Error("temporary refresh service failure");
			return { ...credential, expires: Date.now() + 60 * 60_000 };
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const expiredB = { ...oauthCredential("b"), expires: 0 };
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), expiredB]);
		const targetB = selectionTarget(storage, "b");
		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: false,
		});

		await expectSelectionError(storage.keys.get(PROVIDER, "refresh-failure"), PROVIDER, targetB.identityHash);
		expect(refreshSeen.length).toBeGreaterThan(0);
		expect(refreshSeen.every(accountId => accountId === "acc-b")).toBe(true);

		storage.setOAuthAccountSelectionPolicy({
			selections: { [PROVIDER]: targetB },
			allowSiblingFailover: true,
		});
		expect(await storage.keys.get(PROVIDER, "refresh-failure")).toBe("access-a");
	});
});

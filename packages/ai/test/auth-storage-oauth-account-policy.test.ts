import { afterEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { OAuthAccountSelectionError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-selection-policy";

function credential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${suffix}`,
	};
}

describe("AuthStorage OAuth account selection policy", () => {
	afterEach(() => vi.restoreAllMocks());

	test("strict selection never chooses a sibling; failover tries target before sibling", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		try {
			await storage.credentials.set(PROVIDER, [credential("a"), credential("b")]);
			const target = storage.credentials
				.list(PROVIDER)
				.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-b");
			if (!target) throw new Error("expected target OAuth row");
			const seen: string[] = [];
			const getOAuthApiKey = vi
				.spyOn(oauthUtils, "getOAuthApiKey")
				.mockImplementation(async (provider, credentials) => {
					const selected = credentials[provider];
					if (!selected) return null;
					seen.push(selected.accountId ?? "unknown");
					return null;
				});
			storage.setOAuthAccountSelectionPolicy({
				selections: { [PROVIDER]: { identityHash: "opaque-target", credentialId: target.id } },
				allowSiblingFailover: false,
			});

			await expect(storage.keys.get(PROVIDER, "strict-session")).rejects.toBeInstanceOf(OAuthAccountSelectionError);
			expect(seen).toEqual(["account-b"]);

			seen.length = 0;
			getOAuthApiKey.mockImplementation(async (provider, credentials) => {
				const selected = credentials[provider];
				if (!selected) return null;
				seen.push(selected.accountId ?? "unknown");
				if (selected.accountId === "account-b") return null;
				return { newCredentials: selected, apiKey: selected.access };
			});
			storage.setOAuthAccountSelectionPolicy({
				selections: { [PROVIDER]: { identityHash: "opaque-target", credentialId: target.id } },
				allowSiblingFailover: true,
			});

			expect(await storage.keys.get(PROVIDER, "failover-session")).toBe("access-a");
			expect(seen).toEqual(["account-b", "account-a"]);
		} finally {
			storage.close();
		}
	});

	test("a missing strict target is unavailable and produces a typed selection error", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		try {
			await storage.credentials.set(PROVIDER, [credential("a"), credential("b")]);
			const target = storage.credentials
				.list(PROVIDER)
				.find(row => row.credential.type === "oauth" && row.credential.accountId === "account-b");
			if (!target) throw new Error("expected target OAuth row");
			storage.setOAuthAccountSelectionPolicy({
				selections: { [PROVIDER]: { identityHash: "opaque-target", credentialId: target.id } },
				allowSiblingFailover: false,
			});
			await storage.credentials.removeById(PROVIDER, target.id);

			expect(storage.getOAuthAccountSelection(PROVIDER)).toMatchObject({
				available: false,
				identityHash: "opaque-target",
			});
			await expect(storage.keys.get(PROVIDER, "missing-target-session")).rejects.toBeInstanceOf(
				OAuthAccountSelectionError,
			);
		} finally {
			storage.close();
		}
	});
});

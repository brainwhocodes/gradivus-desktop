import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runSearchCommand } from "@oh-my-pi/pi-coding-agent/cli/web-search-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { credentialPinHash } from "@oh-my-pi/pi-coding-agent/session/credential-pin";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import {
	cfgProvidersOauthAccountFailover,
	cfgProvidersOauthAccountLocks,
	cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { __resetDirsFromEnvForTests, getAgentDbPath, getModelDbPath, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalOmpProfile = process.env.OMP_PROFILE;
const originalPiProfile = process.env.PI_PROFILE;

let tempAgentDir: TempDir | undefined;
let originalExitCode: typeof process.exitCode;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function makeFetchMock(): typeof fetch {
	return Object.assign(
		async (input: string | Request | URL): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === "https://www.startpage.com/") {
				return new Response("<html><body></body></html>", {
					status: 200,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (url.startsWith("https://www.startpage.com/sp/search")) {
				return new Response(
					'<div class="result"><a class="result-link" href="https://startpage.example"><h2>Startpage result</h2></a><p class="description">startpage</p></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			if (url === "https://html.duckduckgo.com/html/") {
				return new Response(
					'<div class="result"><a class="result__a" href="https://duckduckgo.example">DuckDuckGo result</a><a class="result__snippet">duckduckgo</a></div>',
					{ status: 200, headers: { "Content-Type": "text/html" } },
				);
			}
			return new Response(`unexpected URL: ${url}`, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
}

beforeEach(async () => {
	originalExitCode = process.exitCode;
	process.exitCode = undefined;
	resetSettingsForTest();
	tempAgentDir = TempDir.createSync("@omp-search-cli-");
	setAgentDir(tempAgentDir.path());
	const settings = await Settings.init({ inMemory: true, cwd: tempAgentDir.path() });
	settings.setModelRole("web", "web/startpage");
	cfgRetryFallbackChains.set(settings, { web: [] });
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	process.exitCode = originalExitCode;
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	restoreEnv("PI_PROFILE", originalPiProfile);
	__resetDirsFromEnvForTests();
	if (tempAgentDir) {
		await tempAgentDir.remove();
		tempAgentDir = undefined;
	}
});

describe("runSearchCommand model role settings", () => {
	it("honors modelRoles.web for the implicit request", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({ query: "role selection smoke test", limit: 1, expanded: false });

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("startpage.example");
		expect(plain).not.toContain("duckduckgo.example");
	});

	it("treats --model as a one-shot override of modelRoles.web", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(makeFetchMock());
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({
			query: "explicit model override",
			model: "web/duckduckgo",
			limit: 1,
			expanded: false,
		});

		const plain = stripVTControlCharacters(stdout);
		expect(plain).toContain("duckduckgo.example");
		expect(plain).not.toContain("startpage.example");
	});

	it("uses the configured OAuth account lock when resolving search credentials", async () => {
		const currentTempDir = tempAgentDir;
		if (!currentTempDir) throw new Error("tempAgentDir missing");
		const selectedIdentityHash = credentialPinHash("anthropic", {
			accountId: "search-account-b",
			email: "search-b@example.com",
		});
		if (!selectedIdentityHash) throw new Error("expected a stable search account identity");

		const settings = await Settings.init({ cwd: currentTempDir.path() });
		settings.setModelRole("web", "anthropic/claude-haiku-4-5");
		await Bun.write(
			currentTempDir.join("config.yml"),
			`providers:
  oauthAccountLocks:
    anthropic: ${selectedIdentityHash}
  oauthAccountFailover: false
`,
		);
		const fileSettings = await Settings.loadReadOnly({
			cwd: currentTempDir.path(),
			agentDir: currentTempDir.path(),
		});
		cfgProvidersOauthAccountLocks.set(settings, cfgProvidersOauthAccountLocks.get(fileSettings));
		cfgProvidersOauthAccountFailover.set(settings, cfgProvidersOauthAccountFailover.get(fileSettings));
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath(currentTempDir.path()));
		store.saveOAuth("anthropic", {
			access: "sk-ant-oat-search-a",
			refresh: "refresh-search-a",
			expires: Date.now() + 3_600_000,
			accountId: "search-account-a",
			email: "search-a@example.com",
		});
		store.saveOAuth("anthropic", {
			access: "sk-ant-oat-search-b",
			refresh: "refresh-search-b",
			expires: Date.now() + 3_600_000,
			accountId: "search-account-b",
			email: "search-b@example.com",
		});
		store.close();

		let authorization: string | null = null;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | Request | URL, init?: RequestInit): Promise<Response> => {
					authorization = new Headers(init?.headers).get("authorization");
					return new Response(
						JSON.stringify({
							id: "msg_search_policy",
							model: "claude-haiku-4-5",
							content: [{ type: "text", text: "Configured OAuth search result" }],
							usage: { input_tokens: 1, output_tokens: 2 },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runSearchCommand({
			query: "OAuth storage threading",
			limit: 1,
			expanded: false,
		});

		expect(authorization ?? "").toBe("Bearer sk-ant-oat-search-b");
		expect(stripVTControlCharacters(stdout)).toContain("Anthropic");
	});

	it("rejects mismatched direct and registry authentication storage", async () => {
		const directStorage = await AuthStorage.create(":memory:");
		const registryStorage = await AuthStorage.create(":memory:");
		try {
			const modelRegistry = new ModelRegistry(registryStorage, undefined, { cacheDbPath: getModelDbPath() });
			await expect(
				runSearchQuery({ query: "must not dispatch" }, { authStorage: directStorage, modelRegistry }),
			).rejects.toThrow(
				"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
			);
		} finally {
			directStorage.close();
			registryStorage.close();
		}
	});
});

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { WorkspaceCommandV1, WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { ensureWorkspaceRuntime, type WorkspaceRuntimeDescriptor } from "@oh-my-pi/pi-workspace-runtime/bootstrap";
import type { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime/client";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, protocol, session } from "electron";
import { MAX_INLINE_PROMPT_BYTES, type OpenChatTerminalInput } from "../shared/contracts";
import { BROWSER_SELECTION_AGENT_PROFILE_ID } from "../shared/selection-agent";
import { DESKTOP_THEME_PALETTES, type ResolvedTheme, resolveTheme } from "../shared/theme-palette";
import { AppSettingsStore } from "./app-settings";
import { defaultWorkspacePath, ompExecutablePath, runtimeRootDir } from "./backend-path";
import { DesktopHost } from "./desktop-host";
import { adoptOwnedRuntimeCandidate } from "./runtime-candidate";
import { driveRuntimeReconnect } from "./runtime-reconnect";
import { shutdownDesktopServices } from "./shutdown";
import { type CreateBrowserOptions, type CreateTerminalOptions, WorkspaceHost } from "./workspace-host";

process.stdout?.on?.("error", (err: unknown) => {
	if ((err as { code?: string })?.code === "EIO") return;
});
process.stderr?.on?.("error", (err: unknown) => {
	if ((err as { code?: string })?.code === "EIO") return;
});
process.on("uncaughtException", (err: unknown) => {
	if ((err as { code?: string })?.code === "EIO") return;
	console.error("UNCAUGHT EXCEPTION IN MAIN PROCESS:", err);
	logger.error("Uncaught exception in main process", { error: err instanceof Error ? err.message : String(err) });
});
process.on("unhandledRejection", (reason: unknown) => {
	console.error("UNHANDLED REJECTION IN MAIN PROCESS:", reason);
	logger.error("Unhandled rejection in main process", { error: String(reason) });
});

const DEV_SERVER =
	typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string" ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL) : undefined;
const CONTENT_SECURITY_POLICY =
	"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let mainWindow: BrowserWindow | undefined;
let host: DesktopHost | undefined;
let appSettingsStore: AppSettingsStore | undefined;
let quitting = false;
let workspace: WorkspaceHost | undefined;
let runtimeDescriptor: WorkspaceRuntimeDescriptor | undefined;
let requestRuntimeReconnect: (() => Promise<void>) | undefined;
let runtimeClient: WorkspaceClient | undefined;

interface InitializedServices {
	host: DesktopHost;
	workspace: WorkspaceHost;
	settingsStore: AppSettingsStore;
	runtimeClient?: WorkspaceClient;
}

let resolveServicesReady: ((services: InitializedServices) => void) | undefined;
let rejectServicesReady: ((error: unknown) => void) | undefined;

const servicesReadyPromise = new Promise<InitializedServices>((resolve, reject) => {
	resolveServicesReady = resolve;
	rejectServicesReady = reject;
});

async function ensureServices(): Promise<InitializedServices> {
	if (host && workspace && appSettingsStore) {
		return { host, workspace, settingsStore: appSettingsStore, runtimeClient };
	}
	await servicesReadyPromise;
	if (!host || !workspace || !appSettingsStore) {
		throw new Error("Desktop services are unavailable");
	}
	return { host, workspace, settingsStore: appSettingsStore, runtimeClient };
}

const DEFAULT_WORKSPACE_ID = "workspace-default";
const DEFAULT_LOCATION_ID = "location-default";

async function executeBootstrapCommand(
	client: WorkspaceClient,
	command: WorkspaceCommandV1,
): Promise<WorkspaceDocumentV1> {
	const result = await client.executeCommandWithRetry(() => command);
	if (result.status === "accepted" || result.status === "duplicate") return result.document;
	throw new Error(`Workspace bootstrap command ${command.type} failed: ${result.error?.message ?? result.status}`);
}

async function ensureDefaultWorkspace(client: WorkspaceClient): Promise<void> {
	let document = client.document ?? (await client.getDocument());
	if (document.workspaces.length === 0) {
		document = await executeBootstrapCommand(client, {
			version: 1,
			commandId: "workspace-bootstrap-default",
			workspaceId: DEFAULT_WORKSPACE_ID,
			expectedRevision: document.revision,
			issuedAt: 1,
			type: "workspace.create",
			payload: {
				locationId: DEFAULT_LOCATION_ID,
				locationName: "Local",
				address: { kind: "local", path: defaultWorkspacePath() },
				name: "Workspace",
			},
		});
	}

	const workspaceId = document.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
	for (const profileId of ["profile-codex", "profile-claude"] as const) {
		if (!document.agentProfiles.some(item => item.id === profileId)) continue;
		if (
			document.agents.some(item => item.profileId === profileId) ||
			document.terminals.some(item => item.profileId === profileId)
		) {
			continue;
		}
		document = await executeBootstrapCommand(client, {
			version: 1,
			commandId: `profile-retire-${profileId}`,
			workspaceId,
			expectedRevision: document.revision,
			issuedAt: 1,
			type: "profile.delete",
			payload: { id: profileId },
		});
	}
	const defaultProfiles = [
		{ id: "profile-omp", name: "Oh My Pi", protocol: "omp" as const, config: {}, capabilityIds: [] },
		{
			id: BROWSER_SELECTION_AGENT_PROFILE_ID,
			name: "Page Agent",
			protocol: "omp" as const,
			config: {},
			capabilityIds: [],
		},
	];

	for (const profile of defaultProfiles) {
		if (document.agentProfiles.some(item => item.id === profile.id)) continue;
		document = await executeBootstrapCommand(client, {
			version: 1,
			commandId: `profile-bootstrap-${profile.id}`,
			workspaceId,
			expectedRevision: document.revision,
			issuedAt: 1,
			type: "profile.create",
			payload: {
				id: profile.id,
				name: profile.name,
				protocol: profile.protocol,
				config: profile.config,
				capabilityIds: profile.capabilityIds,
			},
		});
	}
}

function showFatalStartupError(title: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	dialog.showErrorBox(title, `${message}\n\nGradivus cannot continue and will now close. Logs: ~/.omp/logs/`);
}

app.name = "Gradivus";
app.setName("Gradivus");
app.setAppUserModelId("labs.gradivus.desktop");
protocol.registerSchemesAsPrivileged([
	{ scheme: "gradivus", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

// Register all IPC handlers synchronously so no renderer IPC call ever races with async initialization
registerIpc();

const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true;
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.focus();
	});

	void app
		.whenReady()
		.then(async () => {
			if (process.platform === "darwin" && app.dock && typeof app.dock.setIcon === "function") {
				const iconCandidates = [
					path.join(__dirname, "..", "..", "resources", "icon.png"),
					path.join(__dirname, "..", "..", "resources", "icon.icns"),
				];
				for (const cand of iconCandidates) {
					if (existsSync(cand)) {
						try {
							app.dock.setIcon(cand);
							break;
						} catch {}
					}
				}
			}
			registerProtocol();
			configureSecurity();

			const rawUserData = app.getPath("userData");
			const userDataPath = await fs.realpath(rawUserData).catch(() => rawUserData);
			appSettingsStore = new AppSettingsStore(userDataPath, defaultWorkspacePath());
			await appSettingsStore.load();
			const theme = resolveTheme(appSettingsStore.settings.theme, nativeTheme.shouldUseDarkColors);

			host = new DesktopHost(userDataPath);
			await host.load();

			const runtimeRoot = runtimeRootDir(userDataPath);
			try {
				runtimeDescriptor = await ensureWorkspaceRuntime({
					runtimeDir: runtimeRoot,
					executablePath: ompExecutablePath(),
				});
			} catch (error) {
				console.error("RUNTIME STARTUP ERROR:", error);
				logger.error("Gradivus runtime startup failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				showFatalStartupError("Gradivus runtime failed to start", error);
				rejectServicesReady?.(error);
				app.quit();
				return;
			}
			runtimeClient = runtimeDescriptor.client;

			try {
				await ensureDefaultWorkspace(runtimeClient);
			} catch (error) {
				console.error("WORKSPACE AUTHORITY ERROR:", error);
				logger.error("Could not initialize workspace authority", { error: String(error) });
				showFatalStartupError("Gradivus workspace failed to initialize", error);
				rejectServicesReady?.(error);
				app.quit();
				return;
			}
			mainWindow = createWindow(theme);
			mainWindow.on("closed", () => {
				host?.setWindow(undefined);
				mainWindow = undefined;
			});
			host.setWindow(mainWindow);
			workspace = new WorkspaceHost(mainWindow, appSettingsStore, host);
			workspace.setDesktopHost(host);

			let runtimeGeneration = 0;
			let reconnecting = false;
			async function reconnectRuntime(): Promise<void> {
				if (reconnecting || quitting) return;
				reconnecting = true;
				try {
					await driveRuntimeReconnect({
						emit: event => {
							if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
								try {
									mainWindow.webContents.send("gradivus:workspace", {
										type: "connection-state",
										...event,
									});
								} catch {}
							}
						},
						attempt: async () => {
							const nextDescriptor = await ensureWorkspaceRuntime({
								runtimeDir: runtimeRoot,
								executablePath: ompExecutablePath(),
							});
							const previousDescriptor = runtimeDescriptor;
							const adoptedDescriptor = await adoptOwnedRuntimeCandidate(
								nextDescriptor,
								async candidate => {
									await candidate.client.getDocument();
									if (quitting) throw new Error("Runtime reconnect canceled during verification");
								},
								async candidate => {
									if (quitting) throw new Error("Runtime reconnect canceled before binding");
									await bindRuntimeClient(candidate.client);
									if (quitting) throw new Error("Runtime reconnect canceled after binding");
								},
							);
							if (quitting) {
								await adoptedDescriptor.close().catch(error => {
									logger.warn("Runtime reconnect candidate close failed during shutdown", {
										error: String(error),
									});
								});
								throw new Error("Runtime reconnect canceled during shutdown");
							}

							runtimeDescriptor = adoptedDescriptor;
							runtimeClient = adoptedDescriptor.client;
							if (previousDescriptor && previousDescriptor !== adoptedDescriptor) {
								try {
									await previousDescriptor.close();
								} catch (error) {
									logger.warn("Previous runtime descriptor close failed", { error: String(error) });
								}
							}
						},
						onAttemptError: (error, attemptNumber) => {
							logger.warn("Runtime reconnect attempt failed", {
								attempt: attemptNumber,
								error: String(error),
							});
						},
						shouldContinue: () => !quitting,
					});
				} finally {
					reconnecting = false;
				}
			}
			requestRuntimeReconnect = () => reconnectRuntime();

			async function bindRuntimeClient(client: WorkspaceClient): Promise<void> {
				const generation = runtimeGeneration + 1;
				if (client.principal && client.document) {
					host?.setWorkspaceAuthority(client.principal, client.document);
				}
				if (workspace) {
					await workspace.replaceClient(client);
				}

				client.onDocument(d => {
					if (generation !== runtimeGeneration) return;
					if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
					if (client.principal) {
						host?.setWorkspaceAuthority(client.principal, d);
						workspace?.syncWithDocument(d);
					}
					try {
						mainWindow.webContents.send("gradivus:workspace-document", d);
					} catch {}
				});

				client.onConnectionState(state => {
					if (generation !== runtimeGeneration) return;
					if (!state.connected && state.unexpected) {
						void reconnectRuntime();
					}
				});
				runtimeGeneration = generation;
			}

			await bindRuntimeClient(runtimeClient);

			// Unblock all pending and future IPC calls
			resolveServicesReady?.({
				host,
				workspace,
				settingsStore: appSettingsStore,
				runtimeClient,
			});

			if (host.bootstrap().warning) {
				mainWindow.webContents.once("did-finish-load", () => {
					if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
						try {
							mainWindow.webContents.send("gradivus:event", {
								sessionId: "",
								type: "warning",
								message: host?.bootstrap().warning,
							});
						} catch {}
					}
				});
			}
			await loadRenderer(mainWindow);
		})
		.catch(error => {
			console.error("GRADIVUS STARTUP FAILED:", error);
			logger.error("Gradivus startup failed", { error: error instanceof Error ? error.message : String(error) });
			rejectServicesReady?.(error);
			app.quit();
		});

	app.on("before-quit", event => {
		if (quitting || (!host && !workspace)) return;
		event.preventDefault();
		quitting = true;
		void shutdownDesktopServices({
			host,
			workspace,
			runtimeClient,
			quit: () => app.quit(),
		});
	});

	app.on("window-all-closed", () => {
		app.quit();
	});

	app.on("activate", () => {
		if (!appSettingsStore) return;
		if (BrowserWindow.getAllWindows().length === 0) {
			const theme = resolveTheme(appSettingsStore.settings.theme, nativeTheme.shouldUseDarkColors);
			mainWindow = createWindow(theme);
			mainWindow.on("closed", () => {
				host?.setWindow(undefined);
				mainWindow = undefined;
			});
			host?.setWindow(mainWindow);
			workspace = new WorkspaceHost(mainWindow, appSettingsStore, host);
			if (host) workspace.setDesktopHost(host);
			if (runtimeClient) {
				void workspace.replaceClient(runtimeClient);
			}
			void loadRenderer(mainWindow);
		}
	});
}

function createWindow(theme: ResolvedTheme): BrowserWindow {
	const iconCandidate = path.join(__dirname, "..", "..", "resources", "icon.png");
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 640,
		title: "Gradivus",
		frame: false,
		backgroundColor: DESKTOP_THEME_PALETTES[theme].windowBackground,
		...(existsSync(iconCandidate) ? { icon: iconCandidate } : {}),
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: false,
			webSecurity: true,
		},
	});
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event, url) => {
		if (DEV_SERVER && url.startsWith(DEV_SERVER.origin)) return;
		if (url.startsWith("gradivus://")) return;
		event.preventDefault();
	});
	window.webContents.on("will-attach-webview", event => event.preventDefault());
	return window;
}

function configureSecurity(): void {
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	session.defaultSession.setPermissionCheckHandler(() => false);
}

function registerProtocol(): void {
	protocol.handle("gradivus", async request => {
		if (DEV_SERVER) return net.fetch(new URL("src/renderer/index.html", DEV_SERVER).toString());
		const root = path.resolve(__dirname, "..", "renderer", "main_window");
		const url = new URL(request.url);
		let relative: string;
		try {
			relative = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		if (relative.length === 0) relative = "index.html";
		const candidate = path.resolve(root, relative === "index.html" ? "src/renderer/index.html" : relative);
		const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
		const candidateKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
		if (candidateKey !== rootKey && !candidateKey.startsWith(`${rootKey}${path.sep}`))
			return new Response("Forbidden", { status: 403 });
		try {
			await fs.access(candidate);
			const response = await net.fetch(pathToFileURL(candidate).toString());
			const headers = new Headers(response.headers);
			headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		} catch {
			return new Response("Not found", { status: 404 });
		}
	});
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
	if (DEV_SERVER) await window.loadURL(new URL("src/renderer/index.html", DEV_SERVER).toString());
	else await window.loadURL("gradivus://app/index.html");
}

function registerIpc(): void {
	ipcMain.handle("gradivus:bootstrap", async event => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.bootstrap();
	});
	ipcMain.handle("gradivus:auth-status", async event => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getAuthStatus();
	});
	ipcMain.handle("gradivus:oauth-accounts", async event => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getOAuthAccounts();
	});
	ipcMain.handle("gradivus:set-oauth-account-lock", async (event, providerId: unknown, credentialId: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setOAuthAccountLock(providerId, credentialId);
	});
	ipcMain.handle("gradivus:set-oauth-account-failover", async (event, enabled: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setOAuthAccountFailover(enabled);
	});
	ipcMain.handle("gradivus:remove-oauth-account", async (event, providerId: unknown, credentialId: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.removeOAuthAccount(providerId, credentialId);
	});
	ipcMain.handle("gradivus:auth-login", async (event, provider: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.loginProvider(provider);
	});
	ipcMain.handle("gradivus:auth-logout", async (event, provider: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.logoutProvider(provider);
	});
	ipcMain.handle("gradivus:auth-prompt", async (event, value: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.respondAuthPrompt(value);
	});
	ipcMain.handle("gradivus:settings-get", async event => {
		assertTrustedSender(event);
		const { settingsStore: s } = await ensureServices();
		return s.settings;
	});
	ipcMain.handle("gradivus:runtime-reconnect", async event => {
		assertTrustedSender(event);
		if (!requestRuntimeReconnect) throw new Error("Workspace runtime is not initialized yet");
		await requestRuntimeReconnect();
	});
	ipcMain.handle("gradivus:settings-update", async (event, updates: unknown) => {
		assertTrustedSender(event);
		const { settingsStore: s, workspace: ws } = await ensureServices();
		const updated = await s.update(typeof updates === "object" && updates !== null ? updates : {});
		ws.updateTheme();
		return updated;
	});
	ipcMain.handle("gradivus:settings-reset", async event => {
		assertTrustedSender(event);
		const { settingsStore: s, workspace: ws } = await ensureServices();
		const reset = await s.reset();
		ws.updateTheme();
		return reset;
	});
	ipcMain.handle("gradivus:agent-settings", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getAgentSettings(id);
	});
	ipcMain.handle("gradivus:set-agent-setting", async (event, id: unknown, pathValue: unknown, value: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setAgentSetting(id, pathValue, value);
	});
	ipcMain.handle("gradivus:choose-and-create", async (event, kind: unknown, cwd: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.chooseAndCreate(kind, cwd);
	});
	ipcMain.handle("gradivus:open", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.openSession(id);
	});
	ipcMain.handle("gradivus:resume", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.resume(id);
	});
	ipcMain.handle("gradivus:timeline-page", async (event, id: unknown, before: unknown, limit: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.loadTimelinePage(id, before, limit);
	});
	ipcMain.handle("gradivus:timeline-item", async (event, id: unknown, itemId: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.loadTimelineItem(id, itemId);
	});
	ipcMain.handle("gradivus:available-commands", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getAvailableCommands(id);
	});
	ipcMain.handle("gradivus:available-models", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getAvailableModels(id);
	});
	ipcMain.handle("gradivus:openrouter-model-routing", async (event, id: unknown, modelId: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getOpenRouterModelRouting(id, modelId);
	});
	ipcMain.handle(
		"gradivus:set-openrouter-provider-enabled",
		async (event, id: unknown, modelId: unknown, providerId: unknown, enabled: unknown) => {
			assertTrustedSender(event);
			const { host: h } = await ensureServices();
			return h.setOpenRouterProviderEnabled(id, modelId, providerId, enabled);
		},
	);
	ipcMain.handle("gradivus:stop", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.stop(id);
	});
	ipcMain.handle("gradivus:rename", async (event, id: unknown, title: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.rename(id, title);
	});
	ipcMain.handle("gradivus:delete", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.deleteSession(id);
	});
	ipcMain.handle("gradivus:stage-prompt-attachments", async (event, id: unknown, uploads: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.stagePromptAttachments(id, uploads);
	});
	ipcMain.handle("gradivus:stage-prompt-text", async (event, id: unknown, text: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.stagePromptText(id, text);
	});
	ipcMain.handle("gradivus:release-prompt-attachments", async (event, id: unknown, attachmentIds: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.releasePromptAttachments(id, attachmentIds);
	});
	ipcMain.handle("gradivus:prompt", async (event, id: unknown, composition: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.prompt(id, composition);
	});
	ipcMain.handle("gradivus:steer", async (event, id: unknown, composition: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.steer(id, composition);
	});
	ipcMain.handle("gradivus:queue", async (event, id: unknown, composition: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.queueFollowUp(id, composition);
	});
	ipcMain.handle("gradivus:abort", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.abort(id);
	});
	ipcMain.handle("gradivus:set-model", async (event, id: unknown, provider: unknown, model: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setModel(id, provider, model);
	});
	ipcMain.handle("gradivus:set-thinking", async (event, id: unknown, level: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setThinking(id, level);
	});
	ipcMain.handle("gradivus:set-fast", async (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setFastMode(id, enabled);
	});
	ipcMain.handle("gradivus:toggle-plan-mode", async (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.togglePlanMode(id, enabled);
	});
	ipcMain.handle("gradivus:set-queue-mode", async (event, id: unknown, kind: unknown, mode: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setQueueMode(id, kind, mode);
	});
	ipcMain.handle("gradivus:set-interrupt-mode", async (event, id: unknown, mode: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setInterruptMode(id, mode);
	});
	ipcMain.handle("gradivus:set-auto-compaction", async (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setAutoCompaction(id, enabled);
	});
	ipcMain.handle("gradivus:set-auto-retry", async (event, id: unknown, enabled: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.setAutoRetry(id, enabled);
	});
	ipcMain.handle("gradivus:extension-response", async (event, id: unknown, response: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.extensionResponse(id, response);
	});
	ipcMain.handle("gradivus:subagent-messages", async (event, id: unknown, subagentId: unknown, fromByte: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getSubagentMessages(id, subagentId, fromByte);
	});
	ipcMain.handle("gradivus:agent-hub", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getAgentHub(id);
	});
	ipcMain.handle("gradivus:agent-hub-messages", async (event, id: unknown, agentId: unknown, fromByte: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.getAgentHubMessages(id, agentId, fromByte);
	});
	ipcMain.handle("gradivus:agent-hub-message", async (event, id: unknown, agentId: unknown, message: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.agentHubMessage(id, agentId, message);
	});
	ipcMain.handle("gradivus:agent-hub-kill", async (event, id: unknown, agentId: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.agentHubKill(id, agentId);
	});
	ipcMain.handle("gradivus:agent-hub-revive", async (event, id: unknown, agentId: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.agentHubRevive(id, agentId);
	});
	ipcMain.handle("gradivus:file-diff", async (event, id: unknown, target: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.loadFileDiff(id, target);
	});
	ipcMain.handle("gradivus:workspace-image", async (event, id: unknown, target: unknown, maxDimension: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.loadWorkspaceImage(id, target, maxDimension);
	});
	ipcMain.handle("gradivus:clipboard-write", (event, value: unknown) => {
		assertTrustedSender(event);
		if (typeof value !== "string") throw new TypeError("clipboard text must be text");
		if (Buffer.byteLength(value, "utf8") > MAX_INLINE_PROMPT_BYTES) {
			throw new RangeError("clipboard text exceeds 512 KiB");
		}
		clipboard.writeText(value);
	});
	ipcMain.handle("gradivus:open-workspace-file", async (event, id: unknown, target: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.openWorkspaceFile(id, target);
	});
	ipcMain.handle("gradivus:open-external", async (event, url: unknown) => {
		assertTrustedSender(event);
		const { host: h } = await ensureServices();
		return h.openExternal(url);
	});
	ipcMain.handle("gradivus:workspace-document-get", async event => {
		assertTrustedSender(event);
		const { runtimeClient: client } = await ensureServices();
		return client?.document ?? (await client?.getDocument()) ?? null;
	});
	ipcMain.handle("gradivus:browser-create", async (event, options: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.createBrowser(options as CreateBrowserOptions);
	});
	ipcMain.handle("gradivus:browser-navigate", async (event, id: unknown, url: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.navigateBrowser(id, url);
	});
	ipcMain.handle("gradivus:browser-control", async (event, id: unknown, action: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.controlBrowser(id, action);
	});
	ipcMain.handle("gradivus:browser-bounds", async (event, id: unknown, bounds: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.setBrowserBounds(id, bounds);
	});
	ipcMain.handle("gradivus:browser-visible", async (event, ids: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.setVisibleBrowsers(ids);
	});
	ipcMain.handle("gradivus:browser-close", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.closeBrowser(id);
	});
	ipcMain.handle("gradivus:chat-terminal-open", async (event, input: unknown) => {
		assertTrustedSender(event);
		const { host: h, workspace: ws } = await ensureServices();
		if (typeof input !== "object" || input === null) throw new TypeError("invalid chat terminal input");
		const value = input as Partial<OpenChatTerminalInput>;
		if (
			typeof value.id !== "string" ||
			!/^[a-z0-9-]{8,100}$/i.test(value.id) ||
			typeof value.sessionId !== "string" ||
			value.sessionId.length < 8 ||
			value.sessionId.length > 100 ||
			!Number.isSafeInteger(value.cols) ||
			(value.cols as number) < 2 ||
			(value.cols as number) > 500 ||
			!Number.isSafeInteger(value.rows) ||
			(value.rows as number) < 2 ||
			(value.rows as number) > 500 ||
			!Number.isSafeInteger(value.fromOffset) ||
			(value.fromOffset as number) < 0
		)
			throw new TypeError("invalid chat terminal input");
		const resolved = h.resolveSessionWorkspace(value.sessionId);
		return ws.openChatTerminal(value as OpenChatTerminalInput, resolved);
	});
	ipcMain.handle("gradivus:terminal-create", async (event, options: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.createTerminal(options as CreateTerminalOptions);
	});
	ipcMain.handle("gradivus:terminal-write", async (event, id: unknown, data: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.writeTerminal(id, data);
	});
	ipcMain.handle("gradivus:terminal-resize", async (event, id: unknown, cols: unknown, rows: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.resizeTerminal(id, cols, rows);
	});
	ipcMain.handle("gradivus:terminal-close", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.closeTerminal(id);
	});
	ipcMain.handle("gradivus:tab-update", async (event, tabId: unknown, updates: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.updateTab(tabId, updates);
	});
	ipcMain.handle("gradivus:tab-close", async (event, tabId: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.closeTab(tabId);
	});
	ipcMain.handle("gradivus:pane-close", async (event, paneId: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.closePane(paneId);
	});
	ipcMain.on("gradivus:pane-context-menu", (event, id: unknown, canSplit: unknown) => {
		assertTrustedSender(event);
		void ensureServices()
			.then(({ workspace: ws }) => {
				ws.showPaneContextMenu(id, canSplit);
			})
			.catch(error => {
				logger.error("Failed to show pane context menu", { error: String(error) });
			});
	});
	ipcMain.handle("gradivus:selection-start", async (event, id: unknown, captureMode: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		const pane = typeof id === "string" ? id.trim() : "";
		const mode = captureMode === "screenshot" ? "screenshot" : "dom";
		const { scope, target } = await ws.ensureSelectionTarget(pane);
		return ws.startSelection(scope, { captureMode: mode, target });
	});
	ipcMain.handle("gradivus:selection-cancel", async (event, id: unknown, reason: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.cancelSelection(id, reason);
	});
	ipcMain.handle("gradivus:selection-commit", async (event, id: unknown, instruction: unknown, action: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		const pane = typeof id === "string" ? id.trim() : "";
		const act = action === "inline" || action === "queue" || action === "chat" ? action : undefined;
		return ws.commitSelection(pane, typeof instruction === "string" ? instruction : undefined, act);
	});
	ipcMain.handle("gradivus:selection-run-queued", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		const pane = typeof id === "string" ? id.trim() : "";
		return ws.runQueuedTasks(pane);
	});
	ipcMain.handle("gradivus:selection-clear-queued", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		const pane = typeof id === "string" ? id.trim() : "";
		return ws.clearQueuedTasks(pane);
	});
	ipcMain.handle("gradivus:selection-state", async (event, id: unknown) => {
		assertTrustedSender(event);
		const { workspace: ws } = await ensureServices();
		return ws.getSelectionState(id);
	});
	ipcMain.handle("gradivus:window-minimize", event => {
		assertTrustedSender(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error("Window is unavailable");
		window.minimize();
	});
	ipcMain.handle("gradivus:window-toggle-maximize", event => {
		assertTrustedSender(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error("Window is unavailable");
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
		return window.isMaximized();
	});
	ipcMain.handle("gradivus:window-close", event => {
		assertTrustedSender(event);
		const window = BrowserWindow.fromWebContents(event.sender);
		if (!window) throw new Error("Window is unavailable");
		window.close();
	});
}

function assertTrustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): void {
	const senderUrl = event.senderFrame?.url;
	if (!senderUrl) throw new Error("Untrusted IPC sender");
	if (senderUrl.startsWith("gradivus://app/")) return;
	if (DEV_SERVER && new URL(senderUrl).origin === new URL(DEV_SERVER).origin) return;
	throw new Error("Untrusted IPC sender");
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;

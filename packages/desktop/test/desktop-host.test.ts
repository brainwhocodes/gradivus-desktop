import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceDocumentV1 } from "@oh-my-pi/pi-wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentSwatch } from "../src/shared/agent-swatch";
import type { GradivusEvent, ProcessState, PromptCompositionPart, SessionRecordV1 } from "../src/shared/contracts";

function composition(...parts: PromptCompositionPart[]) {
	return { parts };
}

const processHarness = vi.hoisted(() => ({
	instances: [] as Array<{
		sessionFile?: string;
		startCalls: number;
		stopCalls: number;
		state: ProcessState;
		emitEvent: (event: unknown) => void;
		emitExtension: (request: unknown) => void;
	}>,
	promptResolvers: new Map<string, () => void>(),
	promptCalls: [] as Array<{ text: string; images?: unknown[] }>,
	requestCalls: [] as Array<Record<string, unknown>>,
	failNextCommand: false,
	failNextPrompt: false,
}));

vi.mock("electron", () => ({
	dialog: { showOpenDialog: vi.fn() },
	shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("../src/main/rpc-process", () => ({
	RpcProcess: class {
		readonly options: {
			onState: (state: ProcessState, error?: string) => void;
			onEvent: (event: unknown) => void;
			onExtension: (request: unknown) => void;
		};
		sessionFile?: string;
		startCalls = 0;
		stopCalls = 0;
		state: ProcessState = "stopped";
		client:
			| {
					request: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
					prompt: (text: string) => Promise<string>;
					onEvent: (listener: (event: unknown) => void) => () => void;
					sendExtensionResponse: () => void;
			  }
			| undefined;

		constructor(options: {
			onState: (state: ProcessState, error?: string) => void;
			onEvent: (event: unknown) => void;
			onExtension: (request: unknown) => void;
		}) {
			this.options = options;
			processHarness.instances.push(this);
		}

		emitExtension(request: unknown): void {
			this.options.onExtension(request);
		}

		emitEvent(event: unknown): void {
			this.options.onEvent(event);
		}

		async start(sessionFile?: string) {
			this.startCalls++;
			this.sessionFile = sessionFile;
			this.state = "starting";
			this.options.onState("starting");
			const eventListeners = new Set<(event: unknown) => void>();
			this.client = {
				request: async request => {
					processHarness.requestCalls.push({ ...request });
					if (processHarness.failNextCommand) {
						processHarness.failNextCommand = false;
						return { success: false, command: request.type, error: "command failed" };
					}
					switch (request.type) {
						case "get_state":
							return {
								success: true,
								command: "get_state",
								data: {
									sessionId: `omp-${this.sessionFile ?? "new"}`,
									sessionFile: this.sessionFile ?? "new-session.jsonl",
									fastModeEnabled: false,
									steeringMode: "all",
									followUpMode: "all",
									interruptMode: "immediate",
									autoCompactionEnabled: true,
									autoRetryEnabled: true,
									tokensPerSecond: null,
									queuedMessageCount: 0,
									todoPhases: [],
								},
							};
						case "get_messages_page":
							return { success: true, command: "get_messages_page", data: { messages: [] } };
						case "get_settings":
							return {
								success: true,
								command: "get_settings",
								data: {
									settings: [
										{
											path: "read.defaultLimit",
											tab: "files",
											label: "Read limit",
											description: "Maximum lines",
											control: "select",
											value: 64,
											options: [{ value: 64, label: "64" }],
											apply: "next-session",
										},
										{
											path: "bash.enabled",
											tab: "shell",
											label: "Bash",
											description: "Enable Bash",
											control: "toggle",
											value: true,
											apply: "next-session",
										},
										{
											path: "auth.apiKey",
											tab: "providers",
											label: "API key",
											description: "Secret",
											control: "toggle",
											value: false,
											apply: "immediate",
										},
										{
											path: "memory.backend",
											tab: "memory",
											label: "Memory",
											description: "Backend",
											control: "toggle",
											value: false,
											apply: "immediate",
										},
										{
											path: "files.empty",
											tab: "files",
											label: "Empty",
											description: "Invalid select",
											control: "select",
											value: "none",
											options: [],
											apply: "next-session",
										},
									],
								},
							};
						case "get_subagents":
							return { success: true, command: "get_subagents", data: { subagents: [] } };
						default:
							return { success: true, command: request.type, data: {} };
					}
				},
				prompt: (text, images) => {
					processHarness.promptCalls.push({ text, images });
					if (processHarness.failNextPrompt) {
						processHarness.failNextPrompt = false;
						return Promise.reject(new Error("prompt failed"));
					}
					if (text === "hold") {
						const pending = Promise.withResolvers<string>();
						processHarness.promptResolvers.set(this.sessionFile ?? "", () => pending.resolve("gradivus-test"));
						return pending.promise;
					}
					queueMicrotask(() => {
						for (const listener of eventListeners) {
							listener({
								type: "message_end",
								message: {
									role: "assistant",
									content: "Analysis for `button.submit`\n\nExplain element",
								},
							});
							listener({ type: "prompt_result", id: "gradivus-test", agentInvoked: true });
						}
					});
					return Promise.resolve("gradivus-test");
				},
				onEvent: listener => {
					eventListeners.add(listener);
					return () => eventListeners.delete(listener);
				},
				sendExtensionResponse: () => {},
			};
			this.state = "ready";
			this.options.onState("ready");
			return this.client;
		}

		async sample() {
			return { pid: 100 + processHarness.instances.indexOf(this), residentMemoryBytes: 1024 };
		}

		async stop() {
			this.stopCalls++;
			this.state = "stopping";
			this.options.onState("stopping");
			this.client = undefined;
			this.state = "stopped";
			this.options.onState("stopped");
		}
	},
}));

import { DesktopHost } from "../src/main/desktop-host";

const tempDirectories: string[] = [];
const hosts: DesktopHost[] = [];

afterEach(async () => {
	for (const resolve of processHarness.promptResolvers.values()) resolve();
	processHarness.promptResolvers.clear();
	await Promise.all(hosts.splice(0).map(host => host.close()));
	await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
	processHarness.instances.length = 0;
	processHarness.promptCalls.length = 0;
	processHarness.requestCalls.length = 0;
	processHarness.failNextCommand = false;
	processHarness.failNextPrompt = false;
	vi.clearAllMocks();
});

function sessionRecord(id: string): SessionRecordV1 {
	return {
		id,
		kind: "code",
		cwd: `/workspace/${id}`,
		ompSessionId: `omp-${id}`,
		sessionFile: `${id}.jsonl`,
		title: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		lastOpenedAt: "2026-01-01T00:00:00.000Z",
	};
}

async function createHost(ids: string[]): Promise<DesktopHost> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-desktop-host-"));
	tempDirectories.push(directory);
	await writeFile(
		path.join(directory, "sessions-v1.json"),
		`${JSON.stringify({
			version: 1,
			sessions: ids.map(sessionRecord),
			activeByKind: { work: null, code: null },
		})}\n`,
		"utf8",
	);
	const host = new DesktopHost(directory);
	hosts.push(host);
	await host.load();
	return host;
}

it("transports files and shell agent settings while filtering unsupported categories", async () => {
	const host = await createHost(["one"]);
	const settings = await host.getAgentSettings("one");

	expect(settings.map(setting => setting.path)).toEqual(["read.defaultLimit", "bash.enabled"]);
	expect(settings[0]).toMatchObject({
		tab: "files",
		value: 64,
		options: [{ value: 64, label: "64" }],
	});
	expect(settings[1]).toMatchObject({
		tab: "shell",
		value: true,
	});
});

describe("DesktopHost runtime supervision", () => {
	it("registers restored sessions without starting their processes", async () => {
		await createHost(["one", "two"]);

		expect(processHarness.instances).toHaveLength(2);
		expect(processHarness.instances.map(instance => instance.startCalls)).toEqual([0, 0]);
		expect(processHarness.instances.map(instance => instance.state)).toEqual(["stopped", "stopped"]);
	});

	it("emits state-only runtime reports and includes the report in snapshots", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);

		const snapshot = await host.openSession("one");
		const events = send.mock.calls
			.filter(([channel]) => channel === "gradivus:event")
			.map(([, event]) => event as GradivusEvent);
		expect(processHarness.instances[0]?.sessionFile).toBe("one.jsonl");
		const stateOnly = events.find(event => event.type === "session" && event.runtime?.phase === "resident");

		expect(snapshot.runtime).toMatchObject({ id: "one", phase: "resident", processState: "ready" });
		expect(stateOnly).toMatchObject({
			sessionId: "one",
			type: "session",
			state: "ready",
			runtime: { id: "one", phase: "resident", processState: "ready" },
		});
		expect(stateOnly).not.toHaveProperty("record");
	});

	it("replays a backgrounded session's outstanding extension through snapshots until answered", async () => {
		const host = await createHost(["one", "two"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);

		processHarness.instances[0]?.emitExtension({
			type: "extension_ui_request",
			id: "ext-select-1",
			method: "select",
			title: "Pick a lane",
			message: "Choose one",
			options: ["alpha", "beta"],
		});

		const events = send.mock.calls
			.filter(([channel]) => channel === "gradivus:event")
			.map(([, event]) => event as GradivusEvent);
		expect(events.at(-1)).toMatchObject({
			sessionId: "one",
			type: "extension",
			extension: { id: "ext-select-1", method: "select" },
		});

		const replayed = await host.openSession("one");
		expect(replayed.pendingExtension).toMatchObject({
			id: "ext-select-1",
			method: "select",
			title: "Pick a lane",
			options: ["alpha", "beta"],
		});
		const other = await host.openSession("two");
		expect(other.pendingExtension).toBeUndefined();

		await expect(
			host.extensionResponse("one", { id: "ext-select-1", method: "confirm", value: "alpha" }),
		).rejects.toThrow("extension response method mismatch");
		await host.extensionResponse("one", { id: "ext-select-1", value: "alpha" });
		const cleared = await host.openSession("one");
		expect(cleared.pendingExtension).toBeUndefined();
	});

	it("projects an early prompt_result push with request correlation", async () => {
		const host = await createHost(["one"]);
		const send = vi.fn();
		host.setWindow({ webContents: { send } } as never);
		await host.openSession("one");

		await expect(host.prompt("one", composition({ type: "text", text: "recover provider" }))).resolves.toBe(
			"gradivus-test",
		);
		processHarness.instances[0]?.emitEvent({
			type: "prompt_result",
			id: "gradivus-test",
			agentInvoked: false,
			error: { message: "account locked", code: "ACCOUNT_UNAVAILABLE" },
		});

		const events = send.mock.calls
			.filter(([channel]) => channel === "gradivus:event")
			.map(([, event]) => event as GradivusEvent);
		expect(events.at(-1)).toEqual({
			sessionId: "one",
			type: "prompt_result",
			requestId: "gradivus-test",
			agentInvoked: false,
			error: { message: "account locked", code: "ACCOUNT_UNAVAILABLE" },
		});
	});
	it("resolves one staged batch for prompt, steering, and queued follow-up", async () => {
		const host = await createHost(["one"]);
		const [file, image] = await host.stagePromptAttachments("one", [
			{ name: "notes.md", data: new TextEncoder().encode("host notes") },
			{
				name: "screen.dat",
				data: Uint8Array.from(
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
						"base64",
					),
				),
			},
		]);
		await host.openSession("one");
		const orderedComposition = composition(
			{ type: "text", text: "summarize " },
			{ type: "attachment", id: image!.id },
			{ type: "text", text: " then " },
			{ type: "attachment", id: file!.id },
		);
		await host.prompt("one", orderedComposition);
		expect(processHarness.promptCalls.at(-1)).toMatchObject({
			text: expect.stringContaining('File "notes.md": @"'),
			images: [{ type: "image", mimeType: "image/png" }],
		});
		const sentText = processHarness.promptCalls.at(-1)?.text ?? "";
		expect(sentText.indexOf(image!.reference)).toBeLessThan(sentText.indexOf(" then "));
		expect(sentText.indexOf(" then ")).toBeLessThan(sentText.indexOf(file!.reference));
		await host.steer("one", orderedComposition);
		await host.queueFollowUp("one", orderedComposition);
		expect(processHarness.requestCalls.filter(request => request.type === "steer")).toHaveLength(1);
		expect(processHarness.requestCalls.filter(request => request.type === "follow_up")).toHaveLength(1);
		expect(processHarness.requestCalls.at(-1)).toMatchObject({
			type: "follow_up",
			message: expect.stringContaining('File "notes.md": @"'),
			images: [{ type: "image", mimeType: "image/png" }],
		});
	});

	it("rejects duplicate and cross-session attachment IDs without consuming the staged attachment", async () => {
		const host = await createHost(["one", "two"]);
		const [own] = await host.stagePromptAttachments("one", [
			{ name: "own.txt", data: new TextEncoder().encode("own") },
		]);
		const [foreign] = await host.stagePromptAttachments("two", [
			{ name: "foreign.txt", data: new TextEncoder().encode("foreign") },
		]);
		await host.openSession("one");

		await expect(host.prompt("one", composition({ type: "attachment", id: foreign!.id }))).rejects.toThrow(
			"unknown prompt attachment",
		);
		await expect(
			host.prompt("one", composition({ type: "attachment", id: own!.id }, { type: "attachment", id: own!.id })),
		).rejects.toThrow("duplicate prompt attachment ID");
		await expect(host.prompt("one", composition({ type: "attachment", id: own!.id }))).resolves.toBe("gradivus-test");
	});
	it("keeps staged IDs available after dispatch failure and removes them on host close", async () => {
		const host = await createHost(["one"]);
		const [file] = await host.stagePromptAttachments("one", [{ name: "retry.txt", data: new Uint8Array([1, 2, 3]) }]);
		await host.openSession("one");
		processHarness.failNextPrompt = true;
		const retryComposition = composition({ type: "text", text: "retry " }, { type: "attachment", id: file!.id });
		await expect(host.prompt("one", retryComposition)).rejects.toThrow("prompt failed");
		await host.prompt("one", retryComposition);
		const stagedPath = processHarness.promptCalls.at(-1)?.text.match(/@"([^"]+)"/)?.[1];
		expect(stagedPath).toBeDefined();
		await host.close();
		await expect(stat(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("holds admission for each complete client command", async () => {
		const host = await createHost(["one", "two", "three", "four"]);
		const hold = composition({ type: "text", text: "hold" });
		const held = [host.prompt("one", hold), host.prompt("two", hold), host.prompt("three", hold)];
		await vi.waitFor(() => expect(processHarness.promptResolvers.size).toBe(3));

		const fourth = host.prompt("four", composition({ type: "text", text: "quick" }));
		await Promise.resolve();
		expect(processHarness.instances[3]?.startCalls).toBe(0);
		expect(processHarness.instances.slice(0, 3).map(instance => instance.stopCalls)).toEqual([0, 0, 0]);

		processHarness.promptResolvers.get("one.jsonl")?.();
		await held[0];
		await fourth;
		expect(processHarness.instances[3]?.startCalls).toBe(1);
		expect(processHarness.instances[0]?.stopCalls).toBe(1);

		processHarness.promptResolvers.get("two.jsonl")?.();
		processHarness.promptResolvers.get("three.jsonl")?.();
		await Promise.all(held.slice(1));
	});

	it("delivers a selected element prompt with its JPEG screenshot as PromptImageContent", async () => {
		const host = await createHost(["one"]);
		await host.openSession("one");
		const jpegBase64 = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
			0x00, 0xff, 0xd9,
		]).toString("base64");
		await host.deliverElementPrompt("Inspect this button", "one", {
			selector: "#btn",
			captureMode: "screenshot",
			screenshot: { base64: jpegBase64, mimeType: "image/jpeg" },
		});
		expect(processHarness.instances[0]?.startCalls).toBe(1);
		expect(processHarness.promptCalls.at(-1)).toEqual({
			text: "Inspect this button",
			images: [{ type: "image", data: jpegBase64, mimeType: "image/jpeg" }],
		});
	});

	it("executes inline element prompt and forwards its JPEG screenshot", async () => {
		const host = await createHost(["one"]);
		await host.openSession("one");
		const jpegBase64 = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9,
		]).toString("base64");
		const response = await host.executeInlinePrompt("What does this button do?", "one", {
			selector: "button.submit",
			instruction: "Explain element",
			captureMode: "screenshot",
			screenshot: { base64: jpegBase64, mimeType: "image/jpeg" },
		});
		expect(response).toContain("Analysis for `button.submit`");
		expect(response).toContain("Explain element");
		expect(processHarness.promptCalls.at(-1)).toEqual({
			text: expect.stringContaining("What does this button do?"),
			images: [{ type: "image", data: jpegBase64, mimeType: "image/jpeg" }],
		});
	});
	it("resolves only active same-workspace agent sessions for selection", async () => {
		const host = await createHost(["session-a", "session-b"]);
		const now = Date.now();
		const document = {
			version: 1,
			revision: 1,
			activeWorkspaceId: "workspace-a",
			workspaces: [{ id: "workspace-a", name: "Workspace A", locationId: "location-a", generation: 1 }],
			locations: [
				{
					id: "location-a",
					name: "Local",
					address: { kind: "local", path: "/tmp/workspace-a" },
					lifecycle: { status: "active", generation: 1, updatedAt: now },
				},
			],
			tabs: [
				{
					id: "tab-browser",
					workspaceId: "workspace-a",
					locationId: "location-a",
					generation: 1,
					name: "Browser",
					paneKind: "browser",
					layout: "columns",
					ratio: 50,
					paneIds: ["pane-browser"],
					activePaneId: "pane-browser",
				},
			],
			panes: [{ id: "pane-browser", tabId: "tab-browser", generation: 1, kind: "browser", entityId: "browser" }],
			terminals: [],
			browsers: [
				{
					id: "browser",
					locationId: "location-a",
					paneId: "pane-browser",
					generation: 1,
					url: "https://omp.sh",
					status: "open",
				},
			],
			previews: [],
			agentProfiles: [{ id: "profile-a", name: "Agent Alpha", config: {}, capabilityIds: [] }],
			agents: [
				{ id: "agent-a", profileId: "profile-a", sessionId: "session-a", status: "running" },
				{ id: "agent-b", profileId: "profile-a", sessionId: "session-b", status: "running" },
			],
			capabilities: [],
			sessions: [
				{
					id: "session-a",
					locationId: "location-a",
					actorId: "agent-a",
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: now,
					lastSeenAt: now,
				},
				{
					id: "session-b",
					locationId: "location-a",
					actorId: "agent-b",
					kind: "agent",
					status: "active",
					capabilityIds: [],
					startedAt: now,
					lastSeenAt: now,
				},
			],
			sessionEvents: [],
			deliveryReceipts: [],
			services: [],
			worktrees: [],
			elementEdits: [],
			notifications: [],
			pendingCleanup: [],
			createdAt: now,
			updatedAt: now,
		} as unknown as WorkspaceDocumentV1;
		host.setWorkspaceAuthority({ kind: "user", id: "user-a" }, document);

		const resolved = host.resolveSelectionTarget("pane-browser", "agent-a", 1);
		expect(resolved).toMatchObject({
			scope: { agentId: "agent-a", sessionId: "session-a", workspaceId: "workspace-a" },
			target: { id: "agent-a", name: "Agent Alpha", swatch: getAgentSwatch("agent-a") },
		});

		host.setWorkspaceAuthority(
			{ kind: "user", id: "user-a" },
			{
				...document,
				agents: document.agents.map(agent => (agent.id === "agent-a" ? { ...agent, status: "stopped" } : agent)),
			},
		);
		expect(() => host.resolveSelectionTarget("pane-browser", "agent-a", 1)).toThrow(
			"No deliverable workspace agent is available for selection",
		);
	});
});

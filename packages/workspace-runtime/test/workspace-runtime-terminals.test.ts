import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildChildEnvironment,
	isReservedChildEnvName,
	type TerminalOutputChunk,
	WorkspaceClient,
	WorkspaceServer,
	WorkspaceSupervisor,
	WorkspaceTerminalManager,
	WorkspaceTerminalSession,
} from "../src";

// Parent-provided reserved variables must never reach terminal children (reserved prefix in src/env.ts).
process.env.GRADIVUS_PARENT_LEAK = "parent-provided";
afterAll(() => {
	delete process.env.GRADIVUS_PARENT_LEAK;
});

describe("WorkspaceTerminalSession & Manager", () => {
	let supervisor: WorkspaceSupervisor;

	beforeEach(() => {
		supervisor = new WorkspaceSupervisor();
	});

	afterEach(async () => {
		await supervisor.stopAll();
	});

	it("starts PTY session, streams output chunks with monotonic offsets, and tracks history", async () => {
		const chunks: TerminalOutputChunk[] = [];
		const chunkSignal = Promise.withResolvers<TerminalOutputChunk>();

		const session = new WorkspaceTerminalSession({
			id: "term-test-1",
			shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
			args: process.platform === "win32" ? ["/c", "echo test-pty-output"] : ["-c", "echo test-pty-output"],
			supervisor,
			onData: (_id, chunk) => {
				chunks.push(chunk);
				chunkSignal.resolve(chunk);
			},
		});

		const pid = await session.start();
		expect(pid).toBeGreaterThan(0);
		expect(session.status).toBe("running");

		const firstChunk = await chunkSignal.promise;
		expect(firstChunk.offset).toBe(0);
		expect(firstChunk.data.length).toBeGreaterThan(0);

		// History query with offset
		const allHistory = session.getHistory(0);
		expect(allHistory.length).toBeGreaterThan(0);

		await session.close();
		expect(session.status).toBe("exited");
	});

	it("supports resize and input writing via manager", async () => {
		const manager = new WorkspaceTerminalManager({ supervisor });
		const session = await manager.createSession({
			id: "term-mgr-1",
			shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
			args: process.platform === "win32" ? ["/c", "echo hello"] : ["-c", "echo hello"],
			columns: 100,
			rows: 30,
		});

		expect(session.columns).toBe(100);
		expect(session.rows).toBe(30);

		manager.resize("term-mgr-1", 120, 40);
		expect(session.columns).toBe(120);
		expect(session.rows).toBe(40);

		expect(() => manager.write("term-mgr-1", "echo hello\n")).not.toThrow();

		await manager.close("term-mgr-1");
		expect(manager.sessionCount).toBe(0);
	});
	it("defaults to /bin/zsh on macOS when shell is not specified and executes zsh", async () => {
		if (process.platform !== "darwin") return;
		const outputPromise = Promise.withResolvers<string>();
		const session = new WorkspaceTerminalSession({
			id: "term-default-shell",
			supervisor,
			onData: (_id, chunk) => {
				if (chunk.data.includes("shell-id:zsh")) outputPromise.resolve(chunk.data);
			},
		});
		expect(session.shell).toBe("/bin/zsh");
		const pid = await session.start();
		expect(pid).toBeGreaterThan(0);
		expect(session.status).toBe("running");
		session.write("printf 'shell-id:%s\\n' \"$ZSH_NAME\"\n");
		const output = await Promise.race([outputPromise.promise, Bun.sleep(4000).then(() => "")]);
		expect(output).toContain("shell-id:zsh");
		await session.close();
	});

	it("allows explicit shell override on all platforms", async () => {
		const explicitShell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
		const session = new WorkspaceTerminalSession({
			id: "term-explicit-shell",
			shell: explicitShell,
			supervisor,
		});
		expect(session.shell).toBe(explicitShell);
		const pid = await session.start();
		expect(pid).toBeGreaterThan(0);
		await session.close();
	});
});

describe("WorkspaceServer terminal authority", () => {
	let root: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;

	beforeEach(async () => {
		root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "omp-terminal-server-")));
		server = new WorkspaceServer({ runtimeRoot: root });
		await server.start();
		client = new WorkspaceClient({ runtimeRoot: root });
		await client.connect();
	});

	afterEach(async () => {
		await client?.close().catch(() => {});
		if (server?.isListening) await server.stop();
		await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
	});

	it("owns the PTY, replays output by offset, and accepts transient input", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-workspace",
			workspaceId: "ws-terminal",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Terminal Workspace",
				locationId: "loc-terminal",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		expect(workspace.status).toBe("accepted");

		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-open",
			workspaceId: "ws-terminal",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-authoritative",
				paneId: "pane-authoritative",
				tabId: "tab-authoritative",
				locationId: "loc-terminal",
				label: "Terminal",
				columns: 80,
				rows: 24,
			},
		});
		expect(opened.status).toBe("accepted");

		const isWindows = process.platform === "win32";
		let terminalOutput = "";
		const marker = Promise.withResolvers<string>();
		const removeOutput = client.onTerminalOutput("term-authoritative", frame => {
			terminalOutput += frame.data;
			// ConPTY soft-wraps output at the terminal width, which can split the
			// marker across lines; unwrap before matching.
			if (terminalOutput.replace(/\r?\n/g, "").includes("runtime-terminal-marker")) marker.resolve(terminalOutput);
		});
		const snapshot = await client.subscribeTerminal("term-authoritative", 0);
		expect(snapshot.status).toBe("running");
		await client.sendTerminalInput(
			"term-authoritative",
			isWindows ? "echo runtime-terminal-marker\r\n" : "printf 'runtime-terminal-marker\\n'\r\n",
		);
		const output = await Promise.race([marker.promise, Bun.sleep(5000).then(() => "")]);
		removeOutput();
		expect(output.replace(/\r?\n/g, "")).toContain("runtime-terminal-marker");

		const current = await client.getDocument();
		const closed = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-close",
			workspaceId: "ws-terminal",
			expectedRevision: current.revision,
			issuedAt: Date.now(),
			type: "terminal.close",
			payload: { id: "term-authoritative" },
		});
		expect(closed.status).toBe("accepted");
		expect(closed.document.terminals.some(item => item.id === "term-authoritative")).toBe(false);
	});
	it("opens detached terminals without creating tabs or panes", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-detached-workspace",
			workspaceId: "ws-detached",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Detached Workspace",
				locationId: "loc-detached",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-detached-open",
			workspaceId: "ws-detached",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-detached",
				detached: true,
				locationId: "loc-detached",
				label: "Chat shell",
				columns: 80,
				rows: 24,
			},
		});
		expect(opened.status).toBe("accepted");
		expect(opened.document.terminals.find(item => item.id === "term-detached")?.paneId).toBeUndefined();
		expect(opened.document.tabs).toHaveLength(0);
		expect(opened.document.panes).toHaveLength(0);
	});

	it("accepts terminal.open with custom shell and args and launches process with them", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-workspace-custom-shell",
			workspaceId: "ws-custom-shell",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Custom Shell Workspace",
				locationId: "loc-custom-shell",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		expect(workspace.status).toBe("accepted");

		const customShell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
		const customArgs =
			process.platform === "win32" ? ["/c", "echo custom-shell-active"] : ["-c", "echo custom-shell-active"];

		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-open-custom",
			workspaceId: "ws-custom-shell",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-custom-shell",
				paneId: "pane-custom-shell",
				tabId: "tab-custom-shell",
				locationId: "loc-custom-shell",
				label: "Custom Terminal",
				shell: customShell,
				args: customArgs,
				columns: 80,
				rows: 24,
			},
		});
		expect(opened.status).toBe("accepted");
		expect(opened.document.terminals.some(item => item.id === "term-custom-shell")).toBe(true);

		const marker = Promise.withResolvers<string>();
		const removeOutput = client.onTerminalOutput("term-custom-shell", frame => {
			if (frame.data.includes("custom-shell-active")) marker.resolve(frame.data);
		});
		const snapshot = await client.subscribeTerminal("term-custom-shell", 0);
		expect(snapshot.status).toBe("running");
		const output = await Promise.race([marker.promise, Bun.sleep(5000).then(() => "")]);
		removeOutput();
		expect(output).toContain("custom-shell-active");

		const current = await client.getDocument();
		await client.executeCommand({
			version: 1,
			commandId: "cmd-terminal-close-custom",
			workspaceId: "ws-custom-shell",
			expectedRevision: current.revision,
			issuedAt: Date.now(),
			type: "terminal.close",
			payload: { id: "term-custom-shell" },
		});
	});

	it("stamps spawned terminals with the Gradivus capability family", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-env-family-workspace",
			workspaceId: "ws-env-family",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "Env Family Workspace",
				locationId: "loc-env-family",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		expect(workspace.status).toBe("accepted");
		const profile = await client.executeCommand({
			version: 1,
			commandId: "cmd-env-family-profile",
			workspaceId: "ws-env-family",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "profile.create",
			payload: {
				id: "profile-env-family",
				name: "Env Family Profile",
				config: {},
				capabilityIds: [],
			},
		});
		expect(profile.status).toBe("accepted");

		const isWindows = process.platform === "win32";
		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-env-family-open",
			workspaceId: "ws-env-family",
			expectedRevision: profile.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-env-family",
				paneId: "pane-env-family",
				tabId: "tab-env-family",
				locationId: "loc-env-family",
				profileId: "profile-env-family",
				label: "Env Family Terminal",
				columns: 80,
				rows: 24,
				...(isWindows
					? {
							shell: "cmd.exe",
							args: [
								"/c",
								"if defined GRADIVUS_PARENT_LEAK (echo FAMILY[%GRADIVUS_TERMINAL%][%GRADIVUS_TERMINAL_ID%][%GRADIVUS_PANE_ID%][%GRADIVUS_WORKSPACE_ID%][%GRADIVUS_PROFILE_ID%][leaked]) else (echo FAMILY[%GRADIVUS_TERMINAL%][%GRADIVUS_TERMINAL_ID%][%GRADIVUS_PANE_ID%][%GRADIVUS_WORKSPACE_ID%][%GRADIVUS_PROFILE_ID%][unset])",
							],
						}
					: {
							shell: "/bin/sh",
							args: [
								"-c",
								'printf \'FAMILY[%s][%s][%s][%s][%s][%s]\\n\' "$GRADIVUS_TERMINAL" "$GRADIVUS_TERMINAL_ID" "$GRADIVUS_PANE_ID" "$GRADIVUS_WORKSPACE_ID" "$GRADIVUS_PROFILE_ID" "${GRADIVUS_PARENT_LEAK:-unset}"',
							],
						}),
			},
		});
		expect(opened.status).toBe("accepted");

		const expectedFamily = "FAMILY[1][term-env-family][pane-env-family][ws-env-family][profile-env-family][unset]";
		let familyOutput = "";
		const marker = Promise.withResolvers<void>();
		const removeOutput = client.onTerminalOutput("term-env-family", frame => {
			familyOutput += frame.data;
			// Unwrap ConPTY soft-wrapped lines before matching.
			if (familyOutput.replace(/\r?\n/g, "").includes(expectedFamily)) marker.resolve();
		});
		await client.subscribeTerminal("term-env-family", 0);
		await marker.promise;
		removeOutput();
		expect(familyOutput.replace(/\r?\n/g, "")).toContain(expectedFamily);
		expect(familyOutput).not.toContain("parent-provided");

		const current = await client.getDocument();
		await client.executeCommand({
			version: 1,
			commandId: "cmd-env-family-close",
			workspaceId: "ws-env-family",
			expectedRevision: current.revision,
			issuedAt: Date.now(),
			type: "terminal.close",
			payload: { id: "term-env-family" },
		});
	});

	it("omits GRADIVUS_PROFILE_ID for terminals opened without a profile", async () => {
		const workspace = await client.executeCommand({
			version: 1,
			commandId: "cmd-no-profile-workspace",
			workspaceId: "ws-no-profile",
			expectedRevision: 0,
			issuedAt: Date.now(),
			type: "workspace.create",
			payload: {
				name: "No Profile Workspace",
				locationId: "loc-no-profile",
				locationName: "Local",
				address: { kind: "local", path: root },
			},
		});
		expect(workspace.status).toBe("accepted");

		const isWindows = process.platform === "win32";
		const opened = await client.executeCommand({
			version: 1,
			commandId: "cmd-no-profile-open",
			workspaceId: "ws-no-profile",
			expectedRevision: workspace.document.revision,
			issuedAt: Date.now(),
			type: "terminal.open",
			payload: {
				id: "term-no-profile",
				locationId: "loc-no-profile",
				label: "No Profile Terminal",
				columns: 80,
				rows: 24,
				...(isWindows
					? {
							shell: "cmd.exe",
							args: ["/c", "if defined GRADIVUS_PROFILE_ID (echo PROFILE^[set^]) else (echo PROFILE^[unset^])"],
						}
					: {
							shell: "/bin/sh",
							args: ["-c", "printf 'PROFILE[%s]\\n' \"${GRADIVUS_PROFILE_ID-unset}\""],
						}),
			},
		});
		expect(opened.status).toBe("accepted");

		let profileOutput = "";
		const marker = Promise.withResolvers<void>();
		const removeOutput = client.onTerminalOutput("term-no-profile", frame => {
			profileOutput += frame.data;
			if (profileOutput.includes("PROFILE[unset]")) marker.resolve();
		});
		await client.subscribeTerminal("term-no-profile", 0);
		await marker.promise;
		removeOutput();
		expect(profileOutput).not.toContain("profile-env-family");
		expect(profileOutput).toContain("PROFILE[unset]");

		const current = await client.getDocument();
		await client.executeCommand({
			version: 1,
			commandId: "cmd-no-profile-close",
			workspaceId: "ws-no-profile",
			expectedRevision: current.revision,
			issuedAt: Date.now(),
			type: "terminal.close",
			payload: { id: "term-no-profile" },
		});
	});
});

describe("child environment policy", () => {
	it("rejects reserved GRADIVUS_* names in explicit bindings but keeps approved scoped descriptors", () => {
		expect(isReservedChildEnvName("GRADIVUS_PARENT_LEAK")).toBe(true);

		const env = buildChildEnvironment({
			explicitBindings: {
				TERM: "xterm-256color",
				GRADIVUS_PARENT_LEAK: "parent-provided",
			},
		});
		expect(env.TERM).toBe("xterm-256color");
		expect(env.GRADIVUS_PARENT_LEAK).toBeUndefined();

		const scoped = buildChildEnvironment({ scopedDescriptor: { GRADIVUS_TERMINAL: "1" } });
		expect(scoped.GRADIVUS_TERMINAL).toBe("1");
	});
});

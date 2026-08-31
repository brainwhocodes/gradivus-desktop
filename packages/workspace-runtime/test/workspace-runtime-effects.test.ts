import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceCommandV1 } from "@oh-my-pi/pi-wire";
import { WorkspaceClient, WorkspaceServer } from "../src";

function command(
	workspaceId: string,
	commandId: string,
	expectedRevision: number,
	type: WorkspaceCommandV1["type"],
	payload: Record<string, unknown>,
) {
	return {
		version: 1 as const,
		commandId,
		workspaceId,
		expectedRevision,
		issuedAt: Date.now(),
		type,
		payload,
	};
}

describe("WorkspaceServer effect ownership and ordering", () => {
	let root: string;
	let server: WorkspaceServer;
	let client: WorkspaceClient;

	beforeEach(async () => {
		root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "omp-effects-server-")));
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

	async function createWorkspace(id = "ws-effects") {
		return client.executeCommand(
			command(id, `create-${id}`, 0, "workspace.create", {
				name: "Effects Workspace",
				locationId: `loc-${id}`,
				locationName: "Local",
				address: { kind: "local", path: root },
			}),
		);
	}

	it("rejects unsupported effects before commit and preserves revision and state", async () => {
		const workspace = await createWorkspace();
		expect(workspace.status).toBe("accepted");
		const declared = await client.executeCommand(
			command("ws-effects", "declare-service", workspace.document.revision, "service.declare", {
				id: "svc-effects",
				locationId: "loc-ws-effects",
				name: "service",
				command: "sleep 1",
			}),
		);
		expect(declared.status).toBe("accepted");
		const before = await client.getDocument();
		const started = await client.executeCommand(
			command("ws-effects", "start-service", before.revision, "service.start", { id: "svc-effects" }),
		);
		expect(started.status).toBe("rejected");
		expect(started.error?.code).toBe("unsupported_command");
		expect(started.document.revision).toBe(before.revision);
		expect(started.document.services.find(item => item.id === "svc-effects")?.status).toBe("declared");
		expect((await client.getDocument()).revision).toBe(before.revision);
	});

	it("keeps browser document reconciliation and agent adapter records effect-free", async () => {
		const workspace = await createWorkspace("ws-records");
		expect(workspace.status).toBe("accepted");
		const browser = await client.executeCommand(
			command("ws-records", "open-browser", workspace.document.revision, "browser.open", {
				id: "browser-record",
				locationId: "loc-ws-records",
				url: "https://example.com",
			}),
		);
		expect(browser.status).toBe("accepted");
		expect(browser.effects).toHaveLength(0);
		const navigated = await client.executeCommand(
			command("ws-records", "navigate-browser", browser.document.revision, "browser.navigate", {
				id: "browser-record",
				url: "https://example.com/next",
			}),
		);
		expect(navigated.status).toBe("accepted");
		expect(navigated.effects).toHaveLength(0);
	});

	it("serializes terminal open and input by terminal resource even when accepted concurrently", async () => {
		const workspace = await createWorkspace("ws-ordering");
		expect(workspace.status).toBe("accepted");
		const open = command("ws-ordering", "open-ordered-terminal", workspace.document.revision, "terminal.open", {
			id: "term-ordered",
			locationId: "loc-ws-ordering",
			columns: 80,
			rows: 24,
		});
		const input = command(
			"ws-ordering",
			"input-ordered-terminal",
			workspace.document.revision + 1,
			"terminal.input",
			{
				id: "term-ordered",
				data:
					process.platform === "win32" ? "echo ordered-effect-marker\r\n" : "printf 'ordered-effect-marker\\n'\\n",
			},
		);
		const otherClient = new WorkspaceClient({ runtimeRoot: root });
		await otherClient.connect();
		const committed = Promise.withResolvers<void>();
		const removeDocumentListener = client.onDocument(document => {
			if (document.revision === workspace.document.revision + 1) committed.resolve();
		});
		const openPromise = client.executeCommand(open);
		await committed.promise;
		removeDocumentListener();
		const inputPromise = otherClient.executeCommand(input);
		const [opened, written] = await Promise.all([openPromise, inputPromise]);
		await otherClient.close();
		expect(opened.status).toBe("accepted");
		expect(written.status).toBe("accepted");
		let terminalOutput = "";
		const marker = Promise.withResolvers<string>();
		const removeOutput = client.onTerminalOutput("term-ordered", frame => {
			terminalOutput += frame.data;
			// ConPTY soft-wraps output at the terminal width; unwrap before matching.
			if (terminalOutput.replace(/\r?\n/g, "").includes("ordered-effect-marker")) marker.resolve(terminalOutput);
		});
		await client.subscribeTerminal("term-ordered", 0);
		const output = await Promise.race([marker.promise, Bun.sleep(5000).then(() => "")]);
		removeOutput();
		expect(output.replace(/\r?\n/g, "")).toContain("ordered-effect-marker");
	});
});

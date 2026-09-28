import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedProjection } from "../src/main/hosted-projection";
import type { BootstrapSnapshot, SessionRecordV1, SessionSnapshot } from "../src/shared/contracts";

const temporaryRoots: string[] = [];

async function temporaryWorkspace(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gradivus-hosted-projection-"));
	temporaryRoots.push(root);
	return root;
}

function assertNoForbiddenKeys(value: unknown): void {
	const forbidden = new Set([
		"cwd",
		"sessionFile",
		"ompSessionId",
		"pid",
		"residentMemoryBytes",
		"browserInventory",
		"pendingExtension",
		"args",
		"result",
	]);
	const visit = (candidate: unknown): void => {
		if (Array.isArray(candidate)) {
			for (const entry of candidate) visit(entry);
			return;
		}
		if (typeof candidate !== "object" || candidate === null) return;
		for (const [key, entry] of Object.entries(candidate)) {
			expect(forbidden.has(key), `forbidden hosted key ${key}`).toBe(false);
			visit(entry);
		}
	};
	visit(value);
}

function sessionRecord(cwd: string, overrides: Partial<SessionRecordV1> = {}): SessionRecordV1 {
	return {
		id: "session-1",
		kind: "code",
		surface: "chat",
		cwd,
		ompSessionId: "omp-secret-session-id",
		sessionFile: path.join(cwd, ".omp", "secret-session.jsonl"),
		title: "Hosted projection",
		createdAt: "2026-08-30T00:00:00.000Z",
		lastOpenedAt: "2026-08-30T00:00:01.000Z",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("HostedProjection", () => {
	it("omits browser-selection sessions and replaces canonical workspace roots with launch-scoped ids", async () => {
		const cwd = await temporaryWorkspace();
		const visible = sessionRecord(cwd);
		const hidden = sessionRecord(cwd, { id: "selection-session", surface: "browser-selection" });
		const bootstrap: BootstrapSnapshot = {
			registry: {
				version: 1,
				sessions: [visible, hidden],
				activeByKind: { work: null, code: visible.id },
			},
		};
		const firstLaunch = await HostedProjection.create();
		const secondLaunch = await HostedProjection.create();

		const projected = await firstLaunch.projectHostedBootstrap(bootstrap);
		const nextLaunchWorkspace = await secondLaunch.projectHostedWorkspace(cwd);

		expect(projected.sessions.map(record => record.id)).toEqual([visible.id]);
		expect(projected.activeSessionId).toBe(visible.id);
		expect(projected.workspaces).toHaveLength(1);
		expect(projected.workspaces[0]?.id).not.toBe(cwd);
		expect(projected.workspaces[0]?.id).not.toBe(nextLaunchWorkspace.id);
		expect(firstLaunch.workspaceRoot(projected.workspaces[0]!.id)).toBe(await fs.realpath(cwd));
		assertNoForbiddenKeys(projected);
	});

	it("projects transcript and runtime data without privileged paths, process details, or extension payloads", async () => {
		const cwd = await temporaryWorkspace();
		const record = sessionRecord(cwd);
		const inRootFile = path.join(cwd, "src", "safe.ts");
		const outOfRootFile = path.join(os.tmpdir(), "outside-secret.ts");
		const snapshot: SessionSnapshot = {
			record,
			state: "ready",
			timeline: [
				{
					id: "timeline-1",
					kind: "tool",
					text: `Read ${inRootFile} from ${record.sessionFile} for ${record.ompSessionId}`,
					args: { cwd, sessionFile: record.sessionFile },
					result: { path: outOfRootFile },
					files: [
						{ path: inRootFile, operation: "write", disposition: "edited" },
						{ path: outOfRootFile, operation: "write", disposition: "edited" },
					],
					toolActivity: {
						operation: "edit",
						paths: [inRootFile, outOfRootFile],
						diff: [`--- ${inRootFile}`, `+++ ${outOfRootFile}`],
					},
				},
			],
			subagents: [],
			todoState: { phases: [], revision: 0 },
			pendingExtension: {
				id: "extension-secret",
				method: "input",
				title: "Credential",
				message: "Enter secret",
				prefill: "never expose",
			},
			runtime: {
				id: record.id,
				phase: "resident",
				processState: "ready",
				healthy: true,
				pid: 4242,
				residentMemoryBytes: 4096,
				lastUsedAt: 1,
			},
			planReviewSupported: true,
		};
		const projection = await HostedProjection.create();

		const projected = await projection.projectHostedSession(snapshot);
		const serialized = JSON.stringify(projected);

		expect(projected.timeline[0]?.files).toEqual([
			{ path: "src/safe.ts", operation: "write", disposition: "edited" },
		]);
		expect(projected.timeline[0]?.toolActivity).toMatchObject({ operation: "edit", paths: ["src/safe.ts"] });
		expect(projected).not.toHaveProperty("extensionAttention");
		expect(serialized).not.toContain(cwd);
		expect(serialized).not.toContain(record.sessionFile);
		expect(serialized).not.toContain(record.ompSessionId);
		expect(serialized).not.toContain(outOfRootFile);
		expect(serialized).not.toContain("never expose");
		assertNoForbiddenKeys(projected);
	});

	it("reduces every extension event to an opaque Desktop attention action", async () => {
		const cwd = await temporaryWorkspace();
		const record = sessionRecord(cwd);
		const projection = await HostedProjection.create();
		const projected = await projection.projectHostedEvent(record, {
			sessionId: record.id,
			type: "extension",
			extension: {
				id: "extension-action-1",
				method: "editor",
				title: "Private title",
				message: "Private message",
				options: ["Private option"],
				prefill: "Private prefill",
				text: "Private text",
				url: "https://private.example",
				instructions: "Private instructions",
				widgetLines: ["Private widget"],
				sensitive: false,
			},
		});

		expect(projected).toEqual({
			type: "extension_attention",
			sessionId: record.id,
			action: { actionId: "extension-action-1", kind: "extension_attention", state: "pending" },
		});
		expect(
			projection.projectHostedDesktopAction(
				{
					actionId: "extension-action-2",
					kind: "extension_attention",
					state: "failed",
					message: `Private ${cwd}/secret.txt`,
				},
				record.id,
			),
		).toEqual({
			type: "extension_attention",
			sessionId: record.id,
			action: { actionId: "extension-action-2", kind: "extension_attention", state: "failed" },
		});
	});
});

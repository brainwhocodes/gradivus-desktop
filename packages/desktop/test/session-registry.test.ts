import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertBoundedText, assertSessionName, resolveWorkspaceTarget, safeExternalUrl } from "../src/main/guards";
import { SessionRegistry } from "../src/main/session-registry";
import type { SessionRecordV1 } from "../src/shared/contracts";

const tempDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function record(id: string): SessionRecordV1 {
	const now = new Date().toISOString();
	return {
		id,
		kind: id.startsWith("work") ? "work" : "code",
		cwd: ".",
		ompSessionId: id,
		sessionFile: `${id}.jsonl`,
		title: null,
		createdAt: now,
		lastOpenedAt: now,
	};
}

describe("SessionRegistry", () => {
	it("preserves malformed JSON and starts empty with a recovery warning", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const filePath = path.join(directory, "sessions-v1.json");
		await writeFile(filePath, "{not json", "utf8");

		const registry = new SessionRegistry(directory);
		const value = await registry.load();

		expect(value.sessions).toHaveLength(0);
		expect(value.activeByKind).toEqual({ work: null, code: null });
		expect(registry.warning).toMatch(/preserved|unreadable/);
		const files = await readdir(directory);
		expect(files.some(file => file.startsWith("sessions-v1.corrupt-") && file.endsWith(".json"))).toBe(true);
	});

	it("serializes concurrent updates and leaves one complete JSON document", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();

		await Promise.all([registry.create(record("work-one")), registry.create(record("code-one"))]);

		const text = await readFile(path.join(directory, "sessions-v1.json"), "utf8");
		const saved = JSON.parse(text) as { sessions: SessionRecordV1[] };
		expect(saved.sessions.map(item => item.id).sort()).toEqual(["code-one", "work-one"]);
		expect(registry.value.sessions).toHaveLength(2);
	});
	it("rejects duplicate IDs before changing the registry or persisted active session", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();
		const original = record("work-one");
		await registry.create(original);
		const before = await readFile(path.join(directory, "sessions-v1.json"), "utf8");

		await expect(registry.create({ ...original, kind: "code" })).rejects.toThrow(/already exists/);

		expect(registry.value.sessions).toEqual([original]);
		expect(registry.value.activeByKind).toEqual({ work: "work-one", code: null });
		await expect(readFile(path.join(directory, "sessions-v1.json"), "utf8")).resolves.toBe(before);
	});

	it("repairs duplicate records and invalid active pointers, then persists the repaired registry", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const first = record("work-one");
		const duplicate = { ...record("work-one"), kind: "code" as const };
		const code = record("code-one");
		await writeFile(
			path.join(directory, "sessions-v1.json"),
			JSON.stringify({
				version: 1,
				sessions: [first, duplicate, code],
				activeByKind: { work: "work-one", code: "work-one" },
			}),
			"utf8",
		);

		const registry = new SessionRegistry(directory);
		const value = await registry.load();

		expect(value.sessions).toEqual([first, code]);
		expect(value.activeByKind).toEqual({ work: "work-one", code: null });
		expect(registry.warning).toMatch(/discarded 1 duplicate session record/);
		await expect(readFile(path.join(directory, "sessions-v1.json"), "utf8")).resolves.toBe(
			`${JSON.stringify(value, null, 2)}\n`,
		);
	});

	it("persists stale active-pointer repair without raising a duplicate warning", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const session = record("work-one");
		await writeFile(
			path.join(directory, "sessions-v1.json"),
			JSON.stringify({
				version: 1,
				sessions: [session],
				activeByKind: { work: "missing", code: null },
			}),
			"utf8",
		);

		const registry = new SessionRegistry(directory);
		const value = await registry.load();

		expect(value.activeByKind).toEqual({ work: null, code: null });
		expect(registry.warning).toBeUndefined();
		await expect(readFile(path.join(directory, "sessions-v1.json"), "utf8")).resolves.toBe(
			`${JSON.stringify(value, null, 2)}\n`,
		);
	});
	it("rejects missing and wrong-kind active IDs without changing the valid pointer", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();
		await registry.create(record("work-one"));
		const before = registry.value;
		const beforePersisted = await readFile(path.join(directory, "sessions-v1.json"), "utf8");

		await expect(registry.setActive("work", "missing")).rejects.toThrow(/does not exist or has the wrong kind/);
		await expect(registry.setActive("code", "work-one")).rejects.toThrow(/does not exist or has the wrong kind/);

		expect(registry.value).toEqual(before);
		await expect(readFile(path.join(directory, "sessions-v1.json"), "utf8")).resolves.toBe(beforePersisted);
	});
	it("removes a session, persists the removal, and leaves other active pointers intact", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();
		await registry.create(record("work-one"));
		await registry.create(record("code-one"));

		await registry.remove("code-one");

		expect(registry.value.sessions.map(item => item.id)).toEqual(["work-one"]);
		expect(registry.value.activeByKind).toEqual({ work: "work-one", code: null });
		const saved = JSON.parse(await readFile(path.join(directory, "sessions-v1.json"), "utf8")) as {
			sessions: SessionRecordV1[];
			activeByKind: { work: string | null; code: string | null };
		};
		expect(saved.sessions.map(item => item.id)).toEqual(["work-one"]);
		expect(saved.activeByKind).toEqual({ work: "work-one", code: null });
	});

	it("falls back to the most recent remaining session of the kind when the active one is removed", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();
		const older = { ...record("work-a"), lastOpenedAt: "2026-01-01T00:00:00.000Z" };
		const newer = { ...record("work-b"), lastOpenedAt: "2026-02-01T00:00:00.000Z" };
		await registry.create(older);
		await registry.create(newer);
		expect(registry.value.activeByKind.work).toBe("work-b");

		await registry.remove("work-b");

		expect(registry.value.sessions.map(item => item.id)).toEqual(["work-a"]);
		expect(registry.value.activeByKind).toEqual({ work: "work-a", code: null });
		const saved = JSON.parse(await readFile(path.join(directory, "sessions-v1.json"), "utf8")) as {
			activeByKind: { work: string | null };
		};
		expect(saved.activeByKind.work).toBe("work-a");
	});

	it("clears the active pointer when removing the last session of its kind", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();
		await registry.create(record("work-one"));

		await registry.remove("work-one");

		expect(registry.value.sessions).toHaveLength(0);
		expect(registry.value.activeByKind).toEqual({ work: null, code: null });
		const saved = JSON.parse(await readFile(path.join(directory, "sessions-v1.json"), "utf8")) as {
			sessions: unknown[];
			activeByKind: { work: string | null; code: string | null };
		};
		expect(saved.sessions).toHaveLength(0);
		expect(saved.activeByKind).toEqual({ work: null, code: null });
	});

	it("rejects removing unknown IDs without changing the registry or persisted file", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-registry-"));
		tempDirectories.push(directory);
		const registry = new SessionRegistry(directory);
		await registry.load();
		await registry.create(record("work-one"));
		const before = registry.value;
		const beforePersisted = await readFile(path.join(directory, "sessions-v1.json"), "utf8");

		await expect(registry.remove("missing")).rejects.toThrow(/Session not found/);

		expect(registry.value).toEqual(before);
		await expect(readFile(path.join(directory, "sessions-v1.json"), "utf8")).resolves.toBe(beforePersisted);
	});
});

describe("guards", () => {
	it("enforces UTF-8 and Unicode-name limits", () => {
		expect(() => assertBoundedText("x".repeat(512 * 1024 + 1), "prompt")).toThrow(/512 KiB/);
		expect(assertSessionName("    ")).toBe("");
		expect(() => assertSessionName("x".repeat(161))).toThrow(/160/);
	});

	it("allows only explicitly safe external URL schemes", () => {
		expect(safeExternalUrl("https://example.com/path").protocol).toBe("https:");
		expect(safeExternalUrl("http://127.0.0.1:4567/status").hostname).toBe("127.0.0.1");
		expect(() => safeExternalUrl("http://example.com")).toThrow();
		expect(() => safeExternalUrl("file:///secret.txt")).toThrow();
		expect(() => safeExternalUrl("javascript:alert(1)")).toThrow();
	});

	it("realpaths workspace targets and marks executable types reveal-only", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gradivus-target-"));
		tempDirectories.push(directory);
		const document = path.join(directory, "note.md");
		const script = path.join(directory, "run.sh");
		await writeFile(document, "note", "utf8");
		await writeFile(script, "echo no", "utf8");

		await expect(resolveWorkspaceTarget(directory, "note.md")).resolves.toMatchObject({
			target: await realpath(document),
			revealOnly: false,
		});
		await expect(resolveWorkspaceTarget(directory, path.join(directory, "missing.txt"))).rejects.toThrow();
		await expect(
			resolveWorkspaceTarget(directory, path.join(directory, "..", path.basename(directory), "note.md")),
		).resolves.toMatchObject({ revealOnly: false });
		await expect(resolveWorkspaceTarget(directory, script)).resolves.toMatchObject({ revealOnly: true });
	});
});

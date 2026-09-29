import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertBufferWithMarkit, convertFileWithMarkit } from "@oh-my-pi/pi-coding-agent/utils/markit";
import { pruneMarkitConversionCache } from "@oh-my-pi/pi-coding-agent/utils/markit-cache";
import { __resetDirsFromEnvForTests, getAgentDir, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("document conversion cache", () => {
	let testDir: string;
	let originalPiCodingAgentDir: string | undefined;
	let originalOmpProfile: string | undefined;
	let originalPiProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfile = process.env.OMP_PROFILE;
		originalPiProfile = process.env.PI_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		testDir = path.join(os.tmpdir(), `markit-cache-${Snowflake.next()}`);
		await fs.mkdir(testDir, { recursive: true });
		setAgentDir(path.join(testDir, "agent"));
	});

	afterEach(async () => {
		restoreEnv("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
		restoreEnv("OMP_PROFILE", originalOmpProfile);
		restoreEnv("PI_PROFILE", originalPiProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("reuses locally converted text across normalized extension spellings", async () => {
		const bytes = new TextEncoder().encode("{\\rtf1\\ansi Cached document body}");
		const first = await convertBufferWithMarkit(bytes, "rtf");
		const second = await convertBufferWithMarkit(bytes, ".RTF");
		expect(first.ok).toBe(true);
		expect(first.content).toContain("Cached document body");
		expect(second.content).toBe(first.content);
		expect(first.cache).toBe("miss");
		expect(second.cache).toBe("hit");
	});

	it("does not present malformed documents as successful cached text", async () => {
		const bytes = new TextEncoder().encode("not a PDF");
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await convertBufferWithMarkit(bytes, ".pdf");
			expect(result.ok).toBe(false);
			expect(result.content).toBe("");
			expect(result.cache).toBe("skipped");
		}
	});

	it("invalidates file conversions when source bytes change", async () => {
		const docPath = path.join(testDir, "doc.rtf");
		await Bun.write(docPath, "{\\rtf1\\ansi First revision}");
		const first = await convertFileWithMarkit(docPath);
		await Bun.write(docPath, "{\\rtf1\\ansi Second revision}");
		const second = await convertFileWithMarkit(docPath);
		const repeated = await convertFileWithMarkit(docPath);
		expect(first.content).toContain("First revision");
		expect(second.content).toContain("Second revision");
		expect(second.content).not.toContain("First revision");
		expect(second.cache).toBe("miss");
		expect(repeated.content).toBe(second.content);
		expect(repeated.cache).toBe("hit");
	});

	it("sweeps orphaned .tmp files during prune", async () => {
		const cacheDir = path.join(getAgentDir(), "cache", "document-conversions");
		await fs.mkdir(cacheDir, { recursive: true });

		const stalePath = path.join(cacheDir, "orphan.123.456.tmp");
		const freshPath = path.join(cacheDir, "active.789.012.tmp");
		await fs.writeFile(stalePath, "stale");
		await fs.writeFile(freshPath, "fresh");
		const old = new Date(Date.now() - 60 * 60 * 1000);
		await fs.utimes(stalePath, old, old);

		await pruneMarkitConversionCache(cacheDir);

		expect(await fs.exists(stalePath)).toBe(false);
		expect(await fs.exists(freshPath)).toBe(true);
	});
});

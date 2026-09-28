import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import {
	findFreeCdpPort,
	findReusableCdp,
	pickCdpTarget,
	probeCdpStatus,
	resolveSpawnArgs,
	shouldPreserveConnectedBrowserFocus,
	waitForCdp,
} from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { acquireBrowser, normalizeConnectedCdpUrl } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
		}),
	};
}

interface DisposableExecutable {
	path: string;
	pid: number;
	close(): Promise<void>;
}

async function spawnDisposableExecutable(args: string[] = []): Promise<DisposableExecutable> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-app-path-"));
	const executablePath = path.join(tempDir, path.basename(process.execPath));
	await Bun.write(executablePath, Bun.file(process.execPath));
	if (process.platform !== "win32") await fs.chmod(executablePath, 0o755);
	const executable = await fs.realpath(executablePath);
	const child = Bun.spawn(
		[executable, "--eval", 'process.stdout.write("ready\\n"); await Bun.stdin.text()', ...args],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const readiness = child.stdout.getReader();
	await readiness.read();
	readiness.releaseLock();
	return {
		path: executable,
		pid: child.pid,
		async close() {
			child.kill();
			await child.exited;
			await fs.rm(tempDir, { recursive: true, force: true });
		},
	};
}

async function withTargetFixture<T>(
	targets: Array<{ id: string; type: string; url: string; title: string }>,
	fn: (cdpEndpoint: string) => Promise<T>,
): Promise<T> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json(targets),
	});
	try {
		return await fn(`http://127.0.0.1:${server.port}`);
	} finally {
		await server.stop(true);
	}
}

describe("browser attach behavior", () => {
	test("requires an authenticated broker in Gradivus instead of adopting an unrelated page", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json([{ id: "internal", type: "page", url: "devtools://devtools/", title: "DevTools" }]),
		});
		const previous = {
			terminal: process.env.GRADIVUS_TERMINAL,
			runtimeDir: process.env.PI_RUNTIME_DIR,
			token: process.env.PI_RUNTIME_TOKEN,
		};
		process.env.GRADIVUS_TERMINAL = "1";
		delete process.env.PI_RUNTIME_DIR;
		delete process.env.PI_RUNTIME_TOKEN;
		try {
			await expect(pickCdpTarget(`http://127.0.0.1:${server.port}`)).rejects.toThrow("authenticated runtime broker");
		} finally {
			if (previous.terminal === undefined) delete process.env.GRADIVUS_TERMINAL;
			else process.env.GRADIVUS_TERMINAL = previous.terminal;
			if (previous.runtimeDir === undefined) delete process.env.PI_RUNTIME_DIR;
			else process.env.PI_RUNTIME_DIR = previous.runtimeDir;
			if (previous.token === undefined) delete process.env.PI_RUNTIME_TOKEN;
			else process.env.PI_RUNTIME_TOKEN = previous.token;
			await server.stop(true);
		}
	});

	test("preserves focus only for automatic target selection and normalizes HTTP CDP URLs", () => {
		expect(shouldPreserveConnectedBrowserFocus()).toBe(true);
		expect(shouldPreserveConnectedBrowserFocus("example.com")).toBe(false);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222/")).toBe("http://127.0.0.1:9222");
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/id")).toThrow(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint",
		);
	});
	test("selects the exact matched page and fails closed on a matcher miss", async () => {
		await withTargetFixture(
			[
				{ id: "internal", type: "page", url: "devtools://devtools/", title: "DevTools" },
				{ id: "target", type: "page", url: "https://example.com/", title: "Example" },
			],
			async endpoint => {
				await expect(pickCdpTarget(endpoint, { matcher: "example" })).resolves.toMatchObject({
					id: "target",
					url: "https://example.com/",
				});
				await expect(pickCdpTarget(endpoint, { matcher: "missing" })).rejects.toThrow(
					'No page target matched "missing"',
				);
			},
		);
	});

	test("refuses to replace a running same-executable process", async () => {
		const existing = await spawnDisposableExecutable();
		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: existing.path },
					{ cwd: process.cwd(), signal: AbortSignal.timeout(2_000) },
				),
			).rejects.toThrow("already running without a reusable CDP endpoint");
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await existing.close();
		}
	}, 10_000);

	test("rejects a user-data-dir already used by the running executable", async () => {
		const profile = path.join(os.tmpdir(), `omp-browser-profile-${process.pid}-${Date.now()}`);
		const existing = await spawnDisposableExecutable([`--user-data-dir=${profile}`]);
		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: existing.path, args: [`--user-data-dir=${profile}`] },
					{
						cwd: process.cwd(),
						signal: AbortSignal.timeout(2_000),
					},
				),
			).rejects.toThrow("already running without a reusable CDP endpoint");
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await existing.close();
		}
	}, 10_000);

	test("launches an isolated user-data-dir beside a running executable", async () => {
		const existing = await spawnDisposableExecutable();
		const { promise: launched, resolve: markLaunched } = Promise.withResolvers<void>();
		const marker = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				markLaunched();
				return new Response("ok");
			},
		});
		const controller = new AbortController();
		const childScript = `await fetch(${JSON.stringify(marker.url.href)}); Bun.serve({ port: 0, fetch: () => new Response("ok") });`;
		const openError = acquireBrowser(
			{
				kind: "spawned",
				path: existing.path,
				args: ["--eval", childScript, `--user-data-dir=${path.join(path.dirname(existing.path), "profile")}`],
			},
			{
				cwd: process.cwd(),
				signal: controller.signal,
			},
		).then(
			() => new Error("Expected isolated app acquisition to remain pending"),
			error => (error instanceof Error ? error : new Error(String(error))),
		);

		try {
			await Promise.race([
				launched,
				openError.then(error => {
					throw error;
				}),
			]);
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
			controller.abort();
			expect((await openError).name).toBe("ToolAbortError");
		} finally {
			controller.abort();
			await openError;
			await marker.stop(true);
			await existing.close();
		}
	}, 10_000);

	test("does not reuse a live CDP endpoint belonging to a different profile", async () => {
		const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
		const profile = path.join(os.tmpdir(), `omp-cdp-profile-${crypto.randomUUID()}`);
		const existing = await spawnDisposableExecutable([
			`--user-data-dir=${profile}`,
			`--remote-debugging-port=${cdp.port}`,
		]);
		try {
			expect(await findReusableCdp(existing.path, { appArgs: [`--user-data-dir=${profile}-other`] })).toBeNull();
			expect(await findReusableCdp(existing.path, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
				cdpUrl: `http://127.0.0.1:${cdp.port}`,
				pid: existing.pid,
			});
		} finally {
			await existing.close();
			cdp.stop(true);
		}
	});

	test.skipIf(process.platform !== "linux")("reuses Chromium launched through a distro wrapper", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-wrapper-"));
		const wrapper = path.join(root, "google-chrome");
		const target = path.join(root, "chrome");
		const profile = path.join(root, "profile");
		const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
		await Bun.write(target, Bun.file(process.execPath));
		await fs.chmod(target, 0o755);
		await Bun.write(wrapper, '#!/bin/bash\nHERE="$(dirname "$0")"\nexec -a "$0" "$HERE/chrome" "$@"\n');
		await fs.chmod(wrapper, 0o755);
		const child = Bun.spawn(
			[
				wrapper,
				"--eval",
				'process.stdout.write("ready\\n"); await Bun.stdin.text()',
				`--user-data-dir=${profile}`,
				`--remote-debugging-port=${cdp.port}`,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
		);
		const readiness = child.stdout.getReader();
		await readiness.read();
		readiness.releaseLock();
		try {
			expect(await findReusableCdp(wrapper, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
				cdpUrl: `http://127.0.0.1:${cdp.port}`,
				pid: child.pid,
			});
		} finally {
			child.kill();
			await child.exited;
			cdp.stop(true);
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps profile tabs isolated and never kills a borrowed Chrome on close",
		async () => {
			const exe = await ensureChromiumExecutable();
			if (!exe) throw new Error("Expected a Chromium executable");
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-isolation-"));
			const borrowedProfile = path.join(root, "borrowed");
			const port = await findFreeCdpPort();
			// Explicit profiles keep the real OS keystore, so bypass it here or macOS
			// blocks each spawn on a keychain-access dialog.
			const flags = [
				"--headless=new",
				"--no-sandbox",
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				"--password-store=basic",
			];
			const child = Bun.spawn(
				[exe, ...flags, `--user-data-dir=${borrowedProfile}`, `--remote-debugging-port=${port}`],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: unknown) =>
				prelude.invoke(parameters, { session, toolCallId: "profile-isolation" });
			const borrowedName = `borrowed-${crypto.randomUUID()}`;
			const ownedName = `owned-${crypto.randomUUID()}`;
			try {
				await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
				await invoke({
					action: "open",
					name: borrowedName,
					url: "data:text/html,<title>Borrowed</title>",
					app: { path: exe, args: [...flags, "--user-data-dir", borrowedProfile] },
				});
				await invoke({
					action: "open",
					name: ownedName,
					url: "data:text/html,<title>Owned</title>",
					app: { path: exe, args: [...flags, "--user-data-dir", path.join(root, "owned")] },
				});
				const title = await invoke({ action: "run", name: borrowedName, code: "return await tab.title();" });
				expect(title.details).toMatchObject({ value: "Borrowed" });
				await invoke({ action: "close", name: borrowedName, kill: true });
				expect(await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500 })).toBe(200);
			} finally {
				await invoke({ action: "close", name: ownedName, kill: true }).catch(() => {});
				await invoke({ action: "close", name: borrowedName, kill: true }).catch(() => {});
				child.kill();
				await child.exited;
				await fs.rm(root, { recursive: true, force: true });
			}
		},
		30_000,
	);
});

describe("resolveSpawnArgs", () => {
	test("normalizes separated and relative Chromium profiles into an absolute switch value", () => {
		const args = resolveSpawnArgs(
			"/usr/bin/google-chrome-stable",
			["--user-data-dir", "profile", "--incognito"],
			"/tmp",
		);
		expect(args).toEqual(["--incognito", `--user-data-dir=${path.resolve("/tmp", "profile")}`]);
	});

	test("isolates a Flatpak Chromium launcher without treating unrelated apps as browsers", () => {
		const args = resolveSpawnArgs("/var/lib/flatpak/exports/bin/com.google.Chrome", []);
		expect(args.some(arg => arg.startsWith("--user-data-dir="))).toBe(true);
		expect(resolveSpawnArgs("/Applications/Slack.app/Contents/MacOS/Slack", ["--foo"])).toEqual(["--foo"]);
	});

	test("bypasses the OS keystore only for omp-owned Chromium profiles", () => {
		const owned = resolveSpawnArgs("/usr/bin/google-chrome-stable", ["--password-store=gnome"]);
		expect(owned).toContain("--use-mock-keychain");
		expect(owned).toContain("--password-store=gnome");
		expect(owned).not.toContain("--password-store=basic");

		const borrowedProfile = path.resolve("/home/me/.config/chrome");
		const borrowed = resolveSpawnArgs("/usr/bin/google-chrome-stable", [`--user-data-dir=${borrowedProfile}`]);
		expect(borrowed).toEqual([`--user-data-dir=${borrowedProfile}`]);
	});
});

describe("probeCdpStatus", () => {
	// Regression for #8567: a local proxy (Clash, corporate) 502s internal
	// loopback addresses, so a bare fetch()/node:http probe misreports a healthy
	// CDP daemon as dead. The raw-TCP probe must ignore HTTP_PROXY entirely.
	test("returns the loopback status even when HTTP_PROXY 502s the request", async () => {
		const cdp = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
		const proxy = Bun.serve({ port: 0, fetch: () => new Response("Bad Gateway", { status: 502 }) });
		const saved = { HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
		process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${cdp.port}/json/version`, { timeoutMs: 1500 });
			expect(status).toBe(200);
		} finally {
			// Bun's fetch never unlearns a deleted proxy var: `delete process.env.X`
			// (or assigning undefined) leaves the proxy active process-wide, silently
			// routing every later fetch in the suite to the stopped proxy port. Only
			// assignment flushes it, so write "" first, then restore the JS view.
			process.env.HTTP_PROXY = saved.HTTP_PROXY ?? "";
			process.env.http_proxy = saved.http_proxy ?? "";
			if (saved.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
			if (saved.http_proxy === undefined) delete process.env.http_proxy;
			await cdp.stop(true);
			await proxy.stop(true);
		}
	});

	test("surfaces a non-2xx status from a live endpoint", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) });
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${server.port}/json/version`, { timeoutMs: 1500 });
			expect(status).toBe(503);
		} finally {
			await server.stop(true);
		}
	});

	test("returns null when the endpoint is unreachable", async () => {
		const port = await findFreeCdpPort();
		const status = await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 500 });
		expect(status).toBeNull();
	});

	test("returns null when the request is already aborted", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 200 }) });
		try {
			const status = await probeCdpStatus(`http://127.0.0.1:${server.port}/json/version`, {
				timeoutMs: 1500,
				signal: AbortSignal.abort(),
			});
			expect(status).toBeNull();
		} finally {
			await server.stop(true);
		}
	});
});

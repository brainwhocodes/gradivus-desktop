import * as childProcess from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import {
	captureProcessIdentity,
	DEFAULT_CONTROL_TOKEN_BASENAME,
	DEFAULT_ENDPOINT_BASENAME,
	ensureSecureRuntimeRoot,
	inspectProcessIdentity,
	type ProcessIdentity,
	readControlToken,
	secureRuntimeEndpoint,
	secureRuntimePath,
	shutdownProcessTree,
} from "@oh-my-pi/pi-utils/local-runtime";
import { WorkspaceClient } from "./client";
import { WORKSPACE_RUNTIME_VERSION } from "./constants";

function sleep(ms: number): Promise<void> {
	if (typeof Bun !== "undefined" && typeof Bun.sleep === "function") return Bun.sleep(ms);
	return new Promise(resolve => setTimeout(resolve, ms));
}

interface DaemonExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface SpawnedDaemon {
	pid?: number;
	unref?: () => void;
	failure: Promise<{ kind: "error"; error: unknown } | { kind: "exit"; exit: DaemonExit }>;
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 2_000 ? `${message.slice(0, 1_997)}...` : message;
}

async function waitForRuntimeShutdown(runtimeDir: string, endpointPath: string, timeoutMs: number): Promise<void> {
	const ownerFile = secureRuntimePath(runtimeDir, "runtime.owner.json");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let ownerAlive = false;
		try {
			const ownerContent = await fsp.readFile(ownerFile, "utf8");
			const parsed = JSON.parse(ownerContent) as unknown;
			if (typeof parsed !== "object" || parsed === null || !("pid" in parsed) || !("startToken" in parsed)) {
				ownerAlive = true;
			} else {
				const inspection = await inspectProcessIdentity(parsed as ProcessIdentity);
				ownerAlive = inspection.status !== "dead";
			}
		} catch (error) {
			ownerAlive = (error as NodeJS.ErrnoException).code !== "ENOENT";
		}

		let endpointAlive = true;
		try {
			await fsp.access(endpointPath);
		} catch {
			endpointAlive = false;
		}
		if (!ownerAlive && !endpointAlive) return;
		await sleep(50);
	}
	throw new Error(`Timed out waiting for incompatible workspace runtime shutdown at ${runtimeDir}`);
}

function spawnDaemonProcess(
	execPath: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): SpawnedDaemon {
	const failure = Promise.withResolvers<{ kind: "error"; error: unknown } | { kind: "exit"; exit: DaemonExit }>();
	if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
		const child = Bun.spawn([execPath, ...args], {
			cwd: options.cwd,
			env: options.env as Record<string, string>,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		void child.exited.then(code => {
			failure.resolve({ kind: "exit", exit: { code, signal: null } });
		});
		return {
			pid: child.pid,
			unref: () => {
				if (process.platform !== "win32") child.unref();
			},
			failure: failure.promise,
		};
	}
	const child = childProcess.spawn(execPath, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: "ignore",
		detached: process.platform !== "win32",
	});
	child.once("error", error => failure.resolve({ kind: "error", error }));
	child.once("exit", (code, signal) => failure.resolve({ kind: "exit", exit: { code, signal } }));
	return {
		pid: child.pid,
		unref: () => {
			if (process.platform !== "win32") child.unref();
		},
		failure: failure.promise,
	};
}

export interface EnsureWorkspaceRuntimeOptions {
	runtimeDir: string;
	tokenBasename?: string;
	endpointBasename?: string;
	executablePath?: string;
	serverEntryPath?: string;
	connectTimeoutMs?: number;
	startupTimeoutMs?: number;
}

export interface WorkspaceRuntimeDescriptor {
	runtimeDir: string;
	endpointPath: string;
	token: string;
	client: WorkspaceClient;
	pid?: number;
	close(): Promise<void>;
	shutdownRuntime(): Promise<void>;
}

export const WORKER_RUNTIME_SERVER_SELECTOR = "__omp_worker_runtime_server";

export async function ensureWorkspaceRuntime(
	options: EnsureWorkspaceRuntimeOptions,
): Promise<WorkspaceRuntimeDescriptor> {
	const rawRuntimeDir = path.resolve(options.runtimeDir);
	const runtimeDir = await fsp.realpath(rawRuntimeDir).catch(() => rawRuntimeDir);
	const tokenBasename = options.tokenBasename ?? DEFAULT_CONTROL_TOKEN_BASENAME;
	const endpointBasename = options.endpointBasename ?? DEFAULT_ENDPOINT_BASENAME;
	const endpointPath = secureRuntimeEndpoint(runtimeDir, endpointBasename);

	await ensureSecureRuntimeRoot(runtimeDir);
	let replacingIncompatible = false;
	// 1. First validate and connect if runtime is already running
	try {
		const token = await readControlToken(runtimeDir, tokenBasename);
		const probeClient = new WorkspaceClient({
			runtimeRoot: runtimeDir,
			token,
			tokenBasename,
			endpointBasename,
			connectTimeoutMs: options.connectTimeoutMs ?? 1500,
		});
		await probeClient.connect();
		if (probeClient.runtimeVersion !== WORKSPACE_RUNTIME_VERSION) {
			replacingIncompatible = true;
			await probeClient.shutdownRuntime().catch(() => {});
			await waitForRuntimeShutdown(runtimeDir, endpointPath, options.startupTimeoutMs ?? 10_000);
		} else {
			return {
				runtimeDir,
				endpointPath,
				token,
				client: probeClient,
				close: async () => {
					await probeClient.close().catch(() => {});
				},
				shutdownRuntime: async () => {
					if (probeClient.isConnected) {
						await probeClient.shutdownRuntime().catch(() => {});
					} else {
						try {
							const shutdownClient = new WorkspaceClient({
								runtimeRoot: runtimeDir,
								token,
								tokenBasename,
								endpointBasename,
							});
							await shutdownClient.shutdownRuntime();
						} catch {}
					}
				},
			};
		}
	} catch (error) {
		if (replacingIncompatible) throw error;
		// Proceed to startup lock
	}

	// 2. Acquire exclusive startup lock
	const lockPath = secureRuntimePath(runtimeDir, "startup.lock");
	const lock = FileLock.tryAcquire(lockPath);
	if (!lock.acquired) {
		// Wait for winner to initialize runtime
		const startWait = Date.now();
		const timeoutMs = options.startupTimeoutMs ?? 10000;
		while (Date.now() - startWait < timeoutMs) {
			await sleep(100);
			try {
				const token = await readControlToken(runtimeDir, tokenBasename);
				const client = new WorkspaceClient({
					runtimeRoot: runtimeDir,
					token,
					tokenBasename,
					endpointBasename,
					connectTimeoutMs: 1500,
				});
				await client.connect();
				if (client.runtimeVersion !== WORKSPACE_RUNTIME_VERSION) {
					await client.close().catch(() => {});
					continue;
				}
				return {
					runtimeDir,
					endpointPath,
					token,
					client,
					close: async () => {
						await client.close().catch(() => {});
					},
					shutdownRuntime: async () => {
						await client.shutdownRuntime().catch(() => {});
					},
				};
			} catch {}
		}
		throw new Error(`Timed out waiting for workspace runtime startup lock at ${runtimeDir}`);
	}

	try {
		// 3. Under the lock, recheck if another process initialized the runtime
		try {
			const token = await readControlToken(runtimeDir, tokenBasename);
			const client = new WorkspaceClient({
				runtimeRoot: runtimeDir,
				token,
				tokenBasename,
				endpointBasename,
				connectTimeoutMs: 1500,
			});
			await client.connect();
			if (client.runtimeVersion !== WORKSPACE_RUNTIME_VERSION) {
				await client.shutdownRuntime().catch(() => {});
				await waitForRuntimeShutdown(runtimeDir, endpointPath, options.startupTimeoutMs ?? 10_000);
			} else {
				return {
					runtimeDir,
					endpointPath,
					token,
					client,
					close: async () => {
						await client.close().catch(() => {});
					},
					shutdownRuntime: async () => {
						if (client.isConnected) {
							await client.shutdownRuntime().catch(() => {});
						} else {
							try {
								const shutdownClient = new WorkspaceClient({
									runtimeRoot: runtimeDir,
									token,
									tokenBasename,
									endpointBasename,
									connectTimeoutMs: 1500,
								});
								await shutdownClient.connect();
								await shutdownClient.shutdownRuntime();
							} catch {}
						}
					},
				};
			}
		} catch {}
		// 4. Verify process identity of previous runtime if recorded
		const ownerFile = secureRuntimePath(runtimeDir, "runtime.owner.json");
		try {
			const ownerContent = await fsp.readFile(ownerFile, "utf8");
			const parsed = JSON.parse(ownerContent) as unknown;
			if (typeof parsed === "object" && parsed !== null && "pid" in parsed && "startToken" in parsed) {
				const ownerIdentity = parsed as ProcessIdentity;
				const inspection = await inspectProcessIdentity(ownerIdentity);
				if (inspection.status === "matched") {
					// Live owner exists - fail closed without unlinking
					throw new Error(`Active workspace runtime process ${ownerIdentity.pid} is already running`);
				}
				if (inspection.status === "unverifiable" || inspection.status === "mismatched") {
					// Unverifiable/mismatched identity on a live PID - fail closed without unlinking or killing
					throw new Error(
						`Cannot verify previous workspace runtime process ${ownerIdentity.pid} identity (${inspection.status})`,
					);
				}
				// inspection.status === "dead": previous process is verified dead
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		// 5. Spawn packaged runtime server worker
		const execPath = options.executablePath ?? process.execPath;
		const isCompiledBinary = !execPath.endsWith("bun") && !execPath.endsWith("bun.exe");
		const defaultDir =
			typeof import.meta.dir === "string"
				? import.meta.dir
				: typeof __dirname === "string"
					? __dirname
					: process.cwd();
		const serverEntryPath = options.serverEntryPath ?? path.join(defaultDir, "cli.ts");
		const spawnArgs = isCompiledBinary
			? [WORKER_RUNTIME_SERVER_SELECTOR]
			: [serverEntryPath, WORKER_RUNTIME_SERVER_SELECTOR];

		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			GRADIVUS_BOOTSTRAP_RUNTIME_DIR: runtimeDir,
			GRADIVUS_BOOTSTRAP_TOKEN_BASENAME: tokenBasename,
			GRADIVUS_BOOTSTRAP_ENDPOINT_BASENAME: endpointBasename,
			GRADIVUS_BOOTSTRAP_EXECUTABLE_PATH: execPath,
		};

		let child: SpawnedDaemon;
		try {
			child = spawnDaemonProcess(execPath, spawnArgs, {
				cwd: runtimeDir,
				env,
			});
		} catch (error) {
			throw new Error(`Failed to spawn workspace runtime server at ${execPath}: ${describeError(error)}`, {
				cause: error,
			});
		}
		if (child.unref) child.unref();

		const childPid = child.pid;
		let childIdentity: ProcessIdentity | undefined;
		if (childPid) {
			const captured = await captureProcessIdentity(childPid);
			if (captured.status === "matched" && captured.identity) {
				childIdentity = captured.identity;
				await fsp.writeFile(ownerFile, JSON.stringify(childIdentity), "utf8");
			}
		}

		// 6. Wait for ready and perform authenticated round trip. A daemon that
		// exits before authentication is a startup failure, not a timeout.
		const startReady = Date.now();
		const timeoutMs = options.startupTimeoutMs ?? 10000;
		let authenticatedClient: WorkspaceClient | undefined;
		let runtimeToken = "";
		let lastConnectionError: unknown;

		while (Date.now() - startReady < timeoutMs) {
			const startupSignal = await Promise.race([sleep(100).then(() => undefined), child.failure]);
			if (startupSignal) {
				if (startupSignal.kind === "error") {
					throw new Error(
						`Workspace runtime server failed to start at ${execPath}: ${describeError(startupSignal.error)}`,
						{ cause: startupSignal.error },
					);
				}
				const { code, signal } = startupSignal.exit;
				throw new Error(
					`Workspace runtime server exited before becoming ready at ${execPath} (code=${code ?? "null"}, signal=${signal ?? "none"})`,
				);
			}
			try {
				runtimeToken = await readControlToken(runtimeDir, tokenBasename);
				const client = new WorkspaceClient({
					runtimeRoot: runtimeDir,
					token: runtimeToken,
					tokenBasename,
					endpointBasename,
					connectTimeoutMs: 1500,
				});
				await client.connect();
				if (client.runtimeVersion !== WORKSPACE_RUNTIME_VERSION) {
					lastConnectionError = new Error(
						`Workspace runtime reported incompatible version ${String(client.runtimeVersion)}`,
					);
					await client.shutdownRuntime().catch(() => {});
					continue;
				}
				authenticatedClient = client;
				break;
			} catch (error) {
				lastConnectionError = error;
			}
		}

		if (!authenticatedClient) {
			if (childIdentity) {
				await shutdownProcessTree(childIdentity, { gracefulMs: 100, forceMs: 500 }).catch(() => {});
			}
			const detail = lastConnectionError
				? ` Last authenticated connection error: ${describeError(lastConnectionError)}`
				: "";
			throw new Error(`Timed out waiting for workspace runtime server ready at ${runtimeDir}.${detail}`);
		}

		const shutdown = async (): Promise<void> => {
			if (authenticatedClient?.isConnected) {
				await authenticatedClient.shutdownRuntime().catch(() => {});
			} else {
				try {
					const shutdownClient = new WorkspaceClient({
						runtimeRoot: runtimeDir,
						token: runtimeToken,
						tokenBasename,
						endpointBasename,
						connectTimeoutMs: 1500,
					});
					await shutdownClient.connect();
					await shutdownClient.shutdownRuntime();
				} catch {}
			}
			if (childIdentity) {
				let attempts = 0;
				while (attempts < 20) {
					const check = await inspectProcessIdentity(childIdentity);
					if (check.status !== "matched") break;
					await sleep(50);
					attempts++;
				}
				const finalCheck = await inspectProcessIdentity(childIdentity);
				if (finalCheck.status === "matched") {
					await shutdownProcessTree(childIdentity, { gracefulMs: 100, forceMs: 500 }).catch(() => {});
				}
			}
			try {
				await fsp.unlink(ownerFile);
			} catch {}
		};

		return {
			runtimeDir,
			endpointPath,
			token: runtimeToken,
			client: authenticatedClient,
			pid: childPid,
			close: async () => {
				await authenticatedClient?.close().catch(() => {});
			},
			shutdownRuntime: shutdown,
		};
	} finally {
		lock.release();
	}
}

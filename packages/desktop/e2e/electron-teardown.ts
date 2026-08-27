import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";
import {
	captureProcessIdentity,
	encodeLocalJsonlFrame,
	inspectProcessIdentity,
	readControlToken,
	secureRuntimeEndpoint,
	secureRuntimePath,
	shutdownProcessTree,
	type ProcessIdentity,
	type ProcessIdentityInspection,
} from "@oh-my-pi/pi-utils/local-runtime";
import { withTimeout } from "@oh-my-pi/pi-utils/async";

const APP_CLOSE_TIMEOUT_MS = 3_000;
const CLIENT_CONNECT_TIMEOUT_MS = 1_000;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const CLIENT_CLOSE_TIMEOUT_MS = 1_000;
const OWNER_GRACE_TIMEOUT_MS = 1_000;
const OWNER_POLL_INTERVAL_MS = 50;
const PROCESS_GRACEFUL_TIMEOUT_MS = 500;
const PROCESS_FORCE_TIMEOUT_MS = 1_000;

type RuntimeOwner = ProcessIdentity;
type CleanupFailure = { phase: string; error: unknown };

type ElectronChild = ChildProcess & {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
};

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isRuntimeOwner(value: unknown): value is RuntimeOwner {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return Number.isSafeInteger(record.pid) && (record.pid as number) > 0 && typeof record.startToken === "string" && record.startToken.length > 0;
}

async function readRuntimeOwner(runtimeRoot: string): Promise<RuntimeOwner | undefined> {
	const ownerPath = secureRuntimePath(runtimeRoot, "runtime.owner.json");
	try {
		const raw = await fs.readFile(ownerPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRuntimeOwner(parsed)) throw new Error(`Malformed runtime ownership record at ${ownerPath}`);
		return parsed;
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function inspectOwnerUntilSettled(identity: RuntimeOwner): Promise<ProcessIdentityInspection> {
	const deadline = Date.now() + OWNER_GRACE_TIMEOUT_MS;
	let inspection = await inspectProcessIdentity(identity);
	while (inspection.status === "matched" && Date.now() < deadline) {
		await sleep(OWNER_POLL_INTERVAL_MS);
		inspection = await inspectProcessIdentity(identity);
	}
	if (inspection.status === "matched") {
		await shutdownProcessTree(identity, {
			gracefulMs: PROCESS_GRACEFUL_TIMEOUT_MS,
			forceMs: PROCESS_FORCE_TIMEOUT_MS,
		});
		inspection = await inspectProcessIdentity(identity);
	}
	return inspection;
}
async function shutdownWorkspaceRuntime(runtimeRoot: string): Promise<void> {
	const token = await readControlToken(runtimeRoot);
	const endpoint = secureRuntimeEndpoint(runtimeRoot);
	const requestId = `e2e-shutdown-${process.pid}-${Date.now()}`;
	const gate = Promise.withResolvers<void>();
	let settled = false;
	const finish = (error?: unknown): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (error) gate.reject(error);
		else gate.resolve();
	};
	const socket = net.createConnection(endpoint);
	const timer = setTimeout(() => {
		socket.destroy();
		finish(new Error("Timed out authenticating workspace runtime shutdown"));
	}, CLIENT_CONNECT_TIMEOUT_MS + RUNTIME_SHUTDOWN_TIMEOUT_MS + 250);
	let buffer = "";
	socket.on("connect", () => {
		socket.write(encodeLocalJsonlFrame({ type: "auth", token }));
	});
	socket.on("data", chunk => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let message: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
				message = parsed as Record<string, unknown>;
			} catch (error) {
				socket.destroy();
				finish(error);
				return;
			}
			if (message.type === "auth.error") {
				socket.destroy();
				finish(new Error(`Workspace runtime authentication failed: ${String(message.message ?? "unknown error")}`));
				return;
			}
			if (message.type === "auth.ok") {
				socket.write(encodeLocalJsonlFrame({ type: "runtime.shutdown", requestId }));
				continue;
			}
			if (message.requestId === requestId) {
				socket.end();
				finish();
				return;
			}
		}
	});
	socket.on("error", error => finish(error));
	socket.on("close", () => {
		// A runtime may close immediately after accepting shutdown while the
		// response is still buffered; ownership and endpoint checks below decide
		// whether teardown actually completed.
		if (!settled) finish();
	});
	await gate.promise;
}

/** Close an Electron test and its resident workspace runtime without touching unrelated processes. */
export async function teardownElectronTest(app: ElectronApplication | undefined, userData: string): Promise<void> {
	const failures: CleanupFailure[] = [];
	const runtimeRoot = path.join(userData, "runtime");
	let electronIdentity: ProcessIdentity | undefined;
	let electronIdentityUnverifiable = false;

	if (app) {
		let processRef: ElectronChild | undefined;
		let electronCloseError: unknown;
		try {
			processRef = app.process() as ElectronChild;
			if (typeof processRef.pid === "number") {
				const captured = await captureProcessIdentity(processRef.pid);
				if (captured.identity) electronIdentity = captured.identity;
				else if (captured.status === "unverifiable") electronIdentityUnverifiable = true;
			}
		} catch {
			// Playwright may dispose the process handle after an earlier close.
		}

		try {
			await withTimeout(app.close(), APP_CLOSE_TIMEOUT_MS, "timed out closing Electron test application");
		} catch (error) {
			electronCloseError = error;
		}

		if (electronIdentity) {
			try {
				const inspection = await inspectProcessIdentity(electronIdentity);
				if (inspection.status === "matched") {
					await shutdownProcessTree(electronIdentity, {
						gracefulMs: PROCESS_GRACEFUL_TIMEOUT_MS,
						forceMs: PROCESS_FORCE_TIMEOUT_MS,
					});
				}
			} catch (error) {
				failures.push({ phase: "stop Electron process tree", error });
			}
			try {
				const finalInspection = await inspectProcessIdentity(electronIdentity);
				if (finalInspection.status === "matched" || finalInspection.status === "unverifiable") {
					failures.push({ phase: "verify Electron process exit", error: new Error(`Electron process ${finalInspection.status}`) });
				}
			} catch (error) {
				failures.push({ phase: "verify Electron process exit", error });
			}
		} else if (electronIdentityUnverifiable) {
			failures.push({ phase: "verify Electron process identity", error: new Error("Electron process identity is unverifiable") });
		} else if (processRef && processRef.exitCode === null && processRef.signalCode === null) {
			failures.push({ phase: "verify Electron process identity", error: electronCloseError ?? new Error("Electron process identity was unavailable while Electron remained active") });
		}
	}

	let owner: RuntimeOwner | undefined;
	let ownerRecordValid = true;
	try {
		owner = await readRuntimeOwner(runtimeRoot);
	} catch (error) {
		ownerRecordValid = false;
		failures.push({ phase: "read runtime ownership", error });
	}

	try {
		if (await pathExists(secureRuntimeEndpoint(runtimeRoot))) {
			await withTimeout(
				shutdownWorkspaceRuntime(runtimeRoot),
				CLIENT_CONNECT_TIMEOUT_MS + RUNTIME_SHUTDOWN_TIMEOUT_MS + 500,
				"timed out shutting down test workspace runtime",
			);
		}
	} catch (error) {
		if (!isEnoent(error)) failures.push({ phase: "authenticated runtime shutdown", error });
	}

	let ownerVerificationFailed = false;
	if (ownerRecordValid && owner) {
		try {
			const inspection = await inspectOwnerUntilSettled(owner);
			if (inspection.status === "matched" || inspection.status === "unverifiable") {
				ownerVerificationFailed = true;
				failures.push({ phase: "verify runtime owner exit", error: new Error(`Runtime owner ${inspection.status}`) });
			}
		} catch (error) {
			ownerVerificationFailed = true;
			failures.push({ phase: "stop runtime owner", error });
		}
	}

	let endpointPresent = false;
	let endpointInspectionFailed = false;
	if (process.platform !== "win32") {
		try {
			endpointPresent = await pathExists(secureRuntimeEndpoint(runtimeRoot));
		} catch (error) {
			endpointInspectionFailed = true;
			failures.push({ phase: "inspect runtime endpoint", error });
		}
		if (endpointPresent) {
			failures.push({ phase: "verify runtime endpoint exit", error: new Error("Test-owned runtime endpoint is still present") });
		}
	}

	const ownershipPostconditionsPass =
		ownerRecordValid &&
		!endpointPresent &&
		!endpointInspectionFailed &&
		!electronIdentityUnverifiable &&
		!failures.some(
			failure =>
				failure.phase.includes("verify runtime owner") ||
				failure.phase.includes("verify Electron") ||
				failure.phase === "read runtime ownership",
		);

	if (ownershipPostconditionsPass) {
		try {
			await fs.rm(runtimeRoot, { recursive: true, force: true });
		} catch (error) {
			failures.push({ phase: "remove runtime root", error });
		}
		try {
			await fs.rm(userData, { recursive: true, force: true });
		} catch (error) {
			failures.push({ phase: "remove Electron user data", error });
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(failures.map(failure => failure.error), failures.map(failure => `${failure.phase}: ${describeError(failure.error)}`).join("; "));
	}
}

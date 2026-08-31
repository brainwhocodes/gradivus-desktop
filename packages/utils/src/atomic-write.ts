import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

async function syncDirectory(directory: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(directory, "r");
		await handle.sync();
	} catch {
		// Directory fsync is unsupported on Windows and some network filesystems.
	} finally {
		await handle?.close().catch(() => {});
	}
}
const pendingWrites = new Map<string, Promise<void>>();

/**
 * Durably replace a UTF-8 text file without exposing partially-written content.
 * The temporary file is created beside the target so the final rename stays on
 * the same filesystem. Writes to one target are serialized within this process.
 */
export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
	const targetPath = path.resolve(filePath);
	const previous = pendingWrites.get(targetPath) ?? Promise.resolve();
	const operation = previous.catch(() => {}).then(() => writeTextFileAtomicUnlocked(targetPath, content));
	pendingWrites.set(targetPath, operation);
	try {
		await operation;
	} finally {
		if (pendingWrites.get(targetPath) === operation) pendingWrites.delete(targetPath);
	}
}

async function writeTextFileAtomicUnlocked(filePath: string, content: string): Promise<void> {
	const targetPath = filePath;
	const directory = path.dirname(targetPath);
	const baseName = path.basename(targetPath);
	const nonce = `${process.pid}-${randomUUID()}`;
	const tempPath = path.join(directory, `.${baseName}.${nonce}.tmp`);
	const backupPath = path.join(directory, `.${baseName}.${nonce}.bak`);
	let backupCreated = false;

	await fs.mkdir(directory, { recursive: true });
	let mode = 0o600;
	try {
		mode = (await fs.stat(targetPath)).mode;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}

	try {
		const handle = await fs.open(tempPath, "wx", mode);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		try {
			await fs.rename(tempPath, targetPath);
		} catch (error) {
			const code = errorCode(error);
			if (process.platform !== "win32" || (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES")) {
				throw error;
			}

			// Older Windows/filesystem combinations cannot replace an existing file
			// with rename. Keep the old target recoverable until the new one lands.
			try {
				await fs.rename(targetPath, backupPath);
				backupCreated = true;
			} catch (backupError) {
				if (errorCode(backupError) !== "ENOENT") throw backupError;
			}
			try {
				await fs.rename(tempPath, targetPath);
			} catch (replaceError) {
				if (backupCreated) {
					await fs.rename(backupPath, targetPath).catch(() => {});
					backupCreated = false;
				}
				throw replaceError;
			}
		}

		if (backupCreated) {
			await fs.rm(backupPath, { force: true });
			backupCreated = false;
		}
		await syncDirectory(directory);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		if (backupCreated) await fs.rm(backupPath, { force: true }).catch(() => {});
	}
}

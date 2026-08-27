import { existsSync } from "node:fs";
import * as path from "node:path";
import { app } from "electron";

export interface OmpExecutableResolverOptions {
	cwd: string;
	module: string;
	resources: string;
	exists: (candidate: string) => boolean;
	isPackaged?: boolean;
	platform: NodeJS.Platform;
}

/**
 * Resolve the OMP executable without consulting Electron or process state.
 * Filesystem access is supplied by the caller so this resolver remains pure.
 *
 * Development launches may happen from either the repository root or the
 * desktop package. Keep the candidates rooted at known repository locations so
 * a desktop cwd never produces `packages/desktop/packages/...`.
 */
export function resolveOmpExecutablePath(options: OmpExecutableResolverOptions): string {
	const executableName = options.platform === "win32" ? "omp.exe" : "omp";
	if (options.isPackaged) return path.join(options.resources, executableName);

	const moduleDir = path.extname(path.basename(options.module)) === "" ? options.module : path.dirname(options.module);
	const candidates = [
		...new Set([
			path.resolve(options.cwd, "packages/coding-agent/dist", executableName),
			path.resolve(options.cwd, "../coding-agent/dist", executableName),
			path.resolve(moduleDir, "../../../coding-agent/dist", executableName),
			path.resolve(moduleDir, "../../../packages/coding-agent/dist", executableName),
		]),
	];
	for (const candidate of candidates) {
		if (options.exists(candidate)) return candidate;
	}
	throw new Error(
		`Unable to locate the development OMP executable. Attempted paths:\n${candidates
			.map(candidate => `- ${candidate}`)
			.join("\n")}`,
	);
}

export function ompExecutablePath(): string {
	return resolveOmpExecutablePath({
		cwd: process.cwd(),
		module: __dirname,
		resources: process.resourcesPath,
		platform: process.platform,
		exists: existsSync,
		isPackaged: app?.isPackaged === true,
	});
}

export function rpcConfigPath(): string {
	if (app?.isPackaged) {
		return path.join(process.resourcesPath, "rpc-config.yml");
	}
	const candidates = [
		path.resolve(process.cwd(), "packages/desktop/resources/rpc-config.yml"),
		path.resolve(process.cwd(), "resources/rpc-config.yml"),
		path.resolve(__dirname, "../../resources/rpc-config.yml"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0];
}

export function runtimeRootDir(userDataDir?: string): string {
	const configured = process.env.GRADIVUS_RUNTIME_DIR?.trim();
	if (configured) return path.resolve(configured);
	const userDir = userDataDir ?? (app?.getPath ? app.getPath("userData") : path.join(process.cwd(), ".runtime"));
	return path.join(userDir, "runtime");
}

export function defaultWorkspacePath(): string {
	const configured = process.env.GRADIVUS_WORKSPACE?.trim();
	if (configured) return path.resolve(configured);
	return process.cwd();
}

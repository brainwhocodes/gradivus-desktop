import * as path from "node:path";
import {
	globalMutationCoordinator,
	type MutationCoordinator,
	type MutationLease,
	type MutationScope,
} from "@oh-my-pi/hashline";

/** The single in-process coordinator used by every first-party edit mutation. */
export const editMutationCoordinator: MutationCoordinator = globalMutationCoordinator;

export function exactMutationScope(filePath: string): MutationScope {
	return { kind: "exact", path: path.resolve(filePath) };
}

export function subtreeMutationScope(directory: string): MutationScope {
	return { kind: "subtree", path: path.resolve(directory) };
}

export function mutationScopes(...filePaths: readonly string[]): MutationScope[] {
	return filePaths.map(exactMutationScope);
}

export async function withMutationLease<T>(
	scopes: readonly MutationScope[],
	fn: (lease: MutationLease) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const lease = await editMutationCoordinator.acquire(scopes, signal);
	try {
		return await fn(lease);
	} finally {
		lease.release();
	}
}

export async function withMutation<T>(
	filePaths: readonly string[],
	fn: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return withMutationLease(mutationScopes(...filePaths), () => fn(), signal);
}

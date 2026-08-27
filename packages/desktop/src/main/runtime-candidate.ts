export interface OwnedRuntimeCandidate {
	close(): Promise<void>;
}

/**
 * Verify and bind an owned runtime candidate before transferring ownership.
 *
 * A candidate remains owned by the caller until this function resolves. Any
 * failed verification or binding closes it best-effort, while preserving the
 * original failure for the caller.
 */
export async function adoptOwnedRuntimeCandidate<T extends OwnedRuntimeCandidate>(
	candidate: T,
	verify: (candidate: T) => void | Promise<void>,
	bind: (candidate: T) => void | Promise<void>,
): Promise<T> {
	try {
		await verify(candidate);
		await bind(candidate);
		return candidate;
	} catch (error) {
		try {
			await candidate.close();
		} catch {
			// Preserve the verification or binding failure as the useful error.
		}
		throw error;
	}
}

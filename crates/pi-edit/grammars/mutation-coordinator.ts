import * as path from "node:path";

/** A local mutation scope. Exact scopes cover one file; subtree scopes cover a directory and all descendants. */
export type MutationScope =
	| { readonly kind: "exact"; readonly path: string }
	| { readonly kind: "subtree"; readonly path: string };

function canonicalScopePath(value: string): string {
	return path.resolve(value);
}

function normalizeScope(scope: MutationScope): MutationScope {
	return { kind: scope.kind, path: canonicalScopePath(scope.path) };
}

function isWithin(pathname: string, root: string): boolean {
	return pathname === root || pathname.startsWith(`${root}${path.sep}`);
}

function scopesConflict(left: MutationScope, right: MutationScope): boolean {
	if (left.kind === "exact" && right.kind === "exact") return left.path === right.path;
	if (left.kind === "subtree" && right.kind === "subtree") {
		return isWithin(left.path, right.path) || isWithin(right.path, left.path);
	}
	const exact = left.kind === "exact" ? left : right;
	const subtree = left.kind === "subtree" ? left : right;
	return isWithin(exact.path, subtree.path);
}

function dedupeAndSort(scopes: readonly MutationScope[]): MutationScope[] {
	const unique = new Map<string, MutationScope>();
	for (const raw of scopes) {
		const scope = normalizeScope(raw);
		const key = `${scope.kind}:${scope.path}`;
		unique.set(key, scope);
	}
	return [...unique.values()].sort((left, right) => {
		const pathOrder = left.path.localeCompare(right.path);
		return pathOrder !== 0 ? pathOrder : left.kind.localeCompare(right.kind);
	});
}

interface Request {
	readonly scopes: MutationScope[];
	readonly resolve: (lease: MutationLease) => void;
	readonly reject: (error: unknown) => void;
	readonly signal?: AbortSignal;
	settled: boolean;
}

/** Nominal proof that a coordinator lease owns the requested scopes. */
export class MutationLease {
	readonly #coordinator: MutationCoordinator;
	readonly #scopes: readonly MutationScope[];
	#released = false;

	/** @internal */
	constructor(coordinator: MutationCoordinator, scopes: readonly MutationScope[]) {
		this.#coordinator = coordinator;
		this.#scopes = Object.freeze(scopes.map(scope => Object.freeze({ ...scope }))) as readonly MutationScope[];
	}
	get scopes(): readonly MutationScope[] {
		return this.#scopes;
	}

	get released(): boolean {
		return this.#released;
	}

	/** Return whether this lease covers every requested scope. */
	covers(scopes: readonly MutationScope[]): boolean {
		if (this.#released) return false;
		const owned = this.#scopes;
		return dedupeAndSort(scopes).every(requested =>
			owned.some(scope => {
				if (scope.kind === "subtree") return isWithin(requested.path, scope.path);
				return scope.kind === requested.kind && scope.path === requested.path;
			}),
		);
	}

	/** Assert coverage before passing this lease to a mutation. */
	assertCovers(scopes: readonly MutationScope[]): void {
		if (!this.covers(scopes)) throw new Error("Mutation lease does not cover the requested filesystem scope.");
	}

	release(): void {
		if (this.#released) return;
		this.#released = true;
		this.#coordinator.release(this);
	}
}

/**
 * Process-local coordinator for structured filesystem mutations.
 * Non-overlapping scopes may run concurrently; overlapping scopes are FIFO.
 */
export class MutationCoordinator {
	readonly #active = new Set<MutationLease>();
	readonly #pending: Request[] = [];

	async acquire(scopes: readonly MutationScope[], signal?: AbortSignal): Promise<MutationLease> {
		const normalized = dedupeAndSort(scopes);
		if (normalized.length === 0) throw new Error("Cannot acquire an empty mutation scope.");
		if (signal?.aborted) throw abortError();
		return new Promise<MutationLease>((resolve, reject) => {
			const request: Request = { scopes: normalized, resolve, reject, signal, settled: false };
			this.#pending.push(request);
			const onAbort = () => {
				if (request.settled) return;
				request.settled = true;
				const index = this.#pending.indexOf(request);
				if (index >= 0) this.#pending.splice(index, 1);
				reject(abortError());
				this.#drain();
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.#drain();
		});
	}

	/** @internal */
	release(lease: MutationLease): void {
		this.#active.delete(lease);
		this.#drain();
	}

	#drain(): void {
		for (let index = 0; index < this.#pending.length; ) {
			const request = this.#pending[index];
			if (request.settled || request.signal?.aborted) {
				request.settled = true;
				this.#pending.splice(index, 1);
				if (!request.signal?.aborted) request.reject(abortError());
				continue;
			}
			// Preserve FIFO for overlapping queued requests, while allowing unrelated
			// files to proceed in parallel.
			const blockedByActive = [...this.#active].some(lease =>
				lease.scopes.some(active => request.scopes.some(scope => scopesConflict(active, scope))),
			);
			const blockedByEarlier = this.#pending
				.slice(0, index)
				.some(
					earlier =>
						!earlier.settled &&
						earlier.scopes.some(first => request.scopes.some(second => scopesConflict(first, second))),
				);
			if (blockedByActive || blockedByEarlier) {
				index++;
				continue;
			}
			this.#pending.splice(index, 1);
			request.settled = true;
			const lease = new MutationLease(this, request.scopes);
			this.#active.add(lease);
			request.resolve(lease);
		}
	}
}

function abortError(): Error {
	const error = new Error("Mutation acquisition aborted.");
	error.name = "AbortError";
	return error;
}

/** Shared coordinator for all patchers in this process. */
export const globalMutationCoordinator = new MutationCoordinator();

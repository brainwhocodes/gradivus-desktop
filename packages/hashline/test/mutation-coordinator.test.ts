import { describe, expect, it } from "bun:test";
import { MutationCoordinator, NoWriteConflictError } from "@oh-my-pi/hashline";

describe("MutationCoordinator", () => {
	it("serializes overlapping exact scopes while allowing unrelated files", async () => {
		const coordinator = new MutationCoordinator();
		const first = await coordinator.acquire([{ kind: "exact", path: "src/a.ts" }]);
		let overlappingSettled = false;
		const overlapping = coordinator.acquire([{ kind: "exact", path: "src/a.ts" }]).then(lease => {
			overlappingSettled = true;
			return lease;
		});
		const unrelated = await coordinator.acquire([{ kind: "exact", path: "src/b.ts" }]);
		expect(overlappingSettled).toBe(false);
		unrelated.release();
		first.release();
		const second = await overlapping;
		expect(overlappingSettled).toBe(true);
		second.release();
	});

	it("conflicts exact files with ancestor subtree leases and honors abort", async () => {
		const coordinator = new MutationCoordinator();
		const parent = await coordinator.acquire([{ kind: "subtree", path: "workspace" }]);
		const controller = new AbortController();
		const queued = coordinator.acquire([{ kind: "exact", path: "workspace/src/file.ts" }], controller.signal);
		controller.abort();
		await expect(queued).rejects.toMatchObject({ name: "AbortError" });
		parent.release();
		const lease = await coordinator.acquire([{ kind: "exact", path: "workspace/src/file.ts" }]);
		lease.release();
	});

	it("deduplicates scopes and rejects uncovered lease reuse", async () => {
		const coordinator = new MutationCoordinator();
		const lease = await coordinator.acquire([
			{ kind: "exact", path: "src/a.ts" },
			{ kind: "exact", path: "src/a.ts" },
		]);
		expect(lease.scopes).toHaveLength(1);
		lease.assertCovers([{ kind: "exact", path: "src/a.ts" }]);
		expect(() => lease.assertCovers([{ kind: "exact", path: "src/b.ts" }])).toThrow(/does not cover/);
		lease.release();
	});

	it("exports a typed no-write conflict", () => {
		const error = new NoWriteConflictError({ path: "src/a.ts", reason: "changed" });
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("NoWriteConflictError");
		expect(error.path).toBe("src/a.ts");
		expect(error.message).toMatch(/no changes were written/);
	});
});

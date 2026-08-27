import { describe, expect, it, vi } from "vitest";
import { adoptOwnedRuntimeCandidate } from "../src/main/runtime-candidate";

type Candidate = {
	close: () => Promise<void>;
};

function candidate(): Candidate {
	return { close: vi.fn().mockResolvedValue(undefined) };
}

describe("adoptOwnedRuntimeCandidate", () => {
	it("closes a candidate when verification fails and does not bind it", async () => {
		const owned = candidate();
		const bind = vi.fn();
		const error = new Error("runtime is not usable");

		await expect(
			adoptOwnedRuntimeCandidate(
				owned,
				async () => {
					throw error;
				},
				bind,
			),
		).rejects.toBe(error);

		expect(owned.close).toHaveBeenCalledTimes(1);
		expect(bind).not.toHaveBeenCalled();
	});

	it("closes a candidate when binding fails", async () => {
		const owned = candidate();
		const error = new Error("workspace binding failed");

		await expect(
			adoptOwnedRuntimeCandidate(owned, vi.fn(), async () => {
				throw error;
			}),
		).rejects.toBe(error);

		expect(owned.close).toHaveBeenCalledTimes(1);
	});

	it("preserves the original failure when candidate cleanup also fails", async () => {
		const owned = candidate();
		const original = new Error("verification failed");
		const cleanup = new Error("cleanup failed");
		vi.mocked(owned.close).mockRejectedValue(cleanup);

		await expect(
			adoptOwnedRuntimeCandidate(
				owned,
				async () => {
					throw original;
				},
				vi.fn(),
			),
		).rejects.toBe(original);
	});

	it("returns the identical candidate after verification and binding", async () => {
		const owned = candidate();
		const verify = vi.fn();
		const bind = vi.fn();

		const adopted = await adoptOwnedRuntimeCandidate(owned, verify, bind);

		expect(adopted).toBe(owned);
		expect(verify).toHaveBeenCalledWith(owned);
		expect(bind).toHaveBeenCalledWith(owned);
		expect(owned.close).not.toHaveBeenCalled();
	});
});

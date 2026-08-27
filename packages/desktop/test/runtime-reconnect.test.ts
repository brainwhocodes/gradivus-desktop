import { describe, expect, it, vi } from "vitest";
import {
	driveRuntimeReconnect,
	MAX_RECONNECT_ATTEMPTS,
	type ReconnectHooks,
	type RuntimeConnectionEvent,
	reconnectDelayMs,
} from "../src/main/runtime-reconnect";

function createHarness(attemptImpl: (attempt: number) => Promise<void>, shouldContinue?: () => boolean) {
	const events: RuntimeConnectionEvent[] = [];
	const delays: number[] = [];
	let attemptCount = 0;
	const hooks: ReconnectHooks = {
		emit: event => events.push(event),
		attempt: () => attemptImpl(++attemptCount),
		sleep: async ms => {
			delays.push(ms);
		},
		...(shouldContinue ? { shouldContinue } : {}),
	};
	return { hooks, events, delays, getAttemptCount: () => attemptCount };
}

describe("reconnectDelayMs", () => {
	it("starts at 500ms and grows by 1.5x", () => {
		expect(reconnectDelayMs(1)).toBe(500);
		expect(reconnectDelayMs(2)).toBe(750);
	});

	it("caps at 5000ms", () => {
		expect(reconnectDelayMs(6)).toBe(500 * 1.5 ** 5);
		expect(reconnectDelayMs(7)).toBe(5000);
		expect(reconnectDelayMs(MAX_RECONNECT_ATTEMPTS)).toBe(5000);
	});
});

describe("driveRuntimeReconnect", () => {
	it("emits reconnecting first and connected on immediate success", async () => {
		const { hooks, events } = createHarness(async () => {});
		await expect(driveRuntimeReconnect(hooks)).resolves.toBe("connected");
		expect(events).toEqual([{ state: "reconnecting" }, { state: "connected" }]);
	});

	it("retries failed attempts with the backoff schedule before connecting", async () => {
		const { hooks, events, delays } = createHarness(async attempt => {
			if (attempt < 3) throw new Error(`attempt ${attempt} failed`);
		});
		await expect(driveRuntimeReconnect(hooks)).resolves.toBe("connected");
		expect(delays).toEqual([reconnectDelayMs(1), reconnectDelayMs(2), reconnectDelayMs(3)]);
		expect(events).toEqual([{ state: "reconnecting" }, { state: "connected" }]);
	});

	it("reports each failed attempt through onAttemptError", async () => {
		const onAttemptError = vi.fn();
		const failure = new Error("runtime down");
		const { hooks } = createHarness(async attempt => {
			if (attempt === 1) throw failure;
		});
		hooks.onAttemptError = onAttemptError;
		await driveRuntimeReconnect(hooks);
		expect(onAttemptError).toHaveBeenCalledWith(failure, 1);
	});

	it("emits disconnected with attempts and retryExhausted after every attempt fails", async () => {
		const { hooks, events, getAttemptCount } = createHarness(async () => {
			throw new Error("still down");
		});
		await expect(driveRuntimeReconnect(hooks)).resolves.toBe("retry-exhausted");
		expect(getAttemptCount()).toBe(MAX_RECONNECT_ATTEMPTS);
		expect(events[0]).toEqual({ state: "reconnecting" });
		expect(events.at(-1)).toEqual({
			state: "disconnected",
			attempts: MAX_RECONNECT_ATTEMPTS,
			retryExhausted: true,
		});
		expect(events.filter(event => event.state === "reconnecting")).toHaveLength(1);
		expect(events.filter(event => event.state === "connected")).toHaveLength(0);
	});

	it("aborts without a disconnected event when the loop is abandoned mid-retry", async () => {
		let quitting = false;
		let sleeps = 0;
		const events: RuntimeConnectionEvent[] = [];
		await expect(
			driveRuntimeReconnect({
				emit: event => events.push(event),
				attempt: async () => {
					throw new Error("still down");
				},
				sleep: async () => {
					sleeps++;
					if (sleeps === 2) quitting = true;
				},
				shouldContinue: () => !quitting,
			}),
		).resolves.toBe("aborted");
		expect(sleeps).toBe(2);
		expect(events).toEqual([{ state: "reconnecting" }]);
	});
});

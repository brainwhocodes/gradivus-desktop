export type RuntimeConnectionState = "connected" | "reconnecting" | "disconnected";

export interface RuntimeConnectionEvent {
	state: RuntimeConnectionState;
	attempts?: number;
	retryExhausted?: boolean;
}

export const MAX_RECONNECT_ATTEMPTS = 10;

export function reconnectDelayMs(attempt: number): number {
	return Math.min(500 * 1.5 ** (attempt - 1), 5000);
}

export interface ReconnectHooks {
	/** Emit a connection-state event to the renderer. */
	emit(event: RuntimeConnectionEvent): void;
	/** One reconnect attempt; resolves once the runtime is bound and verified. */
	attempt(): Promise<void>;
	/** Called after a failed attempt with the attempt number (1-based). */
	onAttemptError?(error: unknown, attempt: number): void;
	/** Await between attempts; defaults to a real timer. */
	sleep?(ms: number): Promise<void>;
	/** Return false to abandon the loop without an exhaustion event (e.g. app quitting). */
	shouldContinue?(): boolean;
}

export type ReconnectOutcome = "connected" | "retry-exhausted" | "aborted";

/**
 * Drives bounded runtime reconnect attempts and owns the connection-state event
 * contract: `reconnecting` up front, `connected` on success, and `disconnected`
 * carrying `attempts` and `retryExhausted` once every attempt has failed.
 */
export async function driveRuntimeReconnect(hooks: ReconnectHooks): Promise<ReconnectOutcome> {
	const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	const shouldContinue = hooks.shouldContinue ?? (() => true);
	hooks.emit({ state: "reconnecting" });
	let attempts = 0;
	while (shouldContinue() && attempts < MAX_RECONNECT_ATTEMPTS) {
		attempts++;
		await sleep(reconnectDelayMs(attempts));
		if (!shouldContinue()) return "aborted";
		try {
			await hooks.attempt();
			hooks.emit({ state: "connected" });
			return "connected";
		} catch (error) {
			hooks.onAttemptError?.(error, attempts);
		}
	}
	if (!shouldContinue()) return "aborted";
	hooks.emit({ state: "disconnected", attempts, retryExhausted: true });
	return "retry-exhausted";
}

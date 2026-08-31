import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { PaneBroker, type PaneBrokerAdapter, type PaneBrokerContext } from "../src/main/pane-broker";

function harness(): {
	broker: PaneBroker;
	context: PaneBrokerContext;
	setConsent: (accepted: boolean) => void;
	calls: string[];
	setExecution: (execution: PaneBrokerAdapter["execute"]) => void;
	detach: () => void;
} {
	let accepted = false;
	const calls: string[] = [];
	let execute: PaneBrokerAdapter["execute"] = async (_paneId, action) => {
		calls.push(action);
		return action === "snapshot"
			? { details: { interactive: [{ selector: "#target", name: "Target" }] } }
			: { details: { action } };
	};
	const debuggerEvents = new EventEmitter();
	let attached = false;
	const debuggerApi = Object.assign(debuggerEvents, {
		isAttached: () => attached,
		attach: () => {
			attached = true;
		},
		detach: () => {
			attached = false;
			debuggerEvents.emit("detach", {}, "target closed");
		},
	});
	const context = {
		paneId: "browser-pane-0001",
		tabId: "browser-tab-0001",
		browserId: "browser-entity-0001",
		workspaceId: "workspace-0001",
		locationId: "location-0001",
		locationGeneration: 1,
		documentEpoch: 1,
		url: "https://example.test",
		title: "Example",
		visible: true,
		navigationPending: false,
		webContents: { id: 42, debugger: debuggerApi } as unknown as WebContents,
	} satisfies PaneBrokerContext;
	const adapter: PaneBrokerAdapter = {
		list: () => [context],
		resolve: () => context,
		session: () => ({
			record: {
				id: "session-1",
				kind: "work",
				cwd: "C:/repo",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastOpenedAt: "2026-01-01T00:00:00.000Z",
			},
			incarnation: "incarnation-1",
		}),
		confirm: async () => accepted,
		execute: (...args) => execute(...args),
	};
	return {
		broker: new PaneBroker(adapter),
		context,
		setConsent: value => {
			accepted = value;
		},
		calls,
		setExecution: value => {
			execute = value;
		},
		detach: () => debuggerEvents.emit("detach", {}, "crashed"),
	};
}

describe("PaneBroker", () => {
	it("mints no lease before native consent and binds accepted leases to one incarnation", async () => {
		const { broker, context, setConsent } = harness();
		expect(broker.definitionFor("session-1", "incarnation-1")?.name).toBe("gradivus_pane");
		expect((await broker.authorize("session-1", context.paneId, "observe")).lease).toBeUndefined();
		setConsent(true);
		const accepted = await broker.authorize("session-1", context.paneId, "observe");
		expect(accepted.lease?.access).toBe("observe");
		await expect(
			broker.execute(
				"session-1",
				"incarnation-2",
				{
					action: "observe",
					paneId: context.paneId,
					documentEpoch: 1,
				},
				new AbortController().signal,
			),
		).rejects.toThrow("unauthorized_pane");
	});

	it("enforces scope, epoch, refs, visibility, and unexpected debugger loss", async () => {
		const { broker, context, setConsent, calls, detach } = harness();
		setConsent(true);
		await broker.authorize("session-1", context.paneId, "observe");
		const observed = await broker.execute(
			"session-1",
			"incarnation-1",
			{
				action: "observe",
				paneId: context.paneId,
				documentEpoch: 1,
			},
			new AbortController().signal,
		);
		expect(JSON.parse(observed.content[0].type === "text" ? observed.content[0].text : "{}").interactive[0].ref).toBe(
			"e1",
		);
		await expect(
			broker.execute(
				"session-1",
				"incarnation-1",
				{
					action: "act",
					op: "click",
					paneId: context.paneId,
					documentEpoch: 1,
					ref: "e1",
				},
				new AbortController().signal,
			),
		).rejects.toThrow("insufficient_scope");
		context.documentEpoch = 2;
		await expect(
			broker.execute(
				"session-1",
				"incarnation-1",
				{
					action: "observe",
					paneId: context.paneId,
					documentEpoch: 1,
				},
				new AbortController().signal,
			),
		).rejects.toThrow("stale_epoch");
		context.documentEpoch = 1;
		context.visible = false;
		await expect(
			broker.execute(
				"session-1",
				"incarnation-1",
				{
					action: "observe",
					paneId: context.paneId,
					documentEpoch: 1,
				},
				new AbortController().signal,
			),
		).rejects.toThrow("pane_hidden");
		context.visible = true;
		detach();
		expect(broker.state("session-1", context.paneId).lease).toBeUndefined();
		expect(calls).toEqual(["snapshot"]);
	});

	it("settles an already-cancelled call without dispatching pane work", async () => {
		const { broker, calls } = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(broker.execute("session-1", "incarnation-1", { action: "list" }, controller.signal)).rejects.toThrow(
			"cancelled",
		);
		expect(calls).toEqual([]);
	});
	it("serializes pane calls, cancels queued work, and caps each pane queue", async () => {
		const firstHarness = harness();
		firstHarness.setConsent(true);
		await firstHarness.broker.authorize("session-1", firstHarness.context.paneId, "control");
		const firstGate = Promise.withResolvers<{ details: Record<string, unknown> }>();
		firstHarness.setExecution(async (_paneId, action, args) => {
			const selector = args.selector ?? "";
			firstHarness.calls.push(`${action}:${selector}`);
			if (selector === "#first") return firstGate.promise;
			return { details: { action, selector } };
		});
		const invoke = (selector: string, signal: AbortSignal) =>
			firstHarness.broker.execute(
				"session-1",
				"incarnation-1",
				{
					action: "act",
					op: "click",
					paneId: firstHarness.context.paneId,
					documentEpoch: 1,
					selector,
				},
				signal,
			);
		const first = invoke("#first", new AbortController().signal);
		await Bun.sleep(0);
		const cancelledController = new AbortController();
		const cancelled = invoke("#cancelled", cancelledController.signal);
		const third = invoke("#third", new AbortController().signal);
		cancelledController.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(firstHarness.calls).toEqual(["click:#first"]);
		firstGate.resolve({ details: { action: "click" } });
		await first;
		await third;
		expect(firstHarness.calls).toEqual(["click:#first", "click:#third"]);

		const cappedHarness = harness();
		cappedHarness.setConsent(true);
		await cappedHarness.broker.authorize("session-1", cappedHarness.context.paneId, "control");
		const capGate = Promise.withResolvers<{ details: Record<string, unknown> }>();
		cappedHarness.setExecution(async () => capGate.promise);
		const controllers = Array.from({ length: 17 }, () => new AbortController());
		const accepted = controllers.map((controller, index) =>
			cappedHarness.broker
				.execute(
					"session-1",
					"incarnation-1",
					{
						action: "act",
						op: "click",
						paneId: cappedHarness.context.paneId,
						documentEpoch: 1,
						selector: `#queued-${index}`,
					},
					controller.signal,
				)
				.catch(error => error),
		);
		await Bun.sleep(0);
		await expect(
			cappedHarness.broker.execute(
				"session-1",
				"incarnation-1",
				{
					action: "act",
					op: "click",
					paneId: cappedHarness.context.paneId,
					documentEpoch: 1,
					selector: "#overflow",
				},
				new AbortController().signal,
			),
		).rejects.toThrow("pane queue is limited to 16 calls");
		for (const controller of controllers) controller.abort();
		capGate.resolve({ details: { action: "click" } });
		await Promise.all(accepted);
	});

	it("limits concurrent pane work across the workspace", async () => {
		const contexts = Array.from({ length: 9 }, (_, index) => {
			const debuggerEvents = new EventEmitter();
			let attached = false;
			const debuggerApi = Object.assign(debuggerEvents, {
				isAttached: () => attached,
				attach: () => {
					attached = true;
				},
				detach: () => {
					attached = false;
					debuggerEvents.emit("detach", {}, "detached");
				},
			});
			return {
				paneId: `browser-pane-${index}`,
				tabId: `browser-tab-${index}`,
				browserId: `browser-entity-${index}`,
				workspaceId: "workspace-0001",
				locationId: `location-${index}`,
				locationGeneration: 1,
				documentEpoch: 1,
				url: `https://example.test/${index}`,
				title: `Example ${index}`,
				visible: true,
				navigationPending: false,
				webContents: { id: 100 + index, debugger: debuggerApi } as unknown as WebContents,
			} satisfies PaneBrokerContext;
		});
		const gates = new Map(
			contexts.map(context => [context.paneId, Promise.withResolvers<{ details: Record<string, unknown> }>()]),
		);
		const started: string[] = [];
		let running = 0;
		let maximumRunning = 0;
		const adapter: PaneBrokerAdapter = {
			list: () => contexts,
			resolve: (_sessionId, paneId) => {
				const context = contexts.find(candidate => candidate.paneId === paneId);
				if (!context) throw new Error(`Unknown pane ${paneId}`);
				return context;
			},
			session: () => ({
				record: {
					id: "session-1",
					kind: "work",
					cwd: "C:/repo",
					createdAt: "2026-01-01T00:00:00.000Z",
					lastOpenedAt: "2026-01-01T00:00:00.000Z",
				},
				incarnation: "incarnation-1",
			}),
			confirm: async () => true,
			execute: async paneId => {
				started.push(paneId);
				running++;
				maximumRunning = Math.max(maximumRunning, running);
				const result = await gates.get(paneId)!.promise;
				running--;
				return result;
			},
		};
		const broker = new PaneBroker(adapter);
		for (const context of contexts) await broker.authorize("session-1", context.paneId, "observe");
		const calls = contexts.map(context =>
			broker.execute(
				"session-1",
				"incarnation-1",
				{ action: "observe", paneId: context.paneId, documentEpoch: 1 },
				new AbortController().signal,
			),
		);
		await Bun.sleep(0);
		expect(started).toHaveLength(8);
		expect(maximumRunning).toBe(8);
		gates.get(contexts[0].paneId)!.resolve({ details: { action: "snapshot" } });
		await calls[0];
		await Bun.sleep(0);
		expect(started).toHaveLength(9);
		expect(maximumRunning).toBe(8);
		for (const context of contexts.slice(1)) {
			gates.get(context.paneId)!.resolve({ details: { action: "snapshot" } });
		}
		await Promise.all(calls);
	});

	it("rejects active and queued work with debugger_lost after an unexpected detach", async () => {
		const { broker, context, detach, setConsent, setExecution } = harness();
		setConsent(true);
		const authorization = await broker.authorize("session-1", context.paneId, "observe");
		expect(authorization.lease).toBeDefined();
		expect((context.webContents.debugger as unknown as EventEmitter).listenerCount("detach")).toBe(1);
		const gate = Promise.withResolvers<{ details: Record<string, unknown> }>();
		setExecution(async () => gate.promise);
		const active = broker.execute(
			"session-1",
			"incarnation-1",
			{ action: "observe", paneId: context.paneId, documentEpoch: 1 },
			new AbortController().signal,
		);
		await Bun.sleep(10);
		const queued = broker.execute(
			"session-1",
			"incarnation-1",
			{ action: "observe", paneId: context.paneId, documentEpoch: 1 },
			new AbortController().signal,
		);
		expect((context.webContents.debugger as unknown as EventEmitter).listenerCount("detach")).toBe(1);
		const activeFailure = active.catch(error => error);
		const queuedFailure = queued.catch(error => error);
		detach();
		expect(broker.state("session-1", context.paneId).lease).toBeUndefined();
		expect(String(await activeFailure)).toContain("debugger_lost");
		expect(String(await queuedFailure)).toContain("debugger_lost");
		gate.resolve({ details: { action: "snapshot" } });
	});
});

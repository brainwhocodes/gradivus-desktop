import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RpcAgentHub } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-agent-hub";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

function register(registry: AgentRegistry, id: string, status: "running" | "idle" | "parked" | "aborted"): void {
	registry.register({
		id,
		displayName: id,
		kind: "sub",
		parentId: "Main",
		session: null,
		status,
	});
}

describe("RpcAgentHub clear", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;
	let hub: RpcAgentHub;

	beforeEach(() => {
		registry = new AgentRegistry();
		lifecycle = new AgentLifecycleManager(registry);
		hub = new RpcAgentHub({ registry, lifecycle, output: () => {} });
	});

	afterEach(async () => {
		await lifecycle.dispose();
	});

	it("clears parked and aborted agents from the authoritative registry", async () => {
		register(registry, "Parked", "parked");
		register(registry, "Aborted", "aborted");

		await hub.clear("Parked");
		await hub.clear("Aborted");

		expect(registry.get("Parked")).toBeUndefined();
		expect(registry.get("Aborted")).toBeUndefined();
	});

	it("rejects running and idle agents without changing lifecycle state", async () => {
		register(registry, "Running", "running");
		register(registry, "Idle", "idle");

		await expect(hub.clear("Running")).rejects.toThrow("only parked or aborted");
		await expect(hub.clear("Idle")).rejects.toThrow("only parked or aborted");
		expect(registry.get("Running")?.status).toBe("running");
		expect(registry.get("Idle")?.status).toBe("idle");
	});

	it("rejects advisors and read-only agents", async () => {
		registry.register({
			id: "Advisor",
			displayName: "Advisor",
			kind: "advisor",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		registry.register({
			id: "ReadOnly",
			displayName: "Read only",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "aborted",
			history: { readOnly: true },
		});

		await expect(hub.clear("Advisor")).rejects.toThrow("read-only");
		await expect(hub.clear("ReadOnly")).rejects.toThrow("read-only");
		expect(registry.get("Advisor")?.status).toBe("parked");
		expect(registry.get("ReadOnly")?.status).toBe("aborted");
	});
});

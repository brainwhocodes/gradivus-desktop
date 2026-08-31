import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AgentPromptConflictError,
	getRpcAgentPrompts,
	resetRpcAgentPrompt,
	saveRpcAgentPrompt,
} from "../src/modes/rpc/rpc-agents";
import { discoverAgents } from "../src/task/discovery";

describe("RPC subagent prompts", () => {
	it("materializes a bundled prompt as a project override used by the next discovery", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-agent-prompts-"));
		const home = path.join(root, "home");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		try {
			const context = { cwd, home };
			const initial = (await getRpcAgentPrompts(context)).find(agent => agent.name === "scout");
			expect(initial?.effectiveSource).toBe("bundled");
			expect(initial?.project).toBeUndefined();

			const saved = await saveRpcAgentPrompt(context, {
				name: "scout",
				scope: "project",
				systemPrompt: "Inspect the exact requested surface and return evidence.",
				expectedRevision: null,
			});
			expect(saved.effectiveSource).toBe("project");
			expect(saved.project?.systemPrompt).toBe("Inspect the exact requested surface and return evidence.");
			expect(saved.project?.revision).toMatch(/^[0-9a-f]{64}$/);

			const discovered = await discoverAgents(cwd, home);
			expect(discovered.agents.find(agent => agent.name === "scout")?.systemPrompt).toBe(
				"Inspect the exact requested surface and return evidence.",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("preserves existing frontmatter and rejects stale revisions without overwriting", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-agent-prompts-"));
		const home = path.join(root, "home");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		try {
			const context = { cwd, home };
			const first = await saveRpcAgentPrompt(context, {
				name: "scout",
				scope: "project",
				systemPrompt: "First body",
				expectedRevision: null,
			});
			const filePath = path.join(cwd, ".omp", "agents", "scout.md");
			const withUnknownField = (await Bun.file(filePath).text()).replace(
				"description:",
				"custom-field: keep\ndescription:",
			);
			await Bun.write(filePath, withUnknownField);
			const current = (await getRpcAgentPrompts(context)).find(agent => agent.name === "scout");
			const currentRevision = current?.project?.revision;
			expect(currentRevision).toMatch(/^[0-9a-f]{64}$/);

			const saved = await saveRpcAgentPrompt(context, {
				name: "scout",
				scope: "project",
				systemPrompt: "Second body",
				expectedRevision: currentRevision ?? null,
			});
			const savedContent = await Bun.file(filePath).text();
			expect(savedContent).toContain("custom-field: keep");
			expect(savedContent).toEndWith("\n\nSecond body\n");

			await expect(
				saveRpcAgentPrompt(context, {
					name: "scout",
					scope: "project",
					systemPrompt: "Stale overwrite",
					expectedRevision: first.project?.revision ?? null,
				}),
			).rejects.toBeInstanceOf(AgentPromptConflictError);
			expect(await Bun.file(filePath).text()).toBe(savedContent);
			expect(saved.project?.systemPrompt).toBe("Second body");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("reset deletes only the selected override and reveals the bundled definition", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-agent-prompts-"));
		const home = path.join(root, "home");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		try {
			const context = { cwd, home };
			const saved = await saveRpcAgentPrompt(context, {
				name: "scout",
				scope: "project",
				systemPrompt: "Temporary project override",
				expectedRevision: null,
			});
			const revision = saved.project?.revision;
			if (!revision) throw new Error("project override revision missing");

			const reset = await resetRpcAgentPrompt(context, {
				name: "scout",
				scope: "project",
				expectedRevision: revision,
			});
			expect(reset.effectiveSource).toBe("bundled");
			expect(reset.project).toBeUndefined();
			await expect(fs.stat(path.join(cwd, ".omp", "agents", "scout.md"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, writeTextFileAtomic } from "@oh-my-pi/pi-utils";
import type { EffectiveExtensionRoots } from "../../capability/types";
import { refreshAgentDiscovery } from "../../task";
import { replaceAgentPromptBody, serializeAgentDefinition } from "../../task/agent-serialization";
import { parseAgent } from "../../task/agents";
import { discoverAgents } from "../../task/discovery";
import type { AgentDefinition, AgentSource } from "../../task/types";

export type AgentPromptScope = "project" | "user";

export interface RpcAgentPromptOverrideView {
	systemPrompt: string;
	revision: string;
}

export interface RpcAgentPromptView {
	name: string;
	description: string;
	effectiveSource: AgentSource;
	systemPrompt: string;
	project?: RpcAgentPromptOverrideView;
	user?: RpcAgentPromptOverrideView;
	apply: "next-spawn";
}

export interface RpcAgentPromptContext {
	cwd: string;
	extensionRoots?: EffectiveExtensionRoots;
	home?: string;
}

export interface SaveRpcAgentPromptInput {
	name: string;
	scope: AgentPromptScope;
	systemPrompt: string;
	expectedRevision: string | null;
}

export interface ResetRpcAgentPromptInput {
	name: string;
	scope: AgentPromptScope;
	expectedRevision: string;
}

const MAX_AGENT_PROMPT_BYTES = 512 * 1024;
const REVISION_PATTERN = /^[0-9a-f]{64}$/;

export class AgentPromptConflictError extends Error {
	readonly code = "agent_prompt_conflict";

	constructor() {
		super("The subagent prompt changed since it was loaded. Reload before saving again.");
		this.name = "AgentPromptConflictError";
	}
}

function canonicalAgentPath(context: RpcAgentPromptContext, name: string, scope: AgentPromptScope): string {
	const userAgentDir = context.home ? path.join(context.home, ".omp", "agent") : getAgentDir();
	const directory =
		scope === "project" ? path.resolve(context.cwd, ".omp", "agents") : path.join(userAgentDir, "agents");
	return path.join(directory, `${name}.md`);
}
function contentRevision(content: string): string {
	return Bun.SHA256.hash(content, "hex");
}

async function readTarget(filePath: string): Promise<{ content: string; revision: string } | undefined> {
	try {
		const content = await Bun.file(filePath).text();
		return { content, revision: contentRevision(content) };
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function assertScope(scope: string): asserts scope is AgentPromptScope {
	if (scope !== "project" && scope !== "user") throw new TypeError("Agent prompt scope must be project or user");
}

function assertExpectedRevision(revision: string | null, allowNull: boolean): void {
	if (revision === null && allowNull) return;
	if (typeof revision !== "string" || !REVISION_PATTERN.test(revision)) {
		throw new TypeError("Agent prompt revision is invalid");
	}
}

function assertPrompt(systemPrompt: string): string {
	if (typeof systemPrompt !== "string") throw new TypeError("Agent prompt must be text");
	const trimmed = systemPrompt.trim();
	if (!trimmed) throw new TypeError("Agent prompt cannot be empty");
	if (new TextEncoder().encode(systemPrompt).byteLength > MAX_AGENT_PROMPT_BYTES) {
		throw new RangeError("Agent prompt exceeds 512 KiB");
	}
	return systemPrompt;
}

function assertDiscoveredAgent(agents: readonly AgentDefinition[], name: string): AgentDefinition {
	if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
		throw new TypeError("Agent name is invalid");
	}
	const agent = agents.find(candidate => candidate.name === name);
	if (!agent) throw new Error(`Unknown subagent: ${name}`);
	return agent;
}

function parseMatchingAgent(filePath: string, content: string, scope: AgentPromptScope, name: string): AgentDefinition {
	const parsed = parseAgent(filePath, content, scope, "fatal");
	if (parsed.name !== name) throw new Error(`Agent definition name must remain ${name}`);
	return parsed;
}

async function overrideView(
	context: RpcAgentPromptContext,
	name: string,
	scope: AgentPromptScope,
): Promise<RpcAgentPromptOverrideView | undefined> {
	const filePath = canonicalAgentPath(context, name, scope);
	const target = await readTarget(filePath);
	if (!target) return undefined;
	const parsed = parseMatchingAgent(filePath, target.content, scope, name);
	return { systemPrompt: parsed.systemPrompt, revision: target.revision };
}

async function promptViews(context: RpcAgentPromptContext): Promise<RpcAgentPromptView[]> {
	const resolvedContext = { ...context, cwd: path.resolve(context.cwd) };
	const discovery = await discoverAgents(resolvedContext.cwd, context.home, context.extensionRoots);
	return Promise.all(
		discovery.agents.map(async agent => ({
			name: agent.name,
			description: agent.description,
			effectiveSource: agent.source,
			systemPrompt: agent.systemPrompt,
			project: await overrideView(resolvedContext, agent.name, "project"),
			user: await overrideView(resolvedContext, agent.name, "user"),
			apply: "next-spawn" as const,
		})),
	);
}

export async function getRpcAgentPrompts(context: RpcAgentPromptContext): Promise<RpcAgentPromptView[]> {
	return promptViews(context);
}

export async function saveRpcAgentPrompt(
	context: RpcAgentPromptContext,
	input: SaveRpcAgentPromptInput,
): Promise<RpcAgentPromptView> {
	assertScope(input.scope);
	assertExpectedRevision(input.expectedRevision, true);
	const systemPrompt = assertPrompt(input.systemPrompt);
	const cwd = path.resolve(context.cwd);
	const discovery = await discoverAgents(cwd, context.home, context.extensionRoots);
	const agent = assertDiscoveredAgent(discovery.agents, input.name);
	const filePath = canonicalAgentPath({ ...context, cwd }, agent.name, input.scope);
	const initial = await readTarget(filePath);
	if ((initial?.revision ?? null) !== input.expectedRevision) throw new AgentPromptConflictError();

	const content = initial
		? replaceAgentPromptBody(initial.content, systemPrompt)
		: serializeAgentDefinition({ ...agent, systemPrompt, source: input.scope, filePath });
	parseMatchingAgent(filePath, content, input.scope, agent.name);

	const current = await readTarget(filePath);
	if ((current?.revision ?? null) !== input.expectedRevision) throw new AgentPromptConflictError();
	await writeTextFileAtomic(filePath, content);
	await refreshAgentDiscovery(cwd, context.extensionRoots);
	const updated = (await promptViews(context)).find(candidate => candidate.name === agent.name);
	if (!updated) throw new Error(`Saved subagent ${agent.name} was not discovered`);
	return updated;
}

export async function resetRpcAgentPrompt(
	context: RpcAgentPromptContext,
	input: ResetRpcAgentPromptInput,
): Promise<RpcAgentPromptView> {
	assertScope(input.scope);
	assertExpectedRevision(input.expectedRevision, false);
	const cwd = path.resolve(context.cwd);
	const discovery = await discoverAgents(cwd, context.home, context.extensionRoots);
	const agent = assertDiscoveredAgent(discovery.agents, input.name);
	const filePath = canonicalAgentPath({ ...context, cwd }, agent.name, input.scope);
	const current = await readTarget(filePath);
	if (!current || current.revision !== input.expectedRevision) throw new AgentPromptConflictError();

	await fs.rm(filePath);
	await refreshAgentDiscovery(cwd, context.extensionRoots);
	const updated = (await promptViews(context)).find(candidate => candidate.name === agent.name);
	if (!updated) throw new Error(`Reset removed the only definition for subagent ${agent.name}`);
	return updated;
}

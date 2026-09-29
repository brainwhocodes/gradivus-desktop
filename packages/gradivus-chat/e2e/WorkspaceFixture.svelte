<script lang="ts">
	import {
		ChatWorkspace,
		type ChatApi,
		type HostedBootstrapSnapshot,
		type HostedSessionRecord,
		type HostedSessionSnapshot,
	} from "../src/lib";
	import type { HostedAppearanceSettings, HostedChatEvent, HostedSessionRuntimeConfig, HostedAgentHubTranscriptEntry } from "../src/lib/contracts";
	import previewUrl from "../src/assets/brand/gradivus-mark.png?url";
	import videoPreviewUrl from "./media/preview.webm?url";
	import audioPreviewUrl from "./media/preview.wav?url";
	import { fixtureAgents, fixtureModels, fixturePlan, fixturePrompts, fixtureSettings, fixtureStats, fixtureTodos } from "./workspace-fixture-data";

	const workspace = { id: "workspace-fixture", name: "fixture-workspace" };
	let records: HostedSessionRecord[] = [
		{
			id: "session-running",
			kind: "code",
			workspace,
			title: "Running chat",
			createdAt: "2026-08-30T12:00:00.000Z",
			lastOpenedAt: "2026-08-30T12:01:00.000Z",
		},
		{
			id: "session-review",
			kind: "code",
			workspace,
			title: "Review chat",
			createdAt: "2026-08-30T11:00:00.000Z",
			lastOpenedAt: "2026-08-30T11:01:00.000Z",
		},
	];
	let activeSessionId = records[0]!.id;
	const listeners = new Set<Parameters<ChatApi["onEvent"]>[0]>();
	const reconnectListeners = new Set<(snapshot: HostedBootstrapSnapshot) => void>();
	let appearance: HostedAppearanceSettings = { theme: "dark", density: "comfortable", reduceMotion: false, showToolDetails: true };
	let agents = structuredClone(fixtureAgents);
	let settings = structuredClone(fixtureSettings);
	let prompts = structuredClone(fixturePrompts);
	let todos = structuredClone(fixtureTodos);
	let plan = structuredClone(fixturePlan);
	const runtime: HostedSessionRuntimeConfig = { model: "fixture/balanced", thinkingLevel: "high", autoCompactionEnabled: true, autoRetryEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", interruptMode: "wait" };
	const messages: HostedAgentHubTranscriptEntry[] = [
		{ id: "review-request", kind: "user", text: "Review the connection recovery flow and keyboard interactions." },
		{ id: "review-response", kind: "assistant", text: "The draft survives reconnects. I am checking the fallback when a chat is removed and the empty-workspace state." },
	];

	function emit(event: HostedChatEvent): void {
		for (const listener of listeners) listener(event);
	}

	function updateRuntime(sessionId: string, config: HostedSessionRuntimeConfig): void {
		Object.assign(runtime, config);
		emit({ type: "config", sessionId, config });
	}

	function applyAppearance(next: HostedAppearanceSettings): void {
		appearance = next;
		document.documentElement.dataset.theme = next.theme === "light" ? "light" : "dark";
	}

	window.workspaceFixture = {
		resetActiveSession: () => emit({ type: "session_reset", sessionId: activeSessionId, snapshot: snapshot(activeSessionId) }),
		reconnectWithout: sessionId => {
			records = records.filter(record => record.id !== sessionId);
			if (activeSessionId === sessionId) activeSessionId = records[0]?.id ?? "";
			for (const listener of reconnectListeners) listener(bootstrap());
		},
		reconnectEmpty: () => {
			records = [];
			activeSessionId = "";
			for (const listener of reconnectListeners) listener(bootstrap());
		},
		showPlanReview: () => emit({ type: "plan_review", sessionId: activeSessionId, planReview: plan }),
		readPlanReview: () => structuredClone(plan),
	};

	function snapshot(id: string): HostedSessionSnapshot {
		const record = records.find(candidate => candidate.id === id) ?? records[0]!;
		return {
			...runtime,
			record,
			state: record.id === "session-running" ? "running" : "ready",
			timeline: [
				{
					id: `${record.id}-assistant`,
					kind: "assistant",
					text: record.id === "session-running" ? "Working through the repository." : "The plan is ready to review.",
					status: "complete",
				},
				{ id: `${record.id}-files`, kind: "tool", toolName: "edit", text: "Updated the recovery view and preview image.", status: "complete", files: [
					{ path: "src/recovery.ts", operation: "edit", disposition: "edited" },
					{ path: "assets/preview.png", operation: "write", disposition: "created" },
					{ path: "media/demo.webm", operation: "write", disposition: "created" },
					{ path: "media/voice-note.wav", operation: "write", disposition: "created" },
					{ path: "docs/notes.md", operation: "write", disposition: "created" },
					{ path: "docs/report.pdf", operation: "write", disposition: "created" },
				] },
				{ id: `${record.id}-generated`, kind: "tool", toolName: "generate_image", text: "Generated a concept image.", status: "complete", files: [{ path: "@artifacts/concept/generated.webp", operation: "generate" }] },
			],
			subagents: [],
			agentHub: { agents },
			commands: [],
			todoState: todos,
			contextTokens: 36_200,
			contextWindow: 128_000,
			tokensPerSecond: 42,
			isStreaming: record.id === "session-running",
			planReviewSupported: true,
		};
	}

	function bootstrap(): HostedBootstrapSnapshot {
		return { workspaces: [workspace], sessions: records, activeSessionId: activeSessionId || null };
	}

	const implemented: Partial<ChatApi> = {
		bootstrap: async () => bootstrap(),
		openSession: async sessionId => {
			activeSessionId = sessionId;
			return snapshot(sessionId);
		},
		createInWorkspace: async (_workspaceId, kind) => {
			const record: HostedSessionRecord = {
				id: `session-${records.length + 1}`,
				kind,
				workspace,
				title: `New chat ${records.length + 1}`,
				createdAt: new Date().toISOString(),
				lastOpenedAt: new Date().toISOString(),
			};
			records = [...records, record];
			activeSessionId = record.id;
			return snapshot(record.id);
		},
		chooseWorkspaceAndCreate: async kind => {
			const created = await implemented.createInWorkspace!(workspace.id, kind);
			return {
				action: { actionId: crypto.randomUUID(), kind: "choose_workspace", state: "completed" },
				snapshot: created,
			};
		},
		rename: async (sessionId, title) => {
			records = records.map(record => (record.id === sessionId ? { ...record, title } : record));
			return snapshot(sessionId);
		},
		deleteSession: async sessionId => {
			records = records.filter(record => record.id !== sessionId);
			activeSessionId = records[0]?.id ?? "";
			return bootstrap();
		},
		getAvailableCommands: async () => [],
		getAvailableModels: async () => fixtureModels,
		getAgentHub: async () => ({ agents }),
		getAgentHubMessages: async (_sessionId, _agentId, fromByte = 0) => ({ fromByte, nextByte: messages.length, reset: fromByte === 0, entries: messages.slice(fromByte) }),
		agentHubMessage: async (_sessionId, agentId, message) => {
			messages.push({ id: crypto.randomUUID(), kind: "user", text: message });
			agents = agents.map(agent => agent.id === agentId ? { ...agent, status: "running" } : agent);
		},
		agentHubKill: async (_sessionId, agentId) => { agents = agents.map(agent => agent.id === agentId ? { ...agent, status: "aborted" } : agent); },
		agentHubRevive: async (_sessionId, agentId) => { agents = agents.map(agent => agent.id === agentId ? { ...agent, status: "running" } : agent); },
		agentHubClear: async (_sessionId, agentId) => { agents = agents.filter(agent => agent.id !== agentId); },
		getAgentSettings: async () => settings,
		setAgentSetting: async (_sessionId, path, value) => {
			const setting = settings.find(candidate => candidate.path === path);
			if (!setting) throw new Error("Setting not found");
			const updated = { ...setting, value };
			settings = settings.map(candidate => candidate.path === path ? updated : candidate);
			return updated;
		},
		getAgentPrompts: async () => prompts,
		saveAgentPrompt: async (_sessionId, name, scope, systemPrompt, expectedRevision) => {
			const agent = prompts.find(candidate => candidate.name === name);
			if (!agent) throw new Error("Agent not found");
			if ((agent[scope]?.revision ?? null) !== expectedRevision) throw new Error("Definition changed since you opened it. Refresh settings before saving.");
			const updated = { ...agent, systemPrompt, effectiveSource: scope, [scope]: { systemPrompt, revision: String(Number(expectedRevision ?? 0) + 1) } };
			prompts = prompts.map(candidate => candidate.name === name ? updated : candidate);
			return updated;
		},
		getSessionStats: async () => fixtureStats,
		setThinking: async (sessionId, thinkingLevel) => updateRuntime(sessionId, { thinkingLevel }),
		setModel: async (sessionId, provider, modelId) => updateRuntime(sessionId, { model: `${provider}/${modelId}` }),
		setAutoCompaction: async (sessionId, autoCompactionEnabled) => updateRuntime(sessionId, { autoCompactionEnabled }),
		setAutoRetry: async (sessionId, autoRetryEnabled) => updateRuntime(sessionId, { autoRetryEnabled }),
		setTodos: async (sessionId, phases, expectedRevision) => {
			if (todos.revision !== expectedRevision) throw new Error("Tasks changed in another session.");
			todos = { phases, revision: todos.revision + 1 };
			emit({ type: "todo_update", sessionId, todoState: todos });
			return todos;
		},
		loadFileDiff: async (_sessionId, path) => ({ kind: "diff", path, status: "modified", additions: 2, deletions: 1, truncated: false, diff: "diff --git a/src/recovery.ts b/src/recovery.ts\n--- a/src/recovery.ts\n+++ b/src/recovery.ts\n@@ -1,3 +1,4 @@\n-export const keepDraft = false;\n+export const keepDraft = true;\n+export const restoreSelection = true;\n export const refreshChats = true;" }),
		loadWorkspaceFilePreview: async (_sessionId, path) => {
			if (path === "media/demo.webm") return { kind: "video", path, dataUrl: videoPreviewUrl, byteSize: 18_746, mimeType: "video/webm" };
			if (path === "media/voice-note.wav") return { kind: "audio", path, dataUrl: audioPreviewUrl, byteSize: 32_078, mimeType: "audio/wav" };
			if (path === "docs/report.pdf") return { kind: "unavailable", path, byteSize: 1_024, mimeType: "application/pdf", message: "Open this document in its default application. Text scanning is available to the agent through AnyDoc." };
			if (path === "src/recovery.ts") return { kind: "text", path, text: "export const keepDraft = true;\nexport const restoreSelection = true;", truncated: false, byteSize: 65, mimeType: "text/plain" };
			if (path === "docs/notes.md") return { kind: "text", path, text: "# Recovery notes\n\nKeep the draft and selected files when reconnecting.", truncated: false, byteSize: 67, mimeType: "text/markdown" };
			return { kind: "image", path, dataUrl: previewUrl, width: 1024, height: 1024, byteSize: 99_326, mimeType: "image/png" };
		},
		openWorkspaceFile: async () => ({ action: { actionId: crypto.randomUUID(), kind: "open_file", state: "completed" } }),
		requestPlanReview: async () => plan,
		updatePlanReview: async (_sessionId, _reviewId, content, expectedRevision, annotationState) => {
			if (plan.revision !== expectedRevision) throw new Error("Plan changed in another session.");
			plan = { ...plan, content, revision: String(Number(plan.revision) + 1), annotationState };
			return plan;
		},
		resolvePlanReview: async (_sessionId, reviewId, expectedRevision, decision) => {
			if (plan.id !== reviewId || plan.revision !== expectedRevision) throw new Error("Plan changed in another session.");
			if (decision.kind !== "approve") throw new Error("This fixture only implements plan approval.");
			const model = plan.executionModels?.find(candidate => candidate.role === decision.executionRole);
			if (!model) throw new Error("Choose an available execution model.");
			const record: HostedSessionRecord = {
				id: "session-execution", kind: "code", workspace, title: "Execute connection recovery",
				createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
			};
			records = [...records, record];
			activeSessionId = record.id;
			runtime.model = `${model.provider}/${model.modelId}`;
			return { accepted: true, createdSession: snapshot(record.id) };
		},
		releasePromptAttachments: async () => undefined,
		onEvent: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onReconnect: listener => {
			reconnectListeners.add(listener);
			return () => reconnectListeners.delete(listener);
		},
	};

	const api = new Proxy(implemented as ChatApi, {
		get(target, property, receiver) {
			const method = Reflect.get(target, property, receiver);
			if (method !== undefined) return method;
			return async () => {
				throw new Error(`Workspace fixture did not implement ChatApi.${String(property)}`);
			};
		},
	});
</script>

<ChatWorkspace
	{api}
	theme={appearance.theme === "light" ? "light" : "dark"}
	{appearance}
	onAppearanceChange={applyAppearance}
/>

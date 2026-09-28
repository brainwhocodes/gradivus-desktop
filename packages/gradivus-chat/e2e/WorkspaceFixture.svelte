<script lang="ts">
	import {
		ChatWorkspace,
		type ChatApi,
		type HostedBootstrapSnapshot,
		type HostedSessionRecord,
		type HostedSessionSnapshot,
	} from "../src/lib";

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

	function snapshot(id: string): HostedSessionSnapshot {
		const record = records.find(candidate => candidate.id === id) ?? records[0]!;
		return {
			record,
			state: record.id === "session-running" ? "running" : "ready",
			timeline: [
				{
					id: `${record.id}-assistant`,
					kind: "assistant",
					text: record.id === "session-running" ? "Working through the repository." : "The plan is ready to review.",
					status: "complete",
				},
			],
			subagents: [],
			agentHub: { agents: [] },
			commands: [],
			todoState: { phases: [], revision: 0 },
			isStreaming: record.id === "session-running",
			planReviewSupported: true,
		};
	}

	function bootstrap(): HostedBootstrapSnapshot {
		return { workspaces: [workspace], sessions: records, activeSessionId };
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
		getAvailableModels: async () => [],
		getAgentHub: async () => ({ agents: [] }),
		getAgentSettings: async () => [],
		getAgentPrompts: async () => [],
		releasePromptAttachments: async () => undefined,
		onEvent: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
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
	theme="dark"
	appearance={{ theme: "dark", density: "comfortable", reduceMotion: false, showToolDetails: true }}
/>

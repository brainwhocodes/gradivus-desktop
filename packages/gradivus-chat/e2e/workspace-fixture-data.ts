import type {
	HostedAgentHubAgent,
	HostedAgentPrompt,
	HostedAgentSetting,
	HostedModelOption,
	HostedPlanReview,
	HostedSessionStats,
	HostedTodoState,
} from "../src/lib/contracts";
import planContent from "./fixtures/plan.md?raw";
import reviewerPrompt from "./fixtures/reviewer.md?raw";

export interface WorkspaceFixtureControls {
	resetActiveSession(): void;
	reconnectWithout(sessionId: string): void;
	reconnectEmpty(): void;
	showPlanReview(): void;
	readPlanReview(): HostedPlanReview;
}

declare global {
	interface Window {
		workspaceFixture: WorkspaceFixtureControls;
	}
}

export const fixtureModels: HostedModelOption[] = [
	{
		provider: "fixture",
		id: "balanced",
		name: "Balanced model",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
	},
	{
		provider: "fixture",
		id: "fast",
		name: "Fast model",
		reasoning: false,
		input: ["text"],
		contextWindow: 64_000,
	},
];

export const fixtureSettings: HostedAgentSetting[] = [
	{
		path: "generate_image.enabled",
		tab: "tools",
		group: "Available Tools",
		label: "Generate Image",
		description:
			"Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.",
		control: "toggle",
		value: true,
	},
	{
		path: "images.questionTimeoutMs",
		tab: "tools",
		group: "Execution",
		label: "Image Question Timeout",
		description:
			"Per-request timeout for delegated image questions, in milliseconds. Set to 0 to disable the timeout.",
		control: "select",
		value: 300_000,
		options: [
			{ value: 0, label: "Disabled" },
			{ value: 60_000, label: "1 minute" },
			{ value: 300_000, label: "5 minutes" },
		],
	},
	{
		path: "read.limit",
		tab: "files",
		group: "File Reading",
		label: "Default Read Limit",
		description:
			"Default maximum number of lines returned when reading a file.",
		control: "select",
		value: 500,
		options: [
			{ value: 200, label: "200 lines" },
			{ value: 500, label: "500 lines" },
			{ value: 1000, label: "1000 lines" },
		],
	},
	{
		path: "read.lineNumbers",
		tab: "files",
		group: "File Reading",
		label: "Line Numbers",
		description: "Include line numbers in file read results.",
		control: "toggle",
		value: true,
	},
	{
		path: "theme",
		tab: "appearance",
		group: "Terminal",
		label: "Theme",
		description: "The OMP terminal color theme.",
		control: "text",
		value: "dark",
	},
	{
		path: "defaultThinkingLevel",
		tab: "model",
		group: "Defaults",
		label: "Default Thinking Level",
		description: "Reasoning level for new sessions.",
		control: "select",
		value: "high",
		options: [
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
		],
	},
	{
		path: "steeringMode",
		tab: "interaction",
		group: "Delivery",
		label: "Steering Mode",
		description: "How queued steering messages are delivered.",
		control: "select",
		value: "one-at-a-time",
		options: [
			{ value: "all", label: "All" },
			{ value: "one-at-a-time", label: "One at a time" },
		],
	},
	{
		path: "compaction.enabled",
		tab: "context",
		group: "Compaction",
		label: "Auto Compaction",
		description: "Automatically compact context before the model limit.",
		control: "toggle",
		value: true,
	},
	{
		path: "compaction.methodOrder",
		tab: "context",
		group: "Compaction",
		label: "Compaction Method Order",
		description:
			"Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice",
		control: "multiselect",
		value: ["remote", "handoff"],
		ordered: true,
		options: [
			{ value: "remote", label: "Server compaction" },
			{ value: "snapcompact", label: "Snapcompact" },
			{ value: "handoff", label: "Handoff" },
			{ value: "soft", label: "Soft compaction" },
			{ value: "shake", label: "Shake" },
		],
	},
	{
		path: "memory.enabled",
		tab: "memory",
		group: "Memory",
		label: "Memory",
		description: "Enable memory for future sessions.",
		control: "toggle",
		value: true,
	},
	{
		path: "shellPath",
		tab: "shell",
		group: "Execution",
		label: "Shell Path",
		description: "Shell executable used to run commands.",
		control: "text",
		value: "/bin/bash",
	},
	{
		path: "task.enabled",
		tab: "tasks",
		group: "Task Tool",
		label: "Task Tool",
		description: "Enable delegated tasks.",
		control: "toggle",
		value: true,
	},
	{
		path: "providers.maxInFlightRequests",
		tab: "providers",
		group: "Services",
		label: "Max In-Flight Requests",
		description:
			"Maximum concurrent LLM requests per provider id, shared across local OMP processes with this config root. Omitted providers are unlimited.",
		control: "provider-limits",
		value: { fixture: 4 },
	},
];

export const fixturePrompts: HostedAgentPrompt[] = [
	{
		name: "reviewer",
		description: "Review correctness and externally observable behavior.",
		effectiveSource: "project",
		systemPrompt: reviewerPrompt,
		project: { systemPrompt: reviewerPrompt, revision: "1" },
		apply: "next-spawn",
	},
];

export const fixtureAgents: HostedAgentHubAgent[] = [
	{
		id: "reviewer",
		displayName: "Reviewer",
		kind: "sub",
		status: "parked",
		activity: "Reviewed connection recovery and keyboard flow",
		createdAt: 1,
		lastActivity: 2,
		transcriptAvailable: true,
		readOnly: false,
		resolvedModel: "Balanced model",
		metrics: {
			tokens: 18_420,
			contextTokens: 12_400,
			contextWindow: 128_000,
			requests: 6,
			tools: 18,
			cost: 0.0472,
			durationMs: 128_000,
		},
	},
	{
		id: "advisor",
		displayName: "Architecture advisor",
		kind: "advisor",
		status: "idle",
		parentId: "reviewer",
		activity: "Ready for review",
		createdAt: 1,
		lastActivity: 2,
		transcriptAvailable: true,
		readOnly: true,
		resolvedModel: "Balanced model",
	},
];

export const fixtureTodos: HostedTodoState = {
	revision: 1,
	phases: [
		{
			id: "understand",
			name: "Understand the flow",
			tasks: [
				{
					id: "map",
					content: "Map sign-in and connection states",
					status: "completed",
				},
			],
		},
		{
			id: "recover",
			name: "Improve recovery",
			tasks: [
				{
					id: "preserve",
					content: "Preserve failed messages",
					status: "in_progress",
				},
				{
					id: "restore",
					content: "Restore the draft after a send failure",
					status: "completed",
					parentId: "preserve",
				},
				{
					id: "attachments",
					content: "Keep attachment references",
					status: "in_progress",
					parentId: "preserve",
				},
				{
					id: "verify",
					content: "Verify hosted-chat recovery",
					status: "blocked",
					blocker: "Waiting for the runtime to reconnect.",
				},
			],
		},
	],
};

export const fixtureStats: HostedSessionStats = {
	userMessages: 12,
	assistantMessages: 18,
	toolCalls: 36,
	toolResults: 36,
	totalMessages: 102,
	tokens: {
		input: 58_240,
		output: 8_420,
		reasoning: 4_800,
		cacheRead: 12_000,
		cacheWrite: 800,
		total: 84_260,
	},
	premiumRequests: 3,
	cost: 0.1842,
	contextUsage: {
		tokens: 36_200,
		contextWindow: 128_000,
		percentage: 28.28125,
	},
};

export const fixturePlan: HostedPlanReview = {
	id: "connection-plan",
	title: "Improve connection recovery",
	planFilePath: ".omp/plans/connection-recovery.md",
	revision: "1",
	status: "ready",
	phase: "ready",
	content: planContent,
	annotationState: {
		annotations: [],
		deletedSections: [],
		additionalFeedback: "",
	},
	suggestedSaveName: "connection-recovery.md",
	keepContextDisabled: false,
	contextUsage: { tokens: 36_200, contextWindow: 128_000, percent: 28.28125 },
	executionModels: [
		{
			role: "default",
			provider: "fixture",
			modelId: "balanced",
			label: "Balanced model",
		},
		{ role: "fast", provider: "fixture", modelId: "fast", label: "Fast model" },
	],
	defaultExecutionRole: "default",
};

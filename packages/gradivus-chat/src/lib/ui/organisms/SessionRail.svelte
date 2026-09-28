<script lang="ts">
	import AddCircle from "@solar-icons/svelte/linear/add-circle";
	import AddSquare from "@solar-icons/svelte/linear/add-square";
	import ArrowRight from "@solar-icons/svelte/linear/arrow-right";
	import CheckCircle from "@solar-icons/svelte/linear/check-circle";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import DangerCircle from "@solar-icons/svelte/linear/danger-circle";
	import Folder from "@solar-icons/svelte/linear/folder";
	import InfoCircle from "@solar-icons/svelte/linear/info-circle";
	import Moon from "@solar-icons/svelte/linear/moon";
	import Settings from "@solar-icons/svelte/linear/settings";
	import Sun from "@solar-icons/svelte/linear/sun";
	type ResolvedTheme = "dark" | "light";

	interface SessionRailRecord {
		id: string;
		title: string | null;
		createdAt: string;
		lastOpenedAt: string;
	}

	type SessionLiveStatus = {
		status: "idle" | "running" | "error";
		lastCompletedAt?: number;
		hasUnseenComplete?: boolean;
		planReview?: "ready" | "awaiting_refinement" | "applying" | "failed";
	};

	interface WorkspaceGroup {
		cwd: string;
		folderName: string;
		sessions: SessionRailRecord[];
		isRunning: boolean;
	}

	interface Props {
		railId?: string;
		groups: WorkspaceGroup[];
		currentCwd: string | undefined;
		loading: boolean;
		activeId: string;
		liveStatus: Map<string, SessionLiveStatus>;
		displayName: (session?: { title?: string | null; cwd?: string }) => string;
		onCreateWorkspace: () => void;
		onNewChatInWorkspace: (cwd: string) => void;
		onSelectSession: (id: string) => void;
		onDeleteSession: (id: string) => void;
		theme: ResolvedTheme;
		themeDisabled: boolean;
		onOpenSettings: (trigger: HTMLButtonElement) => void;
		onOpenAbout: (trigger: HTMLButtonElement) => void;
		onToggleTheme: () => void;
	}

	const {
		railId = "session-rail",
		groups,
		currentCwd,
		loading,
		activeId,
		liveStatus,
		displayName,
		onCreateWorkspace,
		onNewChatInWorkspace,
		onSelectSession,
		onDeleteSession,
		theme,
		themeDisabled,
		onOpenSettings,
		onOpenAbout,
		onToggleTheme,
	}: Props = $props();

	let collapsedWorkspaces = $state(new Set<string>());

	function toggleWorkspace(cwd: string): void {
		const next = new Set(collapsedWorkspaces);
		if (next.has(cwd)) next.delete(cwd);
		else next.add(cwd);
		collapsedWorkspaces = next;
	}

	function formatRelativeTime(timestamp?: number | string): string {
		if (!timestamp) return "";
		const timeMs = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
		if (Number.isNaN(timeMs)) return "";
		const diff = Math.max(0, Date.now() - timeMs);
		const minutes = Math.floor(diff / 60_000);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		return new Date(timeMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}

	function sessionStatusText(live: SessionLiveStatus | undefined, selected: boolean): string {
		const statuses: string[] = [];
		if (live?.status === "running") statuses.push("Running");
		else if (live?.status === "error") statuses.push("Error");
		if (live?.planReview === "ready") statuses.push("Plan review ready");
		else if (live?.planReview === "awaiting_refinement") statuses.push("Plan refinement requested");
		else if (live?.planReview === "applying") statuses.push("Plan action applying");
		else if (live?.planReview === "failed") statuses.push("Plan review needs attention");
		if (live?.hasUnseenComplete && !selected) statuses.push("New response");
		return statuses.join(" · ");
	}
</script>

<aside id={railId} class="session-rail" aria-label="Chats">
	<div class="rail-heading">
		<h1>Chats</h1>
		<button type="button" class="small-action" aria-label="Choose a workspace in Desktop" title="Choose a workspace in Desktop" disabled={loading} onclick={onCreateWorkspace}>
			<AddSquare size={16} aria-hidden="true" />
		</button>
	</div>

	{#if groups.length > 0}
		<ul class="workspace-tree" aria-label="Workspaces and chats">
			{#each groups as group, groupIndex (group.cwd)}
				<li class="workspace-group-node" class:is-active-workspace={currentCwd === group.cwd}>
					<div class="workspace-folder-header">
						<button
							type="button"
							class="folder-title-wrap"
							aria-expanded={!collapsedWorkspaces.has(group.cwd)}
							aria-controls={`${railId}-workspace-chat-group-${groupIndex}`}
							aria-label={`${collapsedWorkspaces.has(group.cwd) ? "Expand" : "Collapse"} workspace ${group.folderName}`}
							onclick={() => toggleWorkspace(group.cwd)}
						>
							<span class="folder-chevron" class:is-expanded={!collapsedWorkspaces.has(group.cwd)}><ArrowRight size={13} aria-hidden="true" /></span>
							<span class="folder-glyph"><Folder size={15} aria-hidden="true" /></span>
							<strong class="folder-name">{group.folderName}</strong>
							<span class="folder-count">{group.sessions.length}</span>
							{#if group.isRunning}<span class="folder-running-radar" aria-label="Turn in progress"><span class="radar-dot"></span></span>{/if}
						</button>
						<button
							type="button"
							class="btn-folder-new-chat"
							aria-label={`New chat in ${group.folderName}`}
							title={`New chat in ${group.folderName}`}
							disabled={loading}
							onclick={() => onNewChatInWorkspace(group.cwd)}
						>
							<AddCircle size={15} aria-hidden="true" />
						</button>
					</div>

					{#if !collapsedWorkspaces.has(group.cwd)}
						<ul id={`${railId}-workspace-chat-group-${groupIndex}`} class="workspace-chat-sublist" aria-label={`${group.folderName} chats`}>
							{#each group.sessions as session (session.id)}
								{@const live = liveStatus.get(session.id)}
								{@const isSelected = activeId === session.id}
								{@const statusText = sessionStatusText(live, isSelected)}
								<li
									class="session-tree-row"
									class:selected={isSelected}
									class:is-running={live?.status === "running"}
									class:has-unseen={live?.hasUnseenComplete && !isSelected}
								>
									<button
										type="button"
										class="session-select-button"
										aria-current={isSelected ? "page" : undefined}
										onclick={() => onSelectSession(session.id)}
									>
										<span class="session-status-indicator" aria-hidden="true">
											{#if live?.status === "running"}
												<span class="tree-running-radar"><span class="radar-ring"></span><span class="radar-dot"></span></span>
											{:else if live?.status === "error"}
												<span class="tree-status-dot error"><DangerCircle size={12} /></span>
											{:else if live?.hasUnseenComplete}
												<span class="tree-status-dot unseen"></span>
											{:else if isSelected}
												<span class="tree-status-dot active"><CheckCircle size={12} /></span>
											{:else}
												<span class="tree-status-dot idle"></span>
											{/if}
										</span>
										<span class="session-tree-info">
											<strong class="session-tree-title" title={displayName(session)}>{displayName(session)}</strong>
											{#if statusText}<span class="session-state-copy">{statusText}</span>{/if}
											{#if session.lastOpenedAt || session.createdAt}<span class="session-tree-time">{formatRelativeTime(session.lastOpenedAt || session.createdAt)}</span>{/if}
										</span>
									</button>
									<button
										type="button"
										class="session-tree-delete"
										title={`Delete chat ${displayName(session)}`}
										aria-label={`Delete chat ${displayName(session)}`}
										onclick={() => onDeleteSession(session.id)}
									>
										<CloseCircle size={14} aria-hidden="true" />
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<div class="rail-empty">
			<p>No coding chats yet.</p>
			<button type="button" class="text-button" onclick={onCreateWorkspace}>Choose a workspace <span class="button-arrow"><ArrowRight size={14} aria-hidden="true" /></span></button>
		</div>
	{/if}

	<nav class="rail-utilities" aria-label="Chat controls">
		<button type="button" class="rail-utility-button" onclick={(event) => onOpenSettings(event.currentTarget)}>
			<Settings size={16} aria-hidden="true" />
			<span>Settings</span>
		</button>
		<button type="button" class="rail-utility-button" onclick={(event) => onOpenAbout(event.currentTarget)}>
			<InfoCircle size={16} aria-hidden="true" />
			<span>About</span>
		</button>
		<button
			type="button"
			class="rail-utility-button rail-theme-toggle"
			aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
			title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
			disabled={themeDisabled}
			onclick={onToggleTheme}
		>
			{#if theme === "dark"}<Moon size={16} aria-hidden="true" />{:else}<Sun size={16} aria-hidden="true" />{/if}
			<span>{theme === "dark" ? "Dark mode" : "Light mode"}</span>
			<span class="rail-theme-track" class:is-dark={theme === "dark"} aria-hidden="true"><span></span></span>
		</button>
	</nav>
</aside>

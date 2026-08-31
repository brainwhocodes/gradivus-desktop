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
	import type { SessionRecordV1 } from "../../../shared/contracts";
	import type { ResolvedTheme } from "../../../shared/theme-palette";

	type SessionLiveStatus = {
		status: "idle" | "running" | "error";
		lastCompletedAt?: number;
		hasUnseenComplete?: boolean;
		planReview?: "ready" | "awaiting_refinement" | "applying" | "failed";
	};

	interface WorkspaceGroup {
		cwd: string;
		folderName: string;
		sessions: SessionRecordV1[];
		isRunning: boolean;
	}

	interface Props {
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
</script>

<aside id="session-rail" class="session-rail" aria-label="Workspaces">
  <div class="rail-heading">
    <h1>Workspaces</h1>
    <button class="small-action" aria-label="Create new workspace" title="Choose workspace folder" disabled={loading} onclick={onCreateWorkspace}><AddSquare size={16} aria-hidden="true" /></button>
  </div>

  <div class="workspace-tree" aria-label="Workspaces and Chats">
    {#each groups as group, groupIndex (group.cwd)}
      <div class="workspace-group-node" class:is-active-workspace={currentCwd === group.cwd}>
        <header class="workspace-folder-header">
          <button
            type="button"
            class="folder-title-wrap"
            aria-expanded={!collapsedWorkspaces.has(group.cwd)}
            aria-current={currentCwd === group.cwd ? "true" : undefined}
            aria-controls={`workspace-chat-group-${groupIndex}`}
            aria-label={`${collapsedWorkspaces.has(group.cwd) ? "Expand" : "Collapse"} workspace ${group.folderName}`}
            title={group.cwd}
            onclick={() => toggleWorkspace(group.cwd)}
          >
            <span class="folder-chevron" class:is-expanded={!collapsedWorkspaces.has(group.cwd)}><ArrowRight size={13} aria-hidden="true" /></span>
            <span class="folder-glyph"><Folder size={15} aria-hidden="true" /></span>
            <strong class="folder-name">{group.folderName}</strong>
            <span class="folder-count">{group.sessions.length}</span>
            {#if group.isRunning}
              <span class="folder-running-radar" title="Turn in progress in this workspace" aria-label="Turn in progress">
                <span class="radar-dot"></span>
              </span>
            {/if}
          </button>
          <button
            type="button"
            class="btn-folder-new-chat"
            title={`New Chat in ${group.folderName}`}
            aria-label={`New Chat in ${group.folderName}`}
            disabled={loading}
            onclick={() => onNewChatInWorkspace(group.cwd)}
          >
            <AddCircle size={15} aria-hidden="true" />
          </button>
        </header>

        {#if !collapsedWorkspaces.has(group.cwd)}
        <div id={`workspace-chat-group-${groupIndex}`} class="workspace-chat-sublist" role="tree" aria-label={`${group.folderName} chats`}>
          {#each group.sessions as session (session.id)}
            {@const live = liveStatus.get(session.id)}
            {@const isSelected = activeId === session.id}
            <div
              class="session-tree-row"
              class:selected={isSelected}
              class:is-running={live?.status === "running"}
              class:has-unseen={live?.hasUnseenComplete && !isSelected}
              role="treeitem"
              aria-selected={isSelected}
              tabindex={0}
              onclick={() => onSelectSession(session.id)}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectSession(session.id);
                }
              }}
            >
              <span class="session-status-indicator">
                {#if live?.status === "running"}
                  <span class="tree-running-radar" title="Thinking / Running turn" aria-hidden="true">
                    <span class="radar-ring"></span>
                    <span class="radar-dot"></span>
                  </span>
                {:else if live?.status === "error"}
                  <span class="tree-status-dot error" title="Error" aria-hidden="true"><DangerCircle size={12} /></span>
                {:else if live?.hasUnseenComplete}
                  <span class="tree-status-dot unseen" title="New completed turn" aria-hidden="true"></span>
                {:else if isSelected}
                  <span class="tree-status-dot active" aria-hidden="true"><CheckCircle size={12} /></span>
                {:else}
                  <span class="tree-status-dot idle" aria-hidden="true"></span>
                {/if}
              </span>

              <span class="session-tree-info">
                <strong class="session-tree-title" title={displayName(session)}>{displayName(session)}</strong>
                {#if live?.planReview}
                  <span class={`session-plan-review status-${live.planReview}`}>
                    {live.planReview === "ready"
                      ? "Plan review ready"
                      : live.planReview === "awaiting_refinement"
                        ? "Plan refinement requested"
                        : live.planReview === "applying"
                          ? "Plan action applying"
                          : "Plan review needs attention"}
                  </span>
                {/if}
                {#if session.lastOpenedAt || session.createdAt}
                  <span class="session-tree-time">{formatRelativeTime(session.lastOpenedAt || session.createdAt)}</span>
                {/if}
              </span>

              <button
                type="button"
                class="session-tree-delete"
                title={`Delete chat ${displayName(session)}`}
                aria-label={`Delete chat ${displayName(session)}`}
                onclick={(event) => { event.stopPropagation(); onDeleteSession(session.id); }}
              ><CloseCircle size={14} aria-hidden="true" /></button>
            </div>
          {/each}
        </div>
        {/if}
      </div>
    {:else}
      <div class="rail-empty">
        <p>No workspace sessions yet.</p>
        <button class="text-button" onclick={onCreateWorkspace}>Choose a folder <span class="button-arrow"><ArrowRight size={14} aria-hidden="true" /></span></button>
      </div>
    {/each}
  </div>

  <nav class="rail-utilities" aria-label="Application controls">
    <button type="button" class="rail-utility-button" aria-label="Open settings" onclick={(event) => onOpenSettings(event.currentTarget)}>
      <Settings size={16} aria-hidden="true" />
      <span>Settings</span>
    </button>
    <button type="button" class="rail-utility-button" aria-label="About Gradivus" onclick={(event) => onOpenAbout(event.currentTarget)}>
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

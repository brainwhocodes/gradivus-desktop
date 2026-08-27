<script lang="ts">
	import type { SessionRecordV1 } from "../../../shared/contracts";

	type SessionLiveStatus = { status: "idle" | "running" | "error"; lastCompletedAt?: number; hasUnseenComplete?: boolean };

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
	}

	const { groups, currentCwd, loading, activeId, liveStatus, displayName, onCreateWorkspace, onNewChatInWorkspace, onSelectSession, onDeleteSession }: Props = $props();

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
    <button class="small-action" aria-label="Create new workspace" title="Choose workspace folder" disabled={loading} onclick={onCreateWorkspace}>+</button>
  </div>

  <div class="workspace-tree" aria-label="Workspaces and Chats">
    {#each groups as group (group.cwd)}
      <div class="workspace-group-node" class:is-active-workspace={currentCwd === group.cwd}>
        <header class="workspace-folder-header">
          <div class="folder-title-wrap" title={group.cwd}>
            <span class="folder-glyph">📁</span>
            <strong class="folder-name">{group.folderName}</strong>
            <span class="folder-count">{group.sessions.length}</span>
            {#if group.isRunning}
              <span class="folder-running-radar" title="Turn in progress in this workspace" aria-label="Turn in progress">
                <span class="radar-dot"></span>
              </span>
            {/if}
          </div>
          <button
            type="button"
            class="btn-folder-new-chat"
            title={`New Chat in ${group.folderName}`}
            aria-label={`New Chat in ${group.folderName}`}
            disabled={loading}
            onclick={() => onNewChatInWorkspace(group.cwd)}
          >
            +
          </button>
        </header>

        <div class="workspace-chat-sublist" role="tree" aria-label={`${group.folderName} chats`}>
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
                  <span class="tree-status-dot error" title="Error" aria-hidden="true">!</span>
                {:else if live?.hasUnseenComplete}
                  <span class="tree-status-dot unseen" title="New completed turn" aria-hidden="true">●</span>
                {:else if isSelected}
                  <span class="tree-status-dot active" aria-hidden="true">✓</span>
                {:else}
                  <span class="tree-status-dot idle" aria-hidden="true">·</span>
                {/if}
              </span>

              <span class="session-tree-info">
                <strong class="session-tree-title" title={displayName(session)}>{displayName(session)}</strong>
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
              >×</button>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="rail-empty">
        <p>No workspace sessions yet.</p>
        <button class="text-button" onclick={onCreateWorkspace}>Choose a folder <span>→</span></button>
      </div>
    {/each}
  </div>
</aside>

<script lang="ts">
	import type { Snippet } from "svelte";
	import CloseCircle from "@solar-icons/svelte/linear/close-circle";
	import IconButton from "../molecules/IconButton.svelte";

	interface Props {
		tab: "agents" | "files";
		agentUnreadCount: number;
		fileActivityCount: number;
		onTab: (tab: "agents" | "files") => void;
		onClose: () => void;
		children?: Snippet;
	}

	const { tab, agentUnreadCount, fileActivityCount, onTab, onClose, children }: Props = $props();
</script>

<aside id="run-inspector" class="inspector inspector-shell" aria-label="Run inspector">
  <header class="inspector-header">
    <div class="inspector-tabs" role="tablist" aria-label="Run details">
      <button
        type="button"
        role="tab"
        class="inspector-tab"
        class:is-active={tab === "agents"}
        aria-selected={tab === "agents"}
        onclick={() => onTab("agents")}
      >Agent Hub{#if agentUnreadCount > 0}<span class="inspector-count">{agentUnreadCount}</span>{/if}</button>
      <button
        type="button"
        role="tab"
        class="inspector-tab"
        class:is-active={tab === "files"}
        aria-selected={tab === "files"}
        onclick={() => onTab("files")}
      >Files{#if fileActivityCount > 0}<span class="inspector-count">{fileActivityCount}</span>{/if}</button>
    </div>
    <IconButton class="inspector-close" icon={CloseCircle} size={15} label="Close run inspector" onclick={onClose} />
  </header>
  <div class="inspector-panel">
    {@render children?.()}
  </div>
</aside>

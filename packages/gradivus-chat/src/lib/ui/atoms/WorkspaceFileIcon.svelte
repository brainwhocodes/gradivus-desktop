<script lang="ts">
	import Box from "@solar-icons/svelte/linear/box";
	import CodeFile from "@solar-icons/svelte/linear/code-file";
	import Document from "@solar-icons/svelte/linear/document";
	import Gallery from "@solar-icons/svelte/linear/gallery";
	import MusicNote from "@solar-icons/svelte/linear/music-note";
	import VideoFrame from "@solar-icons/svelte/linear/video-frame";
	import type { WorkspaceFileKind } from "../../workspace-file-types";

	let { kind, size = 16 }: { kind: WorkspaceFileKind; size?: number } = $props();
</script>

{#if kind === "image"}
	<Gallery {size} aria-hidden="true" />
{:else if kind === "video"}
	<VideoFrame {size} aria-hidden="true" />
{:else if kind === "audio"}
	<MusicNote {size} aria-hidden="true" />
{:else if kind === "code"}
	<CodeFile {size} aria-hidden="true" />
{:else if kind === "document"}
	<Document {size} aria-hidden="true" />
{:else}
	<Box {size} aria-hidden="true" />
{/if}

<script lang="ts">
	interface Props {
		retryDisabled: boolean;
		restartDisabled: boolean;
		onretry: () => void;
		onstats: () => void;
		onexport: () => void;
		onrestart: () => void;
	}

	let { retryDisabled, restartDisabled, onretry, onstats, onexport, onrestart }: Props = $props();
	let open = $state(false);

	function run(action: () => void): void {
		open = false;
		action();
	}
</script>

<details class="session-actions-menu" bind:open>
	<summary class="secondary-button" aria-label="Session actions">Session</summary>
	<div class="session-actions-panel">
		<button type="button" disabled={retryDisabled} onclick={() => run(onretry)}>Retry last turn</button>
		<button type="button" onclick={() => run(onstats)}>Session statistics</button>
		<button type="button" onclick={() => run(onexport)}>Export HTML…</button>
		<button type="button" class="is-danger" disabled={restartDisabled} onclick={() => run(onrestart)}>Restart OMP…</button>
	</div>
</details>

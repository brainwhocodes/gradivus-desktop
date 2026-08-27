<script lang="ts">
	import { onDestroy, tick } from "svelte";
	import type { DropdownOption } from "../../settings-types";

	type DropdownMode = "listbox" | "menu";
	type DropdownLifecycle = {
		generation: number;
		released: boolean;
	};

	interface Props {
		options: readonly DropdownOption[];
		selectedKey: string | undefined;
		ariaLabel: string;
		placeholder?: string;
		disabled?: boolean;
		busy?: boolean;
	mode?: DropdownMode;
	restoreFocusOnCommit?: boolean;
	onSelect: (option: DropdownOption) => void;
		onOpenChange: (open: boolean, popupHeight: number) => void;
		onBeforeOpen?: () => void | Promise<void>;
		onAfterClose?: () => void | Promise<void>;
	}
	let {
		options,
		selectedKey,
		ariaLabel,
		placeholder = "Select an option",
		disabled = false,
		busy = false,
		mode = "listbox",
		restoreFocusOnCommit = true,
		onSelect,
		onOpenChange,
		onBeforeOpen,
		onAfterClose,
	}: Props = $props();

	const instanceId = $props.id();
	const triggerId = `${instanceId}-trigger`;
	const popupId = `${instanceId}-popup`;
	const TYPEAHEAD_RESET_MS = 700;
	const TYPEAHEAD_MAX_CODE_POINTS = 64;

	let trigger: HTMLButtonElement;
	let popup: HTMLDivElement;
	let open = $state(false);
	let opening = $state(false);
	let closing = $state(false);
	let activeKey = $state<string>();
	let generation = 0;
	let destroyed = false;
	let activeLifecycle: DropdownLifecycle | undefined;
	let restoreFocusAfterClose = false;
	let triggerWasOpenAtPointerDown = false;
	let typeaheadBuffer = "";
	let typeaheadTimer: number | undefined;
	let positionFrame = 0;
	let reportedPopupHeight = -1;
	let resizeObserver: ResizeObserver | undefined;
	let monitoringOpenPopup = false;
	let monitoringPendingOpen = false;

	let availableOptions = $derived(options.filter(option => option.disabled !== true));
	let selectedOption = $derived(options.find(option => option.key === selectedKey));
	let internallyBusy = $derived(opening || closing);
	let unavailable = $derived(disabled || busy);
	function optionDomId(key: string): string {
		let encodedKey = "";
		for (let index = 0; index < key.length; index += 1) {
			encodedKey += key.charCodeAt(index).toString(16).padStart(4, "0");
		}
		return `${popupId}-option-${encodedKey || "empty"}`;
	}

	function enabledOptions(): readonly DropdownOption[] {
		return availableOptions;
	}

	function initialActiveKey(): string | undefined {
		const selected = options.find(option => option.key === selectedKey && option.disabled !== true);
		return selected?.key ?? enabledOptions()[0]?.key;
	}

	function reconciledActiveKey(): string | undefined {
		if (activeKey && options.some(option => option.key === activeKey && option.disabled !== true)) {
			return activeKey;
		}
		return initialActiveKey();
	}

	function clearTypeahead(): void {
		typeaheadBuffer = "";
		if (typeaheadTimer !== undefined) {
			window.clearTimeout(typeaheadTimer);
			typeaheadTimer = undefined;
		}
	}

	function resetTypeaheadTimer(): void {
		if (typeaheadTimer !== undefined) window.clearTimeout(typeaheadTimer);
		typeaheadTimer = window.setTimeout(() => {
			typeaheadBuffer = "";
			typeaheadTimer = undefined;
		}, TYPEAHEAD_RESET_MS);
	}

	function isPrintableKey(event: KeyboardEvent): boolean {
		return (
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			Array.from(event.key).length === 1 &&
			event.key !== " "
		);
	}

	function applyTypeahead(input: string): void {
		const available = enabledOptions();
		if (available.length === 0) return;

		const codePoints = Array.from(`${typeaheadBuffer}${input}`);
		typeaheadBuffer = codePoints.slice(-TYPEAHEAD_MAX_CODE_POINTS).join("");
		resetTypeaheadTimer();

		const normalizedCharacters = Array.from(typeaheadBuffer.normalize("NFKC").toLowerCase());
		const repeatedCharacter = normalizedCharacters.every(character => character === normalizedCharacters[0]);
		const query = repeatedCharacter ? normalizedCharacters[0] : normalizedCharacters.join("");
		if (!query) return;

		const currentIndex = available.findIndex(option => option.key === activeKey);
		for (let offset = 1; offset <= available.length; offset += 1) {
			const index = (Math.max(currentIndex, -1) + offset) % available.length;
			const option = available[index];
			if (option.label.normalize("NFKC").toLowerCase().startsWith(query)) {
				activeKey = option.key;
				if (open) void focusActiveOption();
				return;
			}
		}
	}

	async function focusActiveOption(): Promise<void> {
		await tick();
		if (!open || destroyed) return;
		const activeElement = activeKey ? document.getElementById(optionDomId(activeKey)) : popup;
		activeElement?.focus({ preventScroll: true });
		if (activeElement !== popup) activeElement?.scrollIntoView({ block: "nearest" });
	}

	function focusOptionAt(index: number): void {
		const available = enabledOptions();
		const option = available[index];
		if (!option) return;
		activeKey = option.key;
		void focusActiveOption();
	}

	function moveActive(delta: -1 | 1): void {
		const available = enabledOptions();
		if (available.length === 0) return;
		const currentIndex = available.findIndex(option => option.key === activeKey);
		const baseIndex = currentIndex < 0 ? (delta > 0 ? -1 : 0) : currentIndex;
		const nextIndex = (baseIndex + delta + available.length) % available.length;
		focusOptionAt(nextIndex);
	}

	function cssPixelValue(name: string): number {
		return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
	}

	function schedulePosition(): void {
		if (!open || positionFrame !== 0) return;
		positionFrame = requestAnimationFrame(() => {
			positionFrame = 0;
			positionPopup();
		});
	}

	function positionPopup(): void {
		if (!open || !popup?.matches(":popover-open") || !trigger) return;

		const triggerRect = trigger.getBoundingClientRect();
		const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
		const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
		const viewportGutter = cssPixelValue("--space-2");
		const popupGap = cssPixelValue("--space-1");
		const maximumWidth = Math.max(0, viewportWidth - viewportGutter * 2);
		const minimumWidth = Math.min(triggerRect.width, maximumWidth);

		popup.style.minWidth = `${minimumWidth}px`;
		popup.style.maxWidth = `${maximumWidth}px`;
		popup.style.maxHeight = `${Math.max(0, viewportHeight - viewportGutter * 2)}px`;

		const availableBelow = Math.max(0, viewportHeight - viewportGutter - triggerRect.bottom - popupGap);
		const availableAbove = Math.max(0, triggerRect.top - viewportGutter - popupGap);
		const fullPopupHeight = popup.scrollHeight;
		const placeAbove = availableBelow < fullPopupHeight && availableAbove > availableBelow;
		const availableHeight = placeAbove ? availableAbove : availableBelow;
		popup.style.maxHeight = `${availableHeight}px`;

		const measuredRect = popup.getBoundingClientRect();
		const unclampedLeft = triggerRect.left;
		const maximumLeft = viewportWidth - viewportGutter - measuredRect.width;
		const left = Math.max(viewportGutter, Math.min(unclampedLeft, maximumLeft));
		const top = placeAbove
			? Math.max(viewportGutter, triggerRect.top - popupGap - measuredRect.height)
			: Math.min(viewportHeight - viewportGutter - measuredRect.height, triggerRect.bottom + popupGap);

		popup.style.left = `${left}px`;
		popup.style.top = `${Math.max(viewportGutter, top)}px`;

		const popupHeight = Math.ceil(popup.getBoundingClientRect().height);
		if (popupHeight !== reportedPopupHeight) {
			reportedPopupHeight = popupHeight;
			onOpenChange(true, popupHeight);
		}
	}

	function startOpenMonitoring(): void {
		if (monitoringOpenPopup) return;
		monitoringOpenPopup = true;
		document.addEventListener("scroll", schedulePosition, true);
		window.addEventListener("resize", schedulePosition);
		window.visualViewport?.addEventListener("resize", schedulePosition);
		window.visualViewport?.addEventListener("scroll", schedulePosition);
		resizeObserver = new ResizeObserver(schedulePosition);
		resizeObserver.observe(trigger);
		resizeObserver.observe(popup);
	}

	function stopOpenMonitoring(): void {
		if (!monitoringOpenPopup) return;
		monitoringOpenPopup = false;
		document.removeEventListener("scroll", schedulePosition, true);
		window.removeEventListener("resize", schedulePosition);
		window.visualViewport?.removeEventListener("resize", schedulePosition);
		window.visualViewport?.removeEventListener("scroll", schedulePosition);
		resizeObserver?.disconnect();
		resizeObserver = undefined;
		if (positionFrame !== 0) {
			cancelAnimationFrame(positionFrame);
			positionFrame = 0;
		}
	}

	function cancelPendingOpen(): void {
		if (!opening) return;
		generation += 1;
		stopPendingOpenMonitoring();
	}

	function handlePendingPointerDown(event: PointerEvent): void {
		const path = event.composedPath();
		if (!path.includes(trigger) && !path.includes(popup)) cancelPendingOpen();
	}

	function handlePendingKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		cancelPendingOpen();
	}

	function handleCompetingBeforeToggle(event: Event): void {
		const toggleEvent = event as ToggleEvent;
		if (event.target !== popup && toggleEvent.newState === "open") cancelPendingOpen();
	}

	function startPendingOpenMonitoring(): void {
		if (monitoringPendingOpen) return;
		monitoringPendingOpen = true;
		document.addEventListener("pointerdown", handlePendingPointerDown, true);
		document.addEventListener("keydown", handlePendingKeydown, true);
		document.addEventListener("beforetoggle", handleCompetingBeforeToggle, true);
	}

	function stopPendingOpenMonitoring(): void {
		if (!monitoringPendingOpen) return;
		monitoringPendingOpen = false;
		document.removeEventListener("pointerdown", handlePendingPointerDown, true);
		document.removeEventListener("keydown", handlePendingKeydown, true);
		document.removeEventListener("beforetoggle", handleCompetingBeforeToggle, true);
	}

	async function releaseLifecycle(lifecycle: DropdownLifecycle): Promise<void> {
		if (lifecycle.released) return;
		lifecycle.released = true;
		if (activeLifecycle === lifecycle) activeLifecycle = undefined;
		closing = true;
		try {
			await onAfterClose?.();
		} catch {
			// Closing must settle even when the owner cannot restore its native surface.
		} finally {
			closing = false;
		}
	}

	async function requestOpen(initialTypeahead?: string): Promise<void> {
		if (destroyed || unavailable || opening || closing) return;
		if (open || popup?.matches(":popover-open")) {
			if (initialTypeahead) applyTypeahead(initialTypeahead);
			void focusActiveOption();
			return;
		}

		const token = ++generation;
		opening = true;
		activeKey = initialActiveKey();
		clearTypeahead();
		if (initialTypeahead) applyTypeahead(initialTypeahead);
		startPendingOpenMonitoring();

		try {
			await onBeforeOpen?.();
		} catch {
			const cancellationWon = destroyed || token !== generation || unavailable;
			opening = false;
			stopPendingOpenMonitoring();
			if (cancellationWon) {
				await releaseLifecycle({ generation: token, released: false });
			}
			return;
		}

		const lifecycle: DropdownLifecycle = { generation: token, released: false };
		if (destroyed || token !== generation || unavailable) {
			opening = false;
			stopPendingOpenMonitoring();
			await releaseLifecycle(lifecycle);
			return;
		}

		activeLifecycle = lifecycle;
		opening = false;
		stopPendingOpenMonitoring();
		try {
			popup.showPopover();
			if (!popup.matches(":popover-open")) await releaseLifecycle(lifecycle);
		} catch {
			await releaseLifecycle(lifecycle);
		}
	}

	function requestClose(restoreFocus = false): void {
		if (opening) {
			cancelPendingOpen();
			return;
		}
		restoreFocusAfterClose ||= restoreFocus;
		if (popup?.matches(":popover-open")) {
			popup.hidePopover();
		} else if (!open && activeLifecycle) {
			void releaseLifecycle(activeLifecycle);
		}
	}

	function choose(option: DropdownOption): void {
		if (option.disabled) return;
		try {
			onSelect(option);
		} finally {
			requestClose(restoreFocusOnCommit);
		}
	}

	function handleTriggerPointerDown(): void {
		triggerWasOpenAtPointerDown = open || opening;
	}

	function handleTriggerClick(): void {
		if (triggerWasOpenAtPointerDown) {
			triggerWasOpenAtPointerDown = false;
			if (open) requestClose();
			return;
		}
		void requestOpen();
	}

	function handleTriggerKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape" && (open || opening)) {
			event.preventDefault();
			event.stopPropagation();
			requestClose(true);
			return;
		}
		if (event.key === "Tab" && (open || opening)) {
			if (opening) cancelPendingOpen();
			else queueMicrotask(() => requestClose());
			return;
		}
		if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			void requestOpen();
			return;
		}
		if (isPrintableKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			if (opening) applyTypeahead(event.key);
			else void requestOpen(event.key);
		}
	}

	function handleOptionKeydown(event: KeyboardEvent, option: DropdownOption): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			requestClose(true);
			return;
		}
		if (event.key === "Tab") {
			queueMicrotask(() => requestClose());
			return;
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			moveActive(1);
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			moveActive(-1);
			return;
		}
		if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			event.stopPropagation();
			focusOptionAt(event.key === "Home" ? 0 : enabledOptions().length - 1);
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			event.stopPropagation();
			choose(option);
			return;
		}
		if (isPrintableKey(event)) {
			event.preventDefault();
			event.stopPropagation();
			applyTypeahead(event.key);
		}
	}
	function handlePopupKeydown(event: KeyboardEvent): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			requestClose(true);
			return;
		}
		if (event.key === "Tab") {
			queueMicrotask(() => requestClose());
		}
	}


	function handleBeforeToggle(event: ToggleEvent): void {
		if (event.newState === "open" && (!activeLifecycle || destroyed || unavailable)) {
			event.preventDefault();
		}
	}

	function handleToggle(event: ToggleEvent): void {
		open = event.newState === "open";
		if (open) {
			reportedPopupHeight = -1;
			startOpenMonitoring();
			positionPopup();
			void focusActiveOption();
			return;
		}

		stopOpenMonitoring();
		clearTypeahead();
		reportedPopupHeight = 0;
		onOpenChange(false, 0);
		const lifecycle = activeLifecycle;
		const shouldRestoreFocus = restoreFocusAfterClose;
		restoreFocusAfterClose = false;
		const release = lifecycle ? releaseLifecycle(lifecycle) : Promise.resolve();
		if (shouldRestoreFocus && !destroyed && !trigger.disabled) {
			void release
				.catch(() => undefined)
				.then(() => {
					if (!destroyed && !trigger.disabled) queueMicrotask(() => trigger?.focus({ preventScroll: true }));
				});
		}
	}

	$effect(() => {
		if (import.meta.env.DEV) {
			const keys = new Set<string>();
			for (const option of options) {
				if (keys.has(option.key)) throw new Error(`CustomDropdown received duplicate option key: ${option.key}`);
				keys.add(option.key);
			}
		}
	});

	$effect(() => {
		const nextActiveKey = reconciledActiveKey();
		const activeKeyChanged = nextActiveKey !== activeKey;
		if (activeKeyChanged) activeKey = nextActiveKey;
		if (open) {
			schedulePosition();
			if (activeKeyChanged) void focusActiveOption();
		}
	});

	$effect(() => {
		if (!unavailable) return;
		if (opening) cancelPendingOpen();
		if (open) requestClose();
	});

	onDestroy(() => {
		destroyed = true;
		generation += 1;
		stopPendingOpenMonitoring();
		stopOpenMonitoring();
		clearTypeahead();
		const lifecycle = activeLifecycle;
		activeLifecycle = undefined;
		if (lifecycle) void releaseLifecycle(lifecycle);
	});
</script>

<div class="custom-dropdown" data-mode={mode} data-open={open} data-busy={internallyBusy || busy}>
	<button
		bind:this={trigger}
		id={triggerId}
		type="button"
		class="custom-dropdown-trigger"
		aria-label={ariaLabel}
		aria-haspopup={mode}
		aria-expanded={open}
		aria-controls={popupId}
		aria-busy={internallyBusy || busy}
		disabled={disabled || busy}
		onpointerdown={handleTriggerPointerDown}
		onclick={handleTriggerClick}
		onkeydown={handleTriggerKeydown}
	>
		<span class:custom-dropdown-placeholder={!selectedOption} class="custom-dropdown-trigger-label">
			{selectedOption?.label ?? placeholder}
		</span>
		{#if internallyBusy || busy}
			<span class="custom-dropdown-progress" aria-hidden="true"></span>
		{:else}
			<span class="custom-dropdown-chevron" aria-hidden="true">▾</span>
		{/if}
	</button>

	<div
		bind:this={popup}
		id={popupId}
		class="custom-dropdown-popup"
		popover="auto"
		role={mode}
		aria-labelledby={triggerId}
		tabindex="-1"
		onbeforetoggle={handleBeforeToggle}
		ontoggle={handleToggle}
		onkeydown={handlePopupKeydown}
	>
		{#if options.length === 0}
			<div class="custom-dropdown-empty">No options available</div>
		{:else}
			{#each options as option (option.key)}
				{@const optionId = optionDomId(option.key)}
				{@const optionDescriptionId = `${optionId}-description`}
				{@const isSelected = option.key === selectedKey}
				{@const isActive = option.key === activeKey && option.disabled !== true}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					id={optionId}
					class="custom-dropdown-option"
					class:is-active={isActive}
					class:is-selected={isSelected}
					class:is-disabled={option.disabled === true}
					role={mode === "listbox" ? "option" : "menuitemradio"}
					aria-selected={mode === "listbox" ? isSelected : undefined}
					aria-checked={mode === "menu" ? isSelected : undefined}
					aria-disabled={option.disabled === true}
					aria-describedby={option.description ? optionDescriptionId : undefined}
					tabindex={isActive ? -1 : undefined}
					onmouseenter={() => {
						if (!option.disabled) activeKey = option.key;
					}}
					onpointerdown={() => {
						if (!option.disabled) activeKey = option.key;
					}}
					onclick={() => choose(option)}
					onkeydown={(event) => handleOptionKeydown(event, option)}
				>
					<span class="custom-dropdown-choice" aria-hidden="true">{isSelected ? "✓" : ""}</span>
					{#if option.icon}
						<span class="custom-dropdown-icon" aria-hidden="true">{option.icon}</span>
					{/if}
					<span class="custom-dropdown-option-copy">
						<span class="custom-dropdown-option-label">{option.label}</span>
						{#if option.description}
							<span id={optionDescriptionId} class="custom-dropdown-option-description">
								{option.description}
							</span>
						{/if}
					</span>
				</div>
			{/each}
		{/if}
	</div>
</div>

<script lang="ts">
	import { onMount, tick, type Snippet } from "svelte";
	import { createSettingsSearch, type SettingsSearchEntry } from "../../settings-search";
	import type { DropdownOption, SettingsCategoryId, SettingsRoute } from "../../settings-types";
	import CustomDropdown from "../atoms/CustomDropdown.svelte";

	interface SettingsCategory {
		id: SettingsCategoryId;
		label: string;
	}

	interface SettingsCategoryScope {
		label: string;
		categories: readonly SettingsCategory[];
	}

	const SETTINGS_CATEGORY_SCOPES: readonly SettingsCategoryScope[] = [
		{
			label: "Session",
			categories: [{ id: "runtime", label: "Runtime" }],
		},
		{
			label: "OMP defaults",
			categories: [
				{ id: "omp-appearance", label: "Appearance" },
				{ id: "omp-model", label: "Model" },
				{ id: "omp-interaction", label: "Interaction" },
				{ id: "omp-context", label: "Context" },
				{ id: "omp-files", label: "Files" },
				{ id: "omp-shell", label: "Shell" },
				{ id: "omp-tools", label: "Tools" },
				{ id: "omp-tasks", label: "Tasks" },
			],
		},
		{
			label: "Access",
			categories: [{ id: "accounts", label: "Accounts" }],
		},
		{
			label: "Application",
			categories: [
				{ id: "app-appearance", label: "Appearance" },
				{ id: "app-behavior", label: "Behavior" },
				{ id: "terminal", label: "Terminal" },
				{ id: "browser", label: "Browser" },
				{ id: "workspace", label: "Workspace" },
			],
		},
	];
	const SETTINGS_CATEGORIES = SETTINGS_CATEGORY_SCOPES.flatMap(scope => scope.categories);
	const SETTINGS_CATEGORY_BY_ID = new Map(SETTINGS_CATEGORIES.map(category => [category.id, category] as const));
	const SETTINGS_SCOPE_BY_CATEGORY = new Map(
		SETTINGS_CATEGORY_SCOPES.flatMap(scope => scope.categories.map(category => [category.id, scope.label] as const)),
	);

	export let route: SettingsRoute;
	export let entries: readonly SettingsSearchEntry[] = [];
	export let refreshing = false;
	export let onQueryChange: (query: string) => void;
	export let onCategoryChange: (category: SettingsCategoryId) => void;
	export let onRefresh: () => void;
	export let onClose: () => void;
	export let content: Snippet<[ReadonlySet<string>]>;

	let searchInput: HTMLInputElement | undefined;
	let categoryHeading: HTMLHeadingElement | undefined;
	let requestedAutomaticCategory: SettingsCategoryId | undefined;

	$: indexedEntries = entries.map(entry => {
		const category = SETTINGS_CATEGORY_BY_ID.get(entry.category as SettingsCategoryId);
		const scope = SETTINGS_SCOPE_BY_CATEGORY.get(entry.category as SettingsCategoryId);
		return {
			...entry,
			keywords: [...(entry.keywords ?? []), ...(category ? [category.label] : []), ...(scope ? [scope] : [])],
		};
	});
	$: searchIndex = createSettingsSearch(indexedEntries);
	$: searchResult = searchIndex.search(route.query);
	$: hasSearchQuery = searchResult.query.length > 0;
	$: noSearchResults = hasSearchQuery && searchResult.totalCount === 0;
	$: visibleSettingIds = new Set(searchResult.entries.map(entry => entry.id));
	$: matchingCategoryCount = SETTINGS_CATEGORIES.filter(
		category => (searchResult.categoryCounts[category.id] ?? 0) > 0,
	).length;
	$: activeCategory = SETTINGS_CATEGORY_BY_ID.get(route.activeCategory) ?? SETTINGS_CATEGORIES[0]!;
	$: automaticCategory = hasSearchQuery && searchResult.totalCount > 0 &&
		(searchResult.categoryCounts[route.activeCategory] ?? 0) === 0
		? SETTINGS_CATEGORIES.find(category => (searchResult.categoryCounts[category.id] ?? 0) > 0)?.id
		: undefined;
	$: if (automaticCategory && automaticCategory !== requestedAutomaticCategory) {
		requestedAutomaticCategory = automaticCategory;
		onCategoryChange(automaticCategory);
	}
	$: if (!automaticCategory && requestedAutomaticCategory !== undefined) {
		requestedAutomaticCategory = undefined;
	}
	$: categoryOptions = SETTINGS_CATEGORIES.map(category => {
		const count = searchResult.categoryCounts[category.id] ?? 0;
		const scope = SETTINGS_SCOPE_BY_CATEGORY.get(category.id);
		return {
			key: category.id,
			value: category.id,
			label: hasSearchQuery ? `${category.label} (${count})` : category.label,
			...(scope === undefined ? {} : { description: scope }),
			disabled: hasSearchQuery && count === 0,
		} satisfies DropdownOption;
	});
	$: liveAnnouncement = `${searchResult.totalCount} ${searchResult.totalCount === 1 ? "setting" : "settings"} in ${matchingCategoryCount} ${matchingCategoryCount === 1 ? "category" : "categories"}`;

	onMount(() => {
		void focusSearch();
	});

	async function focusSearch(): Promise<void> {
		await tick();
		searchInput?.focus({ preventScroll: true });
	}

	async function selectCategory(category: SettingsCategoryId): Promise<void> {
		onCategoryChange(category);
		await tick();
		categoryHeading?.focus({ preventScroll: true });
		categoryHeading?.scrollIntoView({ block: "start" });
	}

	function clearSearch(): void {
		onQueryChange("");
		void focusSearch();
	}
</script>

<main class="settings-shell" aria-labelledby="settings-title">
	<header class="settings-shell-toolbar">
		<h1 id="settings-title">Settings</h1>
		<label class="settings-search">
			<span class="sr-only">Search settings</span>
			<input
				bind:this={searchInput}
				type="search"
				placeholder="Search settings"
				value={route.query}
				oninput={(event) => onQueryChange(event.currentTarget.value)}
			/>
			{#if route.query}
				<button type="button" class="settings-search-clear" aria-label="Clear settings search" onclick={clearSearch}>Clear</button>
			{/if}
		</label>
		<div class="settings-shell-actions">
			<button type="button" class="secondary-button" disabled={refreshing} aria-busy={refreshing} onclick={onRefresh}>
				{refreshing ? "Refreshing…" : "Refresh"}
			</button>
			<button type="button" class="secondary-button" onclick={onClose}>Back to workspace</button>
		</div>
		<p class="sr-only" role="status" aria-live="polite">{liveAnnouncement}</p>
	</header>

	<div class="settings-shell-body">
		<aside class="settings-sidebar">
			<nav aria-label="Settings categories">
				{#each SETTINGS_CATEGORY_SCOPES as scope (scope.label)}
					<section class="settings-category-scope" aria-labelledby={`settings-scope-${scope.label.replaceAll(" ", "-").toLowerCase()}`}>
						<h2 id={`settings-scope-${scope.label.replaceAll(" ", "-").toLowerCase()}`}>{scope.label}</h2>
						<div class="settings-category-list">
							{#each scope.categories as category (category.id)}
								{@const count = searchResult.categoryCounts[category.id] ?? 0}
								<button
									type="button"
									class:has-search-match={hasSearchQuery && count > 0}
									aria-current={route.activeCategory === category.id ? "page" : undefined}
									disabled={hasSearchQuery && count === 0}
									onclick={() => void selectCategory(category.id)}
								>
									<span>{category.label}</span>
									{#if hasSearchQuery && count > 0}
										<span class="settings-category-count" aria-label={`${count} ${count === 1 ? "match" : "matches"}`}>{count}</span>
									{/if}
								</button>
							{/each}
						</div>
					</section>
				{/each}
			</nav>
		</aside>

		<div class="settings-mobile-category">
			<CustomDropdown
				options={categoryOptions}
				selectedKey={route.activeCategory}
				ariaLabel="Settings category"
				restoreFocusOnCommit={false}
				onSelect={(option) => void selectCategory(option.value as SettingsCategoryId)}
				onOpenChange={() => undefined}
			/>
		</div>

		<section
			class="settings-shell-content"
			aria-labelledby={noSearchResults ? undefined : "settings-category-title"}
			aria-label={noSearchResults ? "Settings search results" : undefined}
		>
			{#if noSearchResults}
				<div class="settings-no-results" role="status">
					<strong>No settings match “{route.query}”</strong>
					<p>Try a shorter term or clear the search to browse every category.</p>
					<button type="button" class="secondary-button" onclick={clearSearch}>Clear search</button>
				</div>
			{:else}
				<header class="settings-content-heading">
					<span>{SETTINGS_SCOPE_BY_CATEGORY.get(activeCategory.id)}</span>
					<h2 bind:this={categoryHeading} id="settings-category-title" tabindex="-1">{activeCategory.label}</h2>
					{#if hasSearchQuery}
						<p>{searchResult.categoryCounts[activeCategory.id] ?? 0} {(searchResult.categoryCounts[activeCategory.id] ?? 0) === 1 ? "matching setting" : "matching settings"}</p>
					{/if}
				</header>
				{@render content(visibleSettingIds)}
			{/if}
		</section>
	</div>
</main>

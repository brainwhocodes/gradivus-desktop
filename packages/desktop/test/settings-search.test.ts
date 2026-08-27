import { describe, expect, it } from "vitest";
import {
	createSettingsSearch,
	normalizeSettingsSearchText,
	SettingsSearch,
	type SettingsSearchEntry,
} from "../src/renderer/settings-search";

function entry(
	overrides: Partial<SettingsSearchEntry> & Pick<SettingsSearchEntry, "id" | "category" | "label">,
): SettingsSearchEntry {
	return {
		group: "General",
		description: "",
		keywords: [],
		...overrides,
	};
}

describe("settings search", () => {
	it("returns stable blank-query order and counts every category", () => {
		const entries = [
			entry({ id: "b", category: "omp-model", label: "Model", sourceOrder: 0 }),
			entry({ id: "a", category: "runtime", label: "Runtime", sourceOrder: -1 }),
			entry({ id: "c", category: "omp-model", label: "Thinking", sourceOrder: -2 }),
		];

		const result = new SettingsSearch(entries).search("   ");
		expect(result.entries.map(item => item.id)).toEqual(["b", "a", "c"]);
		expect(result.categoryCounts).toEqual({ "omp-model": 2, runtime: 1 });
		expect(result.totalCount).toBe(3);
	});

	it("matches literal substrings independently in label, description, and keywords", () => {
		const search = createSettingsSearch([
			entry({ id: "label", category: "runtime", label: "Model Role" }),
			entry({
				id: "description",
				category: "omp-model",
				label: "Default",
				description: "Choose the model role for new sessions",
			}),
			entry({ id: "keyword", category: "omp-tools", label: "Tools", keywords: ["Model role", "Provider"] }),
		]);

		const result = search.search("model role");
		expect(result.entries.map(item => item.id)).toEqual(["label", "keyword", "description"]);
		expect(result.categoryCounts).toEqual({ runtime: 1, "omp-model": 1, "omp-tools": 1 });
	});

	it("never joins separate fields when confirming a match", () => {
		const search = new SettingsSearch([
			entry({ id: "split", category: "runtime", label: "hello", description: "world" }),
			entry({ id: "joined", category: "runtime", label: "hello world" }),
		]);

		expect(search.search("helloworld").entries.map(item => item.id)).toEqual([]);
		expect(search.search("hello world").entries.map(item => item.id)).toEqual(["joined"]);
	});

	it("normalizes camel case, punctuation, and short queries deterministically", () => {
		const search = new SettingsSearch([
			entry({ id: "camel", category: "omp-files", label: "FuzzyThreshold" }),
			entry({ id: "short", category: "omp-files", label: "Read" }),
		]);

		expect(normalizeSettingsSearchText("XMLParser v2Mode")).toBe("xml parser v2 mode");
		expect(search.search("fuzzy-threshold").entries.map(item => item.id)).toEqual(["camel"]);
		expect(search.search("re").entries.map(item => item.id)).toEqual(["short", "camel"]);
	});

	it("indexes typed metadata and Unicode code points without joining fields", () => {
		const search = new SettingsSearch([
			entry({
				id: "numeric",
				category: "omp-tasks",
				label: "Max concurrency",
				group: "Task limits",
				path: "task.maxConcurrency",
				apply: "next-session",
				optionLabels: ["Unlimited", "8"],
			}),
			entry({
				id: "astral",
				category: "runtime",
				label: "𐐀 model",
				description: "Astral provider",
			}),
		]);

		expect(search.search("max concurrency").entries.map(item => item.id)).toEqual(["numeric"]);
		expect(search.search("unlimited").entries.map(item => item.id)).toEqual(["numeric"]);
		expect(search.search("next session").entries.map(item => item.id)).toEqual(["numeric"]);
		expect(search.search("𐐀").entries.map(item => item.id)).toEqual(["astral"]);
	});

	it("rebuilds the source revision without retaining removed entries", () => {
		const search = new SettingsSearch([entry({ id: "old", category: "runtime", label: "Old setting" })]);
		expect(search.search("old").entries.map(item => item.id)).toEqual(["old"]);

		search.index([entry({ id: "new", category: "runtime", label: "New setting" })]);

		expect(search.search("old").entries).toEqual([]);
		expect(search.search("new").entries.map(item => item.id)).toEqual(["new"]);
	});

	it("authoritatively rejects Bloom false positives caused by deliberate collisions", () => {
		const triples: string[] = [];
		for (let first = 97; first <= 122; first += 1) {
			for (let second = 97; second <= 122; second += 1) {
				for (let third = 97; third <= 122; third += 1) {
					const triple = String.fromCharCode(first, second, third);
					if (triple !== "qzx") triples.push(triple);
				}
			}
		}

		const search = new SettingsSearch([
			entry({ id: "collision", category: "omp-tools", label: "Tools", keywords: [triples.join(" ")] }),
		]);
		expect(search.search("qzx").entries).toEqual([]);
	});

	it("ranks exact, prefix, substring, secondary, and descriptive matches with stable ties", () => {
		const search = new SettingsSearch([
			entry({
				id: "description",
				category: "runtime",
				label: "Other",
				description: "Configure model behavior",
				sourceOrder: 0,
			}),
			entry({ id: "substring", category: "runtime", label: "Current Model Provider", sourceOrder: 4 }),
			entry({ id: "prefix", category: "runtime", label: "Model Defaults", sourceOrder: 3 }),
			entry({ id: "exact-late", category: "omp-model", label: "Model", sourceOrder: 8 }),
			entry({ id: "secondary", category: "omp-tools", label: "Other", group: "Model controls", sourceOrder: 1 }),
			entry({ id: "exact-early", category: "omp-model", label: "Model", sourceOrder: 2 }),
			entry({ id: "unmatched", category: "accounts", label: "Security", sourceOrder: 9 }),
		]);
		expect(search.search("model").entries.map(item => item.id)).toEqual([
			"exact-early",
			"exact-late",
			"prefix",
			"substring",
			"secondary",
			"description",
		]);
		expect(search.search("model").categoryCounts).toEqual({
			runtime: 3,
			"omp-model": 2,
			"omp-tools": 1,
			accounts: 0,
		});
	});
});

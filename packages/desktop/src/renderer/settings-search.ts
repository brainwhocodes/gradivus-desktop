export interface SettingsSearchEntry {
	id: string;
	category: string;
	group: string;
	label: string;
	description: string;
	/** Optional compatibility keywords for static settings copy. */
	keywords?: readonly string[];
	/** Optional field used by settings integrations that expose a setting path. */
	path?: string;
	/** Optional visible option labels for dynamic controls. */
	optionLabels?: readonly string[];
	/** Apply scope, when the indexed setting has one. */
	apply?: string;
	/** Explicit tie-break order supplied by a source catalog. */
	sourceOrder?: number;
}

export interface SettingsSearchResult {
	query: string;
	entries: readonly SettingsSearchEntry[];
	categoryCounts: Readonly<Record<string, number>>;
	totalCount: number;
}

const BLOOM_WORD_BITS = 4096;
const BLOOM_WORDS = BLOOM_WORD_BITS / 32;
const BLOOM_MASK = BLOOM_WORD_BITS - 1;
const BLOOM_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const;
const NON_WORD_RUN = /[^\p{L}\p{M}\p{N}]+/gu;
const LOWER_TO_UPPER = /([\p{Ll}\p{M}\p{N}])(?=\p{Lu})/gu;
const ACRONYM_BOUNDARY = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;

/**
 * Normalize the same way for corpus and query. Boundary insertion happens before
 * lowercasing so acronym and camel-case words remain searchable as phrases.
 */
export function normalizeSettingsSearchText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(ACRONYM_BOUNDARY, "$1 $2")
		.replace(LOWER_TO_UPPER, "$1 ")
		.toLowerCase()
		.replace(NON_WORD_RUN, " ")
		.trim()
		.replace(/\s+/gu, " ");
}

export const normalizeSearchText = normalizeSettingsSearchText;

type SearchFieldKind = "label" | "secondary" | "description";

interface SearchField {
	kind: SearchFieldKind;
	text: string;
}

interface IndexedEntry {
	entry: SettingsSearchEntry;
	fields: readonly SearchField[];
	bloom: Uint32Array;
	inputOrder: number;
	sourceOrder: number;
}

function codePoints(value: string): readonly number[] {
	return Array.from(value, character => character.codePointAt(0) ?? 0);
}

function hashTrigram(trigram: readonly number[], seed: number): number {
	let hash = seed >>> 0;
	for (const codePoint of trigram) {
		hash ^= codePoint;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function setBloomBit(bitset: Uint32Array, bit: number): void {
	const word = bit >>> 5;
	bitset[word] |= 1 << (bit & 31);
}

function hasBloomBit(bitset: Uint32Array, bit: number): boolean {
	const word = bit >>> 5;
	return (bitset[word] & (1 << (bit & 31))) !== 0;
}

function addFieldTrigrams(bitset: Uint32Array, text: string): void {
	const points = codePoints(text);
	for (let index = 0; index + 2 < points.length; index += 1) {
		const trigram = points.slice(index, index + 3);
		for (const seed of BLOOM_SEEDS) {
			setBloomBit(bitset, hashTrigram(trigram, seed) & BLOOM_MASK);
		}
	}
}

function hasPossibleTrigrams(bitset: Uint32Array, query: string): boolean {
	const points = codePoints(query);
	if (points.length < 3) return true;
	for (let index = 0; index + 2 < points.length; index += 1) {
		const trigram = points.slice(index, index + 3);
		for (const seed of BLOOM_SEEDS) {
			if (!hasBloomBit(bitset, hashTrigram(trigram, seed) & BLOOM_MASK)) return false;
		}
	}
	return true;
}

function fieldsFor(entry: SettingsSearchEntry): readonly SearchField[] {
	const fields: SearchField[] = [
		{ kind: "label", text: normalizeSettingsSearchText(entry.label) },
		{ kind: "description", text: normalizeSettingsSearchText(entry.description) },
	];
	for (const keyword of entry.keywords ?? []) {
		fields.push({ kind: "description", text: normalizeSettingsSearchText(keyword) });
	}
	for (const optionLabel of entry.optionLabels ?? []) {
		fields.push({ kind: "description", text: normalizeSettingsSearchText(optionLabel) });
	}
	for (const value of [entry.path, entry.group, entry.category, entry.apply]) {
		if (value !== undefined) fields.push({ kind: "secondary", text: normalizeSettingsSearchText(value) });
	}
	return fields;
}

function createIndex(entry: SettingsSearchEntry, inputOrder: number): IndexedEntry {
	const fields = fieldsFor(entry);
	const bloom = new Uint32Array(BLOOM_WORDS);
	for (const field of fields) addFieldTrigrams(bloom, field.text);
	return {
		entry,
		fields,
		bloom,
		inputOrder,
		sourceOrder: Number.isFinite(entry.sourceOrder) ? (entry.sourceOrder as number) : inputOrder,
	};
}

interface MatchScore {
	fieldRank: number;
	offset: number;
}

function matchScore(record: IndexedEntry, query: string): MatchScore | undefined {
	if (!hasPossibleTrigrams(record.bloom, query)) return undefined;

	let best: MatchScore | undefined;
	for (const field of record.fields) {
		if (!field.text.includes(query)) continue;
		const offset = field.text.indexOf(query);

		let fieldRank: number;
		if (field.kind === "label") {
			fieldRank = field.text === query ? 0 : field.text.startsWith(query) ? 1 : 2;
		} else if (field.kind === "secondary") {
			fieldRank = 3;
		} else {
			fieldRank = 4;
		}

		const score = { fieldRank, offset };
		if (
			best === undefined ||
			score.fieldRank < best.fieldRank ||
			(score.fieldRank === best.fieldRank && score.offset < best.offset)
		) {
			best = score;
		}
	}
	return best;
}

function emptyCounts(categories: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const category of categories) {
		if (!(category in counts)) counts[category] = 0;
	}
	return counts;
}

export class SettingsSearch {
	private records: readonly IndexedEntry[] = [];
	private categories: readonly string[] = [];

	constructor(entries: readonly SettingsSearchEntry[] = []) {
		this.index(entries);
	}

	static build(entries: readonly SettingsSearchEntry[]): SettingsSearch {
		return new SettingsSearch(entries);
	}

	/** Replace the indexed revision and return this instance for fluent setup. */
	index(entries: readonly SettingsSearchEntry[]): this {
		const categories: string[] = [];
		const seenCategories = new Set<string>();
		this.records = entries.map((entry, inputOrder) => {
			if (!seenCategories.has(entry.category)) {
				seenCategories.add(entry.category);
				categories.push(entry.category);
			}
			return createIndex(entry, inputOrder);
		});
		this.categories = categories;
		return this;
	}

	/** Alias for index(), useful when a dynamic settings source is rebuilt. */
	build(entries: readonly SettingsSearchEntry[]): this {
		return this.index(entries);
	}

	search(query: string): SettingsSearchResult {
		const normalizedQuery = normalizeSettingsSearchText(query);
		const counts = emptyCounts(this.categories);

		if (normalizedQuery.length === 0) {
			const entries = this.records.map(record => record.entry);
			for (const entry of entries) counts[entry.category] += 1;
			return { query: normalizedQuery, entries, categoryCounts: counts, totalCount: entries.length };
		}

		const matches: Array<{ record: IndexedEntry; score: MatchScore }> = [];
		for (const record of this.records) {
			const score = matchScore(record, normalizedQuery);
			if (score === undefined) continue;
			matches.push({ record, score });
			counts[record.entry.category] += 1;
		}

		matches.sort((left, right) => {
			if (left.score.fieldRank !== right.score.fieldRank) return left.score.fieldRank - right.score.fieldRank;
			if (left.score.offset !== right.score.offset) return left.score.offset - right.score.offset;
			if (left.record.sourceOrder !== right.record.sourceOrder)
				return left.record.sourceOrder - right.record.sourceOrder;
			return left.record.inputOrder - right.record.inputOrder;
		});

		const entries = matches.map(match => match.record.entry);
		return { query: normalizedQuery, entries, categoryCounts: counts, totalCount: entries.length };
	}
}

export function createSettingsSearch(entries: readonly SettingsSearchEntry[] = []): SettingsSearch {
	return new SettingsSearch(entries);
}

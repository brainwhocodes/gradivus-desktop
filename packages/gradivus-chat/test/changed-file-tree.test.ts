import { describe, expect, it } from "vitest";
import {
	buildChangedFileTree,
	collectChangedFileDirectoryIds,
	collectChangedFileLeaves,
	flattenChangedFileTree,
} from "../src/lib/changed-file-tree";
import type { HostedTimelineFileChange as TimelineFileChange } from "../src/lib/contracts";

function change(path: string, operation: TimelineFileChange["operation"] = "edit"): TimelineFileChange {
	return { path, operation };
}

describe("changed file tree", () => {
	it("normalizes separators, keeps the latest path entry, and sorts folders before files", () => {
		const nodes = buildChangedFileTree([
			change("zeta.ts"),
			change("src\\z-last.ts"),
			change("alpha.ts"),
			change("src/a-first.ts", "write"),
			change("assets/hero.png", "write"),
			change("src/a-first.ts", "edit"),
		]);

		expect(nodes.map(node => `${node.kind}:${node.name}`)).toEqual([
			"directory:assets",
			"directory:src",
			"file:alpha.ts",
			"file:zeta.ts",
		]);
		expect(collectChangedFileLeaves(nodes).map(leaf => [leaf.path, leaf.file.operation])).toEqual([
			["assets/hero.png", "write"],
			["src/a-first.ts", "edit"],
			["src/z-last.ts", "edit"],
			["alpha.ts", "edit"],
			["zeta.ts", "edit"],
		]);
	});

	it("flattens only expanded directory branches with parent and depth metadata", () => {
		const nodes = buildChangedFileTree([change("src/ui/panel.ts"), change("src/main.ts"), change("README.md")]);
		const allDirectoryIds = collectChangedFileDirectoryIds(nodes);
		const collapsed = flattenChangedFileTree(nodes, new Set());
		const srcExpanded = flattenChangedFileTree(nodes, new Set(["directory:src"]));
		const allExpanded = flattenChangedFileTree(nodes, new Set(allDirectoryIds));

		expect(collapsed.map(row => [row.node.name, row.depth])).toEqual([
			["src", 1],
			["README.md", 1],
		]);
		expect(srcExpanded.map(row => [row.node.name, row.depth, row.parentId])).toEqual([
			["src", 1, undefined],
			["ui", 2, "directory:src"],
			["main.ts", 2, "directory:src"],
			["README.md", 1, undefined],
		]);
		expect(allExpanded.map(row => row.node.name)).toEqual(["src", "ui", "panel.ts", "main.ts", "README.md"]);
	});

	it("groups generated artifacts without losing distinct outputs that share a filename", () => {
		const first = change("@artifacts/first/preview.png", "generate");
		const second = change("@artifacts/second/preview.png", "generate");
		const nodes = buildChangedFileTree([first, second, change("assets/preview.png", "write")]);
		const generated = nodes.find(node => node.id === "generated:@artifacts");
		expect(generated?.kind).toBe("directory");
		if (generated?.kind !== "directory") throw new Error("Missing generated group");
		expect(collectChangedFileLeaves(generated.children).map(leaf => [leaf.name, leaf.file.path])).toEqual([
			["preview.png", first.path],
			["preview.png", second.path],
		]);
		expect(
			collectChangedFileLeaves(nodes)
				.map(leaf => leaf.file.path)
				.sort(),
		).toEqual([first.path, second.path, "assets/preview.png"].sort());
	});
});

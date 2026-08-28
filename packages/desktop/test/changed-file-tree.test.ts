import { describe, expect, it } from "vitest";
import {
	buildChangedFileTree,
	collectChangedFileDirectoryIds,
	collectChangedFileLeaves,
	fileDispositionLabel,
	flattenChangedFileTree,
	isRasterImagePath,
} from "../src/renderer/changed-file-tree";
import type { TimelineFileChange } from "../src/shared/contracts";

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

	it("recognizes the supported raster image leaves without an extension icon taxonomy", () => {
		for (const path of ["hero.PNG", "photo.jpg", "photo.jpeg", "animation.gif", "preview.webp"]) {
			expect(isRasterImagePath(path), path).toBe(true);
		}
		for (const path of ["vector.svg", "design.avif", "notes.md", "png"]) {
			expect(isRasterImagePath(path), path).toBe(false);
		}
	});

	it("uses truthful disposition labels for current and historical changes", () => {
		expect(fileDispositionLabel({ path: "new.ts", operation: "write", disposition: "created" })).toBe("Created");
		expect(fileDispositionLabel({ path: "old.ts", operation: "write", disposition: "edited" })).toBe("Edited");
		expect(fileDispositionLabel(change("patched.ts", "edit"))).toBe("Edited");
		expect(fileDispositionLabel(change("historical.ts", "write"))).toBe("Written");
	});
});

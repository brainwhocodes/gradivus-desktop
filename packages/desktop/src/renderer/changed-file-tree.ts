import type { TimelineFileChange } from "../shared/contracts";

export type ChangedFileTreeNode = ChangedFileTreeDirectory | ChangedFileTreeLeaf;

export interface ChangedFileTreeDirectory {
	kind: "directory";
	id: string;
	name: string;
	path: string;
	children: ChangedFileTreeNode[];
}

export interface ChangedFileTreeLeaf {
	kind: "file";
	id: string;
	name: string;
	path: string;
	file: TimelineFileChange;
}

export interface ChangedFileTreeRow {
	node: ChangedFileTreeNode;
	depth: number;
	parentId?: string;
}

interface MutableDirectory {
	name: string;
	path: string;
	directories: Map<string, MutableDirectory>;
	files: Map<string, TimelineFileChange>;
}

const RASTER_IMAGE_EXTENSION = /\.(?:gif|jpe?g|png|webp)$/i;
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function normalizedSegments(path: string): string[] {
	return path
		.replaceAll("\\", "/")
		.split("/")
		.filter(segment => segment.length > 0 && segment !== ".");
}

function normalizedPath(path: string): string {
	return normalizedSegments(path).join("/");
}

function createMutableDirectory(name: string, path: string): MutableDirectory {
	return { name, path, directories: new Map(), files: new Map() };
}

function sortNodes(first: ChangedFileTreeNode, second: ChangedFileTreeNode): number {
	if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
	return NAME_COLLATOR.compare(first.name, second.name) || first.path.localeCompare(second.path);
}

function finalizeDirectory(directory: MutableDirectory): ChangedFileTreeNode[] {
	const nodes: ChangedFileTreeNode[] = [];
	for (const child of directory.directories.values()) {
		nodes.push({
			kind: "directory",
			id: `directory:${child.path}`,
			name: child.name,
			path: child.path,
			children: finalizeDirectory(child),
		});
	}
	for (const [name, file] of directory.files) {
		const path = normalizedPath(file.path);
		nodes.push({ kind: "file", id: `file:${path}`, name, path, file });
	}
	return nodes.sort(sortNodes);
}

export function buildChangedFileTree(files: readonly TimelineFileChange[]): ChangedFileTreeNode[] {
	const latestByPath = new Map<string, TimelineFileChange>();
	for (const file of files) {
		const path = normalizedPath(file.path);
		if (!path) continue;
		latestByPath.delete(path);
		latestByPath.set(path, file);
	}

	const root = createMutableDirectory("", "");
	for (const [path, file] of latestByPath) {
		const segments = path.split("/");
		const fileName = segments.pop();
		if (!fileName) continue;
		let directory = root;
		for (const segment of segments) {
			const childPath = directory.path ? `${directory.path}/${segment}` : segment;
			let child = directory.directories.get(segment);
			if (!child) {
				child = createMutableDirectory(segment, childPath);
				directory.directories.set(segment, child);
			}
			directory = child;
		}
		directory.files.set(fileName, file);
	}
	return finalizeDirectory(root);
}

function appendChangedFileLeaves(nodes: readonly ChangedFileTreeNode[], leaves: ChangedFileTreeLeaf[]): void {
	for (const node of nodes) {
		if (node.kind === "file") leaves.push(node);
		else appendChangedFileLeaves(node.children, leaves);
	}
}

export function collectChangedFileLeaves(nodes: readonly ChangedFileTreeNode[]): ChangedFileTreeLeaf[] {
	const leaves: ChangedFileTreeLeaf[] = [];
	appendChangedFileLeaves(nodes, leaves);
	return leaves;
}

function appendChangedFileDirectoryIds(nodes: readonly ChangedFileTreeNode[], ids: string[]): void {
	for (const node of nodes) {
		if (node.kind !== "directory") continue;
		ids.push(node.id);
		appendChangedFileDirectoryIds(node.children, ids);
	}
}

export function collectChangedFileDirectoryIds(nodes: readonly ChangedFileTreeNode[]): string[] {
	const ids: string[] = [];
	appendChangedFileDirectoryIds(nodes, ids);
	return ids;
}

function appendChangedFileTreeRows(
	nodes: readonly ChangedFileTreeNode[],
	expandedDirectoryIds: ReadonlySet<string>,
	rows: ChangedFileTreeRow[],
	depth: number,
	parentId?: string,
): void {
	for (const node of nodes) {
		rows.push({ node, depth, parentId });
		if (node.kind === "directory" && expandedDirectoryIds.has(node.id)) {
			appendChangedFileTreeRows(node.children, expandedDirectoryIds, rows, depth + 1, node.id);
		}
	}
}

export function flattenChangedFileTree(
	nodes: readonly ChangedFileTreeNode[],
	expandedDirectoryIds: ReadonlySet<string>,
	depth = 1,
	parentId?: string,
): ChangedFileTreeRow[] {
	const rows: ChangedFileTreeRow[] = [];
	appendChangedFileTreeRows(nodes, expandedDirectoryIds, rows, depth, parentId);
	return rows;
}

export function isRasterImagePath(path: string): boolean {
	return RASTER_IMAGE_EXTENSION.test(path);
}

export function fileDispositionLabel(file: TimelineFileChange): "Created" | "Edited" | "Written" {
	if (file.operation === "edit" || file.disposition === "edited") return "Edited";
	if (file.disposition === "created") return "Created";
	return "Written";
}

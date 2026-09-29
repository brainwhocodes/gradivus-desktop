export type WorkspaceFileKind = "image" | "video" | "audio" | "document" | "code" | "other";

const IMAGE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	tif: "image/tiff",
	tiff: "image/tiff",
	heic: "image/heic",
	heif: "image/heif",
};
const VIDEO: Record<string, string> = {
	mp4: "video/mp4",
	m4v: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	ogv: "video/ogg",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	mpeg: "video/mpeg",
	mpg: "video/mpeg",
	wmv: "video/x-ms-wmv",
};
const AUDIO: Record<string, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	wave: "audio/wav",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	opus: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	flac: "audio/flac",
	aiff: "audio/aiff",
	aif: "audio/aiff",
	wma: "audio/x-ms-wma",
	mid: "audio/midi",
	midi: "audio/midi",
};
const DOCUMENT: Record<string, string> = {
	txt: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	mdx: "text/markdown",
	rst: "text/plain",
	log: "text/plain",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	pdf: "application/pdf",
	rtf: "application/rtf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	epub: "application/epub+zip",
};
const CODE: Record<string, string> = {
	js: "text/javascript",
	jsx: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	ts: "text/typescript",
	tsx: "text/typescript",
	mts: "text/typescript",
	cts: "text/typescript",
	json: "application/json",
	jsonc: "application/json",
	jsonl: "application/x-ndjson",
	ndjson: "application/x-ndjson",
	yaml: "text/yaml",
	yml: "text/yaml",
	toml: "text/plain",
	ini: "text/plain",
	conf: "text/plain",
	cfg: "text/plain",
	env: "text/plain",
	html: "text/html",
	htm: "text/html",
	xml: "application/xml",
	css: "text/css",
	scss: "text/x-scss",
	sass: "text/x-sass",
	less: "text/plain",
	svelte: "text/plain",
	vue: "text/plain",
	astro: "text/plain",
	py: "text/x-python",
	pyi: "text/x-python",
	rs: "text/x-rust",
	go: "text/x-go",
	java: "text/x-java",
	kt: "text/plain",
	kts: "text/plain",
	swift: "text/plain",
	c: "text/x-c",
	h: "text/x-c",
	cc: "text/x-c++",
	cpp: "text/x-c++",
	cxx: "text/x-c++",
	hpp: "text/x-c++",
	cs: "text/plain",
	rb: "text/x-ruby",
	php: "text/x-php",
	sh: "text/x-shellscript",
	bash: "text/x-shellscript",
	zsh: "text/x-shellscript",
	ps1: "text/plain",
	bat: "text/plain",
	cmd: "text/plain",
	sql: "text/plain",
	graphql: "text/plain",
	gql: "text/plain",
	lua: "text/plain",
	r: "text/plain",
	jl: "text/plain",
	dart: "text/plain",
	ex: "text/plain",
	exs: "text/plain",
	erl: "text/plain",
	clj: "text/plain",
	scala: "text/plain",
	proto: "text/plain",
	lock: "text/plain",
	gitignore: "text/plain",
	gitattributes: "text/plain",
	dockerignore: "text/plain",
	editorconfig: "text/plain",
	srt: "text/plain",
	vtt: "text/vtt",
	ass: "text/plain",
	diff: "text/plain",
	patch: "text/plain",
	tex: "text/plain",
};
const TEXT_NAMES: Record<string, true> = {
	dockerfile: true,
	containerfile: true,
	makefile: true,
	gnumakefile: true,
	"cmakelists.txt": true,
	license: true,
	licence: true,
	readme: true,
	changelog: true,
	justfile: true,
	procfile: true,
};

function filename(path: string): string {
	return path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}
function extension(path: string): string {
	const name = filename(path);
	return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}
function lookup(table: Record<string, string>, key: string): string | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}
export function workspaceFileKind(path: string): WorkspaceFileKind {
	const ext = extension(path);
	if (lookup(IMAGE, ext)) return "image";
	if (lookup(VIDEO, ext)) return "video";
	if (lookup(AUDIO, ext)) return "audio";
	if (lookup(DOCUMENT, ext)) return "document";
	if (lookup(CODE, ext) || Object.hasOwn(TEXT_NAMES, filename(path))) return "code";
	return "other";
}
export function workspaceFileMimeType(path: string): string {
	const ext = extension(path);
	return (
		lookup(IMAGE, ext) ??
		lookup(VIDEO, ext) ??
		lookup(AUDIO, ext) ??
		lookup(DOCUMENT, ext) ??
		lookup(CODE, ext) ??
		(Object.hasOwn(TEXT_NAMES, filename(path)) ? "text/plain" : "application/octet-stream")
	);
}
export function isTextWorkspaceFile(path: string): boolean {
	return workspaceFileKind(path) === "code" || workspaceFileMimeType(path).startsWith("text/");
}

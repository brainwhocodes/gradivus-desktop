declare module "*.scss" {
	const classes: Record<string, string>;
	export default classes;
}
declare module "*.css" {
	const classes: Record<string, string>;
	export default classes;
}
declare module "@wterm/dom/css" {
	const content: string;
	export default content;
}
declare module "*?url" {
	const url: string;
	export default url;
}
declare module "*.md" {
	const content: string;
	export default content;
}

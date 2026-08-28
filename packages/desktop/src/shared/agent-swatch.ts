export const AGENT_SWATCH_PALETTE: readonly string[] = [
	"#9d4747",
	"#a55252",
	"#666666",
	"#737373",
	"#808080",
	"#8a8a8a",
	"#924e4e",
	"#6f6f6f",
];

export function getAgentSwatch(idOrName: string): string {
	let hash = 0;
	for (let i = 0; i < idOrName.length; i++) {
		hash = (hash * 31 + idOrName.charCodeAt(i)) >>> 0;
	}
	return AGENT_SWATCH_PALETTE[hash % AGENT_SWATCH_PALETTE.length];
}

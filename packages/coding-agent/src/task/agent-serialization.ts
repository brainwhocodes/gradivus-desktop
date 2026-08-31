import { YAML } from "bun";
import type { AgentDefinition } from "./types";

const SERIALIZABLE_AGENT_FIELDS = [
	"name",
	"description",
	"tools",
	"spawns",
	"model",
	"thinkingLevel",
	"output",
	"blocking",
	"autoloadSkills",
	"readSummarize",
	"prewalk",
	"advisor",
] as const satisfies ReadonlyArray<keyof AgentDefinition>;

export function serializeAgentDefinition(agent: AgentDefinition): string {
	const frontmatter: Record<string, unknown> = {};
	for (const field of SERIALIZABLE_AGENT_FIELDS) {
		const value = agent[field];
		if (value !== undefined) frontmatter[field] = value;
	}
	const metadata = YAML.stringify(frontmatter, null, 2).trimEnd();
	return `---\n${metadata}\n---\n\n${agent.systemPrompt.trim()}\n`;
}

/** Replace only the Markdown body, leaving frontmatter and unknown fields byte-for-byte intact. */
export function replaceAgentPromptBody(content: string, systemPrompt: string): string {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	if (!content.startsWith(`---${newline}`)) throw new Error("Agent definition has no YAML frontmatter");
	const closingOffset = content.indexOf(`${newline}---`, 3 + newline.length);
	if (closingOffset < 0) throw new Error("Agent definition has unterminated YAML frontmatter");
	const headerEnd = closingOffset + newline.length + 3;
	return `${content.slice(0, headerEnd)}${newline}${newline}${systemPrompt.trim()}${newline}`;
}

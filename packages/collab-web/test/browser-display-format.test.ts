import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { browserRenderer } from "../src/tool-render/tools/browser";
import type { ToolRenderProps } from "../src/tool-render/types";

function renderBody(props: ToolRenderProps): string {
	const Body = browserRenderer.Body;
	if (!Body) throw new Error("Expected a browser tool body renderer");
	return renderToStaticMarkup(createElement(Body, props));
}

describe("browser tool renderer", () => {
	it("renders compact JavaScript without mutating the tool arguments", () => {
		const source = "if (ready) {run();finish();}";
		const args = { action: "run", code: source };
		const html = renderBody({ name: "browser", args });

		expect(html).toContain(source);
		expect(args.code).toBe(source);
	});

	it("uses resolved browser details instead of stale request args", () => {
		const html = renderBody({
			name: "browser",
			args: { action: "open", name: "Research Docs", app: { relay: true } },
			result: {
				content: [{ type: "text", text: 'Opened tab "Research Docs"' }],
				details: { action: "open", name: "Research Docs", browser: "connected" },
			},
		});

		expect(html).toContain("connected");
		expect(html).not.toContain("relay");
	});
});

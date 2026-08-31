import {
	type AriaSnapshotOptions,
	buildAriaSnapshotScript,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "@oh-my-pi/pi-browser-runtime/aria/aria-snapshot";
import { ToolError } from "../../tool-errors";

export type { AriaSnapshotOptions };
export { buildAriaSnapshotScript, captureAriaSnapshot, parseAriaRefSelector, resolveAriaRefHandle };

export function assertSelectorString(selector: unknown): asserts selector is string {
	if (typeof selector === "string") return;
	let kind: string;
	if (selector !== null && typeof selector === "object") {
		kind =
			"then" in selector && typeof selector.then === "function" ? "a Promise (missing await?)" : "an ElementHandle";
	} else {
		kind = `a ${typeof selector}`;
	}
	throw new ToolError(
		`Browser selector must be a string; got ${kind}. ` +
			"tab.click/type/fill/waitFor take string selectors only — " +
			'call the handle method directly (e.g. (await tab.id(n)).click()) or pass a string like "aria-ref=eN".',
	);
}

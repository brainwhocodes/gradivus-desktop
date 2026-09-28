import type { Selectors } from "playwright-core";

interface QueryDocument {
	getElementById(id: string): Element | null;
	querySelectorAll(selector: string): Iterable<Element>;
}

interface Element {
	tagName: string;
	id: string;
	textContent: string | null;
	querySelectorAll(selector: string): Iterable<Element>;
	querySelector(selector: string): Element | null;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	closest(selector: string): Element | null;
	ownerDocument?: QueryDocument;
	type: string;
	value: string;
	multiple: boolean;
	size: number;
}

interface QueryRoot {
	querySelectorAll(selector: string): Iterable<Element>;
	contains(element: Element): boolean;
}

interface SelectorEngine {
	query(root: QueryRoot, selector: string): Element | null;
	queryAll(root: QueryRoot, selector: string): Element[];
}

function createSelectorEngine(queryAll: SelectorEngine["queryAll"]): SelectorEngine {
	return {
		query: (root, selector) => queryAll(root, selector)[0] ?? null,
		queryAll,
	};
}

// Playwright runs selector scripts in the page; embed both functions so no host closures are required.
function selectorEngine(queryAll: SelectorEngine["queryAll"]): string {
	return `(${createSelectorEngine.toString()})(${queryAll.toString()})`;
}

/** Register worker-local semantic selector engines with Playwright. */
export async function registerSemanticQueryHandlers(selectors: Selectors): Promise<void> {
	await selectors.register(
		"omp-label",
		selectorEngine((node, selector) => {
			const root = node;
			const wanted = selector.trim().toLocaleLowerCase();
			const matches = (value: string | null | undefined): boolean =>
				(value ?? "").trim().toLocaleLowerCase().includes(wanted);
			const elements = Array.from(root.querySelectorAll("*"));
			const result: Element[] = [];
			const seen = new Set<Element>();
			const add = (element: Element | null): void => {
				if (element && !seen.has(element)) {
					seen.add(element);
					result.push(element);
				}
			};
			for (const label of root.querySelectorAll("label")) {
				if (!matches(label.textContent)) continue;
				const htmlFor = label.getAttribute("for");
				if (htmlFor) {
					const target = label.ownerDocument?.getElementById(htmlFor) ?? null;
					if (target && node.contains(target)) {
						add(target);
					}
				} else {
					const control = label.querySelector(
						"button,input,meter,output,progress,select,textarea",
					) as unknown as Element | null;
					add(control);
				}
			}
			for (const element of elements) {
				if (matches(element.getAttribute("aria-label"))) add(element);
				const labelledBy = element.getAttribute("aria-labelledby");
				if (!labelledBy) continue;
				const labelText = labelledBy
					.split(/\s+/)
					.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
					.join(" ");
				if (matches(labelText)) add(element);
			}
			return result;
		}),
	);
	await selectors.register(
		"omp-placeholder",
		selectorEngine((node, selector) => {
			const wanted = selector.trim().toLocaleLowerCase();
			return Array.from(node.querySelectorAll("[placeholder]")).filter(element =>
				(element.getAttribute("placeholder") ?? "").trim().toLocaleLowerCase().includes(wanted),
			);
		}),
	);
	await selectors.register(
		"omp-testid",
		selectorEngine((node, selector) => {
			const wanted = selector.trim();
			return Array.from(node.querySelectorAll("[data-testid]")).filter(
				element => element.getAttribute("data-testid") === wanted,
			);
		}),
	);
	await selectors.register(
		"omp-alt",
		selectorEngine((node, selector) => {
			const wanted = selector.trim().toLocaleLowerCase();
			return Array.from(node.querySelectorAll("[alt]")).filter(element =>
				(element.getAttribute("alt") ?? "").trim().toLocaleLowerCase().includes(wanted),
			);
		}),
	);
	await selectors.register(
		"omp-title",
		selectorEngine((node, selector) => {
			const wanted = selector.trim().toLocaleLowerCase();
			return Array.from(node.querySelectorAll("[title]")).filter(element =>
				(element.getAttribute("title") ?? "").trim().toLocaleLowerCase().includes(wanted),
			);
		}),
	);
	await selectors.register(
		"omp-role",
		selectorEngine((node, selector) => {
			const root = node;
			const roleMatch = /^\s*([^\s[]+)/.exec(selector);
			const wantedRole = roleMatch?.[1]?.toLocaleLowerCase() ?? "";
			const nameMatch =
				/\[\s*name\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\]\s]+))(?:\s+(exact))?\s*\]/i.exec(
					selector,
				);
			const rawName = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
			const wantedName = rawName?.replace(/\\(.)/g, "$1").trim().toLocaleLowerCase();
			const exact = nameMatch?.[4]?.toLocaleLowerCase() === "exact";
			const implicitRole = (element: Element): string | null => {
				const tag = element.tagName.toLocaleLowerCase();
				if (tag === "a" && element.hasAttribute("href")) return "link";
				if (tag === "button") return "button";
				if (tag === "textarea") return "textbox";
				if (tag === "select") {
					const select = element as unknown as { multiple: boolean; size: number };
					return select.multiple || select.size > 1 ? "listbox" : "combobox";
				}
				if (tag === "option") return "option";
				if (tag === "img") return "img";
				if (tag === "ul" || tag === "ol") return "list";
				if (tag === "li") return "listitem";
				if (tag === "nav") return "navigation";
				if (tag === "main") return "main";
				if (tag === "form") return "form";
				if (tag === "article") return "article";
				if (/^h[1-6]$/.test(tag)) return "heading";
				if (tag === "table") return "table";
				if (tag === "tr") return "row";
				if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
				if (tag === "td") return "cell";
				if (tag !== "input") return null;
				// The selector callback's minimal Element type omits HTMLInputElement.type.
				const input = element as unknown as { type?: string };
				const type = (input.type || "text").toLocaleLowerCase();
				if (type === "checkbox") return "checkbox";
				if (type === "radio") return "radio";
				if (type === "range") return "slider";
				if (type === "number") return "spinbutton";
				if (type === "search") return "searchbox";
				if (["button", "submit", "reset", "image"].includes(type)) return "button";
				if (!["hidden", "file", "color", "date", "datetime-local", "month", "time", "week"].includes(type)) {
					return "textbox";
				}
				return null;
			};
			const accessibleName = (element: Element): string => {
				const ariaLabel = element.getAttribute("aria-label");
				if (ariaLabel) return ariaLabel.trim();
				const labelledBy = element.getAttribute("aria-labelledby");
				if (labelledBy) {
					const value = labelledBy
						.split(/\s+/)
						.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
						.join(" ")
						.trim();
					if (value) return value;
				}
				if (element.id) {
					for (const label of element.ownerDocument?.querySelectorAll("label") ?? []) {
						if (label.getAttribute("for") === element.id) return (label.textContent ?? "").trim();
					}
				}
				const wrappingLabel = element.closest("label");
				if (wrappingLabel) return (wrappingLabel.textContent ?? "").trim();
				// The selector callback's minimal Element type omits input type/value properties.
				const input =
					element.tagName.toLocaleLowerCase() === "input"
						? (element as unknown as { type: string; value: string })
						: null;
				const inputValue =
					input && ["button", "submit", "reset"].includes(input.type.toLocaleLowerCase())
						? input.value
						: element.textContent;
				return (
					element.getAttribute("alt") ??
					element.getAttribute("title") ??
					inputValue ??
					element.getAttribute("placeholder") ??
					""
				).trim();
			};
			return Array.from(root.querySelectorAll("*")).filter(element => {
				const role = (
					element.getAttribute("role")?.trim().split(/\s+/)[0] ?? implicitRole(element)
				)?.toLocaleLowerCase();
				if (wantedRole ? role !== wantedRole : !role || role === "generic") return false;
				if (wantedName === undefined) return true;
				const name = accessibleName(element).toLocaleLowerCase();
				return exact ? name === wantedName : name.includes(wantedName);
			});
		}),
	);
}

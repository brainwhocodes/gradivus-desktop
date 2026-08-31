import { setTimeout as sleep } from "node:timers/promises";
import type { WebContentsView } from "electron";
import * as electron from "electron";

const { Menu } = electron;

import { buildAriaSnapshotScript, buildResolveAriaRefScript } from "@oh-my-pi/pi-browser-runtime/aria/aria-snapshot";
import { pathIsWithin } from "@oh-my-pi/pi-utils/dirs";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime";
import {
	type ElementScreenshot,
	ElementSelectionCoordinator,
	SELECTION_LIMITS,
	type SelectionAuthScope,
	type SelectionTargetAgent,
	type StartSelectionOptions,
} from "@oh-my-pi/pi-workspace-runtime/selection";
import type { TerminalOutputFrame, TerminalStatusFrame } from "@oh-my-pi/pi-workspace-runtime/terminal-protocol";
import { getAgentSwatch } from "../shared/agent-swatch";
import type {
	BrowserBounds,
	BrowserFindState,
	BrowserNavigationAction,
	BrowserShortcut,
	BrowserTabCloseResult,
	BrowserViewState,
	CreateBrowserInput,
	CreateTerminalInput,
	ElementEditState,
	ElementTaskAction,
	PaneAutomationState,
	PaneContextMenuAction,
	QueuedElementTask,
	SessionRecordV1,
	TerminalAttachmentState,
	TerminalViewState,
	UpdateTabInput,
	WorkspaceDocumentV1,
	WorkspaceEvent,
} from "../shared/contracts";
import { BROWSER_SELECTION_AGENT_ID_PREFIX, BROWSER_SELECTION_AGENT_PROFILE_ID } from "../shared/selection-agent";
import {
	DESKTOP_THEME_PALETTES,
	type ResolvedTheme,
	resolveTheme as resolveSharedTheme,
} from "../shared/theme-palette";
import type { AppSettingsStore } from "./app-settings";
import type { DesktopHost } from "./desktop-host";
import { DEPARTURE_MONO_BASE64 } from "./inspector-font";
import { PaneBroker, type PaneBrokerContext, type PaneBrokerExecution } from "./pane-broker";
import elementSelectionPromptTemplate from "./prompts/element-selection.md" with { type: "text" };

const MAX_WORKSPACE_PANES = 4;
const PANE_BROWSER_KEYS = new Set([
	"Enter",
	"Tab",
	"Escape",
	"Backspace",
	"Delete",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
]);
const PANE_CLICK_FUNCTION = `function() {
  const element = this;
  if (!(element instanceof HTMLElement)) return { ok: false, error: "Element not found" };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
  return { ok: true, tag: element.localName, text: String(element.textContent || "").trim().slice(0, 200) };
}`;
const PANE_HOVER_FUNCTION = `function() {
  const element = this;
  if (!(element instanceof HTMLElement)) return { ok: false, error: "Element not found" };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  return { ok: true, tag: element.localName };
}`;
const PANE_FILL_FUNCTION = `function(text) {
  const element = this;
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLElement && element.isContentEditable)) {
    return { ok: false, error: "Editable element not found" };
  }
  if (element instanceof HTMLInputElement && (element.type === "password" || element.type === "file")) {
    return { ok: false, error: "sensitive_field: password and file inputs cannot be filled" };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, text);
    else element.value = text;
  } else {
    element.textContent = text;
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, tag: element.localName };
}`;
const PANE_FOCUS_FUNCTION = `function() {
  const element = this;
  if (!(element instanceof HTMLElement)) return { ok: false, error: "Element not found" };
  element.focus();
  return { ok: true, tag: element.localName };
}`;
class StaleSelectionOperation extends Error {
	constructor() {
		super("Selection operation is no longer current");
		this.name = "StaleSelectionOperation";
	}
}

const STALE_SELECTION_OPERATION = new StaleSelectionOperation();

function isStaleSelectionOperation(error: unknown): boolean {
	return error === STALE_SELECTION_OPERATION || error instanceof StaleSelectionOperation;
}

function uniqueCommandId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

interface InspectorBounds {
	x: number;
	y: number;
	width: number;
	height: number;
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

interface InspectorTaskPayload {
	tagName?: string;
	selector?: string;
	instruction?: string;
	action?: ElementTaskAction;
	agentType?: string;
	captureMode?: string;
	bounds?: InspectorBounds;
}

interface InspectorActionPayload extends InspectorTaskPayload {
	enqueue?: boolean;
	queueValidationError?: string;
	targetAgentId?: string;
	canceled?: boolean;
	closed?: boolean;
}

function inspectorThemeVariables(theme: ResolvedTheme): Record<string, string> {
	const palette = DESKTOP_THEME_PALETTES[theme];
	return {
		"--inspector-window-background": palette.windowBackground,
		"--inspector-shell": palette.shell,
		"--inspector-shell-raised": palette.shellRaised,
		"--inspector-shell-hover": palette.shellHover,
		"--inspector-chat-canvas": palette.chatCanvas,
		"--inspector-code-surface": palette.codeSurface,
		"--inspector-foreground": palette.foreground,
		"--inspector-foreground-strong": palette.foregroundStrong,
		"--inspector-foreground-muted": palette.foregroundMuted,
		"--inspector-foreground-disabled": palette.foregroundDisabled,
		"--inspector-line": palette.line,
		"--inspector-line-soft": palette.lineSoft,
		"--inspector-accent": palette.accent,
		"--inspector-accent-hover": palette.accentHover,
		"--inspector-accent-surface": palette.accentSurface,
		"--inspector-accent-boundary": palette.accentBoundary,
		"--inspector-accent-foreground": palette.accentForeground,
		"--inspector-danger": palette.danger,
		"--inspector-danger-surface": palette.dangerSurface,
		"--inspector-danger-boundary": palette.dangerBoundary,
		"--inspector-danger-foreground": palette.dangerForeground,
		"--inspector-success": palette.success,
		"--inspector-success-surface": palette.successSurface,
		"--inspector-success-boundary": palette.successBoundary,
		"--inspector-success-foreground": palette.successForeground,
		"--inspector-warning": palette.warning,
		"--inspector-warning-surface": palette.warningSurface,
		"--inspector-warning-boundary": palette.warningBoundary,
		"--inspector-warning-foreground": palette.warningForeground,
		"--inspector-selection-surface": palette.selectionSurface,
		"--inspector-selection-foreground": palette.selectionForeground,
		"--inspector-focus-inner": palette.focusInner,
		"--inspector-focus-outer": palette.focusOuter,
		"--inspector-shadow-color": palette.shadowColor,
		"--inspector-backdrop": palette.backdrop,
		"--inspector-font-mono": '"Departure Mono", ui-monospace, monospace',
		"--inspector-font-sans": '"Departure Mono", ui-monospace, monospace',
		"--inspector-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
		"--inspector-radius-small": "5px",
		"--inspector-radius-medium": "8px",
		"--inspector-radius-large": "12px",
		"--inspector-control-height": "36px",
	};
}

function buildInspectorScript(
	initialTheme: ResolvedTheme,
	token: string,
	target: SelectionTargetAgent,
	queuedTasks: QueuedElementTask[],
): string {
	const themeJson = JSON.stringify(initialTheme);
	const targetJson = JSON.stringify(target);
	const queueJson = JSON.stringify(
		queuedTasks.map(task => ({
			id: task.id,
			taskIndex: task.taskIndex,
			selector: task.selector,
			tagName: task.tagName,
			targetAgentId: task.targetAgentId,
			targetAgentName: task.targetAgentName,
			agentSwatch: task.agentSwatch,
			status: task.status,
		})),
	);
	const themeValuesJson = JSON.stringify({
		dark: inspectorThemeVariables("dark"),
		light: inspectorThemeVariables("light"),
	});
	return `
(function() {
  const token = ${JSON.stringify(token)};
  const targetAgent = ${targetJson};
  const initialQueue = ${queueJson};
  return (async function() {
    if (window.__gradivus_inspector_cleanup__) {
      try { window.__gradivus_inspector_cleanup__({ canceled: true }); } catch {}
    }
    const root = document.createElement("div");
    root.id = "__gradivus_inspector_root__";
    root.dataset.theme = ${themeJson};
    root.style.cssText = "all:initial;position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;";
    const shadow = root.attachShadow({ mode: "closed" });
    const themeValues = ${themeValuesJson};
    const style = document.createElement("style");
    style.textContent = [
      "@font-face{font-family:'Departure Mono';src:url('data:font/woff2;base64," + ${JSON.stringify(DEPARTURE_MONO_BASE64)} + "') format('woff2');font-weight:normal;font-style:normal;font-display:swap}",
      ":host,*{box-sizing:border-box;margin:0;padding:0;font-family:'Departure Mono',ui-monospace,monospace}",
      "button,textarea,input,select{font:inherit;color:inherit}",
".inspector-box{position:fixed;pointer-events:none;border:2px solid var(--inspector-foreground-muted);background:color-mix(in srgb,var(--inspector-foreground-muted) 20%,transparent);display:none;border-radius:var(--inspector-radius-small,5px);box-shadow:0 0 0 2px var(--inspector-focus-inner),0 0 0 4px var(--inspector-focus-outer)}",
".inspector-box.selected{border-color:var(--inspector-agent-swatch,var(--inspector-accent-boundary));background:color-mix(in srgb,var(--inspector-agent-swatch,var(--inspector-selection-surface)) 35%,transparent)}",
".inspector-box.working{border-color:var(--inspector-warning-boundary);background:color-mix(in srgb,var(--inspector-warning-surface) 65%,transparent)}",
".inspector-box.ready{border-color:var(--inspector-success-boundary);background:color-mix(in srgb,var(--inspector-success-surface) 65%,transparent)}",
".inspector-box.error{border-color:var(--inspector-danger-boundary);background:color-mix(in srgb,var(--inspector-danger-surface) 65%,transparent)}",
".inspector-pill{position:absolute;bottom:calc(100% + 5px);left:0;padding:3px 8px;white-space:nowrap;color:var(--inspector-foreground);background:var(--inspector-shell-raised);border:1px solid var(--inspector-agent-swatch,var(--inspector-line));border-radius:var(--inspector-radius-small,5px);font:11px/14px 'Departure Mono',ui-monospace,monospace;box-shadow:0 8px 24px var(--inspector-shadow-color)}",
      ".agent-cursor{position:fixed;left:0;top:0;z-index:2147483647;display:none;width:24px;height:24px;pointer-events:none;will-change:transform;color:var(--inspector-agent-swatch,var(--inspector-accent-boundary))}",
      ".agent-cursor::before,.agent-cursor::after{content:'';position:absolute;background:currentColor;box-shadow:0 0 0 1px var(--inspector-focus-outer)}",
      ".agent-cursor::before{left:1px;right:1px;top:11px;height:2px}.agent-cursor::after{top:1px;bottom:1px;left:11px;width:2px}",
      ".agent-cursor-dot{position:absolute;left:9px;top:9px;width:6px;height:6px;border:1px solid var(--inspector-focus-outer);border-radius:50%;background:currentColor}",
      ".agent-cursor-label{position:absolute;left:18px;top:17px;max-width:160px;overflow:hidden;text-overflow:ellipsis;padding:2px 5px;white-space:nowrap;color:var(--inspector-foreground);background:var(--inspector-shell-raised);border:1px solid var(--inspector-agent-swatch,var(--inspector-accent-boundary));border-radius:var(--inspector-radius-small,5px);font:10px/13px 'Departure Mono',ui-monospace,monospace;box-shadow:0 4px 14px var(--inspector-shadow-color)}",
".pinned-queue-badge{position:absolute;top:-10px;right:-10px;min-width:22px;height:22px;padding:0 5px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:var(--inspector-selection-foreground);background:var(--inspector-agent-swatch,var(--inspector-selection-surface));border:1px solid var(--inspector-agent-swatch,var(--inspector-accent-boundary));font:11px 'Departure Mono',ui-monospace,monospace}",
      ".inspector-card{position:fixed;z-index:2147483647;width:min(580px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:14px;border-radius:var(--inspector-radius-large,12px);display:none;flex-direction:column;gap:10px;color:var(--inspector-foreground);background:var(--inspector-shell-raised);border:1px solid var(--inspector-line);box-shadow:0 14px 40px var(--inspector-shadow-color);font:12px/1.4 'Departure Mono',ui-monospace,monospace;pointer-events:auto}",
      ".card-header,.target-info,.card-footer,.card-actions,.inline-response-actions{display:flex;align-items:center;gap:8px}.card-header,.card-footer{justify-content:space-between}.card-header{padding-bottom:10px;border-bottom:1px solid var(--inspector-line-soft)}.target-info{flex-wrap:wrap;min-width:0}.target-selector,.inline-response-view{color:var(--inspector-foreground-muted);background:var(--inspector-code-surface);border:1px solid var(--inspector-line-soft);border-radius:var(--inspector-radius-small,5px)}.target-selector{padding:2px 6px;font:10.5px 'Departure Mono',ui-monospace,monospace;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mode-badge{padding:2px 6px;border-radius:999px;color:var(--inspector-foreground);background:var(--inspector-shell-hover);border:1px solid var(--inspector-line);font-size:10px}.mode-badge.local{background:var(--inspector-selection-surface);border-color:var(--inspector-accent-boundary);color:var(--inspector-selection-foreground)}",
      ".card-close-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;color:var(--inspector-foreground-muted);background:transparent;border:1px solid transparent;border-radius:var(--inspector-radius-small,5px);font:16px/1 'Departure Mono',ui-monospace,monospace;cursor:pointer;transition:all 140ms var(--inspector-ease,cubic-bezier(0.16,1,0.3,1))}.card-close-btn:hover{color:var(--inspector-foreground-strong);background:var(--inspector-shell-hover);border-color:var(--inspector-line-soft)}",
      ".card-textarea,.agent-select,.mode-toggle,.recreate-menu,.split-action-menu{color:var(--inspector-foreground);background:var(--inspector-code-surface);border:1px solid var(--inspector-line);border-radius:var(--inspector-radius-small,5px)}.card-textarea{width:100%;min-height:64px;padding:8px 10px;resize:vertical;font:12px/1.4 'Departure Mono',ui-monospace,monospace;transition:border-color 140ms var(--inspector-ease,cubic-bezier(0.16,1,0.3,1))}.card-textarea::placeholder{color:var(--inspector-foreground-muted)}.card-chips,.mode-toggles{display:flex;flex-wrap:wrap;gap:6px}.mode-toggles{display:inline-flex;gap:6px}.mode-toggle{padding:4px 8px;color:var(--inspector-foreground);background:var(--inspector-code-surface);border:1px solid var(--inspector-line);border-radius:var(--inspector-radius-small,5px);font:11px 'Departure Mono',ui-monospace,monospace;cursor:pointer;transition:all 140ms var(--inspector-ease,cubic-bezier(0.16,1,0.3,1))}.mode-toggle.active{background:var(--inspector-selection-surface);color:var(--inspector-selection-foreground);border-color:var(--inspector-accent-boundary);font-weight:600}.mode-toggle:hover:not(.active){background:var(--inspector-shell-hover);color:var(--inspector-foreground)}.chip,.recreate-trigger-btn,.btn-cancel,.btn-close-response,.btn-copy-response{padding:4px 8px;border-radius:var(--inspector-radius-small,5px);color:var(--inspector-foreground);background:var(--inspector-shell-hover);border:1px solid var(--inspector-line);font:11px 'Departure Mono',ui-monospace,monospace;cursor:pointer;transition:all 140ms var(--inspector-ease,cubic-bezier(0.16,1,0.3,1))}.chip:hover,.recreate-trigger-btn:hover,.btn-cancel:hover,.btn-close-response:hover,.btn-copy-response:hover{background:var(--inspector-selection-surface);border-color:var(--inspector-accent-boundary);color:var(--inspector-selection-foreground)}.recreate-dropdown-wrap{position:relative}.recreate-menu{position:absolute;z-index:2;padding:4px;border-radius:var(--inspector-radius-medium,8px);background:var(--inspector-code-surface);box-shadow:0 12px 30px var(--inspector-shadow-color)}.recreate-item,.split-action-item{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border-radius:var(--inspector-radius-small,5px);color:var(--inspector-foreground);background:transparent;border:0;font:11px 'Departure Mono',ui-monospace,monospace;text-align:left;cursor:pointer;transition:all 140ms var(--inspector-ease,cubic-bezier(0.16,1,0.3,1))}.recreate-item:hover,.split-action-item:hover{background:var(--inspector-shell-hover);color:var(--inspector-foreground)}.split-action-btn-group{position:relative;display:inline-flex;border-radius:var(--inspector-radius-small,5px);color:var(--inspector-accent-foreground);background:var(--inspector-accent);border:1px solid var(--inspector-accent-boundary);font:11px 'Departure Mono',ui-monospace,monospace;transition:background-color 140ms var(--inspector-ease,cubic-bezier(0.16,1,0.3,1))}.split-action-btn-group:hover{background:var(--inspector-accent-hover)}.split-action-item.active{background:var(--inspector-selection-surface);color:var(--inspector-selection-foreground);border-color:var(--inspector-accent-boundary)}.btn-submit-main,.btn-action-dropdown{padding:6px 10px;color:inherit;background:transparent;border:0;font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:5px}.btn-action-dropdown{border-left:1px solid var(--inspector-accent-boundary);padding:6px 8px}.btn-submit-main:disabled{color:var(--inspector-foreground-disabled);cursor:not-allowed;opacity:0.6}.split-action-menu{position:absolute;right:0;bottom:calc(100% + 4px);min-width:220px;padding:4px;border-radius:var(--inspector-radius-medium,8px);color:var(--inspector-foreground);background:var(--inspector-code-surface);border:1px solid var(--inspector-line);box-shadow:0 12px 30px var(--inspector-shadow-color);z-index:10;display:flex;flex-direction:column;gap:2px}.inline-response-view{display:none;padding:12px;border-radius:var(--inspector-radius-small,5px);font:11.5px/1.5 'Departure Mono',ui-monospace,monospace;white-space:pre-wrap}.inline-response-view.visible{display:flex;flex-direction:column;gap:8px}.inline-response-header{display:flex;justify-content:space-between;color:var(--inspector-foreground-strong)}.inline-response-body{max-height:300px;overflow:auto;white-space:pre-wrap}.card-status{min-height:18px;padding:4px 6px;border-radius:var(--inspector-radius-small,5px);font:11px 'Departure Mono',ui-monospace,monospace;color:var(--inspector-foreground-muted);white-space:pre-wrap}.card-status.error,.card-status.success{border:1px solid;border-radius:var(--inspector-radius-small,5px);color:var(--inspector-foreground)}.card-status.error{background:var(--inspector-danger-surface);border-color:var(--inspector-danger-boundary)}.card-status.success{background:var(--inspector-success-surface);border-color:var(--inspector-success-boundary)}:focus-visible{outline:2px solid var(--inspector-focus-inner);outline-offset:1px;box-shadow:0 0 0 4px var(--inspector-focus-outer)}",
      "@media(forced-colors:active){.inspector-box,.inspector-pill,.inspector-card,.card-textarea,.agent-select,.mode-toggle,.recreate-menu,.split-action-menu,.chip,.recreate-trigger-btn,.btn-cancel,.btn-close-response,.btn-copy-response,.card-close-btn,.split-action-btn-group,.card-status{background:Canvas;color:CanvasText;border-color:Highlight;box-shadow:none}.recreate-item,.split-action-item{background:Canvas;color:CanvasText}:focus-visible{outline:2px solid Highlight;outline-offset:2px;box-shadow:none}}",
    ].join("\\n");
    shadow.appendChild(style);

    const cursorStyle = document.createElement("style");
    cursorStyle.id = "__gradivus_cursor_style__";
    cursorStyle.textContent = "*{cursor:none!important}";
    const agentCursor = document.createElement("div");
    agentCursor.className = "agent-cursor";
    agentCursor.setAttribute("aria-hidden", "true");
    agentCursor.style.setProperty("--inspector-agent-swatch", targetAgent.swatch);
    const cursorDot = document.createElement("span");
    cursorDot.className = "agent-cursor-dot";
    const cursorLabel = document.createElement("span");
    cursorLabel.className = "agent-cursor-label";
    cursorLabel.textContent = targetAgent.name;
    agentCursor.append(cursorDot, cursorLabel);
    shadow.appendChild(agentCursor);
    const activeBox = document.createElement("div");
    activeBox.className = "inspector-box";
    activeBox.style.setProperty("--inspector-agent-swatch", targetAgent.swatch);
    const activePill = document.createElement("div");
    activePill.className = "inspector-pill";
    activePill.style.setProperty("--inspector-agent-swatch", targetAgent.swatch);
    activeBox.appendChild(activePill);
    shadow.appendChild(activeBox);
    const card = document.createElement("div");
    card.className = "inspector-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "false");
    card.setAttribute("aria-labelledby", "__gradivus_inspector_title__");
    shadow.appendChild(card);
    document.documentElement.appendChild(root);

    let currentTarget = null;
    let selectedElement = null;
    let selectedMetadata = null;
    let currentAction = "inline";
    let currentCaptureMode = "dom";
    let currentAgentType = "task";
    let pinnedBoxes = [];
    let pendingActions = [];
    let actionWaiters = [];
    let cardClickHandler = null;
    let rafId = null;
    let currentTheme = ${themeJson};
    let captureTimer = null;
    let cleaned = false;

    function setText(node, value) {
      if (node) node.textContent = value == null ? "" : String(value);
    }
    function notifyAction(action) {
      if (cleaned) return;
      const waiter = actionWaiters.shift();
      if (waiter) waiter(action);
      else pendingActions.push(action);
    }
    function waitForAction() {
      if (pendingActions.length > 0) return Promise.resolve(pendingActions.shift());
      return new Promise(resolve => actionWaiters.push(resolve));
    }
    function applyTheme(theme) {
      if (theme !== "dark" && theme !== "light") return;
      const values = themeValues[theme];
      for (const [property, value] of Object.entries(values)) root.style.setProperty(property, value);
      currentTheme = theme;
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
      window.__gradivus_inspector_theme__ = theme;
    }
    applyTheme(currentTheme);
    window.__gradivus_inspector_set_theme__ = applyTheme;

    function generateSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      if (el.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(el.id)) {
        try {
          if (document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
        } catch {}
      }
      for (const attr of ["data-testid", "data-test", "data-cy"]) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        try {
          const selector = "[" + attr + "=\\"" + CSS.escape(value) + "\\"]";
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch {}
      }
      const tag = el.tagName.toLowerCase();
      if (el.classList && el.classList.length > 0) {
        try {
          const classes = Array.from(el.classList).slice(0, 3).map(c => "." + CSS.escape(c)).join("");
          const selector = tag + classes;
          if (document.querySelectorAll(selector).length === 1) return selector;
        } catch {}
      }
      const path = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document.documentElement && path.length < 6) {
        let part = current.tagName.toLowerCase();
        let sibling = current;
        let nth = 1;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName.toLowerCase() === current.tagName.toLowerCase()) nth++;
        }
        if (nth > 1) part += ":nth-of-type(" + nth + ")";
        path.unshift(part);
        current = current.parentElement;
      }
      return path.join(" > ");
    }
    function boundsFor(el) {
      if (!el || !el.isConnected) return null;
      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return null;
      return {
        x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
        top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), left: Math.round(rect.left),
      };
    }
    function updateOverlay(el) {
      const bounds = boundsFor(el);
      if (!bounds) { activeBox.style.display = "none"; return; }
      activeBox.style.display = "block";
      activeBox.style.top = bounds.top + "px";
      activeBox.style.left = bounds.left + "px";
      activeBox.style.width = bounds.width + "px";
      activeBox.style.height = bounds.height + "px";
      activePill.style.bottom = bounds.top < 34 ? "auto" : "calc(100% + 5px)";
      activePill.style.top = bounds.top < 34 ? "calc(100% + 4px)" : "auto";
      setText(activePill, "<" + el.tagName.toLowerCase() + "> " + Math.round(bounds.width) + " × " + Math.round(bounds.height));
    }
    function extractMetadata(el) {
      return {
        tagName: el.tagName.toLowerCase(),
        selector: generateSelector(el),
        bounds: boundsFor(el),
      };
    }
    function setBox(box, el, state, label) {
      const bounds = boundsFor(el);
      if (!bounds) { box.style.display = "none"; return; }
      box.className = "inspector-box " + state;
      box.style.display = "block";
      box.style.top = bounds.top + "px"; box.style.left = bounds.left + "px";
      box.style.width = bounds.width + "px"; box.style.height = bounds.height + "px";
      const pill = box.querySelector(".inspector-pill");
      if (pill) setText(pill, label);
    }
    function stopPicking() {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerout", onPointerOut, true);
      window.removeEventListener("pointerdown", interceptEvent, true);
      window.removeEventListener("mousedown", interceptEvent, true);
      window.removeEventListener("mouseup", interceptEvent, true);
      window.removeEventListener("click", onElementClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      agentCursor.style.display = "none";
      cursorStyle.remove();
    }
    function startPicking() {
      if (cleaned) return;
      selectedElement = null;
      selectedMetadata = null;
      activeBox.style.display = "none";
      card.style.display = "none";
      document.documentElement.appendChild(cursorStyle);
      agentCursor.style.display = "none";
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerout", onPointerOut, true);
      window.addEventListener("pointerdown", interceptEvent, true);
      window.addEventListener("mousedown", interceptEvent, true);
      window.addEventListener("mouseup", interceptEvent, true);
      window.addEventListener("click", onElementClick, true);
      window.addEventListener("keydown", onKeyDown, true);
    }
    function resetDraft() {
      if (cardClickHandler) card.removeEventListener("click", cardClickHandler, true);
      cardClickHandler = null;
      card.style.display = "none";
      activeBox.style.display = "none";
      selectedElement = null;
      selectedMetadata = null;
      currentAction = "inline";
      startPicking();
    }
    function renderFloatingCard(el, meta) {
      stopPicking();
      currentAction = "inline";
      const bounds = boundsFor(el);
      const width = Math.min(580, window.innerWidth - 32);
      const left = Math.max(16, Math.min(window.innerWidth - width - 16, bounds ? bounds.left : 16));
      const estimatedHeight = 350;
      const top = bounds && bounds.bottom + estimatedHeight < window.innerHeight - 16
        ? bounds.bottom + 12
        : bounds && bounds.top - estimatedHeight > 16
          ? bounds.top - estimatedHeight - 12
          : Math.max(16, (window.innerHeight - estimatedHeight) / 2);
      card.style.left = left + "px";
      card.style.top = top + "px";
      card.style.display = "flex";
      card.innerHTML = [
        '<div class="card-header"><div class="target-info"><span class="target-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z"/><path d="M2 12L5 12" stroke-linecap="round"/><path d="M19 12L22 12" stroke-linecap="round"/><path d="M12 22L12 19" stroke-linecap="round"/><path d="M12 5L12 2" stroke-linecap="round"/><path d="M10 12H14" stroke-linecap="round"/><path d="M12 14L12 10" stroke-linecap="round"/></svg></span><strong id="__gradivus_inspector_title__" class="target-name"></strong><code class="target-selector"></code><span class="mode-badge"></span></div><button type="button" class="card-close-btn" aria-label="Cancel selection"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M14.5 9.5L9.5 14.5M9.5 9.5L14.5 14.5" stroke-linecap="round"/></svg></button></div>',
        '<textarea class="card-textarea" aria-label="Element instruction" placeholder="Describe changes or ask OMP about this element…" rows="3"></textarea>',
        '<div class="card-chips"></div>',
        '<div class="card-status" role="status" aria-live="polite"></div>',
        '<div class="inline-response-view"><div class="inline-response-header"><strong>OMP result</strong><span class="inline-response-status">Complete</span></div><pre class="inline-response-body"></pre><div class="inline-response-actions"><button type="button" class="btn-copy-response">Copy</button><button type="button" class="btn-close-response">Close</button></div></div>',
        '<div class="card-footer"><select class="agent-select" aria-label="Subagent role"><option value="task">task (General)</option><option value="designer">designer (UI/CSS)</option><option value="quick_task">quick_task (Fast Fix)</option><option value="reviewer">reviewer (Review)</option><option value="librarian">librarian (Docs/API)</option></select><div class="mode-toggles" role="radiogroup" aria-label="Capture mode"><button type="button" class="mode-toggle active" data-mode="dom">DOM</button><button type="button" class="mode-toggle" data-mode="screenshot">Screenshot</button></div><div class="card-actions"><button type="button" class="btn-cancel">Cancel</button><div class="split-action-btn-group"><button type="button" class="btn-submit-main" disabled><span class="submit-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5.67 9.91L8.73 5.77C10.71 3.09 11.7 1.75 12.62 2.04C13.55 2.32 13.55 3.96 13.55 7.25V7.56C13.55 8.74 13.55 9.33 13.93 9.71L13.95 9.72C14.33 10.09 14.95 10.09 16.18 10.09C18.4 10.09 19.51 10.09 19.89 10.76C20.26 11.48 19.62 12.35 18.33 14.09L15.27 18.23C13.29 20.91 12.3 22.25 11.38 21.96C10.45 21.68 10.45 20.04 10.45 16.75V16.44C10.45 15.26 10.45 14.67 10.07 14.29L10.05 14.28C9.67 13.91 9.05 13.91 7.82 13.91C5.6 13.91 4.49 13.91 4.11 13.24C3.74 12.52 4.38 11.65 5.67 9.91Z"/></svg></span><span class="submit-label">Ask OMP</span></button><button type="button" class="btn-action-dropdown" aria-label="Choose action"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M19 9L12 15L5 9" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="split-action-menu" style="display:none"><button type="button" class="split-action-item active" data-action="inline">Ask OMP (Inline)</button><button type="button" class="split-action-item" data-action="chat">Send to Chat</button><button type="button" class="split-action-item" data-action="queue">Add to Queue</button></div></div></div></div>',
      ].join("");
      setText(card.querySelector(".target-name"), "<" + meta.tagName + ">");
      setText(card.querySelector(".target-selector"), meta.selector || meta.tagName);
      const selectorPill = card.querySelector(".target-selector");
      if (selectorPill) {
        selectorPill.style.setProperty("--inspector-agent-swatch", targetAgent.swatch);
        selectorPill.style.borderColor = "var(--inspector-agent-swatch)";
      }
      setText(card.querySelector(".mode-badge"), isLocalPage() ? "Local · Edit" : "External · Debug");
      const textarea = card.querySelector(".card-textarea");
      const submit = card.querySelector(".btn-submit-main");
      const actionMenu = card.querySelector(".split-action-menu");
      const actionDropdown = card.querySelector(".btn-action-dropdown");
      const select = card.querySelector(".agent-select");
      const status = card.querySelector(".card-status");
      const responseView = card.querySelector(".inline-response-view");
      select.value = currentAgentType;
      card.querySelectorAll(".mode-toggle").forEach(item =>
        item.classList.toggle("active", item.getAttribute("data-mode") === currentCaptureMode)
      );
      const responseBody = card.querySelector(".inline-response-body");
      const chips = card.querySelector(".card-chips");
      const prompts = isLocalPage()
        ? [["Restyle", "Restyle this element with modern colors, subtle borders, and clean typography."], ["Edit Copy", "Update the text and messaging of this element to be clear and concise."], ["Spacing", "Fix the alignment, padding, and layout of this element."], ["Add Hover", "Add a smooth hover and focus transition effect to this element."]]
        : [["Explain", "Explain how this element is structured, its CSS styling, and layout behavior."], ["Debug Layout", "Analyze this element's DOM and styles for layout bugs, overflows, or a11y issues."], ["Extract Specs", "Extract the exact CSS rules, colors, typography, and spacing for this component."]];
      for (const [label, prompt] of prompts) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "chip"; setText(button, label);
        button.addEventListener("click", () => { textarea.value = textarea.value.trim() ? textarea.value.trim() + "\\n" + prompt : prompt; submit.disabled = false; textarea.focus(); });
        chips.appendChild(button);
      }
      function updateActionControls() {
        const labels = { inline: ["", "Ask OMP"], chat: ["", "Send to Chat"], queue: ["", "Add to Queue"] };
        const pair = labels[currentAction] || labels.inline;
        setText(submit.querySelector(".submit-icon"), pair[0]);
        setText(submit.querySelector(".submit-label"), pair[1]);
        card.querySelectorAll(".split-action-item").forEach(item => item.classList.toggle("active", item.getAttribute("data-action") === currentAction));
      }
      actionDropdown.addEventListener("click", event => { event.stopPropagation(); actionMenu.style.display = actionMenu.style.display === "none" ? "block" : "none"; });
      card.querySelectorAll(".split-action-item").forEach(item => item.addEventListener("click", event => { event.stopPropagation(); currentAction = item.getAttribute("data-action") || "inline"; updateActionControls(); actionMenu.style.display = "none"; }));
      select.addEventListener("change", () => { currentAgentType = select.value || "task"; });
      card.querySelectorAll(".mode-toggle").forEach(item => item.addEventListener("click", () => { currentCaptureMode = item.getAttribute("data-mode") === "screenshot" ? "screenshot" : "dom"; card.querySelectorAll(".mode-toggle").forEach(other => other.classList.toggle("active", other === item)); }));
      textarea.addEventListener("input", () => { submit.disabled = textarea.value.trim().length === 0; });
      function finishClose() { notifyAction({ closed: true }); }
      card.querySelector(".btn-close-response").addEventListener("click", finishClose);
      card.querySelector(".btn-copy-response").addEventListener("click", async event => { try { await navigator.clipboard.writeText(responseBody.textContent || ""); setText(event.currentTarget, "Copied"); } catch { setText(event.currentTarget, "Copy failed"); } });
      function submitAction() {
        const instruction = textarea.value.trim();
        if (!instruction) return;
        submit.disabled = true;
        textarea.disabled = true;
        status.className = "card-status";
        if (currentAction === "queue") {
          setText(status, "Adding to queue…");
          activeBox.className = "inspector-box selected";
          if (!selectedElement || !selectedElement.isConnected) {
            notifyAction({ enqueue: true, queueValidationError: "Selected element is no longer available" });
            return;
          }
          setText(activePill, "Adding to queue…");
          notifyAction({
            enqueue: true,
            targetAgentId: targetAgent.id,
            instruction,
            agentType: currentAgentType,
            captureMode: currentCaptureMode,
            ...meta,
          });
          return;
        }
        setText(status, currentAction === "chat" ? "Sending to OMP Chat…" : "Running with OMP…");
        activeBox.className = "inspector-box working";
        setText(activePill, currentAction === "chat" ? "Sending to OMP Chat…" : "Running with OMP…");
        notifyAction({ ...meta, instruction, action: currentAction, agentType: currentAgentType, captureMode: currentCaptureMode });
      }
      submit.addEventListener("click", submitAction);
      textarea.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); if (actionMenu.style.display !== "none") actionMenu.style.display = "none"; else if (responseView.classList.contains("visible")) finishClose(); else resetDraft(); }
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey) { event.preventDefault(); currentAction = "queue"; updateActionControls(); submitAction(); }
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && textarea.value.trim()) { event.preventDefault(); submitAction(); }
      });
      card.querySelector(".btn-cancel").addEventListener("click", () => { notifyAction({ canceled: true }); cleanup({ canceled: true }); });
      card.querySelector(".card-close-btn").addEventListener("click", () => { notifyAction({ canceled: true }); cleanup({ canceled: true }); });
      cardClickHandler = event => { if (!event.target.closest(".split-action-btn-group")) actionMenu.style.display = "none"; };
      card.addEventListener("click", cardClickHandler, true);
      textarea.focus();
    }
    function isLocalPage() {
      const host = location.hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".test") || host.endsWith(".internal") || host.startsWith("local.");
    }
    function onPointerMove(event) {
      agentCursor.style.display = "block";
      agentCursor.style.transform = "translate3d(" + (event.clientX - 12) + "px," + (event.clientY - 12) + "px,0)";
      if (selectedElement) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const el = document.elementFromPoint(event.clientX, event.clientY);
        if (el && el !== root && !root.contains(el)) { currentTarget = el; updateOverlay(el); }
      });
    }
    function onPointerOut(event) {
      if (!event.relatedTarget) agentCursor.style.display = "none";
    }
    function interceptEvent(event) { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation(); }
    function onElementClick(event) {
      if (selectedElement) return;
      if (event.composedPath().some(item => item === root)) return;
      interceptEvent(event);
      let target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target) target = event.composedPath().find(candidate => candidate instanceof Element && candidate.isConnected && candidate !== root && !root.contains(candidate)) || null;
      if (!target || !target.isConnected || target === root || root.contains(target)) return;
      const bounds = boundsFor(target);
      if (!bounds) return;
      selectedElement = target;
      selectedMetadata = extractMetadata(target);
      activeBox.className = "inspector-box selected";
      updateOverlay(target);
      renderFloatingCard(target, selectedMetadata);
    }
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      interceptEvent(event);
      if (card.style.display !== "none") { resetDraft(); return; }
      notifyAction({ canceled: true });
      cleanup({ canceled: true });
    }
    function onScrollOrResize() {
      if (selectedElement) updateOverlay(selectedElement);
      else if (currentTarget) updateOverlay(currentTarget);
      pinnedBoxes.forEach(item => setBox(item.box, item.el, item.box.className.replace("inspector-box ", "") || "selected", item.pill.textContent || ""));
      if (card.style.display !== "none" && selectedElement) {
        const rect = selectedElement.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        if (cardRect.bottom > window.innerHeight - 16) card.style.top = Math.max(16, window.innerHeight - card.offsetHeight - 16) + "px";
        if (rect.left + card.offsetWidth > window.innerWidth - 16) card.style.left = Math.max(16, window.innerWidth - card.offsetWidth - 16) + "px";
      }
    }
    function cleanup(result) {
      if (result?.token && result.token !== token) return false;
      if (cleaned) return;
      cleaned = true;
      stopPicking();
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize, true);
      if (rafId) cancelAnimationFrame(rafId);
      if (captureTimer) clearTimeout(captureTimer);
      root.remove();
      if (actionWaiters.length > 0) actionWaiters.splice(0).forEach(waiter => waiter(result || { canceled: true }));
      pendingActions.length = 0;
      delete window.__gradivus_inspector_wait_for_action__;
      delete window.__gradivus_inspector_get_current_target_bounds__;
      delete window.__gradivus_inspector_clear_queue__;
      delete window.__gradivus_inspector_set_capture_hidden__;
      delete window.__gradivus_inspector_finish__;
      delete window.__gradivus_inspector_cleanup__;
      delete window.__gradivus_inspector_set_theme__;
      delete window.__gradivus_inspector_theme__;
      cursorStyle.remove();
    }
    window.__gradivus_inspector_wait_for_action__ = waitForAction;
    window.__gradivus_inspector_get_current_target_bounds__ = () => boundsFor(selectedElement);
    window.__gradivus_inspector_clear_queue__ = () => {
      for (const item of pinnedBoxes) item.box.remove();
      pinnedBoxes = [];
      return true;
    };
    window.__gradivus_inspector_set_capture_hidden__ = hidden => {
      root.style.visibility = hidden ? "hidden" : "visible";
      return new Promise(resolve => {
        if (captureTimer) clearTimeout(captureTimer);
        requestAnimationFrame(() => {
          captureTimer = setTimeout(() => { captureTimer = null; resolve(true); }, 0);
        });
      });
    };
    function pinTask(task, element) {
      if (!task || !element || !element.isConnected) return false;
      if (typeof task.agentSwatch !== "string" || !task.agentSwatch) return false;
      if (!Number.isFinite(Number(task.taskIndex))) return false;
      const swatch = task.agentSwatch;
      const pinned = document.createElement("div");
      pinned.className = "inspector-box";
      pinned.style.setProperty("--inspector-agent-swatch", swatch);
      const pill = document.createElement("div");
      pill.className = "inspector-pill";
      pill.style.setProperty("--inspector-agent-swatch", swatch);
      pinned.appendChild(pill);
      const badge = document.createElement("div");
      badge.className = "pinned-queue-badge";
      badge.style.setProperty("--inspector-agent-swatch", swatch);
      setText(badge, "#" + task.taskIndex);
      pinned.appendChild(badge);
      shadow.appendChild(pinned);
      pinnedBoxes.push({
        taskId: task.taskId || task.id,
        taskIndex: Number(task.taskIndex),
        el: element,
        box: pinned,
        pill,
        badge,
        agentSwatch: swatch,
      });
      const taskStatus = task.status || "pending";
      const state = taskStatus === "error" ? "error" : taskStatus === "completed" ? "ready" : taskStatus === "running" ? "working" : "selected";
      setBox(pinned, element, state, "#" + task.taskIndex + " <" + (task.tagName || "element") + "> " + taskStatus);
      pinned.style.borderColor = swatch;
      return true;
    }
    function pinAuthoritativeTask(result) {
      if (
        !result ||
        typeof result.taskId !== "string" ||
        !Number.isFinite(Number(result.taskIndex)) ||
        typeof result.targetAgentId !== "string" ||
        typeof result.targetAgentName !== "string" ||
        typeof result.agentSwatch !== "string"
      ) return false;
      return pinTask(result, selectedElement);
    }
    function rehydratePins() {
      for (const task of initialQueue) {
        try {
          pinTask(task, document.querySelector(task.selector));
        } catch {}
      }
    }
    window.__gradivus_inspector_finish__ = result => {
      if (cleaned || !result || result.token !== token) return false;
      if (result.kind === "inline-success" || result.kind === "chat-success" || result.kind === "error") {
        card.style.display = "flex";
        activeBox.className = result.kind === "error" ? "inspector-box error" : "inspector-box ready";
        setText(activePill, result.kind === "error" ? "Error" : "Ready");
        const status = card.querySelector(".card-status");
        status.className = "card-status " + (result.kind === "error" ? "error" : "success");
        setText(status, result.message || (result.kind === "chat-success" ? "Delivered to OMP Chat." : "Completed."));
        const responseView = card.querySelector(".inline-response-view");
        const responseBody = card.querySelector(".inline-response-body");
        if (result.response || result.kind === "chat-success") {
          setText(responseBody, result.response || "Sent to OMP Chat.");
          responseView.classList.add("visible");
        }
        const textarea = card.querySelector(".card-textarea");
        if (textarea) textarea.disabled = true;
        return true;
      }
      if (result.kind === "queue-added") {
        pinAuthoritativeTask(result);
        resetDraft();
        return true;
      }
      if (result.kind === "queue-add-error") {
        card.style.display = "flex";
        activeBox.className = "inspector-box error";
        setText(activePill, "Queue error");
        const status = card.querySelector(".card-status");
        status.className = "card-status error";
        setText(status, result.message || "Could not add this element to the queue.");
        const textarea = card.querySelector(".card-textarea");
        if (textarea) textarea.disabled = false;
        const submit = card.querySelector(".btn-submit-main");
        if (submit) submit.disabled = false;
        return true;
      }
      return false;
    };
    window.__gradivus_inspector_cleanup__ = cleanup;
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { capture: true, passive: true });
    rehydratePins();
    startPicking();
    return await waitForAction();
  })();
})();
`;
}
const DEFAULT_BROWSER_URL = "https://omp.sh";
interface PendingNavigation {
	url: string;
	issuedAt: number;
}

interface BrowserEntry {
	view: WebContentsView;
	state: BrowserViewState;
	attached: boolean;
	bounds: BrowserBounds;
	cssBounds?: BrowserBounds;
	documentEpoch: number;
	authoritativeUrl: string;
	pendingNavigation?: PendingNavigation;
	findQuery?: string;
	navigationSerial: number;
	navigationPending: boolean;
	navigationFailure?: string;
	paneExecutionWorld?: { documentEpoch: number; executionContextId: number };
	findRequestId?: number;
	cleanup: Array<() => void>;
	debuggerAttachedBySelection?: boolean;
	selectionCssKey?: string;
}
export type CreateBrowserOptions = CreateBrowserInput;
export type CreateTerminalOptions = CreateTerminalInput;
function paneId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z0-9-]{8,100}$/i.test(value)) throw new TypeError("Invalid pane id");
	return value;
}

function dimension(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${label} must be a number`);
	}
	const rounded = Math.round(value);
	return Math.max(2, Math.min(500, rounded));
}

function browserUrl(value: unknown, searchEngineTemplate?: string, defaultUrl?: string): URL {
	if (typeof value !== "string") throw new TypeError("Address must be text");
	const address = value.trim();
	if (address.length === 0) return new URL(defaultUrl ?? DEFAULT_BROWSER_URL);
	let candidate = address;
	if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) {
		const searchTemplate = searchEngineTemplate || "https://www.google.com/search?q=%s";
		const encoded = encodeURIComponent(candidate);
		candidate =
			/\s/.test(candidate) || !candidate.includes(".")
				? searchTemplate.includes("%s")
					? searchTemplate.replace("%s", encoded)
					: `${searchTemplate}${encoded}`
				: `https://${candidate}`;
	}
	const url = new URL(candidate);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Only HTTP and HTTPS addresses can open here");
	return url;
}

function browserBounds(value: unknown): BrowserBounds {
	if (typeof value !== "object" || value === null) throw new TypeError("Invalid browser bounds");
	const source = value as Record<string, unknown>;
	const numbers = [source.x, source.y, source.width, source.height];
	if (!numbers.every(item => typeof item === "number" && Number.isFinite(item)))
		throw new TypeError("Browser bounds must be finite numbers");
	return {
		x: Math.max(0, Math.round(source.x as number)),
		y: Math.max(0, Math.round(source.y as number)),
		width: Math.max(0, Math.round(source.width as number)),
		height: Math.max(0, Math.round(source.height as number)),
	};
}

type SelectionQueueState = {
	generation: number;
	nextTaskIndex: number;
	running: boolean;
	tasks: QueuedElementTask[];
};

export class WorkspaceHost {
	#window: Electron.BaseWindow & { webContents?: Electron.WebContents };
	#visibleBrowsers = new Set<string>();
	#activeBrowserPaneId: string | undefined;
	#browsers = new Map<string, BrowserEntry>();
	#terminalSubscriptions = new Map<string, () => void>();
	#terminalIds = new Map<string, string>();
	#terminalStates = new Map<string, string>();
	#terminalOffsets = new Map<string, number>();
	#selectionCoordinator: ElementSelectionCoordinator;
	#activeSelectionPaneId?: string;
	#selectionStates = new Map<string, ElementEditState>();
	#selectionGenerationSequence = 0;
	#selectionGenerations = new Map<string, number>();
	#selectionTokens = new Map<string, string>();
	#boundScopes = new Map<string, SelectionAuthScope>();
	#selectionQueues = new Map<string, SelectionQueueState>();
	#selectionQueueGenerations = new Map<string, number>();
	#client?: WorkspaceClient;
	#settingsStore?: AppSettingsStore;
	#desktopHost?: DesktopHost;
	#paneBroker: PaneBroker;
	constructor(
		window: Electron.BaseWindow & { webContents?: Electron.WebContents },
		settingsStore?: AppSettingsStore,
		desktopHost?: DesktopHost,
	) {
		this.#window = window;
		this.#settingsStore = settingsStore;
		this.#desktopHost = desktopHost;
		this.#selectionCoordinator = new ElementSelectionCoordinator();
		this.#paneBroker = new PaneBroker({
			list: sessionId => this.#listPaneBrokerContexts(sessionId),
			resolve: (sessionId, paneId) => this.#resolvePaneBrokerContext(sessionId, paneId),
			session: sessionId => {
				const session = this.#desktopHost?.paneAutomationSession(sessionId);
				return session
					? {
							record: session.record,
							incarnation: session.incarnation,
							...(session.automationUnavailableReason
								? { automationUnavailableReason: session.automationUnavailableReason }
								: {}),
						}
					: undefined;
			},
			confirm: (context, record, access) => this.#confirmPaneAuthorization(context, record, access),
			execute: (paneId, action, args, signal) => this.#executePaneBrowserAction(paneId, { action, ...args }, signal),
		});
		this.#desktopHost?.setPaneBroker(this.#paneBroker);
		if ("nativeTheme" in electron && electron.nativeTheme && typeof electron.nativeTheme.on === "function") {
			electron.nativeTheme.on("updated", () => this.updateTheme());
		}
	}
	setDesktopHost(desktopHost: DesktopHost): void {
		if (this.#desktopHost === desktopHost) return;
		this.#desktopHost = desktopHost;
		desktopHost.setPaneBroker(this.#paneBroker);
	}

	resolveTheme(): ResolvedTheme {
		const setting = this.#settingsStore?.settings.theme ?? "system";
		const systemDark =
			"nativeTheme" in electron &&
			electron.nativeTheme &&
			typeof electron.nativeTheme.shouldUseDarkColors === "boolean"
				? electron.nativeTheme.shouldUseDarkColors
				: true;
		return resolveSharedTheme(setting, systemDark);
	}

	#listPaneBrokerContexts(sessionId: string): PaneBrokerContext[] {
		const document = this.#client?.document;
		if (!document) return [];
		return document.panes.flatMap(pane => {
			if (pane.kind !== "browser") return [];
			try {
				return [this.#resolvePaneBrokerContext(sessionId, pane.id)];
			} catch {
				return [];
			}
		});
	}

	#resolvePaneBrokerContext(sessionId: string, targetPaneId: string): PaneBrokerContext {
		const session = this.#desktopHost?.paneAutomationSession(sessionId);
		if (!session) throw new Error("OMP runtime is not ready for pane automation");
		const document = this.#client?.document;
		if (!document) throw new Error("Workspace authority is unavailable");
		const pane = document.panes.find(candidate => candidate.id === targetPaneId && candidate.kind === "browser");
		if (!pane) throw new Error("Browser pane is unavailable");
		const tab = document.tabs.find(candidate => candidate.id === pane.tabId);
		if (!tab) throw new Error("Browser tab is unavailable");
		const workspace = document.workspaces.find(candidate => candidate.id === tab.workspaceId);
		const location = workspace
			? document.locations.find(candidate => candidate.id === workspace.locationId)
			: undefined;
		if (!workspace || !location || location.address.kind !== "local") {
			throw new Error("Pane automation requires a local workspace");
		}
		if (!pathIsWithin(location.address.path, session.record.cwd)) {
			throw new Error("The OMP session is outside this pane's workspace");
		}
		const browser = document.browsers.find(
			candidate => candidate.id === pane.entityId && candidate.status !== "closed" && candidate.status !== "failed",
		);
		if (!browser) throw new Error("Browser entity is closed");
		const entry = this.#requireBrowser(targetPaneId);
		const windowState = this.#window as Electron.BaseWindow & {
			isVisible?: () => boolean;
			isMinimized?: () => boolean;
			getContentBounds?: () => Electron.Rectangle;
		};
		const windowVisible = (windowState.isVisible?.() ?? true) && !(windowState.isMinimized?.() ?? false);
		const contentBounds = windowState.getContentBounds?.();
		const inWindow =
			!contentBounds ||
			(entry.bounds.x < contentBounds.width &&
				entry.bounds.y < contentBounds.height &&
				entry.bounds.x + entry.bounds.width > 0 &&
				entry.bounds.y + entry.bounds.height > 0);
		return {
			paneId: targetPaneId,
			tabId: tab.id,
			browserId: browser.id,
			workspaceId: workspace.id,
			locationId: location.id,
			locationGeneration: location.lifecycle.generation,
			documentEpoch: entry.documentEpoch,
			url: entry.state.url,
			title: entry.state.title,
			visible: entry.attached && entry.bounds.width > 0 && entry.bounds.height > 0 && windowVisible && inWindow,
			navigationPending: entry.navigationPending,
			webContents: entry.view.webContents,
		};
	}

	async #confirmPaneAuthorization(
		context: PaneBrokerContext,
		record: SessionRecordV1,
		access: "observe" | "control",
	): Promise<boolean> {
		const label = access === "control" ? "Control" : "Read";
		const result = await electron.dialog.showMessageBox(this.#window, {
			type: "question",
			title: `Allow ${label} access to browser pane?`,
			message: `${record.title?.trim() || "OMP session"} requests ${label} access`,
			detail: `${context.title}\n${context.url}\n\nSession workspace: ${record.cwd}`,
			buttons: [`Allow ${label}`, "Cancel"],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		});
		return result.response === 0;
	}

	getPaneAutomation(sessionIdInput: unknown, paneIdInput: unknown): PaneAutomationState {
		const sessionId = typeof sessionIdInput === "string" ? sessionIdInput.trim() : "";
		if (!sessionId) throw new TypeError("Invalid session id");
		const state = this.#paneBroker.state(sessionId, paneId(paneIdInput));
		return { ...state, tabs: this.#desktopHost?.browserInventoryForSession(sessionId) ?? [] };
	}

	async requestPaneAuthorization(
		sessionIdInput: unknown,
		paneIdInput: unknown,
		accessInput: unknown,
	): Promise<PaneAutomationState> {
		const sessionId = typeof sessionIdInput === "string" ? sessionIdInput.trim() : "";
		if (!sessionId) throw new TypeError("Invalid session id");
		if (accessInput !== "observe" && accessInput !== "control") throw new TypeError("Invalid pane access");
		const state = await this.#paneBroker.authorize(sessionId, paneId(paneIdInput), accessInput);
		await this.#desktopHost?.refreshPaneBroker();
		return { ...state, tabs: this.#desktopHost?.browserInventoryForSession(sessionId) ?? [] };
	}

	async revokePane(sessionIdInput: unknown, paneIdInput: unknown): Promise<PaneAutomationState> {
		const sessionId = typeof sessionIdInput === "string" ? sessionIdInput.trim() : "";
		if (!sessionId) throw new TypeError("Invalid session id");
		const state = await this.#paneBroker.revoke(sessionId, paneId(paneIdInput));
		await this.#desktopHost?.refreshPaneBroker();
		return { ...state, tabs: this.#desktopHost?.browserInventoryForSession(sessionId) ?? [] };
	}

	async closeBrowserTabForSession(sessionIdInput: unknown, nameInput: unknown): Promise<BrowserTabCloseResult> {
		const sessionId = typeof sessionIdInput === "string" ? sessionIdInput.trim() : "";
		const name = typeof nameInput === "string" ? nameInput.trim() : "";
		if (!sessionId) throw new TypeError("Invalid session id");
		if (!name) throw new TypeError("Invalid browser tab name");
		if (!this.#desktopHost) throw new Error("OMP Chat is unavailable");
		let result = await this.#desktopHost.closeBrowserTabForSession(sessionId, name);
		if (result.requiresConfirmation) {
			const tab = result.tab;
			const activity = tab
				? `${tab.owners.length} owner${tab.owners.length === 1 ? "" : "s"}, ${tab.activeRunCount} active and ${tab.queuedRunCount} queued run${tab.queuedRunCount === 1 ? "" : "s"}`
				: "active browser work";
			const confirmation = await electron.dialog.showMessageBox(this.#window, {
				type: "warning",
				title: `Close OMP browser tab “${name}”?`,
				message: `Close “${name}” inside this OMP session?`,
				detail: `This tab has ${activity}. Closing it cancels its active and queued work. The visible Gradivus pane is unaffected.`,
				buttons: ["Close OMP tab", "Cancel"],
				defaultId: 1,
				cancelId: 1,
				noLink: true,
			});
			if (confirmation.response !== 0) {
				return { closed: false, cancelled: true, inventory: result.inventory };
			}
			result = await this.#desktopHost.closeBrowserTabForSession(sessionId, name, true);
		}
		return { closed: result.closed, inventory: result.inventory };
	}

	getBrowserBackgroundColor(): string {
		return DESKTOP_THEME_PALETTES[this.resolveTheme()].browserBackground;
	}
	updateTheme(): void {
		const theme = this.resolveTheme();
		const palette = DESKTOP_THEME_PALETTES[theme];
		const windowWithBackground = this.#window as Electron.BaseWindow & {
			setBackgroundColor?: (color: string) => void;
		};
		windowWithBackground.setBackgroundColor?.(palette.windowBackground);
		for (const entry of this.#browsers.values()) {
			entry.view.setBackgroundColor?.(palette.browserBackground);
		}
		const activePaneId = this.#activeSelectionPaneId;
		const activeEntry = activePaneId ? this.#browsers.get(activePaneId) : undefined;
		const activeWebContents = activeEntry?.view.webContents;
		if (
			activeWebContents &&
			typeof activeWebContents.isDestroyed === "function" &&
			!activeWebContents.isDestroyed() &&
			typeof activeWebContents.executeJavaScript === "function"
		) {
			const notification = activeWebContents.executeJavaScript(
				`window.__gradivus_inspector_set_theme__?.(${JSON.stringify(theme)})`,
			);
			if (notification && typeof notification.catch === "function") {
				void notification.catch(() => {});
			}
		}
	}
	#getBrowserUrl(value: unknown): URL {
		const settings = this.#settingsStore?.settings;
		return browserUrl(value, settings?.browser?.searchEngine, settings?.browser?.defaultUrl);
	}

	setClient(client: WorkspaceClient): void {
		this.#client = client;
	}

	async replaceClient(newClient: WorkspaceClient): Promise<void> {
		for (const unsubscribe of this.#terminalSubscriptions.values()) {
			try {
				unsubscribe();
			} catch {}
		}
		this.#terminalSubscriptions.clear();
		this.#client = newClient;

		let doc = newClient.document;
		if (doc) {
			for (const terminal of [...doc.terminals]) {
				if (terminal.paneId || !terminal.id.startsWith("term-chat-")) continue;
				const workspaceId =
					doc.workspaces.find(workspace => workspace.locationId === terminal.locationId)?.id ??
					doc.activeWorkspaceId;
				if (!workspaceId) continue;
				const result = await newClient.executeCommandWithRetry(currentDocument => ({
					version: 1 as const,
					commandId: uniqueCommandId("cmd-legacy-chat-terminal-close"),
					workspaceId,
					expectedRevision: currentDocument.revision,
					issuedAt: Date.now(),
					type: "terminal.close" as const,
					payload: { id: terminal.id },
				}));
				if (result.status !== "rejected") doc = result.document;
			}
			this.syncWithDocument(doc);
			for (const terminal of doc.terminals) {
				if (!terminal.paneId) continue;
				if (terminal.status === "running" || terminal.status === "starting") {
					const paneId = terminal.paneId;
					this.#terminalIds.set(paneId, terminal.id);
					void this.#subscribeTerminal(paneId, terminal.id).catch(() => {});
				}
			}
		}
	}

	syncWithDocument(document: WorkspaceDocumentV1): void {
		this.#syncBrowserDocument(document);
		this.#selectionCoordinator.syncWithDocument(document);
		const activeTerminalIds = new Set<string>();
		for (const terminal of document.terminals) {
			if (!terminal.paneId) continue;
			activeTerminalIds.add(terminal.paneId);
			this.#terminalIds.set(terminal.paneId, terminal.id);
			const previousStatus = this.#terminalStates.get(terminal.paneId);
			if (previousStatus !== terminal.status) {
				if (terminal.status === "failed") {
					this.#send({
						type: "terminal-error",
						paneId: terminal.paneId,
						message: terminal.error ?? "Terminal failed",
					});
				} else if (terminal.status === "exited") {
					this.#send({ type: "terminal-exit", paneId: terminal.paneId, exitCode: -1 });
				}
				this.#terminalStates.set(terminal.paneId, terminal.status);
			}
		}
		for (const paneId of this.#terminalIds.keys()) {
			if (activeTerminalIds.has(paneId)) continue;
			this.#unsubscribeTerminal(paneId);
			this.#terminalIds.delete(paneId);
			this.#terminalStates.delete(paneId);
			this.#terminalOffsets.delete(paneId);
		}
	}

	async #subscribeTerminal(paneId: string, terminalId: string): Promise<TerminalStatusFrame> {
		const client = this.#client;
		if (!client) throw new Error("WorkspaceClient is not configured");
		if (!this.#terminalSubscriptions.has(paneId)) {
			const removeOutputListener = client.onTerminalOutput(terminalId, (frame: TerminalOutputFrame) => {
				const nextOffset = frame.offset + Buffer.byteLength(frame.data, "utf8");
				const currentOffset = this.#terminalOffsets.get(paneId) ?? 0;
				if (frame.offset < currentOffset) return;
				this.#terminalOffsets.set(paneId, Math.max(currentOffset, nextOffset));
				this.#send({ type: "terminal-data", paneId, data: frame.data, offset: frame.offset });
			});
			this.#terminalSubscriptions.set(paneId, removeOutputListener);
		}
		try {
			const localOffset = this.#terminalOffsets.get(paneId) ?? 0;
			const snapshot = await client.subscribeTerminal(terminalId, localOffset);
			const remoteOffset =
				typeof snapshot.totalBytesProduced === "number" && Number.isFinite(snapshot.totalBytesProduced)
					? snapshot.totalBytesProduced
					: localOffset;
			this.#terminalOffsets.set(paneId, Math.max(localOffset, remoteOffset));
			if (snapshot.status === "failed") {
				const message = client.document?.terminals.find(item => item.id === terminalId)?.error ?? "Terminal failed";
				throw new Error(message);
			}
			return snapshot;
		} catch (error) {
			this.#unsubscribeTerminal(paneId);
			this.#send({
				type: "terminal-error",
				paneId,
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	#unsubscribeTerminal(paneId: string): void {
		const removeOutputListener = this.#terminalSubscriptions.get(paneId);
		if (removeOutputListener) removeOutputListener();
		this.#terminalSubscriptions.delete(paneId);
	}

	#terminalEntityId(paneId: string): string {
		const terminalId =
			this.#terminalIds.get(paneId) ?? this.#client?.document?.terminals.find(item => item.paneId === paneId)?.id;
		if (!terminalId) throw new Error(`Terminal pane '${paneId}' is unavailable`);
		this.#terminalIds.set(paneId, terminalId);
		return terminalId;
	}
	async createBrowser(options: CreateBrowserInput): Promise<BrowserViewState> {
		if (typeof options !== "object" || options === null) {
			throw new TypeError("CreateBrowserInput must be an object");
		}
		if (
			options.layout !== undefined &&
			options.layout !== "columns" &&
			options.layout !== "rows" &&
			options.layout !== "grid"
		) {
			throw new TypeError("layout must be columns, rows, or grid");
		}
		const id = paneId(options.id);
		const existing = this.#browsers.get(id);
		if (existing) return { ...existing.state };
		const requestedUrl = this.#getBrowserUrl(options.url).toString();

		if (!this.#client?.isConnected || !this.#client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}

		const doc = this.#client.document;
		const durableBrowser = doc.browsers.find(b => b.paneId === id || b.id === id);
		const url = durableBrowser?.url ?? requestedUrl;
		const workspace =
			doc.workspaces.find(w => w.id === options.workspaceId) ??
			doc.workspaces.find(w => w.id === doc.activeWorkspaceId) ??
			doc.workspaces[0];
		if (!workspace) {
			throw new Error(`No active workspace found in authority document`);
		}

		const location = doc.locations.find(l => l.id === workspace.locationId) ?? doc.locations[0];
		if (!location) {
			throw new Error(`Location '${workspace.locationId}' for workspace '${workspace.id}' not found`);
		}

		const targetTabId = options.tabId;

		if (!doc.browsers.some(b => (b.id === id || b.paneId === id) && b.status !== "closed" && b.status !== "failed")) {
			const res = await this.#client.executeCommandWithRetry(currentDoc => ({
				version: 1 as const,
				commandId: uniqueCommandId("cmd-browser-open"),
				workspaceId: workspace.id,
				expectedRevision: currentDoc.revision,
				issuedAt: Date.now(),
				type: "browser.open" as const,
				payload: {
					id: `browser-${id}`,
					paneId: id,
					tabId: targetTabId,
					locationId: location.id,
					url,
					title: "New browser",
					...(options.layout ? { layout: options.layout } : {}),
				},
			}));
			if (res.status !== "accepted" && res.status !== "duplicate") {
				throw new Error(
					`Failed to open browser in runtime: command status '${res.status}' - ${res.error?.message ?? "rejected"}`,
				);
			}
			this.syncWithDocument(res.document);
		}

		return this.#ensureBrowserView(id, url, durableBrowser?.title ?? "New browser");
	}
	#ensureBrowserView(id: string, url: string, title: string): BrowserViewState {
		const existing = this.#browsers.get(id);
		if (existing) {
			if (existing.pendingNavigation) {
				if (url === existing.pendingNavigation.url) {
					existing.authoritativeUrl = url;
					existing.pendingNavigation = undefined;
				} else if (url === existing.authoritativeUrl) {
					// In-flight navigation is still pending and incoming doc reflects prior state; ignore stale URL.
					return { ...existing.state };
				} else {
					// Genuinely newer third-party external navigation from another client.
					existing.authoritativeUrl = url;
					existing.pendingNavigation = undefined;
					if (existing.state.url !== url) {
						existing.state = { ...existing.state, url, loading: true, error: undefined };
						this.#emitBrowserState(id);
						void existing.view.webContents
							.loadURL(url)
							.catch((error: unknown) => this.#setBrowserError(id, error));
					}
				}
			} else {
				existing.authoritativeUrl = url;
				if (existing.state.url !== url) {
					existing.state = { ...existing.state, url, loading: true, error: undefined };
					this.#emitBrowserState(id);
					void existing.view.webContents.loadURL(url).catch((error: unknown) => this.#setBrowserError(id, error));
				}
			}
			return { ...existing.state };
		}
		const view = new electron.WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
			},
		});
		view.setBackgroundColor(this.getBrowserBackgroundColor());
		const entry: BrowserEntry = {
			view,
			attached: false,
			bounds: { x: 0, y: 0, width: 0, height: 0 },
			cleanup: [],
			navigationSerial: 0,
			navigationPending: false,
			state: { id, url, title, canGoBack: false, canGoForward: false, loading: true },
			documentEpoch: 1,
			authoritativeUrl: url,
		};
		this.#browsers.set(id, entry);
		this.#bindBrowser(id, entry);
		if (this.#visibleBrowsers.has(id)) this.#attach(entry);
		void view.webContents.loadURL(url).catch((error: unknown) => this.#setBrowserError(id, error));
		return { ...entry.state };
	}

	#syncBrowserDocument(document: WorkspaceDocumentV1): void {
		const durableIds = new Set<string>();
		for (const browser of document.browsers) {
			if (browser.status === "closed") continue;
			const id = browser.paneId ?? browser.id;
			durableIds.add(id);
			this.#ensureBrowserView(id, browser.url, browser.title ?? "Browser");
		}
		for (const id of this.#browsers.keys()) {
			if (!durableIds.has(id)) this.destroyBrowserView(id);
		}
	}

	async navigateBrowser(rawId: unknown, rawUrl: unknown): Promise<BrowserViewState> {
		const id = paneId(rawId);
		const url = this.#getBrowserUrl(rawUrl).toString();
		const entry = this.#requireBrowser(id);
		entry.pendingNavigation = { url, issuedAt: Date.now() };

		const client = this.#client;
		if (!client?.isConnected || !client.document)
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		const browser = client.document.browsers.find(item => item.paneId === id || item.id === id);
		const pane = browser ? client.document.panes.find(item => item.entityId === browser.id) : undefined;
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		if (!browser || !tab) throw new Error(`Browser pane '${id}' is unavailable`);
		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-browser-nav"),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "browser.navigate" as const,
			payload: { id: browser.id, url },
		}));
		if (result.status === "rejected") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			const rollbackUrl = entry.authoritativeUrl;
			entry.state = { ...entry.state, url: rollbackUrl };
			this.#setBrowserError(id, new Error(`Failed to navigate browser: ${result.error?.message ?? "rejected"}`));
			void entry.view.webContents.loadURL(rollbackUrl).catch((error: unknown) => this.#setBrowserError(id, error));
			throw new Error(`Failed to navigate browser: ${result.error?.message ?? result.status}`);
		}
		if (result.status === "accepted" || result.status === "duplicate") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			entry.authoritativeUrl = url;
			this.syncWithDocument(result.document);
			if (entry.state.url !== url) {
				entry.state = { ...entry.state, url, loading: true, error: undefined };
				this.#emitBrowserState(id);
				void entry.view.webContents.loadURL(url).catch((error: unknown) => this.#setBrowserError(id, error));
			}
		}
		return { ...entry.state };
	}

	#assertPaneOperationActive(signal: AbortSignal): void {
		if (signal.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("cancelled: Gradivus pane call aborted");
		}
	}

	#paneRemoteResult(response: unknown): Record<string, unknown> {
		if (!isRecord(response)) throw new Error("Pane execution returned an invalid CDP response");
		if (isRecord(response.exceptionDetails)) {
			const exception = isRecord(response.exceptionDetails.exception)
				? response.exceptionDetails.exception
				: undefined;
			const message =
				(typeof exception?.description === "string" && exception.description) ||
				(typeof response.exceptionDetails.text === "string" && response.exceptionDetails.text) ||
				"Pane execution failed";
			throw new Error(message.slice(0, 512));
		}
		if (!isRecord(response.result)) throw new Error("Pane execution returned no result");
		return response.result;
	}

	async #paneExecutionContext(entry: BrowserEntry, signal: AbortSignal): Promise<number> {
		this.#assertPaneOperationActive(signal);
		const epoch = entry.documentEpoch;
		if (entry.paneExecutionWorld?.documentEpoch === epoch) return entry.paneExecutionWorld.executionContextId;
		const frameTreeResponse: unknown = await entry.view.webContents.debugger.sendCommand("Page.getFrameTree");
		this.#assertPaneOperationActive(signal);
		const frameTree =
			isRecord(frameTreeResponse) && isRecord(frameTreeResponse.frameTree) ? frameTreeResponse.frameTree : undefined;
		const frame = frameTree && isRecord(frameTree.frame) ? frameTree.frame : undefined;
		if (!frame || typeof frame.id !== "string") throw new Error("pane_closed: Main browser frame is unavailable");
		const worldResponse: unknown = await entry.view.webContents.debugger.sendCommand("Page.createIsolatedWorld", {
			frameId: frame.id,
			worldName: `gradivus-pane-${entry.view.webContents.id}-${epoch}`,
			grantUniveralAccess: false,
		});
		this.#assertPaneOperationActive(signal);
		if (entry.documentEpoch !== epoch || entry.navigationPending) {
			throw new Error("stale_epoch: Page changed while creating the isolated world");
		}
		const executionContextId =
			isRecord(worldResponse) && typeof worldResponse.executionContextId === "number"
				? worldResponse.executionContextId
				: undefined;
		if (executionContextId === undefined) throw new Error("Pane isolated world is unavailable");
		entry.paneExecutionWorld = { documentEpoch: epoch, executionContextId };
		return executionContextId;
	}

	async #evaluatePaneExpression(
		entry: BrowserEntry,
		expression: string,
		signal: AbortSignal,
		returnByValue: boolean,
	): Promise<Record<string, unknown>> {
		const contextId = await this.#paneExecutionContext(entry, signal);
		const response: unknown = await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
			expression,
			contextId,
			returnByValue,
			awaitPromise: true,
		});
		this.#assertPaneOperationActive(signal);
		return this.#paneRemoteResult(response);
	}

	async #resolvePaneElement(
		entry: BrowserEntry,
		args: { selector?: string; ref?: string },
		signal: AbortSignal,
	): Promise<string> {
		const expression = args.ref
			? buildResolveAriaRefScript(args.ref)
			: `document.querySelector(${JSON.stringify(args.selector ?? "")})`;
		const remote = await this.#evaluatePaneExpression(entry, expression, signal, false);
		if (remote.subtype === "null" || typeof remote.objectId !== "string") {
			throw new Error(args.ref ? `stale_ref: unknown ref ${args.ref}` : "Element not found");
		}
		return remote.objectId;
	}

	async #callPaneElement(
		entry: BrowserEntry,
		objectId: string,
		functionDeclaration: string,
		argument: string | undefined,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		try {
			const response: unknown = await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration,
				arguments: argument === undefined ? [] : [{ value: argument }],
				returnByValue: true,
				awaitPromise: true,
			});
			this.#assertPaneOperationActive(signal);
			const remote = this.#paneRemoteResult(response);
			if (!isRecord(remote.value)) throw new Error("Page action returned an invalid result");
			return remote.value;
		} finally {
			await entry.view.webContents.debugger
				.sendCommand("Runtime.releaseObject", { objectId })
				.catch(() => undefined);
		}
	}

	async #executePaneBrowserAction(
		paneBrowserId: string,
		args: {
			action: "snapshot" | "navigate" | "click" | "fill" | "press" | "hover" | "scroll" | "screenshot";
			url?: string;
			selector?: string;
			ref?: string;
			text?: string;
			key?: string;
		},
		signal: AbortSignal,
	): Promise<PaneBrokerExecution> {
		this.#assertPaneOperationActive(signal);
		const entry = this.#requireBrowser(paneBrowserId);
		const { webContents } = entry.view;
		const stateDetails = (): Record<string, unknown> => ({
			action: args.action,
			paneId: paneBrowserId,
			url: entry.state.url.slice(0, 4_096),
			title: entry.state.title.slice(0, 240),
			loading: entry.state.loading,
			canGoBack: entry.state.canGoBack,
			canGoForward: entry.state.canGoForward,
		});

		if (args.action === "navigate") {
			const beforeEpoch = entry.documentEpoch;
			try {
				await this.navigateBrowser(paneBrowserId, args.url);
			} catch (error) {
				throw new Error(`navigate_failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			while (entry.documentEpoch === beforeEpoch || entry.navigationPending) {
				this.#assertPaneOperationActive(signal);
				if (entry.navigationFailure) throw new Error(`navigate_failed: ${entry.navigationFailure}`);
				await sleep(25);
			}
			return { details: stateDetails() };
		}
		if (args.action === "snapshot") {
			const remote = await this.#evaluatePaneExpression(
				entry,
				buildAriaSnapshotScript(undefined, { depth: SELECTION_LIMITS.maxDepth }),
				signal,
				true,
			);
			if (typeof remote.value !== "string") throw new Error("The active page returned an invalid ARIA snapshot");
			const allLines = remote.value.split(/\r?\n/);
			let aria = allLines.slice(0, SELECTION_LIMITS.maxDomRecords).join("\n");
			const encoded = Buffer.from(aria, "utf8");
			if (encoded.byteLength > SELECTION_LIMITS.maxDomBytes) {
				aria = encoded
					.subarray(0, SELECTION_LIMITS.maxDomBytes)
					.toString("utf8")
					.replace(/\uFFFD$/u, "");
			}
			return {
				details: {
					...stateDetails(),
					aria,
					truncated:
						allLines.length > SELECTION_LIMITS.maxDomRecords || encoded.byteLength > SELECTION_LIMITS.maxDomBytes,
				},
			};
		}
		if (args.action === "click" || args.action === "fill" || args.action === "hover") {
			const beforeEpoch = entry.documentEpoch;
			const beforeSerial = entry.navigationSerial;
			const objectId = await this.#resolvePaneElement(entry, args, signal);
			const functionDeclaration =
				args.action === "click"
					? PANE_CLICK_FUNCTION
					: args.action === "hover"
						? PANE_HOVER_FUNCTION
						: PANE_FILL_FUNCTION;
			const raw = await this.#callPaneElement(
				entry,
				objectId,
				functionDeclaration,
				args.action === "fill" ? (args.text ?? "") : undefined,
				signal,
			);
			if (raw.ok !== true) {
				throw new Error(typeof raw.error === "string" ? raw.error.slice(0, 512) : "Page action failed");
			}
			await sleep(0);
			if (args.action === "click" && (entry.navigationSerial !== beforeSerial || entry.navigationPending)) {
				while (entry.navigationPending) {
					this.#assertPaneOperationActive(signal);
					if (entry.navigationFailure) throw new Error(`navigate_failed: ${entry.navigationFailure}`);
					await sleep(25);
				}
				if (entry.navigationFailure) throw new Error(`navigate_failed: ${entry.navigationFailure}`);
			} else if (
				entry.documentEpoch !== beforeEpoch ||
				entry.navigationSerial !== beforeSerial ||
				entry.navigationPending
			) {
				throw new Error("stale_epoch: Page changed during the action");
			}
			return {
				details: {
					...stateDetails(),
					...(args.ref ? { ref: args.ref } : { selector: args.selector }),
					tag: typeof raw.tag === "string" ? raw.tag.slice(0, 32) : "",
					...(typeof raw.text === "string" ? { text: raw.text.slice(0, 200) } : {}),
				},
			};
		}
		if (args.action === "scroll") {
			const beforeEpoch = entry.documentEpoch;
			const beforeSerial = entry.navigationSerial;
			const deltaY = Number(args.text);
			if (!Number.isFinite(deltaY) || Math.abs(deltaY) > 100_000) {
				throw new Error("invalid_params: invalid scroll value");
			}
			webContents.sendInputEvent({
				type: "mouseWheel",
				x: Math.max(0, Math.round(entry.bounds.width / 2)),
				y: Math.max(0, Math.round(entry.bounds.height / 2)),
				deltaY,
				deltaX: 0,
			});
			if (
				entry.documentEpoch !== beforeEpoch ||
				entry.navigationSerial !== beforeSerial ||
				entry.navigationPending
			) {
				throw new Error("stale_epoch: Page changed during the action");
			}
			return { details: { ...stateDetails(), deltaY } };
		}
		if (args.action === "press") {
			const beforeEpoch = entry.documentEpoch;
			const beforeSerial = entry.navigationSerial;
			const key = args.key ?? "";
			if (key.length !== 1 && !PANE_BROWSER_KEYS.has(key)) {
				throw new Error(`invalid_params: unsupported browser key ${key}`);
			}
			if (args.selector || args.ref) {
				const objectId = await this.#resolvePaneElement(entry, args, signal);
				const focused = await this.#callPaneElement(entry, objectId, PANE_FOCUS_FUNCTION, undefined, signal);
				if (focused.ok !== true) {
					throw new Error(typeof focused.error === "string" ? focused.error.slice(0, 512) : "Element not found");
				}
			}
			webContents.sendInputEvent({ type: "keyDown", keyCode: key });
			if (key.length === 1) webContents.sendInputEvent({ type: "char", keyCode: key });
			webContents.sendInputEvent({ type: "keyUp", keyCode: key });
			await sleep(0);
			if (
				entry.documentEpoch !== beforeEpoch ||
				entry.navigationSerial !== beforeSerial ||
				entry.navigationPending
			) {
				throw new Error("stale_epoch: Page changed during the action");
			}
			return {
				details: {
					...stateDetails(),
					key,
					...(args.ref ? { ref: args.ref } : args.selector ? { selector: args.selector } : {}),
				},
			};
		}

		if (typeof webContents.capturePage !== "function") throw new Error("Screenshot capture is unavailable");
		let image = await webContents.capturePage();
		let size = image.getSize();
		const scale = Math.min(
			1,
			SELECTION_LIMITS.maxScreenshotDimension / size.width,
			SELECTION_LIMITS.maxScreenshotDimension / size.height,
		);
		if (scale < 1) {
			image = image.resize({
				width: Math.max(1, Math.floor(size.width * scale)),
				height: Math.max(1, Math.floor(size.height * scale)),
			});
			size = image.getSize();
		}
		for (const quality of [80, 60, 40]) {
			const data = image.toJPEG(quality);
			if (data.byteLength <= SELECTION_LIMITS.maxImageBytes) {
				return {
					details: { ...stateDetails(), width: size.width, height: size.height, bytes: data.byteLength },
					image: { data: data.toString("base64"), mimeType: "image/jpeg" },
				};
			}
		}
		throw new Error(`Pane screenshot exceeded ${SELECTION_LIMITS.maxImageBytes} bytes`);
	}

	controlBrowser(rawId: unknown, rawAction: unknown): void {
		const id = paneId(rawId);
		const entry = this.#browsers.get(id);
		if (!entry) return;
		if (
			rawAction !== "back" &&
			rawAction !== "forward" &&
			rawAction !== "reload" &&
			rawAction !== "hard-reload" &&
			rawAction !== "zoom-in" &&
			rawAction !== "zoom-out" &&
			rawAction !== "zoom-reset" &&
			rawAction !== "stop"
		)
			throw new TypeError("Invalid browser action");
		const action: BrowserNavigationAction = rawAction;
		const { webContents } = entry.view;
		const history = webContents.navigationHistory;
		if (action === "back" && history.canGoBack()) history.goBack();
		else if (action === "forward" && history.canGoForward()) history.goForward();
		else if (action === "reload") webContents.reload();
		else if (action === "hard-reload") webContents.reloadIgnoringCache();
		else if (action === "zoom-in") webContents.setZoomFactor(Math.min(3, webContents.getZoomFactor() + 0.1));
		else if (action === "zoom-out") webContents.setZoomFactor(Math.max(0.5, webContents.getZoomFactor() - 0.1));
		else if (action === "zoom-reset") webContents.setZoomFactor(1);
		else if (action === "stop") webContents.stop();
	}

	findBrowser(rawId: unknown, rawQuery: unknown, rawForward: unknown): void {
		const id = paneId(rawId);
		const entry = this.#requireBrowser(id);
		if (typeof rawQuery !== "string" || rawQuery.length > 1_024) throw new TypeError("Invalid browser find query");
		if (typeof rawForward !== "boolean") throw new TypeError("Invalid browser find direction");
		const query = rawQuery.trim();
		if (!query) {
			this.stopBrowserFind(id);
			return;
		}
		const findNext = entry.findQuery === query;
		entry.findQuery = query;
		entry.findRequestId = entry.view.webContents.findInPage(query, { forward: rawForward, findNext });
	}

	stopBrowserFind(rawId: unknown): void {
		const id = paneId(rawId);
		const entry = this.#requireBrowser(id);
		entry.findQuery = undefined;
		entry.findRequestId = undefined;
		entry.view.webContents.stopFindInPage("clearSelection");
		const state: BrowserFindState = { query: "", activeMatchOrdinal: 0, matches: 0, finalUpdate: true };
		this.#send({ type: "browser-find", paneId: id, state });
	}

	setBrowserBounds(rawId: unknown, rawBounds: unknown): void {
		const entry = this.#requireBrowser(paneId(rawId));
		const raw = browserBounds(rawBounds);
		entry.cssBounds = raw;
		entry.bounds = this.#toDipBounds(raw);
		if (entry.attached && entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds);
	}

	#toDipBounds(cssBounds: BrowserBounds): BrowserBounds {
		const zoomFactor =
			typeof this.#window.webContents?.getZoomFactor === "function" ? this.#window.webContents.getZoomFactor() : 1;
		const factor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
		return {
			x: Math.round(cssBounds.x * factor),
			y: Math.round(cssBounds.y * factor),
			width: Math.max(0, Math.round(cssBounds.width * factor)),
			height: Math.max(0, Math.round(cssBounds.height * factor)),
		};
	}

	updateZoomBounds(): void {
		for (const entry of this.#browsers.values()) {
			if (entry.cssBounds) {
				entry.bounds = this.#toDipBounds(entry.cssBounds);
				if (entry.attached && entry.bounds.width > 0 && entry.bounds.height > 0) {
					entry.view.setBounds(entry.bounds);
				}
			}
		}
	}

	setVisibleBrowsers(value: unknown, rawActivePaneId?: unknown): void {
		if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid visible browser list");
		const ids = value.map(paneId);
		this.#visibleBrowsers = new Set(ids);
		const nextActivePaneId =
			rawActivePaneId !== undefined ? paneId(rawActivePaneId) : ids.length > 0 ? ids[0] : this.#activeBrowserPaneId;
		if (nextActivePaneId && ids.length > 0 && !this.#visibleBrowsers.has(nextActivePaneId)) {
			throw new TypeError("Active browser pane must be visible");
		}
		const activeChanged = this.#activeBrowserPaneId !== nextActivePaneId;
		this.#activeBrowserPaneId = nextActivePaneId;
		for (const [id, entry] of this.#browsers) {
			if (this.#visibleBrowsers.has(id)) this.#attach(entry);
			else this.#detach(entry);
		}
		if (activeChanged) void this.#desktopHost?.refreshPaneBroker();
	}

	async closeBrowser(rawId: unknown): Promise<void> {
		const id = paneId(rawId);

		if (!this.#client?.isConnected || !this.#client.document) {
			this.destroyBrowserView(id);
			if (this.#activeSelectionPaneId === id && !this.#browsers.has(id)) {
				await this.#endSelection(id, "Browser closed");
			}
			return;
		}

		const doc = this.#client.document;
		const browser = doc.browsers.find(b => b.paneId === id || b.id === id);
		if (!browser || browser.status === "closed") {
			this.destroyBrowserView(id);
			if (this.#activeSelectionPaneId === id && !this.#browsers.has(id)) {
				await this.#endSelection(id, "Browser closed");
			}
			return;
		}

		const pane = doc.panes.find(item => item.entityId === browser.id);
		const tab = pane ? doc.tabs.find(item => item.id === pane.tabId) : undefined;
		const workspaceId =
			tab?.workspaceId ??
			doc.workspaces.find(w => w.locationId === browser.locationId)?.id ??
			doc.activeWorkspaceId ??
			"workspace-default";

		const res = await this.#client.executeCommandWithRetry(currentDoc => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-browser-close"),
			workspaceId,
			expectedRevision: currentDoc.revision,
			issuedAt: Date.now(),
			type: "browser.close" as const,
			payload: { id: browser.id },
		}));

		if (res.status === "rejected") {
			throw new Error(`Failed to close browser in runtime: ${res.error?.message ?? "rejected"}`);
		}

		this.syncWithDocument(res.document);
		if (this.#browsers.has(id)) {
			this.destroyBrowserView(id);
		}
		await this.#desktopHost?.refreshPaneBroker();
	}

	destroyBrowserView(id: string): void {
		const entry = this.#browsers.get(id);
		if (!entry) return;

		this.#invalidateQueueForPane(id);
		this.#browsers.delete(id);
		this.#visibleBrowsers.delete(id);
		if (this.#activeBrowserPaneId === id) {
			this.#activeBrowserPaneId = undefined;
			void this.#desktopHost?.refreshPaneBroker();
		}
		void this.#endSelection(id, "Browser view destroyed");
		for (const cleanup of entry.cleanup.splice(0)) cleanup();
		this.#detach(entry);
		if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close?.();
	}
	async updateTab(rawTabId: unknown, rawUpdates: unknown): Promise<void> {
		const tabId = typeof rawTabId === "string" ? rawTabId.trim() : "";
		if (!tabId) throw new TypeError("Invalid tab id");
		const updates = typeof rawUpdates === "object" && rawUpdates !== null ? (rawUpdates as UpdateTabInput) : {};
		if (!this.#client?.isConnected || !this.#client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const payload: Record<string, unknown> = { id: tabId };
		if (typeof updates.name === "string" && updates.name.trim().length > 0) payload.name = updates.name.trim();
		if (updates.layout === "columns" || updates.layout === "rows" || updates.layout === "grid")
			payload.layout = updates.layout;
		if (typeof updates.ratio === "number" && Number.isFinite(updates.ratio)) payload.ratio = updates.ratio;
		if (typeof updates.activePaneId === "string" && updates.activePaneId.trim().length > 0)
			payload.activePaneId = updates.activePaneId.trim();

		const res = await this.#client.executeCommandWithRetry(currentDoc => {
			const tab = currentDoc.tabs.find(t => t.id === tabId);
			if (!tab) throw new Error(`Tab '${tabId}' not found`);
			return {
				version: 1 as const,
				commandId: uniqueCommandId("cmd-tab-update"),
				workspaceId: tab.workspaceId,
				expectedRevision: currentDoc.revision,
				issuedAt: Date.now(),
				type: "tab.update" as const,
				payload,
			};
		});
		if (res.status === "accepted" || res.status === "duplicate") {
			this.syncWithDocument(res.document);
		}
	}

	async reorderTab(rawTabId: unknown, rawBeforeTabId: unknown): Promise<void> {
		const tabId = typeof rawTabId === "string" ? rawTabId.trim() : "";
		const beforeTabId = typeof rawBeforeTabId === "string" ? rawBeforeTabId.trim() : undefined;
		if (!tabId || (rawBeforeTabId !== undefined && !beforeTabId)) throw new TypeError("Invalid tab reorder");
		if (!this.#client?.isConnected || !this.#client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const res = await this.#client.executeCommandWithRetry(currentDoc => {
			const tab = currentDoc.tabs.find(item => item.id === tabId);
			if (!tab) throw new Error(`Tab '${tabId}' not found`);
			if (beforeTabId && !currentDoc.tabs.some(item => item.id === beforeTabId)) {
				throw new Error(`Tab '${beforeTabId}' not found`);
			}
			return {
				version: 1 as const,
				commandId: uniqueCommandId("cmd-tab-reorder"),
				workspaceId: tab.workspaceId,
				expectedRevision: currentDoc.revision,
				issuedAt: Date.now(),
				type: "tab.reorder" as const,
				payload: { id: tabId, ...(beforeTabId ? { beforeId: beforeTabId } : {}) },
			};
		});
		if (res.status === "rejected") {
			throw new Error(`Failed to reorder tab in runtime: ${res.error?.message ?? "rejected"}`);
		}
		this.syncWithDocument(res.document);
	}

	async closeTab(rawTabId: unknown): Promise<void> {
		const tabId = typeof rawTabId === "string" ? rawTabId.trim() : "";
		if (!tabId) throw new TypeError("Invalid tab id");
		if (!this.#client?.isConnected || !this.#client.document) return;
		const doc = this.#client.document;
		const tab = doc.tabs.find(t => t.id === tabId);
		if (!tab) {
			for (const id of this.#browsers.keys()) {
				const pane = doc.panes.find(p => p.id === id);
				if (pane && pane.tabId === tabId) this.destroyBrowserView(id);
			}
			return;
		}

		const res = await this.#client.executeCommandWithRetry(currentDoc => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-tab-close"),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDoc.revision,
			issuedAt: Date.now(),
			type: "tab.close" as const,
			payload: { id: tabId },
		}));

		if (res.status === "rejected") {
			throw new Error(`Failed to close tab in runtime: ${res.error?.message ?? "rejected"}`);
		}

		this.syncWithDocument(res.document);
		await this.#desktopHost?.refreshPaneBroker();
	}

	async closePane(rawPaneId: unknown): Promise<void> {
		const id = paneId(rawPaneId);

		const doc = this.#client?.document;
		const paneRecord = doc?.panes.find(p => p.id === id);
		if (paneRecord?.kind === "browser" || this.#browsers.has(id)) {
			await this.closeBrowser(id);
		} else {
			await this.closeTerminal(id);
		}
	}

	async createTerminal(options: CreateTerminalInput): Promise<TerminalViewState> {
		if (typeof options !== "object" || options === null) throw new TypeError("CreateTerminalInput must be an object");
		if (
			options.layout !== undefined &&
			options.layout !== "columns" &&
			options.layout !== "rows" &&
			options.layout !== "grid"
		) {
			throw new TypeError("layout must be columns, rows, or grid");
		}
		const id = paneId(options.id);
		const name = typeof options.name === "string" ? options.name.trim() : "";
		if (!name || name.length > 160) throw new TypeError("Invalid terminal name");
		const columns = dimension(options.cols, "Terminal columns");
		const rows = dimension(options.rows, "Terminal rows");
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const document = client.document;
		const workspace =
			document.workspaces.find(item => item.id === options.workspaceId) ??
			document.workspaces.find(item => item.id === document.activeWorkspaceId);
		if (!workspace) throw new Error("No active workspace found in authority document");
		const location = document.locations.find(item => item.id === workspace.locationId);
		if (!location) throw new Error(`Location '${workspace.locationId}' does not exist`);
		if (location.address.kind !== "local") throw new Error("Terminal tabs require a local workspace");
		const cwd = location.address.path;
		let terminal = document.terminals.find(item => item.paneId === id);
		if (!terminal || terminal.status === "closed") {
			const result = await client.executeCommandWithRetry(currentDocument => ({
				version: 1 as const,
				commandId: uniqueCommandId("cmd-terminal-open"),
				workspaceId: workspace.id,
				expectedRevision: currentDocument.revision,
				issuedAt: Date.now(),
				type: "terminal.open" as const,
				payload: {
					id: terminal?.id ?? `term-${id}`,
					paneId: id,
					tabId: options.tabId,
					tabName: name,
					locationId: location.id,
					label: name,
					columns,
					rows,
					cwd,
					...(options.layout ? { layout: options.layout } : {}),
					...(this.#settingsStore?.settings.terminal.shell
						? { shell: this.#settingsStore.settings.terminal.shell }
						: {}),
				},
			}));
			if (result.status !== "accepted" && result.status !== "duplicate") {
				throw new Error(
					`Failed to open terminal in runtime: command status '${result.status}' - ${result.error?.message ?? "rejected"}`,
				);
			}
			this.syncWithDocument(result.document);
			terminal = result.document.terminals.find(item => item.paneId === id);
		}
		if (!terminal) throw new Error(`Terminal pane '${id}' was not created`);
		this.#terminalIds.set(id, terminal.id);
		await this.#subscribeTerminal(id, terminal.id);
		return { id, cwd: terminal.cwd ?? cwd };
	}

	async attachTerminal(rawId: unknown, rawFromOffset: unknown): Promise<TerminalAttachmentState> {
		const id = paneId(rawId);
		if (typeof rawFromOffset !== "number" || !Number.isSafeInteger(rawFromOffset) || rawFromOffset < 0) {
			throw new RangeError("invalid replay offset");
		}
		const fromOffset = rawFromOffset;
		const client = this.#client;
		if (!client?.isConnected || !client.document) throw new Error("WorkspaceClient is not connected");
		const terminal = client.document.terminals.find(item => item.paneId === id);
		if (!terminal) throw new Error(`Terminal pane '${id}' is unavailable`);
		const chunks: TerminalAttachmentState["chunks"] = [];
		const removeCollector = client.onTerminalOutput(terminal.id, frame => {
			chunks.push({ offset: frame.offset, data: frame.data });
		});
		let snapshot: TerminalStatusFrame;
		try {
			snapshot = await client.subscribeTerminal(terminal.id, fromOffset);
		} finally {
			removeCollector();
		}
		this.#terminalIds.set(id, terminal.id);
		const ordered = chunks.sort((left, right) => left.offset - right.offset);
		const deduplicated: TerminalAttachmentState["chunks"] = [];
		let nextOffset = Math.max(fromOffset, snapshot.firstAvailableOffset);
		for (const chunk of ordered) {
			const bytes = Buffer.from(chunk.data, "utf8");
			const end = chunk.offset + bytes.byteLength;
			if (end <= nextOffset) continue;
			const delta = Math.max(0, nextOffset - chunk.offset);
			const data = bytes.subarray(delta).toString("utf8");
			deduplicated.push({ offset: chunk.offset + delta, data });
			nextOffset = end;
		}
		const status = snapshot.status === "closed" ? "exited" : snapshot.status;
		return {
			id,
			status,
			cwd: snapshot.cwd ?? terminal.cwd ?? "",
			chunks: deduplicated,
			firstAvailableOffset: snapshot.firstAvailableOffset,
			totalBytesProduced: snapshot.totalBytesProduced,
			...(terminal.error ? { error: terminal.error } : {}),
		};
	}

	async restartTerminal(rawId: unknown): Promise<TerminalAttachmentState> {
		const id = paneId(rawId);
		const client = this.#client;
		if (!client?.isConnected || !client.document) throw new Error("WorkspaceClient is not connected");
		const terminal = client.document.terminals.find(item => item.paneId === id);
		if (!terminal) throw new Error(`Terminal pane '${id}' is unavailable`);
		const pane = client.document.panes.find(item => item.id === id);
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		if (!tab) throw new Error(`Terminal pane '${id}' has no tab`);
		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-terminal-restart"),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "terminal.restart" as const,
			payload: { id: terminal.id },
		}));
		if (result.status !== "accepted" && result.status !== "duplicate") {
			throw new Error(`Failed to restart terminal: ${result.error?.message ?? result.status}`);
		}
		this.syncWithDocument(result.document);
		this.#unsubscribeTerminal(id);
		this.#terminalOffsets.delete(id);
		await this.#subscribeTerminal(id, terminal.id);
		return this.attachTerminal(id, 0);
	}

	async writeTerminal(rawId: unknown, rawData: unknown): Promise<void> {
		const id = paneId(rawId);
		if (typeof rawData !== "string" || Buffer.byteLength(rawData, "utf8") > 512 * 1024)
			throw new TypeError("Invalid terminal input");
		const terminalId = this.#terminalEntityId(id);
		if (!this.#client) throw new Error("WorkspaceClient is not configured");
		await this.#client.sendTerminalInput(terminalId, rawData);
	}

	async resizeTerminal(rawId: unknown, rawCols: unknown, rawRows: unknown): Promise<void> {
		const id = paneId(rawId);
		const terminalId = this.#terminalEntityId(id);
		if (!this.#client) throw new Error("WorkspaceClient is not configured");
		await this.#client.resizeTerminal(
			terminalId,
			dimension(rawCols, "Terminal columns"),
			dimension(rawRows, "Terminal rows"),
		);
	}

	async closeTerminal(rawId: unknown): Promise<void> {
		const id = paneId(rawId);
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
			return;
		}

		const terminalId = this.#terminalIds.get(id) ?? client.document.terminals.find(item => item.paneId === id)?.id;
		if (!terminalId) {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
			return;
		}

		const terminal = client.document.terminals.find(item => item.id === terminalId);
		if (!terminal || terminal.status === "closed") {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
			return;
		}

		const pane = client.document.panes.find(item => item.entityId === terminalId);
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		const workspaceId =
			tab?.workspaceId ??
			(terminal.locationId
				? client.document.workspaces.find(w => w.locationId === terminal.locationId)?.id
				: undefined) ??
			client.document.activeWorkspaceId ??
			"workspace-default";
		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-terminal-close"),
			workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "terminal.close" as const,
			payload: { id: terminal.id },
		}));
		if (result.status === "rejected") {
			throw new Error(`Failed to close terminal in runtime: ${result.error?.message ?? "rejected"}`);
		}
		this.syncWithDocument(result.document);
		if (this.#terminalIds.has(id)) {
			this.#unsubscribeTerminal(id);
			this.#terminalIds.delete(id);
			this.#terminalStates.delete(id);
			this.#terminalOffsets.delete(id);
		}
	}
	showPaneContextMenu(rawId: unknown, rawCanSplit: unknown): void {
		const id = paneId(rawId);
		if (typeof rawCanSplit !== "boolean") throw new TypeError("Pane split availability must be boolean");
		const select = (action: PaneContextMenuAction): void => {
			this.#send({ type: "pane-context-action", paneId: id, action });
		};
		const menu = Menu.buildFromTemplate([
			{ label: "Split Right", enabled: rawCanSplit, click: () => select("split-columns") },
			{ label: "Split Down", enabled: rawCanSplit, click: () => select("split-rows") },
			{ type: "separator" },
			{ label: "Close Pane", click: () => select("close") },
		]);
		menu.popup({ window: this.#window });
	}
	#nextSelectionGeneration(paneId: string): number {
		const generation = ++this.#selectionGenerationSequence;
		this.#selectionGenerations.set(paneId, generation);
		return generation;
	}
	#isCurrentSelection(paneId: string, generation: number, selectionId: string): boolean {
		return (
			this.#selectionGenerations.get(paneId) === generation &&
			this.#activeSelectionPaneId === paneId &&
			this.#selectionCoordinator.activeSelectionId === selectionId &&
			this.#boundScopes.has(paneId)
		);
	}
	#staleSelectionState(paneId: string): ElementEditState {
		return { phase: "idle", paneId, updatedAt: Date.now() };
	}
	async #waitForInspectorAction(entry: BrowserEntry): Promise<InspectorActionPayload | null> {
		if (entry.view.webContents.isDestroyed()) return null;
		let value: unknown;
		try {
			value = await entry.view.webContents.executeJavaScript("window.__gradivus_inspector_wait_for_action__?.()");
		} catch {
			value = null;
		}
		if (typeof value === "object" && value !== null) return value as InspectorActionPayload;
		await new Promise<void>(resolve => setTimeout(resolve, 16));
		return null;
	}

	async #finishInspector(entry: BrowserEntry, token: string, result: Record<string, unknown>): Promise<void> {
		if (entry.view.webContents.isDestroyed()) return;
		const payload = JSON.stringify({ ...result, token });
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const script = `window.__gradivus_inspector_finish__?.(${payload})`;
			const applied = await entry.view.webContents.executeJavaScript(script).catch(() => false);
			if (applied === true) return;
			if (attempt < 4) await sleep(100);
		}
	}

	async #cleanupInspector(entry: BrowserEntry, token: string, result: Record<string, unknown>): Promise<void> {
		if (entry.view.webContents.isDestroyed()) return;
		const payload = JSON.stringify({ ...result, token });
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				const cleanup = entry.view.webContents.executeJavaScript(
					`window.__gradivus_inspector_cleanup__?.(${payload})`,
				);
				await Promise.race([cleanup, sleep(250)]);
			} catch {}
			try {
				const present = await entry.view.webContents.executeJavaScript(
					"Boolean(document.getElementById('__gradivus_inspector_root__'))",
				);
				if (present !== true) return;
			} catch {}
			if (attempt < 2) await sleep(16);
		}
	}

	async #currentInspectorBounds(entry: BrowserEntry): Promise<InspectorBounds | null> {
		if (entry.view.webContents.isDestroyed()) return null;
		const bridge = "window.__gradivus_inspector_get_current_target_bounds__?.()";
		try {
			const bounds = await entry.view.webContents.executeJavaScript(bridge);
			if (typeof bounds !== "object" || bounds === null) return null;
			const value = bounds as Partial<InspectorBounds>;
			if (
				typeof value.x !== "number" ||
				typeof value.y !== "number" ||
				typeof value.width !== "number" ||
				typeof value.height !== "number" ||
				!Number.isFinite(value.x) ||
				!Number.isFinite(value.y) ||
				!Number.isFinite(value.width) ||
				!Number.isFinite(value.height) ||
				value.width <= 0 ||
				value.height <= 0
			) {
				return null;
			}
			return {
				x: value.x,
				y: value.y,
				width: value.width,
				height: value.height,
				top: typeof value.top === "number" ? value.top : value.y,
				left: typeof value.left === "number" ? value.left : value.x,
				right: typeof value.right === "number" ? value.right : value.x + value.width,
				bottom: typeof value.bottom === "number" ? value.bottom : value.y + value.height,
			};
		} catch {
			return null;
		}
	}

	#selectionCaptureRect(entry: BrowserEntry, bounds: InspectorBounds): InspectorBounds {
		const zoomFactor =
			typeof this.#window.webContents?.getZoomFactor === "function" ? this.#window.webContents.getZoomFactor() : 1;
		const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
		const viewportWidth = entry.cssBounds?.width ?? entry.bounds.width;
		const viewportHeight = entry.cssBounds?.height ?? entry.bounds.height;
		const padding = SELECTION_LIMITS.screenshotPaddingPx;
		const left = Math.max(0, Math.floor((bounds.left ?? bounds.x) * zoom - padding));
		const top = Math.max(0, Math.floor((bounds.top ?? bounds.y) * zoom - padding));
		const right = Math.min(
			Math.max(left + 1, Math.ceil((bounds.right ?? bounds.x + bounds.width) * zoom + padding)),
			Math.max(1, Math.round(viewportWidth * zoom)),
		);
		const bottom = Math.min(
			Math.max(top + 1, Math.ceil((bounds.bottom ?? bounds.y + bounds.height) * zoom + padding)),
			Math.max(1, Math.round(viewportHeight * zoom)),
		);
		return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
	}

	async #captureSelectionScreenshot(
		entry: BrowserEntry,
		_token: string,
		bounds: InspectorBounds | null,
	): Promise<ElementScreenshot> {
		if (typeof entry.view.webContents.capturePage !== "function")
			throw new Error("Screenshot capture is unavailable");
		const currentBounds = bounds ?? (await this.#currentInspectorBounds(entry));
		if (!currentBounds) throw new Error("target_unavailable");
		const clip = this.#selectionCaptureRect(entry, currentBounds);
		try {
			await entry.view.webContents
				.executeJavaScript("window.__gradivus_inspector_set_capture_hidden__?.(true)")
				.catch(() => undefined);
			const nativeImage = await entry.view.webContents.capturePage(clip);
			let image = nativeImage;
			let size = typeof image.getSize === "function" ? image.getSize() : { width: clip.width, height: clip.height };
			if (
				size.width > SELECTION_LIMITS.maxScreenshotDimension ||
				size.height > SELECTION_LIMITS.maxScreenshotDimension
			) {
				if (typeof image.resize !== "function") throw new Error("Screenshot capture exceeds selection limits");
				const scale = Math.min(
					SELECTION_LIMITS.maxScreenshotDimension / size.width,
					SELECTION_LIMITS.maxScreenshotDimension / size.height,
				);
				image = image.resize({
					width: Math.max(1, Math.floor(size.width * scale)),
					height: Math.max(1, Math.floor(size.height * scale)),
				});
				size = image.getSize();
			}
			let buffer = image.toJPEG(80);
			if (buffer.byteLength > SELECTION_LIMITS.maxImageBytes) buffer = image.toJPEG(60);
			if (buffer.byteLength > SELECTION_LIMITS.maxImageBytes) {
				throw new Error("Screenshot capture exceeds selection limits");
			}
			const base64 = buffer.toString("base64");
			return {
				dataUrl: `data:image/jpeg;base64,${base64}`,
				base64,
				mimeType: "image/jpeg",
				width: size.width,
				height: size.height,
				byteLength: buffer.byteLength,
			};
		} finally {
			await entry.view.webContents
				.executeJavaScript("window.__gradivus_inspector_set_capture_hidden__?.(false)")
				.catch(() => undefined);
		}
	}
	#queueForPane(id: string): SelectionQueueState {
		const existing = this.#selectionQueues.get(id);
		if (existing) return existing;
		const queue: SelectionQueueState = {
			generation: this.#selectionQueueGenerations.get(id) ?? 0,
			nextTaskIndex: 0,
			running: false,
			tasks: [],
		};
		this.#selectionQueues.set(id, queue);
		return queue;
	}

	#cloneQueuedTasks(tasks: QueuedElementTask[]): QueuedElementTask[] {
		return tasks.map(task => structuredClone(task));
	}

	#stateWithQueue(state: ElementEditState): ElementEditState {
		const queue = state.paneId ? this.#selectionQueues.get(state.paneId) : undefined;
		return {
			...state,
			queueRunning: queue?.running ?? false,
			queuedTasks: queue ? this.#cloneQueuedTasks(queue.tasks) : [],
		};
	}

	#enqueueQueuedTask(
		id: string,
		input: Omit<QueuedElementTask, "id" | "taskIndex" | "paneId" | "createdAt" | "status">,
	): QueuedElementTask {
		const queue = this.#queueForPane(id);
		if (queue.tasks.length >= SELECTION_LIMITS.maxLiveRequests) {
			throw new Error(`Selection queue is full (${SELECTION_LIMITS.maxLiveRequests} tasks)`);
		}
		const task: QueuedElementTask = {
			...input,
			id: `selection-task-${crypto.randomUUID()}`,
			taskIndex: ++queue.nextTaskIndex,
			paneId: id,
			createdAt: Date.now(),
			status: "pending",
		};
		queue.tasks.push(task);
		return structuredClone(task);
	}

	async #clearQueuedTasks(id: string): Promise<ElementEditState> {
		const queue = this.#queueForPane(id);
		if (queue.running) throw new Error("Cannot clear selection queue while it is running");
		queue.tasks = [];
		queue.nextTaskIndex = 0;
		queue.generation += 1;
		this.#selectionQueueGenerations.set(id, queue.generation);
		const entry = this.#browsers.get(id);
		if (entry && !entry.view.webContents.isDestroyed()) {
			await entry.view.webContents
				.executeJavaScript("window.__gradivus_inspector_clear_queue__?.()")
				.catch(() => undefined);
		}
		const base = this.#selectionStates.get(id) ?? { phase: "idle" as const, paneId: id, updatedAt: Date.now() };
		const state = this.#stateWithQueue({ ...base, updatedAt: Date.now() });
		this.#emitSelectionState(state);
		return state;
	}

	#invalidateQueueForPane(id: string): void {
		const current = this.#selectionQueues.get(id);
		const generation = current?.generation ?? this.#selectionQueueGenerations.get(id) ?? 0;
		this.#selectionQueueGenerations.set(id, generation + 1);
		this.#selectionQueues.delete(id);
	}
	async #enqueueSelectionPayload(
		id: string,
		generation: number,
		selectionId: string,
		token: string,
		scope: SelectionAuthScope,
		entry: BrowserEntry,
		target: SelectionTargetAgent,
		payload: InspectorActionPayload,
	): Promise<QueuedElementTask> {
		if (!this.#isCurrentSelection(id, generation, selectionId)) throw STALE_SELECTION_OPERATION;
		if (payload.queueValidationError) throw new Error(payload.queueValidationError);
		const queue = this.#queueForPane(id);
		const queueGeneration = queue.generation;
		const requestedAgentId = payload.targetAgentId?.trim() || target.id;
		const resolved =
			this.#desktopHost?.resolveSelectionTarget(id, requestedAgentId, entry.documentEpoch) ??
			(requestedAgentId === scope.agentId ? { scope, target } : undefined);
		if (!resolved) throw new Error("No deliverable workspace agent is available for selection");
		const instruction = payload.instruction?.trim() || "";
		if (!instruction) throw new Error("An instruction is required to add an element to the queue");
		const selector = payload.selector?.trim() || payload.tagName?.trim() || "element";
		const tagName = payload.tagName?.trim() || "element";
		const captureMode = payload.captureMode === "screenshot" ? "screenshot" : "dom";
		const bounds = payload.bounds ?? null;
		let screenshot: ElementScreenshot | undefined;
		if (captureMode === "screenshot") {
			screenshot = await this.#captureSelectionScreenshot(entry, token, bounds);
		}
		if (
			!this.#isCurrentSelection(id, generation, selectionId) ||
			this.#browsers.get(id) !== entry ||
			this.#selectionQueues.get(id)?.generation !== queueGeneration
		) {
			throw STALE_SELECTION_OPERATION;
		}
		const requestBytes = Buffer.byteLength(
			JSON.stringify({
				selector,
				url: entry.state.url,
				tagName,
				captureMode,
				screenshot,
				instruction,
			}),
			"utf8",
		);
		if (requestBytes > SELECTION_LIMITS.maxRequestStorageBytes) {
			throw new Error(
				`Selection request size (${requestBytes} bytes) exceeds per-request cap of ${SELECTION_LIMITS.maxRequestStorageBytes} bytes`,
			);
		}
		const task = this.#enqueueQueuedTask(id, {
			targetAgentId: resolved.scope.agentId,
			targetAgentName: resolved.target.name,
			agentSwatch: resolved.target.swatch,
			instruction,
			tagName,
			selector,
			agentType: payload.agentType?.trim() || undefined,
			captureMode,
			url: entry.state.url,
			screenshot: screenshot?.base64,
			screenshotWidth: screenshot?.width,
			screenshotHeight: screenshot?.height,
		});
		this.#emitSelectionState({
			phase: "picking",
			selectionId,
			workspaceId: scope.workspaceId,
			paneId: id,
			locationId: scope.locationId,
			locationGeneration: scope.locationGeneration,
			browserSessionId: entry.state.id,
			agentId: scope.agentId,
			captureMode,
			url: entry.state.url,
			updatedAt: Date.now(),
		});
		await this.#finishInspector(entry, token, {
			kind: "queue-added",
			taskId: task.id,
			taskIndex: task.taskIndex,
			targetAgentId: task.targetAgentId,
			targetAgentName: task.targetAgentName,
			agentSwatch: task.agentSwatch,
		});
		return task;
	}

	async #endSelection(
		paneId: string,
		reason?: string,
		expectedGeneration?: number,
		expectedSelectionId?: string,
	): Promise<void> {
		const currentGeneration = this.#selectionGenerations.get(paneId);
		if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) return;

		this.#nextSelectionGeneration(paneId);
		const entry = this.#browsers.get(paneId);
		const scope = this.#boundScopes.get(paneId);
		const selectionId = expectedSelectionId ?? this.#selectionCoordinator.activeSelectionId;
		const token = this.#selectionTokens.get(paneId) ?? "";
		this.#selectionTokens.delete(paneId);
		if (scope && (selectionId === undefined || selectionId === this.#selectionCoordinator.activeSelectionId)) {
			try {
				this.#selectionCoordinator.cancelSelection(scope, selectionId, reason);
			} catch {}
		}
		for (const [key, boundScope] of this.#boundScopes) {
			if (key === paneId || boundScope.paneId === paneId || boundScope === scope) this.#boundScopes.delete(key);
		}
		if (this.#activeSelectionPaneId === paneId) this.#activeSelectionPaneId = undefined;
		this.#emitSelectionState(this.#stateWithQueue({ phase: "idle", paneId, selectionId, updatedAt: Date.now() }));
		if (entry && token) await this.#cleanupInspector(entry, token, { canceled: true });
	}

	async ensureSelectionTarget(rawPaneId: unknown): Promise<{
		scope: SelectionAuthScope;
		target: SelectionTargetAgent;
	}> {
		const id = paneId(rawPaneId);
		const client = this.#client;
		const desktopHost = this.#desktopHost;
		if (!client || !desktopHost) throw new Error("Workspace agent services are unavailable for element selection");
		const entry = this.#requireBrowser(id);
		const document = client.document ?? (await client.getDocument());
		desktopHost.syncWithDocument(document);

		for (const agent of document.agents) {
			if (agent.profileId !== BROWSER_SELECTION_AGENT_PROFILE_ID || !agent.sessionId) continue;
			try {
				desktopHost.resolveSessionWorkspace(agent.sessionId);
				return desktopHost.resolveSelectionTarget(id, agent.id, entry.documentEpoch);
			} catch {
				// Stale page-agent records are skipped; the selector creates a fresh target below.
			}
		}

		const pane = document.panes.find(candidate => candidate.id === id);
		const tab = pane ? document.tabs.find(candidate => candidate.id === pane.tabId) : undefined;
		const location = tab ? document.locations.find(candidate => candidate.id === tab.locationId) : undefined;
		if (!pane || !tab || !location)
			throw new Error("Browser workspace location is unavailable for element selection");
		if (location.address.kind !== "local") {
			throw new Error("Page agents currently require a local workspace location");
		}
		if (!document.agentProfiles.some(profile => profile.id === BROWSER_SELECTION_AGENT_PROFILE_ID)) {
			throw new Error("Page Agent profile is unavailable");
		}

		const session = await desktopHost.createBrowserSelectionSession(location.address.path);
		const agentId = `${BROWSER_SELECTION_AGENT_ID_PREFIX}${crypto.randomUUID()}`;
		try {
			const result = await client.executeCommandWithRetry(currentDocument => ({
				version: 1 as const,
				commandId: uniqueCommandId("cmd-browser-selection-agent"),
				workspaceId: tab.workspaceId,
				expectedRevision: currentDocument.revision,
				issuedAt: Date.now(),
				type: "agent.start" as const,
				payload: {
					id: agentId,
					profileId: BROWSER_SELECTION_AGENT_PROFILE_ID,
					sessionId: session.id,
				},
			}));
			if (result.status !== "accepted" && result.status !== "duplicate") {
				throw new Error(`Page Agent creation failed: ${result.error?.message ?? result.status}`);
			}
			desktopHost.syncWithDocument(result.document);
			return desktopHost.resolveSelectionTarget(id, agentId, entry.documentEpoch);
		} catch (error) {
			await desktopHost.discardBrowserSelectionSession(session.id).catch(() => undefined);
			throw error;
		}
	}

	async startSelection(scope: SelectionAuthScope, options: StartSelectionOptions = {}): Promise<ElementEditState> {
		const id = paneId(scope.paneId);
		const previousPanes = new Set<string>([
			...(this.#activeSelectionPaneId ? [this.#activeSelectionPaneId] : []),
			...this.#selectionTokens.keys(),
		]);
		for (const previousPaneId of previousPanes) {
			if (previousPaneId === id) continue;
			await this.#endSelection(previousPaneId, "Switching selection to another pane");
		}
		if (this.#activeSelectionPaneId === id) {
			await this.#endSelection(id, "Restarting selection on this pane");
		}
		const entry = this.#requireBrowser(id);
		const generation = this.#nextSelectionGeneration(id);
		const token = crypto.randomUUID();
		this.#selectionTokens.set(id, token);
		this.#activeSelectionPaneId = id;
		this.#boundScopes.set(id, scope);

		const state = this.#selectionCoordinator.startSelection(scope, {
			...options,
			url: entry.state.url,
		});
		const activeId = state.selectionId ?? "";
		if (activeId) this.#boundScopes.set(activeId, scope);
		const target = options.target ?? {
			id: scope.agentId,
			name: scope.agentId,
			swatch: getAgentSwatch(scope.agentId),
		};
		const { webContents } = entry.view;
		if (!webContents.isDestroyed()) {
			webContents.focus?.();
			void (async () => {
				try {
					const initial = (await webContents.executeJavaScript(
						buildInspectorScript(
							this.resolveTheme(),
							token,
							target,
							this.#cloneQueuedTasks(this.#queueForPane(id).tasks),
						),
					)) as InspectorActionPayload | null;
					let payload = initial;
					while (this.#isCurrentSelection(id, generation, activeId)) {
						if (!payload) {
							payload = await this.#waitForInspectorAction(entry);
							continue;
						}
						if (payload.canceled || payload.closed) {
							await this.#endSelection(
								id,
								payload.closed ? "Closed by user" : "Canceled by user",
								generation,
								activeId,
							);
							return;
						}
						if (payload.enqueue) {
							try {
								await this.#enqueueSelectionPayload(
									id,
									generation,
									activeId,
									token,
									scope,
									entry,
									target,
									payload,
								);
							} catch (error) {
								if (!this.#isCurrentSelection(id, generation, activeId) || isStaleSelectionOperation(error))
									return;
								const message = error instanceof Error ? error.message : String(error);
								await this.#finishInspector(entry, token, { kind: "queue-add-error", message });
							}
							payload = await this.#waitForInspectorAction(entry);
							continue;
						}
						const instruction = typeof payload.instruction === "string" ? payload.instruction.trim() : "";
						if (!instruction) {
							payload = await this.#waitForInspectorAction(entry);
							continue;
						}
						if (!this.#isCurrentSelection(id, generation, activeId)) return;
						const boundScope = this.#boundScopes.get(id);
						if (!boundScope) return;
						const selector = payload.selector?.trim() || payload.tagName?.trim() || "element";
						const bounds = payload.bounds ?? null;
						let screenshot: ElementScreenshot | undefined;
						if (payload.captureMode === "screenshot") {
							screenshot = await this.#captureSelectionScreenshot(entry, token, bounds);
						}
						const updated = this.#selectionCoordinator.updateSelection(boundScope, activeId, {
							selector,
							captureMode: payload.captureMode === "screenshot" ? "screenshot" : "dom",
							screenshot,
							url: entry.state.url,
						});
						this.#emitSelectionState(updated);
						await this.#commitSelectionForGeneration(
							id,
							generation,
							activeId,
							instruction,
							payload.action,
							payload.agentType,
						);
						payload = await this.#waitForInspectorAction(entry);
					}
				} catch (error) {
					if (!this.#isCurrentSelection(id, generation, activeId) || isStaleSelectionOperation(error)) return;
					const message = error instanceof Error ? error.message : String(error);
					const errState = this.#selectionCoordinator.reportError(scope, activeId, "inspect_failed", message);
					this.#emitSelectionState(errState);
					await this.#finishInspector(entry, token, { kind: "error", message });
					const acknowledgement = await this.#waitForInspectorAction(entry);
					if (acknowledgement) {
						await this.#endSelection(
							id,
							acknowledgement.closed ? "Closed by user" : "Canceled by user",
							generation,
							activeId,
						);
					}
				}
			})();
		}
		this.#emitSelectionState(this.#stateWithQueue(state));
		return this.#stateWithQueue(state);
	}

	async cancelSelection(rawPaneId: unknown, rawReason?: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		const reason = typeof rawReason === "string" ? rawReason : undefined;
		await this.#endSelection(id, reason);
		return this.getSelectionState(id);
	}

	async #deliverSelection(
		scope: SelectionAuthScope,
		selectionState: ElementEditState,
		generation: number,
		selectionId: string,
		instruction: string | undefined,
		action: ElementTaskAction,
		agentType: string | undefined,
	): Promise<ElementEditState> {
		if (!this.#isCurrentSelection(scope.paneId, generation, selectionId)) throw STALE_SELECTION_OPERATION;
		const promptData = {
			url: selectionState.url,
			agentType,
			selector: selectionState.selector,
			captureMode: selectionState.captureMode,
			screenshotAttached: Boolean(selectionState.screenshot),
			screenshotWidth: selectionState.screenshot?.width,
			screenshotHeight: selectionState.screenshot?.height,
			instruction: instruction?.trim() || undefined,
		};
		const promptText = prompt.render(elementSelectionPromptTemplate, promptData);
		const entry = this.#browsers.get(scope.paneId);
		if (action === "inline") {
			selectionState.phase = "analyzing";
			selectionState.action = "inline";
			selectionState.instruction = instruction;
			selectionState.workingMessage = "Analyzing element with AI...";
			selectionState.updatedAt = Date.now();
			this.#emitSelectionState({ ...selectionState });
			try {
				if (!this.#desktopHost) throw new Error("OMP Chat is unavailable for inline selection");
				const response = await this.#desktopHost.executeInlinePrompt(promptText, scope.sessionId, {
					paneId: scope.paneId,
					selector: selectionState.selector,
					instruction,
					url: selectionState.url,
					agentType,
					captureMode: selectionState.captureMode,
					screenshot: selectionState.screenshot,
				});
				if (!this.#isCurrentSelection(scope.paneId, generation, selectionId)) throw STALE_SELECTION_OPERATION;
				if (!response.trim()) throw new Error("OMP returned no inline output");
				if (entry)
					await this.#finishInspector(entry, this.#selectionTokens.get(scope.paneId) ?? "", {
						kind: "inline-success",
						response,
					});
				selectionState.phase = "ready";
				selectionState.response = response;
				selectionState.workingMessage = undefined;
				selectionState.updatedAt = Date.now();
				this.#emitSelectionState({ ...selectionState });
				return selectionState;
			} catch (error) {
				if (isStaleSelectionOperation(error)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				if (entry)
					await this.#finishInspector(entry, this.#selectionTokens.get(scope.paneId) ?? "", {
						kind: "error",
						message,
					});
				throw error;
			}
		}

		selectionState.phase = "working";
		selectionState.action = "chat";
		selectionState.instruction = instruction;
		selectionState.workingMessage = "Delivering to chat...";
		selectionState.updatedAt = Date.now();
		this.#emitSelectionState({ ...selectionState });
		try {
			if (this.#desktopHost) {
				const chatSessionId = this.#desktopHost.resolveChatSessionForBrowserAgent(scope.sessionId);
				await this.#desktopHost.deliverElementPrompt(promptText, chatSessionId, {
					paneId: scope.paneId,
					selector: selectionState.selector,
					instruction,
					url: selectionState.url,
					agentType,
					captureMode: selectionState.captureMode,
					screenshot: selectionState.screenshot,
				});
			} else {
				const workspaceAgent = scope.agentId
					? this.#client?.document?.agents.find(
							(agent: WorkspaceDocumentV1["agents"][number]) => agent.id === scope.agentId,
						)
					: undefined;
				if (!workspaceAgent) throw new Error("No OMP Chat delivery route is available");
				const client = this.#client;
				if (!client?.isConnected || !client.document)
					throw new Error("WorkspaceClient is not connected to authoritative runtime");
				if (workspaceAgent.sessionId !== scope.sessionId)
					throw new Error(`Target agent '${scope.agentId}' session mismatch`);
				const result = await client.executeCommandWithRetry(currentDocument => ({
					version: 1 as const,
					commandId: uniqueCommandId("cmd-selection-deliver"),
					workspaceId: scope.workspaceId,
					expectedRevision: currentDocument.revision,
					issuedAt: Date.now(),
					type: "agent.message" as const,
					payload: {
						id: workspaceAgent.id,
						message: promptText,
						selector: selectionState.selector,
						url: selectionState.url,
						...(selectionState.screenshot ? { screenshot: selectionState.screenshot } : {}),
					},
				}));
				if (result.status === "rejected")
					throw new Error(result.error?.message ?? "Delivery rejected by workspace runtime");
			}
			if (!this.#isCurrentSelection(scope.paneId, generation, selectionId)) throw STALE_SELECTION_OPERATION;
			if (entry)
				await this.#finishInspector(entry, this.#selectionTokens.get(scope.paneId) ?? "", {
					kind: "chat-success",
					message: "Delivered to OMP Chat.",
				});
			selectionState.phase = "ready";
			selectionState.workingMessage = "Delivered to chat";
			selectionState.updatedAt = Date.now();
			this.#emitSelectionState({ ...selectionState });
			return selectionState;
		} catch (error) {
			if (isStaleSelectionOperation(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (entry)
				await this.#finishInspector(entry, this.#selectionTokens.get(scope.paneId) ?? "", {
					kind: "error",
					message,
				});
			throw error;
		}
	}

	async #commitSelectionForGeneration(
		id: string,
		generation: number,
		selectionId: string,
		rawInstruction?: unknown,
		rawAction?: unknown,
		agentType?: string,
	): Promise<ElementEditState> {
		if (!this.#isCurrentSelection(id, generation, selectionId)) return this.#staleSelectionState(id);
		const scope = this.#boundScopes.get(id);
		if (!scope) return this.#staleSelectionState(id);
		const action: ElementTaskAction =
			rawAction === "inline" || rawAction === "queue" || rawAction === "chat" ? rawAction : "chat";
		const instruction = typeof rawInstruction === "string" ? rawInstruction.trim() : undefined;
		if (!instruction) return this.#staleSelectionState(id);
		const committedState = this.#selectionCoordinator.commitSelection(scope, selectionId);
		committedState.action = action;
		committedState.instruction = instruction;
		try {
			return await this.#deliverSelection(
				scope,
				committedState,
				generation,
				selectionId,
				instruction,
				action,
				agentType,
			);
		} catch (error) {
			if (!this.#isCurrentSelection(id, generation, selectionId) || isStaleSelectionOperation(error)) {
				return this.#staleSelectionState(id);
			}
			const message = error instanceof Error ? error.message : String(error);
			const errState = this.#selectionCoordinator.reportError(scope, selectionId, "delivery_failed", message);
			this.#emitSelectionState(errState);
			return errState;
		}
	}

	async commitSelection(rawPaneId: unknown, rawInstruction?: unknown, rawAction?: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		const generation = this.#selectionGenerations.get(id);
		const selectionId = this.#selectionCoordinator.activeSelectionId;
		if (generation === undefined || !selectionId) return this.#staleSelectionState(id);
		return this.#commitSelectionForGeneration(id, generation, selectionId, rawInstruction, rawAction);
	}

	async #executeQueuedTasks(id: string, queueGeneration: number): Promise<ElementEditState> {
		const queue = this.#selectionQueues.get(id);
		if (!queue || queue.generation !== queueGeneration) return this.getSelectionState(id);
		const pendingTaskIds = queue.tasks.filter(task => task.status === "pending").map(task => task.id);
		try {
			for (const taskId of pendingTaskIds) {
				const currentQueue = this.#selectionQueues.get(id);
				const entry = this.#browsers.get(id);
				if (!currentQueue || currentQueue.generation !== queueGeneration || !entry)
					return this.getSelectionState(id);
				const task = currentQueue.tasks.find(candidate => candidate.id === taskId);
				if (task?.status !== "pending") continue;

				let resolved: { scope: SelectionAuthScope; target: SelectionTargetAgent };
				try {
					if (!this.#desktopHost) throw new Error("OMP Chat is unavailable for queued inline task");
					resolved = this.#desktopHost.resolveSelectionTarget(id, task.targetAgentId, entry.documentEpoch);
				} catch (error) {
					task.status = "error";
					task.error = error instanceof Error ? error.message : String(error);
					this.#emitSelectionState(
						this.#stateWithQueue({
							...(this.#selectionStates.get(id) ?? { phase: "idle" as const, paneId: id }),
							updatedAt: Date.now(),
						}),
					);
					continue;
				}

				task.status = "running";
				task.error = undefined;
				this.#emitSelectionState(
					this.#stateWithQueue({
						...(this.#selectionStates.get(id) ?? { phase: "idle" as const, paneId: id }),
						workingMessage: `Running task ${task.taskIndex}: ${task.instruction.slice(0, 40)}…`,
						updatedAt: Date.now(),
					}),
				);
				try {
					let screenshot: ElementScreenshot | undefined;
					if (task.captureMode === "screenshot") {
						if (!task.screenshot || !task.screenshotWidth || !task.screenshotHeight) {
							throw new Error("Queued screenshot capture is unavailable");
						}
						const base64 = task.screenshot.startsWith("data:")
							? task.screenshot.slice(task.screenshot.indexOf(",") + 1)
							: task.screenshot;
						screenshot = {
							dataUrl: task.screenshot.startsWith("data:")
								? task.screenshot
								: `data:image/jpeg;base64,${task.screenshot}`,
							base64,
							mimeType: "image/jpeg",
							width: task.screenshotWidth,
							height: task.screenshotHeight,
							byteLength: Buffer.from(base64, "base64").byteLength,
						};
					}
					if (task.captureMode === "screenshot" && !screenshot) {
						throw new Error("Queued screenshot capture is unavailable");
					}
					const promptText = prompt.render(elementSelectionPromptTemplate, {
						url: task.url ?? entry.state.url,
						targetAgentId: resolved.target.id,
						targetAgentName: resolved.target.name,
						agentType: task.agentType,
						selector: task.selector,
						tagName: task.tagName,
						captureMode: task.captureMode,
						instruction: task.instruction,
						screenshotAttached: Boolean(screenshot),
						screenshotWidth: task.screenshotWidth,
						screenshotHeight: task.screenshotHeight,
					});
					if (!this.#desktopHost) throw new Error("OMP Chat is unavailable for queued inline task");
					const response = await this.#desktopHost.executeInlinePrompt(promptText, resolved.scope.sessionId, {
						paneId: id,
						selector: task.selector,
						tagName: task.tagName,
						instruction: task.instruction,
						url: task.url ?? entry.state.url,
						agentType: task.agentType,
						captureMode: task.captureMode,
						screenshot,
					});
					const liveQueue = this.#selectionQueues.get(id);
					if (!liveQueue || liveQueue.generation !== queueGeneration || !this.#browsers.has(id)) {
						return this.getSelectionState(id);
					}
					if (!response.trim()) throw new Error("OMP returned no inline output");
					task.response = response;
					task.error = undefined;
					task.status = "completed";
				} catch (error) {
					const liveQueue = this.#selectionQueues.get(id);
					if (!liveQueue || liveQueue.generation !== queueGeneration || !this.#browsers.has(id)) {
						return this.getSelectionState(id);
					}
					task.status = "error";
					task.error = error instanceof Error ? error.message : String(error);
				}
				this.#emitSelectionState(
					this.#stateWithQueue({
						...(this.#selectionStates.get(id) ?? { phase: "idle" as const, paneId: id }),
						workingMessage: undefined,
						updatedAt: Date.now(),
					}),
				);
			}
		} finally {
			const liveQueue = this.#selectionQueues.get(id);
			if (liveQueue && liveQueue.generation === queueGeneration) {
				liveQueue.running = false;
				this.#emitSelectionState(
					this.#stateWithQueue({
						...(this.#selectionStates.get(id) ?? { phase: "idle" as const, paneId: id }),
						workingMessage: undefined,
						updatedAt: Date.now(),
					}),
				);
			}
		}
		return this.getSelectionState(id);
	}

	async runQueuedTasks(rawPaneId: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		this.#requireBrowser(id);
		const queue = this.#queueForPane(id);
		if (queue.running) throw new Error("Selection queue is already running");
		if (!queue.tasks.some(task => task.status === "pending")) return this.getSelectionState(id);
		queue.running = true;
		const state = this.#stateWithQueue({
			...(this.#selectionStates.get(id) ?? { phase: "idle" as const, paneId: id }),
			updatedAt: Date.now(),
		});
		this.#emitSelectionState(state);
		return this.#executeQueuedTasks(id, queue.generation);
	}

	async clearQueuedTasks(rawPaneId: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		this.#requireBrowser(id);
		return this.#clearQueuedTasks(id);
	}

	getSelectionState(rawPaneId: unknown): ElementEditState {
		const id = paneId(rawPaneId);
		const current = this.#selectionStates.get(id);
		if (current) return this.#stateWithQueue(current);
		const scope = this.#boundScopes.get(id);
		if (scope) return this.#stateWithQueue(this.#selectionCoordinator.getState(scope));
		return this.#stateWithQueue({ phase: "idle", paneId: id, updatedAt: Date.now() });
	}

	getBrowserDocumentEpoch(rawPaneId: unknown): number {
		const id = paneId(rawPaneId);
		const entry = this.#browsers.get(id);
		if (!entry) {
			throw new Error(`Browser pane '${id}' not found`);
		}
		return entry.documentEpoch;
	}
	#emitSelectionState(state: ElementEditState): void {
		const projected = this.#stateWithQueue(state);
		if (projected.paneId) {
			this.#selectionStates.set(projected.paneId, {
				...projected,
				queuedTasks: projected.queuedTasks ? this.#cloneQueuedTasks(projected.queuedTasks) : [],
			});
		}
		const outbound = {
			...projected,
			queuedTasks: projected.queuedTasks ? this.#cloneQueuedTasks(projected.queuedTasks) : [],
		};
		if (!this.#window.isDestroyed() && this.#window.webContents && !this.#window.webContents.isDestroyed()) {
			try {
				this.#window.webContents.send("gradivus:selection-state", outbound);
				if (outbound.paneId) {
					this.#send({ type: "selection-state", paneId: outbound.paneId, state: outbound });
				}
			} catch {}
		}
	}

	async stop(): Promise<void> {
		for (const paneId of this.#terminalSubscriptions.keys()) this.#unsubscribeTerminal(paneId);
		this.#terminalIds.clear();
		this.#terminalStates.clear();
		this.#terminalOffsets.clear();
		for (const id of [...this.#browsers.keys()]) this.destroyBrowserView(id);
	}

	async #persistBrowserNavigation(id: string, url: string): Promise<void> {
		const entry = this.#browsers.get(id);
		if (!entry) return;
		entry.pendingNavigation = { url, issuedAt: Date.now() };

		const client = this.#client;
		if (!client?.isConnected || !client.document) return;
		const browser = client.document.browsers.find(item => item.paneId === id || item.id === id);
		if (!browser || browser.url === url) return;
		const pane = client.document.panes.find(item => item.entityId === browser.id);
		const tab = pane ? client.document.tabs.find(item => item.id === pane.tabId) : undefined;
		if (!tab) return;
		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId(`cmd-browser-navigate-view-${id}`),
			workspaceId: tab.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "browser.navigate" as const,
			payload: { id: browser.id, url },
		}));
		if (result.status === "rejected") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			const rollbackUrl = entry.authoritativeUrl;
			entry.state = { ...entry.state, url: rollbackUrl };
			this.#setBrowserError(id, new Error(`Failed to persist navigation: ${result.error?.message ?? "rejected"}`));
			void entry.view.webContents.loadURL(rollbackUrl).catch((error: unknown) => this.#setBrowserError(id, error));
			return;
		}
		if (result.status === "accepted" || result.status === "duplicate") {
			if (entry.pendingNavigation?.url === url) {
				entry.pendingNavigation = undefined;
			}
			entry.authoritativeUrl = url;
			this.syncWithDocument(result.document);
		}
	}
	async #updateBrowserFavicon(id: string, entry: BrowserEntry, urls: string[]): Promise<void> {
		const candidate =
			urls.find(url => url.length <= 4_096 && url.startsWith("data:image/")) ??
			urls.find(url => {
				if (url.length > 4_096) return false;
				try {
					const protocol = new URL(url).protocol;
					return protocol === "https:" || protocol === "http:";
				} catch {
					return false;
				}
			});
		if (!candidate) return;
		const documentEpoch = entry.documentEpoch;
		let faviconUrl = candidate;
		if (!candidate.startsWith("data:image/")) {
			try {
				const response = await electron.net.fetch(candidate);
				if (!response.ok || !response.body) return;
				const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
				if (!contentType || (!contentType.startsWith("image/") && contentType !== "application/octet-stream"))
					return;
				const declaredLength = Number(response.headers.get("content-length"));
				if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) return;
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let total = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value.byteLength;
					if (total > 256 * 1024) {
						await reader.cancel();
						return;
					}
					chunks.push(value);
				}
				const bytes = new Uint8Array(total);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				faviconUrl = `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
			} catch {
				return;
			}
		}
		if (this.#browsers.get(id) !== entry || entry.documentEpoch !== documentEpoch) return;
		entry.state = { ...entry.state, faviconUrl };
		this.#emitBrowserState(id);
	}

	#bindBrowser(id: string, entry: BrowserEntry): void {
		const { webContents } = entry.view;
		webContents.on("did-start-loading", () => {
			entry.state = { ...entry.state, loading: true, error: undefined, faviconUrl: undefined };
			this.#emitBrowserState(id);
		});
		webContents.on("did-stop-loading", () => {
			entry.state = { ...entry.state, loading: false };
			this.#refreshBrowserState(id);
		});
		webContents.on("did-finish-load", () => {
			const title = webContents.getTitle().trim().slice(0, 160);
			if (title) {
				entry.state = { ...entry.state, title };
				this.#emitBrowserState(id);
			}
		});
		webContents.on(
			"did-start-navigation",
			(_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
				if (isMainFrame === false) return;
				entry.navigationSerial++;
				entry.navigationPending = true;
				entry.navigationFailure = undefined;
				entry.paneExecutionWorld = undefined;
			},
		);
		webContents.on("did-navigate", (_event: unknown, url: string) => {
			entry.navigationPending = false;
			entry.documentEpoch++;
			entry.navigationFailure = undefined;
			entry.paneExecutionWorld = undefined;
			void this.#endSelection(id, "Page navigated");
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
			void this.#persistBrowserNavigation(id, url).catch(() => {});
		});
		webContents.on("did-navigate-in-page", (_event: unknown, url: string, isMainFrame: boolean) => {
			if (isMainFrame !== false) {
				entry.documentEpoch++;
				entry.navigationPending = false;
				entry.navigationFailure = undefined;
				entry.paneExecutionWorld = undefined;
				void this.#endSelection(id, "In-page navigation");
			}
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
			if (isMainFrame !== false) void this.#persistBrowserNavigation(id, url).catch(() => {});
		});
		webContents.on("page-title-updated", (_event: unknown, title: string) => {
			const pageTitle = title.trim().slice(0, 160) || "Browser";
			entry.state = { ...entry.state, title: pageTitle };
			this.#emitBrowserState(id);
		});
		webContents.on("page-favicon-updated", (_event: unknown, urls: string[]) => {
			void this.#updateBrowserFavicon(id, entry, urls);
		});
		webContents.on("found-in-page", (_event: unknown, result: Electron.FoundInPageResult) => {
			if (entry.findRequestId !== undefined && result.requestId !== entry.findRequestId) return;
			const state: BrowserFindState = {
				query: entry.findQuery ?? "",
				activeMatchOrdinal: result.activeMatchOrdinal,
				matches: result.matches,
				finalUpdate: result.finalUpdate,
			};
			this.#send({ type: "browser-find", paneId: id, state });
		});
		const downloadHandler = (
			event: Electron.Event,
			item: Electron.DownloadItem,
			source: Electron.WebContents,
		): void => {
			if (source !== webContents) return;
			event.preventDefault();
			item.cancel();
			this.#send({
				type: "browser-warning",
				paneId: id,
				message: "Downloads are not available in Gradivus.",
			});
		};
		const browserSession = (webContents as Electron.WebContents & { session?: Electron.Session }).session;
		if (browserSession) {
			browserSession.on("will-download", downloadHandler);
			entry.cleanup.push(() => browserSession.removeListener("will-download", downloadHandler));
		}
		webContents.on(
			"did-fail-load",
			(_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
				if (!isMainFrame) return;
				entry.navigationPending = false;
				entry.navigationFailure =
					errorCode === -3 ? "Navigation was cancelled" : errorDescription || `Navigation failed (${errorCode})`;
				entry.paneExecutionWorld = undefined;
				entry.state = {
					...entry.state,
					url: validatedURL || entry.state.url,
					loading: false,
					error: errorDescription || `Navigation failed (${errorCode})`,
				};
				this.#emitBrowserState(id);
			},
		);
		webContents.on("focus", () => this.#send({ type: "browser-focus", paneId: id }));
		webContents.on("context-menu", () => {
			this.showPaneContextMenu(id, this.#visibleBrowsers.size < MAX_WORKSPACE_PANES);
		});
		webContents.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;
			const command = input.control || input.meta;
			const key = input.key.toLowerCase();
			let shortcut: BrowserShortcut | undefined;
			if (command && key === "tab") shortcut = input.shift ? "previous-tab" : "next-tab";
			else if (command && input.shift && key === "t") shortcut = "reopen-tab";
			else if (command && input.shift && key === "r") shortcut = "hard-reload";
			else if (command && !input.shift && key === "t") shortcut = "new-tab";
			else if (command && !input.shift && key === "w") shortcut = "close-tab";
			else if (command && !input.shift && key === "l") shortcut = "focus-address";
			else if (command && !input.shift && key === "f") shortcut = "find";
			else if (command && !input.shift && key === "-") shortcut = "zoom-out";
			else if (command && !input.shift && (key === "+" || key === "=")) shortcut = "zoom-in";
			else if (command && !input.shift && key === "0") shortcut = "zoom-reset";
			else if (!command && input.alt && key === "arrowleft") shortcut = "back";
			else if (!command && input.alt && key === "arrowright") shortcut = "forward";
			if (!shortcut) return;
			event.preventDefault();
			this.#send({ type: "browser-shortcut", paneId: id, shortcut });
		});
		webContents.on("render-process-gone", (_event: unknown, details: { reason?: string }) => {
			entry.state = {
				...entry.state,
				loading: false,
				error: `Browser process stopped: ${details?.reason ?? "unknown"}`,
			};
			this.#emitBrowserState(id);
		});
		webContents.on("will-navigate", (event: { preventDefault: () => void }, url: string) => {
			try {
				this.#getBrowserUrl(url);
			} catch {
				event.preventDefault();
			}
		});
		webContents.on("will-redirect", (event: { preventDefault: () => void }, url: string) => {
			try {
				this.#getBrowserUrl(url);
			} catch {
				event.preventDefault();
			}
		});
		if (typeof webContents.setWindowOpenHandler === "function") {
			webContents.setWindowOpenHandler(details => {
				try {
					const targetUrl = this.#getBrowserUrl(details.url).toString();
					this.#send({ type: "browser-new-window", paneId: id, url: targetUrl });
				} catch {}
				return { action: "deny" };
			});
		}
	}

	#refreshBrowserState(id: string): void {
		const entry = this.#browsers.get(id);
		if (!entry || entry.view.webContents.isDestroyed()) return;
		const history = entry.view.webContents.navigationHistory;
		entry.state = {
			...entry.state,
			url: entry.view.webContents.getURL() || entry.state.url,
			canGoBack: history.canGoBack(),
			canGoForward: history.canGoForward(),
		};
		this.#emitBrowserState(id);
	}

	#setBrowserError(id: string, error: unknown): void {
		const entry = this.#browsers.get(id);
		if (!entry) return;
		entry.state = { ...entry.state, loading: false, error: error instanceof Error ? error.message : String(error) };
		this.#emitBrowserState(id);
	}

	#emitBrowserState(id: string): void {
		const state = this.#browsers.get(id)?.state;
		if (state) this.#send({ type: "browser-state", paneId: id, state: { ...state } });
	}

	#send(event: WorkspaceEvent): void {
		if (!this.#window.isDestroyed() && this.#window.webContents && !this.#window.webContents.isDestroyed()) {
			try {
				this.#window.webContents.send("gradivus:workspace", event);
			} catch {}
		}
	}

	#requireBrowser(id: string): BrowserEntry {
		const entry = this.#browsers.get(id);
		if (!entry) throw new Error("Browser pane is unavailable");
		return entry;
	}

	#attach(entry: BrowserEntry): void {
		if (!entry.attached) {
			this.#window.contentView.addChildView(entry.view);
			entry.attached = true;
		}
		if (entry.cssBounds) {
			entry.bounds = this.#toDipBounds(entry.cssBounds);
		}
		if (entry.bounds.width > 0 && entry.bounds.height > 0) entry.view.setBounds(entry.bounds);
	}
	#detach(entry: BrowserEntry): void {
		if (!entry.attached) return;
		this.#window.contentView.removeChildView(entry.view);
		entry.attached = false;
	}
}

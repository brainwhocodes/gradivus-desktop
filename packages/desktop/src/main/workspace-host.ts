import type { WebContentsView } from "electron";
import * as electron from "electron";

const { Menu } = electron;

import * as prompt from "@oh-my-pi/pi-utils/prompt";
import type { WorkspaceClient } from "@oh-my-pi/pi-workspace-runtime";
import {
	type ElementScreenshot,
	ElementSelectionCoordinator,
	SELECTION_LIMITS,
	type SelectionAuthScope,
	type StartSelectionOptions,
} from "@oh-my-pi/pi-workspace-runtime/selection";
import type { TerminalOutputFrame } from "@oh-my-pi/pi-workspace-runtime/terminal-protocol";
import type {
	BrowserBounds,
	BrowserNavigationAction,
	BrowserViewState,
	CreateBrowserInput,
	CreateTerminalInput,
	ElementEditState,
	PaneContextMenuAction,
	TerminalViewState,
	UpdateTabInput,
	WorkspaceDocumentV1,
	WorkspaceEvent,
} from "../shared/contracts";
import type { AppSettingsStore } from "./app-settings";
import { defaultWorkspacePath } from "./backend-path";
import elementSelectionPromptTemplate from "./prompts/element-selection.md" with { type: "text" };

export const BROWSER_BG_DARK = "#1c1b1a";
export const BROWSER_BG_LIGHT = "#f6f2eb";
const MAX_WORKSPACE_PANES = 4;

function uniqueCommandId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

const INSPECTOR_SCRIPT = `
(function() {
  return new Promise((resolve) => {
    if (window.__branchlight_inspector_cleanup__) {
      window.__branchlight_inspector_cleanup__({ canceled: true });
    }

    const isLocal = Boolean(
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.hostname === '0.0.0.0' ||
      location.hostname === '::1' ||
      location.hostname.endsWith('.local') ||
      location.hostname.startsWith('local.') ||
      location.hostname.includes('.local.') ||
      location.hostname.endsWith('.localhost') ||
      location.hostname.endsWith('.test') ||
      location.hostname.endsWith('.internal')
    );

    const container = document.createElement('div');
    container.id = '__branchlight_inspector_root__';
    container.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647; pointer-events: none;';
    
    const shadow = container.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      '* { box-sizing: border-box; margin: 0; padding: 0; }',
      '.inspector-box {',
      '  position: fixed;',
      '  pointer-events: none;',
      '  box-sizing: border-box;',
      '  border: 2px solid #f97316;',
      '  background: rgba(249, 115, 22, 0.20);',
      '  border-radius: 3px;',
      '  z-index: 2147483646;',
      '  display: none;',
      '  box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 14px rgba(249, 115, 22, 0.45);',
      '  transition: all 40ms ease-out;',
      '}',
      '.inspector-box.selected {',
      '  border: 2px solid #f97316;',
      '  background: rgba(249, 115, 22, 0.28);',
      '  box-shadow: 0 0 0 2px rgba(0,0,0,0.7), 0 0 24px rgba(249, 115, 22, 0.7);',
      '  transition: none;',
      '}',
      '.inspector-pill {',
      '  position: absolute;',
      '  bottom: calc(100% + 5px);',
      '  left: 0;',
      '  background: #1c1b1a;',
      '  color: #f6f2eb;',
      '  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;',
      '  font-size: 11px;',
      '  line-height: 14px;',
      '  padding: 3px 8px;',
      '  border-radius: 4px;',
      '  box-shadow: 0 4px 14px rgba(0,0,0,0.6);',
      '  border: 1px solid rgba(255,255,255,0.25);',
      '  white-space: nowrap;',
      '  display: flex;',
      '  gap: 6px;',
      '  align-items: center;',
      '  pointer-events: none;',
      '}',
      '.pill-tag { color: #f97316; font-weight: 700; }',
      '.pill-id { color: #38bdf8; }',
      '.pill-class { color: #a78bfa; }',
      '.pill-dim { color: #94a3b8; font-size: 10px; font-weight: 500; }',
      '.floating-card {',
      '  position: fixed;',
      '  z-index: 2147483647;',
      '  width: min(520px, calc(100vw - 32px));',
      '  padding: 14px;',
      '  border-radius: 12px;',
      '  background: rgba(28, 27, 26, 0.96);',
      '  border: 1px solid rgba(249, 115, 22, 0.4);',
      '  box-shadow: 0 20px 50px rgba(0,0,0,0.7), 0 0 0 1px rgba(249, 115, 22, 0.2);',
      '  backdrop-filter: blur(16px);',
      '  color: #f6f2eb;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 12px;',
      '  pointer-events: auto;',
      '  animation: cardFadeIn 160ms cubic-bezier(0.16, 1, 0.3, 1);',
      '}',
      '@keyframes cardFadeIn {',
      '  from { opacity: 0; transform: translateY(8px); }',
      '  to { opacity: 1; transform: translateY(0); }',
      '}',
      '.card-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  padding-bottom: 10px;',
      '  border-bottom: 1px solid rgba(255,255,255,0.1);',
      '}',
      '.target-info {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  min-width: 0;',
      '}',
      '.target-icon { color: #f97316; font-weight: bold; font-size: 13px; }',
      '.target-name { font-family: ui-monospace, monospace; font-size: 12px; font-weight: 700; color: #fff; }',
      '.target-selector { font-family: ui-monospace, monospace; font-size: 10.5px; color: #a49d93; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.mode-badge { font-family: ui-monospace, monospace; font-size: 9px; font-weight: 750; padding: 2px 6px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }',
      '.mode-badge.local { background: rgba(249, 115, 22, 0.2); color: #f97316; }',
      '.mode-badge.external { background: rgba(255, 255, 255, 0.1); color: #a49d93; border: 1px solid rgba(255,255,255,0.15); }',
      '.card-close-btn {',
      '  width: 22px;',
      '  height: 22px;',
      '  border: 0;',
      '  background: transparent;',
      '  color: #a49d93;',
      '  font-size: 16px;',
      '  line-height: 1;',
      '  cursor: pointer;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  border-radius: 4px;',
      '}',
      '.card-close-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }',
      '.card-textarea {',
      '  width: 100%;',
      '  min-height: 64px;',
      '  margin-top: 10px;',
      '  padding: 8px 10px;',
      '  border: 1px solid rgba(255,255,255,0.15);',
      '  border-radius: 6px;',
      '  background: #141312;',
      '  color: #fff;',
      '  font-family: inherit;',
      '  font-size: 12px;',
      '  line-height: 1.45;',
      '  resize: vertical;',
      '  outline: none;',
      '}',
      '.card-textarea:focus { border-color: #f97316; box-shadow: 0 0 0 1px #f97316; }',
      '.card-chips {',
      '  display: flex;',
      '  flex-wrap: wrap;',
      '  gap: 6px;',
      '  margin-top: 8px;',
      '}',
      '.chip {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  padding: 3px 8px;',
      '  border: 1px solid rgba(255,255,255,0.12);',
      '  border-radius: 999px;',
      '  background: rgba(255,255,255,0.04);',
      '  color: #a49d93;',
      '  font-size: 10.5px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '.chip:hover { border-color: #f97316; color: #fff; background: rgba(249, 115, 22, 0.15); }',
      '.recreate-dropdown-wrap { position: relative; display: inline-block; }',
      '.recreate-trigger-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  height: 24px;',
      '  padding: 0 10px;',
      '  border: 1px solid rgba(255,255,255,0.18);',
      '  border-radius: 999px;',
      '  background: #141312;',
      '  color: #f97316;',
      '  font-family: inherit;',
      '  font-size: 10.5px;',
      '  font-weight: 700;',
      '  cursor: pointer;',
      '  user-select: none;',
      '}',
      '.recreate-trigger-btn:hover { border-color: #f97316; background: rgba(249, 115, 22, 0.15); }',
      '.recreate-menu {',
      '  position: absolute;',
      '  top: calc(100% + 4px);',
      '  left: 0;',
      '  z-index: 2147483647;',
      '  width: 170px;',
      '  padding: 4px;',
      '  border-radius: 8px;',
      '  background: #1c1b1a;',
      '  border: 1px solid rgba(255,255,255,0.2);',
      '  box-shadow: 0 12px 30px rgba(0,0,0,0.7);',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 2px;',
      '}',
      '.recreate-item {',
      '  display: flex;',
      '  align-items: center;',
      '  width: 100%;',
      '  height: 28px;',
      '  padding: 0 8px;',
      '  border: 0;',
      '  border-radius: 5px;',
      '  background: transparent;',
      '  color: #f6f2eb;',
      '  font-family: inherit;',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  text-align: left;',
      '  cursor: pointer;',
      '}',
      '.recreate-item:hover { background: rgba(249, 115, 22, 0.2); color: #f97316; }',
      '.card-footer {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-top: 12px;',
      '  padding-top: 4px;',
      '}',
      '.mode-toggles {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 2px;',
      '  padding: 2px;',
      '  border: 1px solid rgba(255,255,255,0.12);',
      '  border-radius: 5px;',
      '  background: #141312;',
      '}',
      '.mode-toggle {',
      '  padding: 2px 7px;',
      '  border: 0;',
      '  border-radius: 3px;',
      '  background: transparent;',
      '  color: #a49d93;',
      '  font-size: 10.5px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '}',
      '.mode-toggle.active { background: #f97316; color: #fff; font-weight: 700; }',
      '.card-actions { display: flex; gap: 6px; }',
      '.btn-cancel {',
      '  height: 28px;',
      '  padding: 0 10px;',
      '  border: 1px solid rgba(255,255,255,0.15);',
      '  border-radius: 5px;',
      '  background: transparent;',
      '  color: #a49d93;',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '}',
      '.btn-cancel:hover { background: rgba(255,255,255,0.08); color: #fff; }',
      '.btn-submit {',
      '  height: 28px;',
      '  padding: 0 12px;',
      '  border: 1px solid #f97316;',
      '  border-radius: 5px;',
      '  background: #f97316;',
      '  color: #fff;',
      '  font-size: 11.5px;',
      '  font-weight: 700;',
      '  cursor: pointer;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '}',
      '.btn-submit:hover:not(:disabled) { filter: brightness(1.15); }',
      '.btn-submit:disabled { opacity: 0.4; cursor: default; }'
    ].join('\\n');
    shadow.appendChild(style);

    const cursorStyle = document.createElement('style');
    cursorStyle.id = '__branchlight_cursor_style__';
    cursorStyle.textContent = '* { cursor: crosshair !important; }';
    (document.head || document.documentElement).appendChild(cursorStyle);

    const box = document.createElement('div');
    box.className = 'inspector-box';
    const pill = document.createElement('div');
    pill.className = 'inspector-pill';
    box.appendChild(pill);
    shadow.appendChild(box);

    const card = document.createElement('div');
    card.className = 'floating-card';
    card.style.display = 'none';
    shadow.appendChild(card);

    document.documentElement.appendChild(container);

    let currentTarget = null;
    let selectedElement = null;
    let selectedMetadata = null;
    let currentCaptureMode = 'dom';
    let rafId = null;

    function generateSelector(el) {
      if (!el || el.nodeType !== 1) return '';
      if (el.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(el.id)) {
        try {
          if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
            return '#' + CSS.escape(el.id);
          }
        } catch {}
      }
      for (const attr of ['data-testid', 'data-test', 'data-cy']) {
        const val = el.getAttribute(attr);
        if (val) {
          try {
            const sel = '[' + attr + '="' + CSS.escape(val) + '"]';
            if (document.querySelectorAll(sel).length === 1) return sel;
          } catch {}
        }
      }
      const tag = el.tagName.toLowerCase();
      if (el.classList && el.classList.length > 0) {
        try {
          const classes = Array.from(el.classList).slice(0, 3).map(c => '.' + CSS.escape(c)).join('');
          const tagClasses = tag + classes;
          if (document.querySelectorAll(tagClasses).length === 1) return tagClasses;
        } catch {}
      }
      let path = [];
      let current = el;
      while (current && current.nodeType === 1 && current !== document.documentElement && path.length < 5) {
        let step = current.tagName.toLowerCase();
        if (current.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(current.id)) {
          step = '#' + CSS.escape(current.id);
          path.unshift(step);
          break;
        }
        let sibling = current;
        let nth = 1;
        while ((sibling = sibling.previousElementSibling)) {
          if (sibling.tagName.toLowerCase() === current.tagName.toLowerCase()) nth++;
        }
        if (nth > 1) step += ':nth-of-type(' + nth + ')';
        path.unshift(step);
        current = current.parentElement;
      }
      return path.join(' > ');
    }

    function updateOverlay(el) {
      if (!el || el === container || container.contains(el) || selectedElement) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';
      box.style.top = rect.top + 'px';
      box.style.left = rect.left + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';

      const tag = el.tagName.toLowerCase();
      const idStr = el.id ? '#' + el.id : '';
      const classStr = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      const dimStr = Math.round(rect.width) + ' × ' + Math.round(rect.height);

      pill.innerHTML = '<span class="pill-tag">&lt;' + tag + '&gt;</span>' +
        (idStr ? '<span class="pill-id">' + idStr + '</span>' : '') +
        (classStr ? '<span class="pill-class">' + classStr + '</span>' : '') +
        '<span class="pill-dim">' + dimStr + '</span>';

      if (rect.top < 34) {
        pill.style.bottom = 'auto';
        pill.style.top = 'calc(100% + 4px)';
      } else {
        pill.style.top = 'auto';
        pill.style.bottom = 'calc(100% + 4px)';
      }
    }

    function extractMetadata(el) {
      const rect = el.getBoundingClientRect();
      const computed = window.getComputedStyle(el);
      const attributes = {};
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        attributes[attr.name] = attr.value;
      }
      const hierarchy = [];
      let cur = el.parentElement;
      while (cur && hierarchy.length < 8) {
        hierarchy.push(cur.tagName.toLowerCase());
        cur = cur.parentElement;
      }
      return {
        tagName: el.tagName.toLowerCase(),
        selector: generateSelector(el),
        id: el.id || undefined,
        classes: Array.from(el.classList || []),
        attributes: attributes,
        role: el.getAttribute('role') || undefined,
        name: el.getAttribute('aria-label') || el.getAttribute('title') || undefined,
        text: (el.innerText || el.textContent || '').trim().slice(0, 1024),
        outerHTML: (el.outerHTML || '').slice(0, 32768),
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          bottom: Math.round(rect.bottom),
          right: Math.round(rect.right)
        },
        computedStyles: {
          display: computed.display,
          position: computed.position,
          fontSize: computed.fontSize,
          fontFamily: computed.fontFamily,
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          padding: computed.paddingTop + ' ' + computed.paddingRight + ' ' + computed.paddingBottom + ' ' + computed.paddingLeft,
          margin: computed.marginTop + ' ' + computed.marginRight + ' ' + computed.marginBottom + ' ' + computed.marginLeft,
          borderRadius: computed.borderRadius,
          zIndex: computed.zIndex
        },
        hierarchy: hierarchy,
        devicePixelRatio: window.devicePixelRatio || 1
      };
    }

    function renderFloatingCard(el, meta) {
      const rect = el.getBoundingClientRect();
      const cardWidth = Math.min(520, window.innerWidth - 32);
      
      let left = Math.max(16, Math.min(window.innerWidth - cardWidth - 16, rect.left));
      let top;
      if (rect.bottom + 230 < window.innerHeight) {
        top = rect.bottom + 12;
      } else if (rect.top - 240 > 0) {
        top = rect.top - 240;
      } else {
        top = Math.max(16, window.innerHeight - 260);
      }

      card.style.left = left + 'px';
      card.style.top = top + 'px';
      card.style.display = 'block';

      const tag = meta.tagName;
      const selectorStr = meta.selector || tag;
      const placeholder = isLocal 
        ? "Describe changes to this element (e.g. 'Make it full-width with a smooth hover gradient')..." 
        : "Ask OMP about this element, request debugging analysis, or extract its design...";
      const submitLabel = isLocal ? "Apply Edit" : "Ask OMP";
      const modeBadge = isLocal ? "Local · Edit" : "External · Debug";
      const modeClass = isLocal ? "local" : "external";

      const chips = isLocal 
        ? [
            { label: '🎨 Restyle', prompt: 'Restyle this element with modern colors, subtle borders, and clean typography.' },
            { label: '📝 Edit Copy', prompt: 'Update the text and messaging of this element to be clear and concise.' },
            { label: '📐 Spacing & Layout', prompt: 'Fix the alignment, padding, and layout of this element.' },
            { label: '✨ Add Hover', prompt: 'Add a smooth hover and focus transition effect to this element.' }
          ]
        : [
            { label: '🔍 Explain', prompt: 'Explain how this element is structured, its CSS styling, and layout behavior.' },
            { label: '🐛 Debug Layout', prompt: "Analyze this element's DOM and styles for layout bugs, overflows, or a11y issues." },
            { label: '📐 Extract Specs', prompt: 'Extract the exact CSS rules, colors, typography, and spacing for this component.' }
          ];

      const recreateHtml = !isLocal ? [
        '<div class="recreate-dropdown-wrap">',
        '  <button type="button" class="recreate-trigger-btn">📋 Recreate in… <span class="arrow">▾</span></button>',
        '  <div class="recreate-menu" style="display: none;">',
        '    <button type="button" class="recreate-item" data-prompt="Recreate this element as an accessible, modern Svelte 5 component with scoped styles and TypeScript.">✦ Svelte 5</button>',
        '    <button type="button" class="recreate-item" data-prompt="Recreate this element as an accessible, modern React component with TypeScript and Tailwind CSS.">✦ React</button>',
        '    <button type="button" class="recreate-item" data-prompt="Recreate this element as an accessible, modern Vue 3 component with <script setup> and scoped styles.">✦ Vue 3</button>',
        '  </div>',
        '</div>'
      ].join('\\n') : '';

      card.innerHTML = [
        '<div class="card-header">',
        '  <div class="target-info">',
        '    <span class="target-icon">⌖</span>',
        '    <strong class="target-name">&lt;' + tag + '&gt;</strong>',
        '    <code class="target-selector" title="' + selectorStr + '">' + selectorStr + '</code>',
        '    <span class="mode-badge ' + modeClass + '">' + modeBadge + '</span>',
        '  </div>',
        '  <button type="button" class="card-close-btn" aria-label="Cancel selection">×</button>',
        '</div>',
        '<textarea class="card-textarea" placeholder="' + placeholder + '" rows="3"></textarea>',
        '<div class="card-chips">',
        chips.map(c => '<button type="button" class="chip" data-prompt="' + c.prompt + '">' + c.label + '</button>').join(''),
        recreateHtml,
        '</div>',
        '<div class="card-footer">',
        '  <div class="mode-toggles">',
        '    <button type="button" class="mode-toggle active" data-mode="dom">DOM</button>',
        '    <button type="button" class="mode-toggle" data-mode="screenshot">Screenshot</button>',
        '  </div>',
        '  <div class="card-actions">',
        '    <button type="button" class="btn-cancel">Cancel</button>',
        '    <button type="button" class="btn-submit" disabled>' + submitLabel + ' <span>↗</span></button>',
        '  </div>',
        '</div>'
      ].join('\\n');

      const textarea = card.querySelector('.card-textarea');
      const submitBtn = card.querySelector('.btn-submit');
      const cancelBtn = card.querySelector('.btn-cancel');
      const closeBtn = card.querySelector('.card-close-btn');
      const chipBtns = card.querySelectorAll('.chip');
      const modeBtns = card.querySelectorAll('.mode-toggle');
      const recreateWrap = card.querySelector('.recreate-dropdown-wrap');

      if (recreateWrap) {
        const trigger = recreateWrap.querySelector('.recreate-trigger-btn');
        const menu = recreateWrap.querySelector('.recreate-menu');
        const items = recreateWrap.querySelectorAll('.recreate-item');

        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
        });

        items.forEach(item => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            const p = item.getAttribute('data-prompt');
            if (textarea.value.trim()) {
              textarea.value = textarea.value.trim() + '\\n' + p;
            } else {
              textarea.value = p;
            }
            submitBtn.disabled = false;
            textarea.focus();
            menu.style.display = 'none';
          });
        });

        card.addEventListener('click', () => {
          menu.style.display = 'none';
        });
      }

      textarea.focus();

      textarea.addEventListener('input', () => {
        submitBtn.disabled = !textarea.value.trim();
      });

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
          resolve({ canceled: true });
        } else if (e.key === 'Enter' && !e.shiftKey && textarea.value.trim()) {
          e.preventDefault();
          doSubmit();
        }
      });

      chipBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const p = btn.getAttribute('data-prompt');
          if (textarea.value.trim()) {
            textarea.value = textarea.value.trim() + '\\n' + p;
          } else {
            textarea.value = p;
          }
          submitBtn.disabled = false;
          textarea.focus();
        });
      });

      modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          modeBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          currentCaptureMode = btn.getAttribute('data-mode') || 'dom';
        });
      });

      function doSubmit() {
        const instruction = textarea.value.trim();
        if (!instruction) return;
        submitBtn.disabled = true;
        submitBtn.textContent = isLocal ? 'Applying…' : 'Sending…';
        cleanup();
        resolve({
          ...meta,
          instruction: instruction,
          captureMode: currentCaptureMode
        });
      }

      submitBtn.addEventListener('click', doSubmit);
      cancelBtn.addEventListener('click', () => { cleanup(); resolve({ canceled: true }); });
      closeBtn.addEventListener('click', () => { cleanup(); resolve({ canceled: true }); });
    }

    function onPointerMove(e) {
      if (selectedElement) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && el !== currentTarget && el !== container && !container.contains(el)) {
          currentTarget = el;
          updateOverlay(el);
        }
      });
    }

    function interceptEvent(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    function onElementClick(e) {
      if (selectedElement) return;
      interceptEvent(e);
      const target = currentTarget || document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === container || container.contains(target)) return;
      
      selectedElement = target;
      selectedMetadata = extractMetadata(target);

      cursorStyle.remove();
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerdown', interceptEvent, true);
      window.removeEventListener('mousedown', interceptEvent, true);
      window.removeEventListener('mouseup', interceptEvent, true);
      window.removeEventListener('click', onElementClick, true);

      box.classList.add('selected');
      const rect = target.getBoundingClientRect();
      box.style.display = 'block';
      box.style.top = rect.top + 'px';
      box.style.left = rect.left + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';

      pill.innerHTML = '<span class="pill-tag">&lt;' + selectedMetadata.tagName + '&gt;</span><span class="pill-id">Selected</span>';

      renderFloatingCard(target, selectedMetadata);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        interceptEvent(e);
        cleanup();
        resolve({ canceled: true });
      }
    }

    function onScrollOrResize() {
      if (selectedElement) {
        const rect = selectedElement.getBoundingClientRect();
        box.style.top = rect.top + 'px';
        box.style.left = rect.left + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
      } else if (currentTarget) {
        updateOverlay(currentTarget);
      }
    }

    function cleanup(res) {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerdown', interceptEvent, true);
      window.removeEventListener('mousedown', interceptEvent, true);
      window.removeEventListener('mouseup', interceptEvent, true);
      window.removeEventListener('click', onElementClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize, true);
      if (rafId) cancelAnimationFrame(rafId);
      container.remove();
      cursorStyle.remove();
      window.__branchlight_inspector_cleanup__ = undefined;
      if (res) resolve(res);
    }

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', interceptEvent, true);
    window.addEventListener('mousedown', interceptEvent, true);
    window.addEventListener('mouseup', interceptEvent, true);
    window.addEventListener('click', onElementClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize, { capture: true, passive: true });

    window.__branchlight_inspector_cleanup__ = cleanup;
  });
})();
`;
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

export class WorkspaceHost {
	#window: Electron.BaseWindow & { webContents?: Electron.WebContents };
	#visibleBrowsers = new Set<string>();
	#browsers = new Map<string, BrowserEntry>();
	#terminalSubscriptions = new Map<string, () => void>();
	#terminalIds = new Map<string, string>();
	#terminalStates = new Map<string, string>();
	#terminalOffsets = new Map<string, number>();
	#selectionCoordinator: ElementSelectionCoordinator;
	#activeSelectionPaneId?: string;
	#boundScopes = new Map<string, SelectionAuthScope>();
	#client?: WorkspaceClient;
	#settingsStore?: AppSettingsStore;
	constructor(
		window: Electron.BaseWindow & { webContents?: Electron.WebContents },
		settingsStoreOrCdpUrl?: AppSettingsStore | string,
		cdpUrl = "http://127.0.0.1:9222",
	) {
		this.#window = window;
		if (typeof settingsStoreOrCdpUrl !== "string") {
			this.#settingsStore = settingsStoreOrCdpUrl;
		}
		// Retained for constructor compatibility with older callers.
		void cdpUrl;
		this.#selectionCoordinator = new ElementSelectionCoordinator();
		if ("nativeTheme" in electron && electron.nativeTheme && typeof electron.nativeTheme.on === "function") {
			electron.nativeTheme.on("updated", () => this.updateTheme());
		}
	}

	resolveTheme(): "dark" | "light" {
		const setting = this.#settingsStore?.settings.theme;
		if (setting === "light") return "light";
		if (setting === "dark") return "dark";
		if (
			"nativeTheme" in electron &&
			electron.nativeTheme &&
			typeof electron.nativeTheme.shouldUseDarkColors === "boolean"
		) {
			return electron.nativeTheme.shouldUseDarkColors ? "dark" : "light";
		}
		return "dark";
	}

	getBrowserBackgroundColor(): string {
		return this.resolveTheme() === "dark" ? BROWSER_BG_DARK : BROWSER_BG_LIGHT;
	}

	updateTheme(): void {
		const bg = this.getBrowserBackgroundColor();
		for (const entry of this.#browsers.values()) {
			entry.view.setBackgroundColor(bg);
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

		if (newClient.document) {
			this.syncWithDocument(newClient.document);
		}

		const doc = newClient.document;
		if (doc) {
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

	async #subscribeTerminal(paneId: string, terminalId: string): Promise<void> {
		const client = this.#client;
		if (!client) throw new Error("WorkspaceClient is not configured");
		if (!this.#terminalSubscriptions.has(paneId)) {
			const removeOutputListener = client.onTerminalOutput(terminalId, (frame: TerminalOutputFrame) => {
				const nextOffset = frame.offset + Buffer.byteLength(frame.data, "utf8");
				const currentOffset = this.#terminalOffsets.get(paneId) ?? 0;
				if (frame.offset < currentOffset) return;
				this.#terminalOffsets.set(paneId, Math.max(currentOffset, nextOffset));
				this.#send({ type: "terminal-data", paneId, data: frame.data });
			});
			this.#terminalSubscriptions.set(paneId, removeOutputListener);
		}
		try {
			const snapshot = await client.subscribeTerminal(terminalId, this.#terminalOffsets.get(paneId) ?? 0);
			if (snapshot.status === "failed") {
				this.#send({ type: "terminal-error", paneId, message: "Terminal failed" });
			}
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
			if (existing.state.title !== title) {
				existing.state = { ...existing.state, title };
				this.#emitBrowserState(id);
			}
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

	controlBrowser(rawId: unknown, rawAction: unknown): void {
		const id = paneId(rawId);
		const entry = this.#browsers.get(id);
		if (!entry) return;
		if (rawAction !== "back" && rawAction !== "forward" && rawAction !== "reload" && rawAction !== "stop")
			throw new TypeError("Invalid browser action");
		const action: BrowserNavigationAction = rawAction;
		const history = entry.view.webContents.navigationHistory;
		if (action === "back" && history.canGoBack()) history.goBack();
		else if (action === "forward" && history.canGoForward()) history.goForward();
		else if (action === "reload") entry.view.webContents.reload();
		else if (action === "stop") entry.view.webContents.stop();
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

	setVisibleBrowsers(value: unknown): void {
		if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid visible browser list");
		const ids = value.map(paneId);
		this.#visibleBrowsers = new Set(ids);
		for (const [id, entry] of this.#browsers) {
			if (this.#visibleBrowsers.has(id)) this.#attach(entry);
			else this.#detach(entry);
		}
	}

	async closeBrowser(rawId: unknown): Promise<void> {
		const id = paneId(rawId);
		if (this.#activeSelectionPaneId === id) {
			await this.#endSelection(id, "Browser closed");
		}

		if (!this.#client?.isConnected || !this.#client.document) {
			this.destroyBrowserView(id);
			return;
		}

		const doc = this.#client.document;
		const browser = doc.browsers.find(b => b.paneId === id || b.id === id);
		if (!browser || browser.status === "closed") {
			this.destroyBrowserView(id);
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
	}

	destroyBrowserView(id: string): void {
		const entry = this.#browsers.get(id);
		if (!entry) return;

		void this.#endSelection(id, "Browser view destroyed");

		this.#browsers.delete(id);
		this.#visibleBrowsers.delete(id);
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
		if (typeof options !== "object" || options === null) {
			throw new TypeError("CreateTerminalInput must be an object");
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
		const columns = dimension(options.cols, "Terminal columns");
		const rows = dimension(options.rows, "Terminal rows");
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const document = client.document;
		const workspace =
			document.workspaces.find(item => item.id === options.workspaceId) ??
			document.workspaces.find(item => item.id === document.activeWorkspaceId) ??
			document.workspaces[0];
		if (!workspace) throw new Error("No active workspace found in authority document");
		const location = document.locations.find(item => item.id === workspace.locationId);
		if (!location) throw new Error(`Location '${workspace.locationId}' does not exist`);
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
					locationId: location.id,
					label: "Terminal",
					columns,
					rows,
					cwd: this.#settingsStore?.settings.workspace.defaultPath ?? defaultWorkspacePath(),
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
		return { id, cwd: terminal.cwd ?? defaultWorkspacePath() };
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

	async #endSelection(paneId: string, reason?: string): Promise<void> {
		const entry = this.#browsers.get(paneId);
		if (entry && !entry.view.webContents.isDestroyed()) {
			try {
				await entry.view.webContents
					.executeJavaScript("window.__branchlight_inspector_cleanup__?.({ canceled: true })")
					.catch(() => {});
			} catch {}
		}

		const scope = this.#boundScopes.get(paneId);
		if (scope) {
			this.#selectionCoordinator.cancelSelection(scope, undefined, reason);
			this.#boundScopes.delete(paneId);
			const activeId = this.#selectionCoordinator.activeSelectionId;
			if (activeId) this.#boundScopes.delete(activeId);
		}
		if (this.#activeSelectionPaneId === paneId) {
			this.#activeSelectionPaneId = undefined;
		}
		this.#emitSelectionState({ phase: "idle", paneId, updatedAt: Date.now() });
	}

	async startSelection(scope: SelectionAuthScope, options: StartSelectionOptions = {}): Promise<ElementEditState> {
		const id = paneId(scope.paneId);
		if (this.#activeSelectionPaneId && this.#activeSelectionPaneId !== id) {
			await this.#endSelection(this.#activeSelectionPaneId, "Switching selection to another pane");
		}
		const entry = this.#requireBrowser(id);
		this.#activeSelectionPaneId = id;
		this.#boundScopes.set(id, scope);

		const state = this.#selectionCoordinator.startSelection(scope, {
			...options,
			url: entry.state.url,
		});
		if (state.selectionId) {
			this.#boundScopes.set(state.selectionId, scope);
		}

		const { webContents } = entry.view;
		if (!webContents.isDestroyed()) {
			if (typeof webContents.focus === "function") {
				webContents.focus();
			}

			const activeId = state.selectionId ?? "";
			void (async () => {
				try {
					const payload = (await webContents.executeJavaScript(INSPECTOR_SCRIPT)) as {
						canceled?: boolean;
						tagName?: string;
						selector?: string;
						id?: string;
						classes?: string[];
						attributes?: Record<string, string>;
						role?: string;
						name?: string;
						text?: string;
						outerHTML?: string;
						bounds?: {
							x: number;
							y: number;
							width: number;
							height: number;
							top: number;
							left: number;
							bottom: number;
							right: number;
						};
						computedStyles?: Record<string, string>;
						hierarchy?: string[];
						devicePixelRatio?: number;
					} | null;

					if (!payload || payload.canceled) {
						if (this.#activeSelectionPaneId === id) {
							await this.#endSelection(id, "Canceled by user");
						}
						return;
					}

					if (this.#activeSelectionPaneId !== id) return;
					const boundScope = this.#boundScopes.get(id);
					if (!boundScope) return;

					let screenshot: ElementScreenshot | undefined;
					if (typeof webContents.capturePage === "function" && payload.bounds) {
						try {
							const padding = 12;
							const clipRect = {
								x: Math.max(0, Math.floor(payload.bounds.x - padding)),
								y: Math.max(0, Math.floor(payload.bounds.y - padding)),
								width: Math.min(entry.bounds.width || 1200, Math.ceil(payload.bounds.width + padding * 2)),
								height: Math.min(entry.bounds.height || 800, Math.ceil(payload.bounds.height + padding * 2)),
							};
							if (clipRect.width > 0 && clipRect.height > 0) {
								const nativeImage = await webContents.capturePage(clipRect);
								const size =
									typeof nativeImage.getSize === "function"
										? nativeImage.getSize()
										: { width: clipRect.width, height: clipRect.height };
								let buffer = nativeImage.toJPEG(80);
								if (buffer.byteLength > SELECTION_LIMITS.maxImageBytes) {
									buffer = nativeImage.toJPEG(60);
								}
								const base64 = buffer.toString("base64");
								screenshot = {
									dataUrl: `data:image/jpeg;base64,${base64}`,
									base64,
									mimeType: "image/jpeg",
									width: size.width,
									height: size.height,
									byteLength: buffer.byteLength,
								};
							}
						} catch {}
					}

					const selector = payload.selector || payload.tagName || "element";
					const updated = this.#selectionCoordinator.updateSelection(boundScope, activeId, {
						selector,
						domSnapshot: {
							selector,
							tagName: payload.tagName || "div",
							role: payload.role,
							name: payload.name,
							html: payload.outerHTML?.slice(0, SELECTION_LIMITS.maxDomBytes),
							text: payload.text,
							attributes: payload.attributes || {},
							bounds: payload.bounds || {
								x: 0,
								y: 0,
								width: 0,
								height: 0,
								top: 0,
								left: 0,
								bottom: 0,
								right: 0,
							},
							hierarchy: payload.hierarchy || ["body", "html"],
						},
						screenshot,
						url: entry.state.url,
					});
					this.#emitSelectionState(updated);

					if (typeof payload.instruction === "string" && payload.instruction.trim().length > 0) {
						await this.commitSelection(id, payload.instruction.trim());
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const errState = this.#selectionCoordinator.reportError(scope, activeId, "inspect_failed", message);
					this.#emitSelectionState(errState);
				}
			})();
		}

		this.#emitSelectionState(state);
		return state;
	}
	async cancelSelection(rawPaneId: unknown, rawReason?: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		const reason = typeof rawReason === "string" ? rawReason : undefined;
		await this.#endSelection(id, reason);
		return { phase: "idle", paneId: id, updatedAt: Date.now() };
	}

	async #deliverSelection(
		scope: SelectionAuthScope,
		selectionState: ElementEditState,
		instruction?: string,
	): Promise<void> {
		const client = this.#client;
		if (!client?.isConnected || !client.document) {
			throw new Error("WorkspaceClient is not connected to authoritative runtime");
		}
		const doc = client.document;
		const agent = doc.agents.find(a => a.id === scope.agentId);
		if (!agent) {
			return;
		}
		if (agent.sessionId !== scope.sessionId) {
			throw new Error(`Target agent '${scope.agentId}' session mismatch`);
		}

		const promptData = {
			url: selectionState.url,
			selector: selectionState.selector,
			tagName: selectionState.selectedElement?.tagName || selectionState.domSnapshot?.tagName,
			captureMode: selectionState.captureMode,
			summary: selectionState.selectedElement?.summary || selectionState.domSnapshot?.summary,
			text: selectionState.selectedElement?.text || selectionState.domSnapshot?.text,
			screenshotAttached: Boolean(selectionState.screenshot),
			screenshotWidth: selectionState.screenshot?.width,
			screenshotHeight: selectionState.screenshot?.height,
			domHtml: selectionState.selectedElement?.html || selectionState.domSnapshot?.html,
			instruction: instruction?.trim() || undefined,
		};

		const promptText = prompt.render(elementSelectionPromptTemplate, promptData);

		const result = await client.executeCommandWithRetry(currentDocument => ({
			version: 1 as const,
			commandId: uniqueCommandId("cmd-selection-deliver"),
			workspaceId: scope.workspaceId,
			expectedRevision: currentDocument.revision,
			issuedAt: Date.now(),
			type: "agent.message" as const,
			payload: {
				id: agent.id,
				message: promptText,
				selector: selectionState.selector,
				url: selectionState.url,
				...(selectionState.selectedElement || selectionState.domSnapshot
					? { domSnapshot: selectionState.selectedElement || selectionState.domSnapshot }
					: {}),
				...(selectionState.screenshot ? { screenshot: selectionState.screenshot } : {}),
			},
		}));

		if (result.status === "rejected") {
			throw new Error(result.error?.message ?? "Delivery rejected by workspace runtime");
		}
	}

	async commitSelection(rawPaneId: unknown, rawInstruction?: unknown): Promise<ElementEditState> {
		const id = paneId(rawPaneId);
		const entry = this.#requireBrowser(id);
		const scope = this.#boundScopes.get(id);
		if (!scope) {
			throw new Error("No active selection scope for pane");
		}
		const activeId = this.#selectionCoordinator.activeSelectionId;
		if (!activeId) return this.#selectionCoordinator.getState(scope);

		const currentState = this.#selectionCoordinator.getState(scope);
		const { webContents } = entry.view;
		if (!webContents.isDestroyed()) {
			try {
				if (
					webContents.debugger &&
					typeof webContents.debugger.isAttached === "function" &&
					webContents.debugger.isAttached()
				) {
					await webContents.debugger.sendCommand("Overlay.hideHighlight").catch(() => {});
					await webContents.debugger
						.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} })
						.catch(() => {});
				}

				if (currentState.captureMode === "screenshot" && typeof webContents.capturePage === "function") {
					const nativeImage = await webContents.capturePage();
					const size =
						typeof nativeImage.getSize === "function"
							? nativeImage.getSize()
							: { width: entry.bounds.width, height: entry.bounds.height };
					let buffer = nativeImage.toJPEG(80);
					if (buffer.byteLength > SELECTION_LIMITS.maxImageBytes) {
						buffer = nativeImage.toJPEG(60);
					}
					const base64 = buffer.toString("base64");
					const screenshot: ElementScreenshot = {
						dataUrl: `data:image/jpeg;base64,${base64}`,
						base64,
						mimeType: "image/jpeg",
						width: size.width,
						height: size.height,
						byteLength: buffer.byteLength,
					};

					this.#selectionCoordinator.updateSelection(scope, activeId, {
						screenshot,
						url: entry.state.url,
					});
				}
			} catch {}
		}

		const committedState = this.#selectionCoordinator.commitSelection(scope, activeId);

		const instruction = typeof rawInstruction === "string" ? rawInstruction.trim() : undefined;

		try {
			await this.#deliverSelection(scope, committedState, instruction);
			await this.#endSelection(id, "Delivered");
			return { phase: "idle", paneId: id, updatedAt: Date.now() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const errState = this.#selectionCoordinator.reportError(scope, activeId, "delivery_failed", message);
			this.#emitSelectionState(errState);
			return errState;
		}
	}

	getSelectionState(rawPaneId: unknown): ElementEditState {
		const id = paneId(rawPaneId);
		const scope = this.#boundScopes.get(id);
		if (scope) {
			return this.#selectionCoordinator.getState(scope);
		}
		return { phase: "idle", updatedAt: Date.now() };
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
		if (!this.#window.isDestroyed() && this.#window.webContents && !this.#window.webContents.isDestroyed()) {
			try {
				this.#window.webContents.send("branchlight:selection-state", state);
				if (state.paneId) {
					this.#send({ type: "selection-state", paneId: state.paneId, state });
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
	#bindBrowser(id: string, entry: BrowserEntry): void {
		const { webContents } = entry.view;
		webContents.on("did-start-loading", () => {
			entry.state = { ...entry.state, loading: true, error: undefined };
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
		webContents.on("did-navigate", (_event: unknown, url: string) => {
			entry.documentEpoch++;
			void this.#endSelection(id, "Page navigated");
			entry.state = { ...entry.state, url };
			this.#refreshBrowserState(id);
			void this.#persistBrowserNavigation(id, url).catch(() => {});
		});
		webContents.on("did-navigate-in-page", (_event: unknown, url: string, isMainFrame: boolean) => {
			if (isMainFrame !== false) {
				entry.documentEpoch++;
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
		webContents.on(
			"did-fail-load",
			(_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
				if (!isMainFrame || errorCode === -3) return;
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
				this.#window.webContents.send("branchlight:workspace", event);
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

# Verify the workspace shell and tab navigation

**Documentation status:** drafted. Passing items come from fixture-backed Playwright journeys in the actual Electron application executed on Windows x64 on 2026-08-28 (36/36 journeys passing; the composer geometry journey that failed in the pass's first run was fixed within it, [`CHAT-012`](../bug-triage.md#chat-012--the-composer-footer-loses-its-attachment-bar-at-narrow-widths) resolved). Working tree anchored at `ac5f533bb245ef7f911dfc165c7c39356a2ac639` with the cross-platform terminal-renderer cutover applied.

## WS-01 — Launch shows the shell chrome and ends the loading overlay

- **Setup:** Launch the packaged Electron application with isolated user data and a seeded workspace.
- **Steps:** Observe the title bar and stage before hydration, then wait for the chat composer.
- **Expected result:** The Gradivus mark and window controls are visible, the fixed chat tab is selected, the **Connecting to the workspace runtime…** overlay covers the stage until the workspace document arrives, and the composer becomes usable afterward.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application with deterministic workspace fixture.
- **Evidence:** **Observed and Tested.** Every journey waits on the composer (for example `packages/desktop/e2e/desktop.spec.ts:184`); the title-bar mark is asserted at `desktop.spec.ts:207-208` and the selected chat tab at `:221`. Passed in the 36/36 run.
- **Result:** pass

## WS-02 — The fixed chat tab cannot be closed

- **Setup:** Launch the app with at least one browser tab open.
- **Steps:** Inspect the chat tab for a close affordance; attempt Ctrl+W while the chat tab is active.
- **Expected result:** The chat tab renders no close control, and Ctrl+W is a no-op on it; only browser tabs can be closed.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/molecules/WorkspaceTab.svelte` renders no close control on the chat variant, and `packages/desktop/src/renderer/ui/pages/App.svelte` guards Ctrl+W to browser tabs. No e2e journey asserts the chat-tab close absence.
- **Result:** blocked

## WS-03 — A new browser tab opens with a durable name

- **Setup:** Launch the app and wait for hydration.
- **Steps:** Activate **Open browser tab**, then inspect the tab strip.
- **Expected result:** A new tab appears, is activated, and is named **Browser** (subsequent tabs **Browser 2**, **Browser 3**, …); the new-tab button is disabled before hydration.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1628-1631` opens a browser tab and `:1748-1751` asserts the exact **Browser** name. Passed in the 36/36 run.
- **Result:** pass

## WS-04 — Global shortcuts are inert while a modal dialog is open

- **Setup:** Open a chat with an Agent Hub transcript modal open.
- **Steps:** Press Ctrl+T while the modal is open, then close the modal and press Ctrl+T again.
- **Expected result:** Ctrl+T does nothing while the modal is open; after closing it, Ctrl+T opens a browser tab.
- **Priority:** P2
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1836-1839` asserts Ctrl+T is suppressed with the Agent Hub modal open. Passed in the 36/36 run.
- **Result:** pass

## WS-05 — Settings opens, searches, closes, and restores focus

- **Setup:** Open a ready chat from the rail.
- **Steps:** Activate **Open settings**, type in **Search settings**, select a category, then activate **Back to workspace**.
- **Expected result:** Settings replaces the workspace, the search field is auto-focused, category match counts update, closing returns to the workspace and focuses the invoking control.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:239-256` runs the settings journey including focus restore. Passed in the 36/36 run.
- **Result:** pass

## WS-06 — Browser views detach while settings are open

- **Setup:** Open a browser tab with a loaded page.
- **Steps:** Open settings, observe the browser pane, close settings, and reactivate the browser tab.
- **Expected result:** Browser views are detached and inert while settings are open; they reattach and remain interactive after **Back to workspace**.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1618-1672` covers detachment and tab reactivation. Passed in the 36/36 run.
- **Result:** pass

## WS-07 — Window controls minimize, maximize/restore, and close

- **Setup:** Launch the app.
- **Steps:** Activate **Minimize**, restore, activate **Maximize**/**Restore**, then verify the window state; activate **Close** last.
- **Expected result:** Each control performs its OS action; the maximize label toggles to **Restore**.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/molecules/WindowControls.svelte` and the window-control IPC in `packages/desktop/src/main/main.ts` establish the actions. No e2e journey drives the window controls, and the maximize label's desync after OS-level maximize is unverified.
- **Result:** blocked

## WS-08 — Window geometry does not persist across relaunch

- **Setup:** Resize and maximize the window.
- **Steps:** Quit and relaunch the app.
- **Expected result:** The window reopens at the default size, unmaximized.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/main.ts` creates the window with fixed defaults and persists no bounds. No journey relaunches with a resized window.
- **Result:** blocked

## WS-09 — Runtime reconnect and retry-exhaustion feedback is visible

- **Setup:** Launch the app connected to the workspace runtime.
- **Steps:** Sever the runtime connection, wait through reconnect attempts, then exhaust retries.
- **Expected result:** **Reconnecting to the workspace runtime…** appears, then **Workspace runtime disconnected**, and finally the persistent **Workspace runtime unreachable** error with **Retry**, which reconnects when the runtime returns.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with a controllable runtime.
- **Evidence:** **Test-specified, not passing Electron evidence.** `packages/desktop/test/runtime-reconnect.test.ts` proves the emission sequence including exhaustion; no mounted journey severs the runtime.
- **Result:** blocked

## WS-10 — Theme and density apply shell-wide from settings and the rail

- **Setup:** Launch the app in dark theme.
- **Steps:** Toggle the rail theme control, then change theme and density in Settings.
- **Expected result:** `data-theme` and `data-density` change on the document, the rail toggle label flips, and native surfaces follow.
- **Priority:** P2
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:196-218,498-524,2569-2598` cover the rail toggle, theme updates with **Theme updated.** feedback, and density changes. Passed in the 36/36 run.
- **Result:** pass

## WS-11 — A second launch focuses the existing window

- **Setup:** Launch the packaged app once.
- **Steps:** Launch the same packaged binary again.
- **Expected result:** No second window; the existing window is restored and focused.
- **Priority:** P2
- **Device or environment:** Packaged install on any supported host.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/main.ts` acquires the single-instance lock and focuses the existing window. Not exercised by the fixture journeys, which run isolated instances.
- **Result:** blocked

## WS-12 — Tab titles stay durable names and the chat-tab window title is doubled

- **Setup:** Open a browser tab and navigate to a page with a distinct title.
- **Steps:** Inspect the tab strip and the window title while the browser tab is active, then switch to the chat tab.
- **Expected result:** The tab strip keeps the durable **Browser** name (the page title never reaches the strip), and the window title reads **Gradivus · Gradivus** while the chat tab is active.
- **Priority:** P3
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Partially observed and tested.** The durable **Browser** tab name is asserted at `packages/desktop/e2e/desktop.spec.ts:1748-1751`; the window-title suffix is asserted at `:460`. The page-title exclusion from the strip is code-established from `packages/workspace-runtime/src/reducer.ts` and `WorkspaceShell.svelte`.
- **Result:** pass

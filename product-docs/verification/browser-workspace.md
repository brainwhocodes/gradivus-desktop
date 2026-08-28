# Verify the browser workspace

**Documentation status:** drafted. Passing items come from fixture-backed Playwright journeys in the actual Electron application executed on Windows x64 on 2026-08-28 (36/36 journeys passing; the composer geometry journey that failed in the pass's first run was fixed within it, [`CHAT-012`](../bug-triage.md#chat-012--the-composer-footer-loses-its-attachment-bar-at-narrow-widths) resolved). Working tree anchored at `ac5f533bb245ef7f911dfc165c7c39356a2ac639` with the cross-platform terminal-renderer cutover applied.

## BW-01 — A new browser tab activates and is durably named

- **Setup:** Launch the app with a seeded workspace and wait for hydration.
- **Steps:** Activate **Open browser tab** and inspect the tab strip.
- **Expected result:** The new tab activates and its strip label is exactly **Browser**; later tabs number as **Browser 2**, **Browser 3**, …; the strip never shows the loaded page's title.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1628-1631,1748-1751` asserts the exact **Browser** tab name. Passed in the 36/36 run.
- **Result:** pass

## BW-02 — The address bar navigates by rule

- **Setup:** Open a browser tab on any page.
- **Steps:** Type a loopback fixture URL into **Address** and press Enter; then try a multi-word query and a non-HTTP value such as `file:///`.
- **Expected result:** The URL loads; the multi-word entry becomes a search; the non-HTTP value is refused with **Only HTTP and HTTPS addresses can open here** and an action-failed toast.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application with the e2e fixture server.
- **Evidence:** **Partially observed and tested.** Address-entry navigation to the fixture URL is exercised in `packages/desktop/e2e/desktop.spec.ts:1633-1636` and `packages/desktop/e2e/omp-selection.spec.ts` navigation steps. The search-template and non-HTTP rejection branches are code-established from `packages/desktop/src/main/workspace-host.ts:722-741` and not separately executed.
- **Result:** pass

## BW-03 — Back, Forward, and Reload/Stop follow the pane history

- **Setup:** Open a browser tab and navigate to at least two pages.
- **Steps:** Use **Back**, **Forward**, and **Reload**; reload during a slow load and observe the toolbar.
- **Expected result:** **Back** is disabled on the first page, **Forward** on the last; while a page loads the toolbar shows **Stop loading**, which cancels the load.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/molecules/BrowserToolbar.svelte:60-63` and `packages/desktop/src/main/workspace-host.ts:1184-1196` establish the controls; no journey asserts their enabled/disabled transitions.
- **Result:** blocked

## BW-04 — Splitting panes builds columns, rows, then a grid

- **Setup:** Open a browser tab with one pane.
- **Steps:** Activate **Split browser right**, then **Split browser below**, then split again to four panes; attempt a fifth split.
- **Expected result:** Two panes divide as columns; a second split still offers right/below; three and four panes arrange as a 2×2 grid; the split buttons disable at four panes. Panes divide evenly with no drag-resize.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Partially observed and tested.** `packages/desktop/e2e/omp-selection.spec.ts:804-811` exercises **Split browser right** to two panes and **Close browser pane** back to one. The grid upgrade at three and four panes and the four-pane cap are code-established from `packages/desktop/src/renderer/ui/pages/App.svelte:372-390` and `packages/workspace-runtime/src/reducer.ts:539-551`.
- **Result:** pass

## BW-05 — Closing the last pane closes the tab with confirmation

- **Setup:** Open a browser tab with one pane and the default close confirmation on.
- **Steps:** Activate **Close browser pane**.
- **Expected result:** The confirmation **Close tab “Browser”?** appears first; accepting it closes the tab and returns to the chat tab.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/pages/App.svelte:419-445` routes last-pane close through the tab-close confirmation; the journey exercised pane close only with multiple panes.
- **Result:** blocked

## BW-06 — Browser views detach for Settings and reattach with identity

- **Setup:** Open a browser tab and navigate to a page.
- **Steps:** Open Settings, observe the pane, close Settings with **Back to workspace**, and reactivate the browser tab.
- **Expected result:** While Settings is open the native view is detached and inert; after closing, the same view reattaches and remains interactive.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1618-1672` asserts detachment, reattachment, and tab focus. Passed in the 36/36 run.
- **Result:** pass

## BW-07 — The pane context menu labels exist but its items do nothing

- **Setup:** Open a browser tab with one pane.
- **Steps:** Right-click inside the page; choose **Split Right**.
- **Expected result:** The menu shows **Split Right**, **Split Down**, and **Close Pane** (split items disabled at four panes), but choosing any item has no effect — filed as [`CHAT-013`](../bug-triage.md#chat-013--browser-pane-right-click-menu-items-do-nothing).
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established.** The menu emits `pane-context-action` (`packages/desktop/src/main/workspace-host.ts:1690-1699`) with no renderer subscriber; unit coverage is main-side only (`test/workspace-host-pane-menu.test.ts`).
- **Result:** blocked

## BW-08 — Tabs, panes, and URLs persist across relaunch

- **Setup:** Open two browser tabs, split one into two panes, and navigate both to distinct URLs.
- **Steps:** Quit and relaunch the app.
- **Expected result:** The same tabs with the same names and pane layouts reappear and load their last URLs; back/forward history is empty.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with relaunch.
- **Evidence:** **Code-established, not executed.** Durable projection and URL persistence are established by `packages/desktop/src/renderer/workspace-projection.ts`, `packages/desktop/src/main/workspace-host.ts:1019-1062,2636-2707`, and the workspace-runtime store. No journey relaunches with browser tabs open.
- **Result:** blocked

## BW-09 — Popups become Gradivus browser tabs

- **Setup:** Open a browser tab and navigate to a page with a `target="_blank"` link.
- **Steps:** Activate the link.
- **Expected result:** No OS popup window; a new Gradivus browser tab opens with the link target.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/workspace-host.ts:2751-2759` denies the new-window attempt and routes it to a new tab. Not exercised by the fixture journeys.
- **Result:** blocked

## BW-10 — Navigation failures show the engine's error page

- **Setup:** Open a browser tab.
- **Steps:** Navigate to a non-resolvable hostname and to a refused port.
- **Expected result:** The pane shows the browser engine's own error page; the toolbar does not add an error surface; the address bar keeps the attempted URL.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application without network access to the targets.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/workspace-host.ts:2713-2725` records the failure into view state without a toolbar surface.
- **Result:** blocked

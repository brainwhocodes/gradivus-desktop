# Verification: browser selection to chat

This checklist verifies the user-visible browser-selection delivery lifecycle without expanding into generic browser navigation or split-layout behavior. Passing items below are grounded in the executed Electron selection suite: `bunx playwright test e2e/omp-selection.spec.ts`, **8/8 passed** on macOS arm64 on 2026-08-25. Source-only expectations remain blocked rather than being promoted to passing runtime evidence.

## SEL-01 — Fresh card exposes the selected element and defaults

- **Setup:** Launch the fixture-backed Electron app with one Work session, one deliverable **Fixture Agent**, and the browser fixture open.
- **Steps:** Choose **Select page element for agent** and click the fixture action button.
- **Expected result:** One visible dialog identifies `<button>` and `#fixture-action`, starts with an empty instruction, `task`, **DOM**, and **Ask OMP**.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; isolated user data; deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:625-650`, **“opens a fresh BrowserView card with independent defaults and stable native surface.”**
- **Result:** `pass`

## SEL-02 — Starting in another pane enforces one active inspector

- **Setup:** Launch the fixture-backed Electron app, open the browser fixture, and create a second browser pane.
- **Steps:** Start selection and pick `#fixture-action` in pane one, then start selection and pick `#fixture-secondary` in pane two.
- **Expected result:** Exactly one inspector root remains, and its card identifies `#fixture-secondary` in pane two.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell and two native BrowserViews; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:652-670`, **“starting a second pane cancels the first card and leaves one active card.”**
- **Result:** `pass`

## SEL-03 — Add to Queue creates a numbered captured item

- **Setup:** Launch the fixture-backed Electron app with the browser fixture open and select `#fixture-action`.
- **Steps:** Enter an instruction, choose a subagent role, choose **Screenshot**, choose **Add to Queue**, and submit.
- **Expected result:** **Selection queue and output** opens with one `#1` row for `#fixture-action` and a corresponding pinned marker on the page.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:672-704,733-737`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-04 — Repeated picks retain per-item role and capture choices

- **Setup:** Continue with queued item `#1` captured as Screenshot with the `designer` role.
- **Steps:** Pick `#fixture-secondary`, inspect the new card, change the role to `reviewer`, and add the second item.
- **Expected result:** The next card retains Screenshot and the prior role before editing, while the queue records a distinct numbered `#2` item after the role change.
- **Priority:** P2
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:672-721`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-05 — Run All leaves every queue row with a terminal outcome

- **Setup:** Create two pending selection queue rows in one browser pane.
- **Steps:** Choose **Run All** and wait for queue execution to settle.
- **Expected result:** Every row ends as completed or error and retains visible output or failure text in that row.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, native BrowserView, and deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:722-731`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-06 — Clear removes queue rows and pins

- **Setup:** Finish a two-item queue run with the queue dock visible.
- **Steps:** Choose **Clear**.
- **Expected result:** The queue dock disappears, page pins are removed, and the native browser surface returns to its pre-dock bounds.
- **Priority:** P2
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:730-737`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-07 — Send to Chat reports delivery only after acceptance

- **Setup:** Launch the fixture-backed Electron app with the browser fixture, Fixture Agent, and its active Work chat.
- **Steps:** Select an element, enter “Explain this target,” choose **Send to Chat**, and submit.
- **Expected result:** The browser card reaches a delivered/sent/complete state only after the fixture-backed OMP prompt is accepted.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, native BrowserView, and deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:743-763`, **“Send to Chat reports only after fixture acceptance and closes cleanly.”**
- **Result:** `pass`

## SEL-08 — Send to Chat reaches the fixture target chat

- **Setup:** Use the seeded Fixture Agent whose active target session is the seeded Work chat.
- **Steps:** Send the selected element instruction to chat and inspect the target chat's conversation transcript.
- **Expected result:** The target chat shows “Fixture completed the requested work.”
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell and renderer; one explicitly routed fixture agent/chat pair.
- **Evidence:** Observed/Tested — target ownership fixture at `packages/desktop/e2e/omp-selection.spec.ts:33-94`; transcript assertion at `:743-757`, **“Send to Chat reports only after fixture acceptance and closes cleanly.”**
- **Result:** `pass`

## SEL-09 — Close acknowledges a delivered chat card

- **Setup:** Complete one **Send to Chat** submission until the BrowserView card reports delivery.
- **Steps:** Choose **Close** in the result card.
- **Expected result:** The inspector root is removed from the BrowserView.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:756-759`, **“Send to Chat reports only after fixture acceptance and closes cleanly.”**
- **Result:** `pass`

## SEL-10 — Inline success remains until Close

- **Setup:** Launch the fixture-backed Electron app without forced prompt failure and select an element.
- **Steps:** Enter “Describe this target,” leave **Ask OMP** selected, submit, and wait for completion without closing the card.
- **Expected result:** A complete inline response remains visible in the BrowserView card until the user chooses **Close**.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, native BrowserView, and deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:765-789`, **“inline result and delivery error stay in the card until Close.”**
- **Result:** `pass`

## SEL-11 — Delivery failure remains until Close

- **Setup:** Launch the fixture-backed Electron app with prompt failure forced and select an element.
- **Steps:** Enter “fail this prompt,” submit, and wait for the terminal selection state without closing the card.
- **Expected result:** A failed/error/rejected state remains visible in the BrowserView card until the user chooses **Close**.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, native BrowserView, and deterministic forced-failure fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:765-789`, **“inline result and delivery error stay in the card until Close.”**
- **Result:** `pass`

## SEL-12 — Toolbar cancellation removes the active inspector

- **Setup:** Start element selection on the browser fixture before submitting any instruction.
- **Steps:** Choose **Cancel element selection** in the browser toolbar.
- **Expected result:** No inspector root remains in the BrowserView.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:792-803`, **“cancel, restart, navigate and close leave no stale inspector root.”**
- **Result:** `pass`

## SEL-13 — Card cancellation returns the page to normal input

- **Setup:** Restart selection, pick `#fixture-secondary`, and leave its instruction card open.
- **Steps:** Choose **Cancel** in the card, then click `#fixture-secondary` normally.
- **Expected result:** The inspector is gone and the page handles the next click, showing “Secondary connected.”
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:804-810`, **“cancel, restart, navigate and close leave no stale inspector root.”**
- **Result:** `pass`

## SEL-14 — Navigation removes the active inspector

- **Setup:** Start a new selection and open a card for `#fixture-action`.
- **Steps:** Navigate the same browser pane to the fixture URL with a new query string.
- **Expected result:** The previous page's inspector root does not remain after navigation.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; local fixture navigation.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:811-817`, **“cancel, restart, navigate and close leave no stale inspector root.”**
- **Result:** `pass`

## SEL-15 — Active-inspector pane close cleans up selection

- **Setup:** Open two browser panes and start a selection card in the pane that will be closed.
- **Steps:** Close that browser pane while its inspector is active.
- **Expected result:** The closed pane's inspector and pane-owned queue are removed without appearing in the remaining pane.
- **Priority:** P3
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and two native BrowserViews; active-inspector close was not executed.
- **Evidence:** Code-established at `packages/desktop/src/main/workspace-host.ts:1244-1303`. The executed sequence in `packages/desktop/e2e/omp-selection.spec.ts:792-825` navigated away from the active inspector before it performed an ordinary pane close, so it does not prove this claim.
- **Result:** `blocked`

## SEL-16 — Live theme change preserves target and queued pins

- **Setup:** Launch with Dark theme, queue one element, and select a second element so one pin and one active target are visible.
- **Steps:** Change the application theme from Dark to Light while the BrowserView inspector remains active.
- **Expected result:** The inspector adopts the exact Light palette while retaining the same selected target, queued pin count, and native BrowserView bounds.
- **Priority:** P2
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic fixture; dark-to-light setting mutation.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:827-872`, **“theme changes preserve target and queued pins.”**
- **Result:** `pass`

## SEL-17 — Screenshot capture delivers one valid JPEG

- **Setup:** Launch the fixture-backed Electron app with attachment capture enabled, select one element, and set the BrowserView zoom factor to 1.25.
- **Steps:** Enter an instruction, choose **Screenshot**, and submit once.
- **Expected result:** OMP receives exactly one non-empty, base64-valid `image/jpeg` attachment.
- **Priority:** P1
- **Device or environment:** macOS arm64; actual Electron shell, renderer, native BrowserView, and deterministic capture fixture at 1.25× zoom.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:874-904`, **“screenshot mode sends one valid JPEG while BrowserView identity and bounds stay fixed.”**
- **Result:** `pass`

## SEL-18 — Screenshot capture does not replace or resize the BrowserView

- **Setup:** Record the selected browser pane's native BrowserView identity, URL, and bounds before Screenshot submission.
- **Steps:** Submit one Screenshot-mode inline request and wait for its success state.
- **Expected result:** The BrowserView identity, URL, and bounds equal their pre-capture values.
- **Priority:** P2
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; deterministic capture fixture at 1.25× zoom.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:874-904`, **“screenshot mode sends one valid JPEG while BrowserView identity and bounds stay fixed.”**
- **Result:** `pass`

## SEL-19 — Fresh inspector has no serious or critical automated accessibility violations

- **Setup:** Open a fresh browser-selection card on the fixture page.
- **Steps:** Run Axe in the mounted Electron journey and evaluate enhanced contrast for the page surface.
- **Expected result:** Axe reports no serious or critical violations and the enhanced-contrast assertion passes.
- **Priority:** P2
- **Device or environment:** macOS arm64; actual Electron shell, renderer, and native BrowserView; automated Axe and computed-color checks.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:625-650`, **“opens a fresh BrowserView card with independent defaults and stable native surface.”**
- **Result:** `pass`

## SEL-20 — Workspace-runtime failure exposes visible recovery feedback

- **Setup:** Start inline selection work or a queue run, then interrupt the local workspace-runtime connection before the request settles.
- **Steps:** Observe the workspace shell through reconnect attempts and retry exhaustion.
- **Expected result:** A visible reconnecting state progresses to recovery or a persistent error with an actionable recovery control.
- **Priority:** P2
- **Device or environment:** macOS arm64 Electron app with a controllable workspace-runtime connection; not executed in the passing selection suite.
- **Evidence:** Blocked runtime coverage; source predicts missing shell feedback and the gap is filed in [`../bug-triage.md#CHAT-002`](../bug-triage.md#chat-002--workspace-reconnect-and-outer-shell-errors-are-not-rendered). The package-wide unit command did not complete and cannot substitute for this mounted journey.
- **Result:** `blocked`

## SEL-21 — Multiple target chats preserve explicit ownership

- **Setup:** Create two deliverable workspace agents backed by two different active chat sessions and open one browser pane.
- **Steps:** Route one selection to each target, switch the visible chat while both are active, then inspect both transcripts and browser outcomes.
- **Expected result:** Each admitted turn, result, and completion remains with the explicitly selected target chat without crossing into the other chat.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a two-agent/two-chat runtime fixture; no such fixture was executed.
- **Evidence:** Code-established routing at `packages/desktop/src/main/desktop-host.ts:616-750` and `packages/desktop/src/main/workspace-host.ts:2237-2378`; the passing Electron suite used one Fixture Agent/chat pair only.
- **Result:** `blocked`

## SEL-22 — Distinct target agents expose stable distinguishable swatches

- **Setup:** Provide at least three deliverable agents in one workspace and run the app in Dark, Light, System, and enhanced-contrast conditions.
- **Steps:** Choose each target and compare the toolbar swatch, active highlight, queued pin, and queue row before and after theme changes.
- **Expected result:** Each agent keeps one consistent, visibly distinguishable swatch across every ownership surface and theme.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a multi-agent fixture and enhanced-contrast mode; not executed.
- **Evidence:** Code-established deterministic swatch propagation at `packages/desktop/src/main/desktop-host.ts:733-738`, `packages/desktop/src/main/workspace-host.ts:149-218,594-643,2017-2054`, and `packages/desktop/src/renderer/ui/molecules/BrowserToolbar.svelte:97-113`; the passing theme journey used one target.
- **Result:** `blocked`

## SEL-23 — Navigation defines what happens to an existing queue

- **Setup:** Queue at least one captured element, leave it pending, then navigate the same pane to a different document.
- **Steps:** Inspect the queue and attempt **Run All** after navigation.
- **Expected result:** The product visibly applies one defined policy: retain the captured task with its original URL and run it, or mark/clear it as stale without silently retargeting it.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with local pages A and B; not executed with a non-empty queue.
- **Evidence:** Code-established active-inspector cancellation at `packages/desktop/src/main/workspace-host.ts:2663-2695`; queue invalidation occurs on BrowserView destruction at `:1293-1303,1938-1943`, not navigation. Existing E2E navigation used no queued item.
- **Result:** `blocked`

## SEL-24 — Process exit defines pending and retained-state recovery

- **Setup:** Prepare four cases: an awaiting inline request, an awaiting chat acceptance, a pending queue, and a completed outcome card not yet closed.
- **Steps:** Exit and relaunch Electron during each case, then return to the same workspace and chat.
- **Expected result:** Each case has a documented visible recovery outcome with no duplicate delivery and no misleading stale success.
- **Priority:** P3
- **Device or environment:** macOS arm64 packaged or development Electron app with deterministic delayed fixture; not executed.
- **Evidence:** No passing Electron journey exits during selection work; source establishes host-owned in-memory selection and queue state but not a relaunch contract (`packages/desktop/src/main/workspace-host.ts:768-773,1873-1943,2086-2613`).
- **Result:** `blocked`

## SEL-25 — Inline execution has a defined transcript-history consequence

- **Setup:** Start **Ask OMP** in a browser card while the target chat transcript is visible or recordable.
- **Steps:** Let the inline response complete, close the card, switch away, return to the target chat, and page its history.
- **Expected result:** The user can determine whether inline work is intentionally present in the target conversation transcript or intentionally BrowserView-only, consistently before and after history reload.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a resumable deterministic OMP fixture; transcript consequence was not asserted.
- **Evidence:** Code-established inline execution uses the target chat runtime at `packages/desktop/src/main/desktop-host.ts:530-615`, while `packages/desktop/e2e/omp-selection.spec.ts:765-790` asserted only the retained BrowserView card.
- **Result:** `blocked`

## SEL-26 — A mixed DOM/Screenshot queue preserves each capture mode

- **Setup:** Start a selection queue on one page with at least two selectable elements.
- **Steps:** Add one item in **DOM** mode, add a second in **Screenshot** mode, then choose **Run All**.
- **Expected result:** Each completed queue row reports and executes the capture mode selected when that item was added.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with attachment capture enabled; the executed queue journey used Screenshot mode for its repeated picks.
- **Evidence:** Code-established per-task capture retention at `packages/desktop/src/main/workspace-host.ts:1944-2055,2428-2537` and row presentation at `packages/desktop/src/renderer/ui/organisms/SelectionQueuePane.svelte:45-70`; no executed Electron journey mixed both modes in one queue.
- **Result:** `blocked`

## Evidence boundary

- Revision anchor: `c125341133ff90a29fe266e1b166bac0183338c8`
- Evidence date: 2026-08-25
- Working-tree boundary: this checklist describes the working tree anchored at that commit. Relevant desktop source and E2E files may be modified or untracked.
- Runtime evidence: the 8/8 selection suite passed in an actual Electron application on macOS arm64 using isolated user data and deterministic local fixtures.
- Test evidence: only the named executed Electron journeys support `pass`. The failing `bun run test` invocation is not passing evidence; source-only and unit-only claims are not marked pass.

# Verify element targeting and Page Agent delivery

This checklist verifies the user-visible element-targeting delivery lifecycle without expanding into generic browser navigation or split-layout behavior. Passing items are grounded in the executed Electron selection suite `packages/desktop/e2e/omp-selection.spec.ts`, which passed **8/8 on Windows x64 on 2026-08-28** as part of the final 36/36 overall run (the composer geometry journey that failed in the pass's first run was fixed within it, [`CHAT-012`](../bug-triage.md#chat-012--the-composer-footer-loses-its-attachment-bar-at-narrow-widths) resolved). Source-only expectations remain blocked rather than being promoted to passing runtime evidence. The 2026-08-25 macOS arm64 evidence predates the Page Agent cutover and is not counted for the changed behavior.

## SEL-01 — Fresh card exposes the selected element and defaults

- **Setup:** Launch the fixture-backed Electron app with one Work session and the browser fixture open.
- **Steps:** Choose **Select page element with Page Agent** and click the fixture action button.
- **Expected result:** One visible dialog identifies `<button>` and `#fixture-action`, starts with an empty instruction, the `task` role, **DOM**, and **Ask OMP**; the browser Agent Hub count becomes one Page Agent; the crosshair carries the Page Agent name and swatch.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; isolated user data; deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:551-637`, **“opens a fresh BrowserView card with independent defaults and stable native surface.”**
- **Result:** `pass`

## SEL-02 — Starting in another pane enforces one active inspector

- **Setup:** Launch the fixture-backed Electron app, open the browser fixture, and create a second browser pane.
- **Steps:** Start selection and pick `#fixture-action` in pane one, then start selection and pick `#fixture-secondary` in pane two.
- **Expected result:** Exactly one inspector root remains, and its card identifies `#fixture-secondary` in pane two.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell and two native BrowserViews; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:642-660`, **“starting a second pane cancels the first card and leaves one active card.”**
- **Result:** `pass`

## SEL-03 — Add to Queue creates a numbered captured item

- **Setup:** Launch the fixture-backed Electron app with the browser fixture open and select `#fixture-action`.
- **Steps:** Enter an instruction, choose a subagent role, choose **Screenshot**, choose **Add to Queue**, and submit.
- **Expected result:** **Selection queue and output** opens with one `#1` row for `#fixture-action` and a corresponding pinned marker on the page.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:662-731`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-04 — Repeated picks retain per-item role and capture choices

- **Setup:** Continue with queued item `#1` captured as Screenshot with the `designer` role.
- **Steps:** Pick `#fixture-secondary`, inspect the new card, change the role to `reviewer`, and add the second item.
- **Expected result:** The next card retains Screenshot and the prior role before editing, while the queue records a distinct numbered `#2` item after the role change.
- **Priority:** P2
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:662-700`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-05 — Run All leaves every queue row with a terminal outcome

- **Setup:** Create two pending selection queue rows in one browser pane.
- **Steps:** Choose **Run All** and wait for queue execution to settle.
- **Expected result:** Every row ends as completed or error and retains visible output or failure text in that row.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, native BrowserView, and deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:700-718`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-06 — Clear removes queue rows and pins

- **Setup:** Finish a two-item queue run with the queue dock visible.
- **Steps:** Choose **Clear**.
- **Expected result:** The queue dock disappears, page pins are removed, and the native browser surface returns to its pre-dock bounds.
- **Priority:** P2
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:718-731`, **“repeated queued picks retain role, capture, selector, URL and report statuses.”**
- **Result:** `pass`

## SEL-07 — Send to Chat reports delivery only after acceptance

- **Setup:** Launch the fixture-backed Electron app with the browser fixture and its Work chat open.
- **Steps:** Select an element, enter “Explain this target,” choose **Send to Chat**, and submit.
- **Expected result:** The browser card reaches a delivered/sent/complete state only after the fixture-backed OMP prompt is accepted.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, native BrowserView, and deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:733-753`, **“Send to Chat reports only after fixture acceptance and closes cleanly.”**
- **Result:** `pass`

## SEL-08 — Send to Chat reaches the chat resolved for the workspace

- **Setup:** Use the seeded fixture workspace whose active Work chat shares the Page Agent's workspace path.
- **Steps:** Send the selected element instruction to chat and inspect the chat's conversation transcript.
- **Expected result:** The resolved chat shows “Fixture completed the requested work.”; the delivery starts a turn rather than staging content in the composer.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell and renderer; one fixture workspace/chat pair.
- **Evidence:** Observed/Tested — transcript assertion at `packages/desktop/e2e/omp-selection.spec.ts:733-753`, **“Send to Chat reports only after fixture acceptance and closes cleanly.”** Chat resolution by workspace path is code-established at `packages/desktop/src/main/desktop-host.ts:1335-1356`.
- **Result:** `pass`

## SEL-09 — Close acknowledges a delivered chat card

- **Setup:** Complete one **Send to Chat** submission until the browser card reports delivery.
- **Steps:** Choose **Close** in the result card.
- **Expected result:** The inspector root is removed from the BrowserView.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:746-753`, **“Send to Chat reports only after fixture acceptance and closes cleanly.”**
- **Result:** `pass`

## SEL-10 — Inline success remains until Close

- **Setup:** Launch the fixture-backed Electron app without forced prompt failure and select an element.
- **Steps:** Enter “Describe this target,” leave **Ask OMP** selected, submit, and wait for completion without closing the card.
- **Expected result:** A complete inline response remains visible in the browser card until the user chooses **Close**; no visible chat gains a transcript entry.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, native BrowserView, and deterministic OMP fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:755-780`, **“inline result and delivery error stay in the card until Close.”** The hidden-session exclusion from the chat rail is code-established at `packages/desktop/src/main/desktop-host.ts:270`.
- **Result:** `pass`

## SEL-11 — Delivery failure remains until Close

- **Setup:** Launch the fixture-backed Electron app with prompt failure forced (`GRADIVUS_REJECT_NEXT_PROMPT`) and select an element.
- **Steps:** Enter “fail this prompt,” submit, and wait for the terminal selection state without closing the card.
- **Expected result:** A failed/error/rejected state remains visible in the browser card until the user chooses **Close**.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, native BrowserView, and deterministic forced-failure fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:755-780`, **“inline result and delivery error stay in the card until Close.”**
- **Result:** `pass`

## SEL-12 — Toolbar cancellation removes the active inspector

- **Setup:** Start element selection on the browser fixture before submitting any instruction.
- **Steps:** Choose **Cancel element selection** in the browser toolbar.
- **Expected result:** No inspector root remains in the BrowserView.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:782-803`, **“cancel, restart, navigate and close leave no stale inspector root.”**
- **Result:** `pass`

## SEL-13 — Card cancellation returns the page to normal input

- **Setup:** Restart selection, pick `#fixture-secondary`, and leave its instruction card open.
- **Steps:** Choose **Cancel** in the card, then click `#fixture-secondary` normally.
- **Expected result:** The inspector is gone and the page handles the next click, showing “Secondary connected.”
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:804-810`, **“cancel, restart, navigate and close leave no stale inspector root.”**
- **Result:** `pass`

## SEL-14 — Navigation removes the active inspector

- **Setup:** Start a new selection and open a card for `#fixture-action`.
- **Steps:** Navigate the same browser pane to the fixture URL with a new query string.
- **Expected result:** The previous page's inspector root does not remain after navigation.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; local fixture navigation.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:811-815`, **“cancel, restart, navigate and close leave no stale inspector root.”**
- **Result:** `pass`

## SEL-15 — Active-inspector pane close cleans up selection

- **Setup:** Open two browser panes and start a selection card in the pane that will be closed.
- **Steps:** Close that browser pane while its inspector is active.
- **Expected result:** The closed pane's inspector and pane-owned queue are removed without appearing in the remaining pane.
- **Priority:** P3
- **Device or environment:** Any supported host; actual Electron shell, renderer, and two native BrowserViews; active-inspector close was not executed.
- **Evidence:** Code-established at `packages/desktop/src/main/workspace-host.ts:1291-1298`. The executed sequence in `packages/desktop/e2e/omp-selection.spec.ts:782-815` navigated away from the active inspector before it performed an ordinary pane close, so it does not prove this claim.
- **Result:** `blocked`

## SEL-16 — Live theme change preserves target and queued pins

- **Setup:** Launch with Dark theme, queue one element, and select a second element so one pin and one active target are visible.
- **Steps:** Change the application theme from Dark to Light while the browser inspector remains active.
- **Expected result:** The inspector adopts the exact Light palette while retaining the same selected target, queued pin count, and native BrowserView bounds.
- **Priority:** P2
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic fixture; dark-to-light setting mutation.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:817-862`, **“theme changes preserve target and queued pins.”**
- **Result:** `pass`

## SEL-17 — Screenshot capture delivers one valid JPEG

- **Setup:** Launch the fixture-backed Electron app with attachment capture enabled, select one element, and set the BrowserView zoom factor to 1.25.
- **Steps:** Enter an instruction, choose **Screenshot**, and submit once.
- **Expected result:** OMP receives exactly one non-empty, base64-valid `image/jpeg` attachment.
- **Priority:** P1
- **Device or environment:** Windows x64; actual Electron shell, renderer, native BrowserView, and deterministic capture fixture at 1.25× zoom.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:864-904`, **“screenshot mode sends one valid JPEG while BrowserView identity and bounds stay fixed.”**
- **Result:** `pass`

## SEL-18 — Screenshot capture does not replace or resize the BrowserView

- **Setup:** Record the selected browser pane's native BrowserView identity, URL, and bounds before Screenshot submission.
- **Steps:** Submit one Screenshot-mode inline request and wait for its success state.
- **Expected result:** The BrowserView identity, URL, and bounds equal their pre-capture values.
- **Priority:** P2
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; deterministic capture fixture at 1.25× zoom.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:864-904`, **“screenshot mode sends one valid JPEG while BrowserView identity and bounds stay fixed.”**
- **Result:** `pass`

## SEL-19 — Fresh inspector has no serious or critical automated accessibility violations

- **Setup:** Open a fresh element-targeting card on the fixture page.
- **Steps:** Run Axe in the mounted Electron journey and evaluate enhanced contrast for the page surface.
- **Expected result:** Axe reports no serious or critical violations and the enhanced-contrast assertion passes.
- **Priority:** P2
- **Device or environment:** Windows x64; actual Electron shell, renderer, and native BrowserView; automated Axe and computed-color checks.
- **Evidence:** Observed/Tested — `packages/desktop/e2e/omp-selection.spec.ts:551-637`, **“opens a fresh BrowserView card with independent defaults and stable native surface.”**
- **Result:** `pass`

## SEL-20 — Workspace-runtime failure exposes visible recovery feedback

- **Setup:** Start inline selection work or a queue run, then interrupt the local workspace-runtime connection before the request settles.
- **Steps:** Observe the workspace shell through reconnect attempts and retry exhaustion.
- **Expected result:** A visible reconnecting state progresses to recovery or a persistent error with an actionable recovery control.
- **Priority:** P2
- **Device or environment:** Any supported host; Electron app with a controllable workspace-runtime connection; not executed in the passing selection suite.
- **Evidence:** Blocked for mounted coverage. Shell reconnect feedback now exists (resolved [`CHAT-002`](../bug-triage.md#chat-002--workspace-reconnect-and-outer-shell-errors-are-not-rendered)) with unit evidence in `test/runtime-reconnect.test.ts`; no selection journey severs the runtime.
- **Result:** `blocked`

## SEL-21 — Multiple chats for one workspace preserve delivery ownership

- **Setup:** Create two visible chats whose workspace paths match the Page Agent's, with one active.
- **Steps:** Route two selections to chat, switch the visible chat between them, then inspect both transcripts and browser outcomes.
- **Expected result:** Each admitted turn stays with the chat resolved at submission time — the active chat for the workspace path when submitted — without crossing into the other chat.
- **Priority:** P3
- **Device or environment:** Any supported host; Electron app with a two-chat runtime fixture; no such fixture was executed.
- **Evidence:** Code-established routing at `packages/desktop/src/main/desktop-host.ts:1335-1356`; the passing Electron suite used one workspace/chat pair only.
- **Result:** `blocked`

## SEL-22 — Multiple Page Agents expose stable distinguishable swatches

- **Setup:** Provide at least three Page Agents in one workspace across Dark, Light, System, and enhanced-contrast conditions.
- **Steps:** Compare the crosshair label, active highlight, queued pin, and queue row for each agent before and after theme changes.
- **Expected result:** Each agent keeps one consistent, visibly distinguishable swatch across every ownership surface and theme.
- **Priority:** P3
- **Device or environment:** Any supported host; Electron app with a multi-agent fixture and enhanced-contrast mode; not executed.
- **Evidence:** Code-established deterministic swatch propagation at `packages/desktop/src/shared/agent-swatch.ts` and the inspector script at `packages/desktop/src/main/workspace-host.ts:142-690`; the passing theme journey used one agent.
- **Result:** `blocked`

## SEL-23 — Navigation defines what happens to an existing queue

- **Setup:** Queue at least one captured element, leave it pending, then navigate the same pane to a different document.
- **Steps:** Inspect the queue and attempt **Run All** after navigation.
- **Expected result:** The product visibly applies one defined policy: retain the captured task with its original URL and frozen capture and run it, or mark/clear it as stale without silently retargeting it.
- **Priority:** P3
- **Device or environment:** Any supported host; Electron app with local pages A and B; not executed with a non-empty queue.
- **Evidence:** Code-established active-inspector cancellation at `packages/desktop/src/main/workspace-host.ts:2692-2705`; queue invalidation occurs on BrowserView destruction at `:1291-1298`, not navigation. Existing e2e navigation used no queued item.
- **Result:** `blocked`

## SEL-24 — Process exit defines pending and retained-state recovery

- **Setup:** Prepare four cases: an awaiting inline request, an awaiting chat acceptance, a pending queue, and a completed outcome card not yet closed.
- **Steps:** Exit and relaunch Electron during each case, then return to the same workspace and chat.
- **Expected result:** Each case has a documented visible recovery outcome with no duplicate delivery and no misleading stale success.
- **Priority:** P3
- **Device or environment:** Any supported host; packaged or development Electron app with deterministic delayed fixture; not executed.
- **Evidence:** No passing Electron journey exits during selection work; source establishes host-owned in-memory selection and queue state but not a relaunch contract.
- **Result:** `blocked`

## SEL-25 — Inline execution has a defined transcript-history consequence

- **Setup:** Start **Ask OMP** in a browser card while any visible chat transcript is open.
- **Steps:** Let the inline response complete, close the card, switch away, return to the chat, and page its history.
- **Expected result:** Inline work is intentionally absent from every visible chat transcript: it runs on the hidden Page Agent session, which is filtered from the chat rail and chat Agent Hub.
- **Priority:** P3
- **Device or environment:** Any supported host; Electron app with a resumable deterministic OMP fixture; transcript absence was not asserted end to end.
- **Evidence:** Code-established hidden-session routing at `packages/desktop/src/main/desktop-host.ts:270,633-716`; the passing journeys asserted only the retained browser card.
- **Result:** `blocked`

## SEL-26 — A mixed DOM/Screenshot queue preserves each capture mode

- **Setup:** Start a selection queue on one page with at least two selectable elements.
- **Steps:** Add one item in **DOM** mode, add a second in **Screenshot** mode, then choose **Run All**.
- **Expected result:** Each completed queue row reports and executes the capture mode selected when that item was added.
- **Priority:** P3
- **Device or environment:** Any supported host; Electron app with attachment capture enabled; the executed queue journey used Screenshot mode for its repeated picks.
- **Evidence:** Code-established per-task capture retention at `packages/desktop/src/main/workspace-host.ts:1950-2028,2442-2537` and row presentation at `packages/desktop/src/renderer/ui/organisms/SelectionQueuePane.svelte`; no executed Electron journey mixed both modes in one queue.
- **Result:** `blocked`

## SEL-27 — First use provisions the Page Agent visibly

- **Setup:** Launch the fixture-backed Electron app with no live Page Agent for the workspace.
- **Steps:** Activate **Select page element with Page Agent** and observe the toolbar, then pick an element.
- **Expected result:** The control briefly reads **Creating Page Agent** and is disabled while the hidden session starts, then selection begins; the browser Agent Hub count grows by one.
- **Priority:** P2
- **Device or environment:** Any supported host; actual Electron shell with no pre-existing Page Agent.
- **Evidence:** Code-established at `packages/desktop/src/renderer/ui/molecules/BrowserToolbar.svelte:65-75` and `packages/desktop/src/main/workspace-host.ts:2058-2118`; the executed journeys reuse an already-provisioned fixture agent, so the pending state was not observed.
- **Result:** `blocked`

## SEL-28 — DOM capture sends no DOM bytes

- **Setup:** Capture one DOM-mode inline submission through the attachment-capture fixture.
- **Steps:** Inspect the request the OMP side receives.
- **Expected result:** The captured request contains the selector, tag, bounds, and URL with the instruction, and no serialized HTML, text, or hierarchy.
- **Priority:** P2
- **Device or environment:** Any supported host; fixture-backed Electron app with request capture.
- **Evidence:** **Test-specified.** `packages/desktop/test/selection-flow.test.ts:304-309` and `packages/desktop/test/workspace-host-selection.test.ts:216` assert the no-DOM contract; the mounted journeys do not inspect DOM-mode request bytes.
- **Result:** `blocked`

## Evidence boundary

- Working tree anchored at `ac5f533bb245ef7f911dfc165c7c39356a2ac639` with the cross-platform terminal-renderer cutover applied.
- Evidence date: 2026-08-28.
- Runtime evidence: the 8/8 selection suite passed in an actual Electron application on Windows x64 using isolated user data and deterministic local fixtures.
- Test evidence: only the named executed Electron journeys support `pass`. Source-only and unit-only claims are not marked pass.

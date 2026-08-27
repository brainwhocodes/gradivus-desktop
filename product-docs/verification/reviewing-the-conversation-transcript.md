# Reviewing the conversation transcript verification

**Feature:** [`../features/reviewing-the-conversation-transcript.md`](../features/reviewing-the-conversation-transcript.md)  
**Document status:** verified  
**Evidence date:** 2026-08-25  
**Revision boundary:** working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop files may be modified or untracked.

## RCT-01 — Complete one streaming turn in stable transcript rows

**Observable claim:** A normal streaming turn ends with one submitted user row and the final assistant response in the conversation transcript.

- **Setup:** Launch the fixture-backed Electron app with its seeded chat and wait for the **Message OMP** composer.
- **Steps:** Enter `normal streaming turn`; press Enter; observe active-turn progress; wait for the final response; count user rows.
- **Expected result:** OMP Chat visibly enters a running/generating/reasoning state, then shows `Fixture completed the requested work.` and exactly one user transcript row for the submission.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with deterministic local chat RPC fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:179-227`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys,”** passed in the 24/24 `desktop.spec.ts` run; the claim is asserted at `:200-205`.
- **Result:** pass

## RCT-02 — Page backward without losing the reading position

**Observable claim:** Loading older transcript history prepends entries while keeping the user in the historical reading area.

- **Setup:** Launch the timeline fixture chat with 260 deterministic history entries at a 1280 × 820 viewport.
- **Steps:** Confirm the newest deterministic entry; activate **Load 100 older entries**; verify the oldest fixture entry; scroll to the top and record the viewport position.
- **Expected result:** `Deterministic history entry 1` appears before the already loaded recent entries, and the transcript remains in the user's historical reading position instead of jumping to the bottom.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with `GRADIVUS_TIMELINE_FIXTURE=1`.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1459-1495`, **“keeps timeline activity paused while reading history and renders bounded file summaries,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## RCT-03 — Pause and resume per-chat timeline follow

**Observable claim:** While the user reads above the bottom, incoming transcript activity does not move the viewport, and **Jump to latest** returns to follow mode.

- **Setup:** Use the timeline fixture after loading older entries; scroll the conversation transcript to the top.
- **Steps:** Submit `timeline wave`; keep the transcript scrolled up while tool and assistant updates arrive; compare scroll position; activate **Jump to latest**; submit `timeline wave following`.
- **Expected result:** The initial live updates appear without moving the historical viewport; **Jump to latest** remains visible until activated, then hides, moves to the bottom, and the next turn remains followed through completion.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with `GRADIVUS_TIMELINE_FIXTURE=1`.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1477-1507`, **“keeps timeline activity paused while reading history and renders bounded file summaries,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## RCT-04 — Render recognized semantic presentations

**Observable claim:** Recognized special events appear as user-facing semantic transcript cards rather than raw event payloads.

- **Setup:** Launch the fixture special-message chat with `GRADIVUS_SPECIAL_MESSAGES=1`.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Steps:** Inspect the initial timeline; run `/fixture-special`; review status, IRC, collaboration, advisor, activity, execution, provider-error, and context content.
- **Expected result:** The transcript exposes labelled semantic surfaces including **System update**, routed IRC messages, collaboration, advisor notes, background activity, truncated bash execution, **Provider error**, and an expandable compaction summary.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with deterministic semantic-event fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1748-1794`, **“renders semantic transcript messages,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## RCT-05 — Keep hidden and control-only payloads out of the transcript

**Observable claim:** Designated hidden/internal and known control payloads do not become visible transcript text or a raw fallback row.

- **Setup:** Use the core fixture chat and special-message fixture chat.
- **Steps:** Inspect the core transcript before and after a normal turn; inspect the special transcript for the injected system notice, live-model sentinel, unknown detail sentinel, and raw fallback label.
- **Expected result:** Hidden developer/custom/hook reminders, todo control progress, `<system-notice>`, `LIVE_MODEL_IRC_INSTRUCTION_SENTINEL`, and `FIXTURE_UNKNOWN_DETAILS_MUST_NOT_RENDER` are absent, and the injected known control event does not produce **Unrecognized event**.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with core and semantic fixtures.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:179-227`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys,”** asserts the core exclusions at `:200-205`; `:1748-1822`, **“renders semantic transcript messages,”** asserts semantic/control exclusions at `:1781-1784`. Both passed in the 24/24 run.
- **Result:** pass

## RCT-06 — Expand bounded semantic detail accessibly

**Observable claim:** A keyboard user can expand bounded advisor/context details without horizontal page or transcript overflow.

- **Setup:** Launch the special-message fixture at 1440 × 900, then prepare to resize to 760 × 620.
- **Steps:** Verify the fourth advisor note starts hidden; activate **Show remaining advisor notes**; focus **Show full compaction summary** and press Enter; resize to the narrow viewport; inspect page and transcript overflow.
- **Expected result:** The fourth advisor note and `Compacted context line 12` become visible, the focused summary remains focused, and neither the document nor transcript gains horizontal overflow at either viewport.
- **Priority:** P2
- **Device or environment:** macOS arm64, mounted Electron renderer with semantic fixture and Playwright keyboard/viewport control.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1748-1822`, **“renders semantic transcript messages,”** passed in the 24/24 run; disclosure and overflow assertions are at `:1771-1776,1789-1794,1803-1817`.
- **Result:** pass

## RCT-07 — Distinguish prompt-admission failure from a provider outcome

**Observable claim:** A delayed failure before work starts restores the submitted draft and shows prompt-recovery feedback instead of committing it as an ordinary assistant response.

- **Setup:** Launch the seeded core fixture chat and wait for an idle composer.
- **Steps:** Enter `delayed error`; press Enter; observe active progress; wait for failure; inspect the recovery card and composer.
- **Expected result:** **Prompt could not start** recovery contains `Fixture provider rejected the request.`, and the composer again contains `delayed error` for recovery.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with deterministic delayed-error fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:179-227`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys,”** passed in the 24/24 run; the exact recovery assertion is at `:206`.
- **Result:** pass

## RCT-08 — Keep live reasoning, assistant, and tool updates in stable rows

**Observable claim:** Multiple live updates for one reasoning, assistant, or tool identifier update one row rather than appending duplicate rows.

- **Setup:** A mounted Electron fixture that emits at least two deltas and a terminal event for each of one reasoning entry, one assistant entry, and one tool call, with stable identifiers.
- **Steps:** Record the row count and row identifiers after each emitted delta and after terminal completion.
- **Expected result:** Each identifier is represented by one row throughout; text/status changes in place; the assistant cursor disappears and tool/reasoning terminal state is visible at completion.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a controllable delta-level transcript fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/main/transcript-store.ts:102-290` and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2388-2417`. Repository assertions in `packages/desktop/test/transcript-projection.test.ts:244-258` and `packages/desktop/test/e2e-chat-progress.test.ts:452-677` were not executed. The passing Electron journeys observed streaming outcomes but did not assert row identity after every delta.
- **Result:** blocked

## RCT-09 — Apply Work and Code transcript projections

**Observable claim:** Work sessions hide raw tool arguments/results and raw-event detail while Code sessions expose the corresponding technical disclosure.

- **Setup:** Two otherwise equivalent restored chats, one Work and one Code, containing a tool with arguments/result/detail and an unknown raw event.
- **Steps:** Open the Work chat and record visible tool/raw details; open the Code chat and inspect **Technical details** and raw payload detail.
- **Expected result:** Work retains user-safe tool/file/image activity without raw arguments/results or raw payload detail; Code exposes the additional technical material without duplicating the chat container.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with matched Work/Code transcript fixtures.
- **Evidence:** **Code-established** by `packages/desktop/src/shared/projection.ts:3-13` and `packages/desktop/src/renderer/ui/organisms/TimelineEntry.svelte:179-242`. Repository audience assertions in `packages/desktop/test/transcript-projection.test.ts:628-654` were not executed, and no executed Electron journey compared both projections.
- **Result:** blocked

## RCT-10 — Expose a genuinely full large reasoning record

**Observable claim:** Activating **Reasoning** for a history record larger than 64 KiB exposes all stored reasoning text.

- **Setup:** A restored OMP chat containing a reasoning record larger than 64 KiB with a unique sentinel after the first 16 KiB.
- **Steps:** Open the chat; activate the **Reasoning** disclosure; wait for loading; search the rendered disclosure for the late sentinel and truncation marker.
- **Expected result:** The late sentinel is visible and the disclosure does not falsely present a truncated preview as the full record.
- **Priority:** P2
- **Device or environment:** macOS arm64 Electron app with a deterministic oversized OMP history fixture.
- **Evidence:** **Blocked by known defect.** Source at `packages/desktop/src/renderer/ui/organisms/TimelineEntry.svelte:217-232` renders only the first 16 KiB after a record over 64 KiB is loaded by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2276-2290`. No passing Electron journey covered this case. Filed as [CHAT-004 — “Full” large reasoning remains truncated](../bug-triage.md#chat-004--full-large-reasoning-remains-truncated).
- **Result:** blocked

## RCT-11 — Present ordinary turn cancellation without stale running rows

**Observable claim:** Stopping a turn leaves no assistant or tool row looking active after cancellation and clearly labels any retained partial output as interrupted.

- **Setup:** A mounted Electron fixture that holds both a partial assistant response and a running tool until **Stop** is activated.
- **Steps:** Start the turn; wait for partial assistant and tool content; activate **Stop**; inspect the user, reasoning, assistant, tool, attachment, and notification states.
- **Expected result:** The submitted user row remains, optimistic reasoning is removed, staged attachments are restored, **Turn stopped** appears, and every retained partial assistant/tool row has an unambiguous non-running cancellation presentation.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a controllable held-turn/tool fixture.
- **Evidence:** The executed `desktop.spec.ts` journey did not activate **Stop**. **Code-established** rollback is in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1226-1239`, but ordinary transcript status supports only `running|complete|error` in `packages/desktop/src/shared/contracts.ts:295-313`. The user-visible retained-partial outcome is not established.
- **Result:** blocked

# Verify workspaces and chat sessions

**Feature status: drafted.** Passing results below come only from the 24/24 executed `desktop.spec.ts` Electron journeys on macOS arm64. Source-only and unit-only claims remain `blocked`; `bun run test` did not complete and is not passing evidence. The checklist deliberately keeps a rail workspace separate from workspace authority: it verifies the OMP Chat rail and chat-session lifecycle, not browser/terminal authority persistence.

## 1. Fresh launch with no saved chats shows the workspace choice

**Observable claim:** After initial workspace-runtime hydration on a fresh user-data directory, OMP Chat shows an empty rail and **Choose a workspace** rather than inventing a chat.

- **Setup:** Start Gradivus with an empty isolated Electron user-data directory and a working local workspace runtime.
- **Steps:** Launch the application; wait for **Connecting to the workspace runtime…** to clear; inspect OMP Chat without choosing a folder.
- **Expected result:** The rail says **No workspace sessions yet**, the main card offers **Choose a workspace**, and no chat row or enabled composer is present.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell, isolated user data.
- **Evidence:** **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:626-635,2504-2528` and `packages/desktop/src/renderer/ui/organisms/SessionRail.svelte:117-123`. `packages/desktop/e2e/packaged.spec.ts:91-152` specifies a fresh empty surface but was not among the executed journeys.
- **Result:** blocked

## 2. Cancelling the workspace picker preserves the staged input

**Observable claim:** Cancelling **Create new workspace** leaves the current chat's staged attachment visible.

- **Setup:** Open a ready chat and stage `session-a.md`; configure the native folder picker to return Cancel.
- **Steps:** Activate **Create new workspace**; cancel the picker.
- **Expected result:** `session-a.md` remains staged in the same chat and no destination chat is selected.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with deterministic RPC fixture and controlled native-dialog response.
- **Evidence:** **Observed/Tested:** `bun run test:e2e:browser` passed 24/24; `packages/desktop/e2e/desktop.spec.ts:1343-1382`, **“isolates attachments across successful workspace creation”**, asserts the attachment remains after cancellation.
- **Result:** pass

## 3. Accepting a workspace creates a clean destination chat

**Observable claim:** Accepting a different folder in **Create new workspace** selects a new chat whose first prompt contains none of the prior chat's staged attachments.

- **Setup:** Open workspace A, stage `session-a.md`, and configure the native picker to return workspace B.
- **Steps:** Activate **Create new workspace**; accept workspace B; submit `new workspace prompt`.
- **Expected result:** The attachment chip from workspace A is absent, and the prompt sent from the new chat has no attachment reference.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with deterministic RPC fixture and controlled native-dialog response.
- **Evidence:** **Observed/Tested:** `bun run test:e2e:browser` passed 24/24; `desktop.spec.ts:1343-1382`, **“isolates attachments across successful workspace creation”**, asserts the chip disappears, the captured prompt has `references: []`, and temporary attachment files are released.
- **Result:** pass

## 4. A rail-workspace plus action creates a second same-folder chat

**Observable claim:** Activating **New Chat in workspace** adds a second selectable chat row while keeping the composer available.

- **Setup:** Launch a fixture-backed OMP Chat with one ready chat in one local folder.
- **Steps:** Activate **New Chat in workspace** on that rail workspace.
- **Expected result:** The same rail workspace contains two chat rows and the selected destination exposes the composer.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with deterministic RPC fixture.
- **Evidence:** **Observed/Tested:** `bun run test:e2e:browser` passed 24/24; `desktop.spec.ts:179-227`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys”**, asserts two tree items and a visible composer after the action.
- **Result:** pass

## 5. Relaunch selects the saved active chat

**Observable claim:** On relaunch, OMP Chat prefers the saved active Work chat, then the saved active Code chat, then the first saved chat.

- **Setup:** Persist at least two chat sessions with distinct titles and active pointers; quit the app cleanly.
- **Steps:** Relaunch; record the first selected rail row and displayed transcript; repeat with the Work pointer cleared and then with both pointers cleared.
- **Expected result:** Selection follows Work, then Code, then first-record precedence, and the highlighted row matches the loaded transcript.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell, isolated persistent user data reused across launches.
- **Evidence:** **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:626-635`; active pointers persist in `packages/desktop/src/main/session-registry.ts:74-115`. No executed Electron journey relaunched the same user-data directory.
- **Result:** blocked

## 6. Switching during a turn preserves origin ownership

**Observable claim:** A turn started in chat A can finish while chat B is selected, and its result appears in chat A after returning rather than in chat B.

- **Setup:** Launch two fixture chats in one rail workspace.
- **Steps:** Start a delayed turn in chat A; select chat B; complete a normal turn in B; return to A.
- **Expected result:** B shows B's completion; A shows **Background session completed.** after returning; the background result is not reassigned to B.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with deterministic RPC fixture.
- **Evidence:** **Observed/Tested:** `bun run test:e2e:browser` passed 24/24; `packages/desktop/e2e/desktop.spec.ts:1702-1705`, **“keeps background completion attached to its originating chat”**.
- **Result:** pass

## 7. A running inactive chat is visible in the rail

**Observable claim:** When chat A has an active turn and chat B is selected, chat A's row and rail workspace visibly indicate running work.

- **Setup:** Open two chats in the same rail workspace.
- **Steps:** Start a held turn in chat A; select chat B; inspect chat A's row and its folder header.
- **Expected result:** Chat A has a running radar and the folder header exposes **Turn in progress** without requiring a return to A.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with deterministic held-turn fixture.
- **Evidence:** **Code-established:** `packages/desktop/src/renderer/ui/organisms/SessionRail.svelte:50-62,77-95` and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:268-305`. The executed background-turn test did not assert these rail indicators.
- **Result:** blocked

## 8. A runtime failure is visible on its chat row

**Observable claim:** A chat whose OMP runtime enters error state shows the rail's error indicator even when another chat is selected.

- **Setup:** Open two chats and arrange for chat A's OMP process or RPC stream to fail unexpectedly while chat B is selected.
- **Steps:** Select B; trigger A's runtime failure; inspect A's rail row.
- **Expected result:** A's row shows the error `!` indicator with **Error**, while B remains selected.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with a controllable OMP child-process failure.
- **Evidence:** **Code-established:** `SessionRail.svelte:77-104` and `OmpChat.svelte:2295-2347`. No passing mounted Electron journey forced an OMP runtime disconnect.
- **Result:** blocked

## 9. Returning to an unseen completion clears its rail marker

**Observable claim:** Completion in an inactive chat creates an unseen marker, and selecting that chat clears the marker.

- **Setup:** Open chats A and B; start a delayed turn in A and select B before completion.
- **Steps:** Wait for A to complete; inspect A's row; select A; inspect the row again.
- **Expected result:** A shows **New completed turn** while inactive; selecting A removes the unseen marker and reveals A's completed transcript.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with deterministic delayed completion.
- **Evidence:** **Code-established:** `OmpChat.svelte:268-279,647-652` and `SessionRail.svelte:84-104`. **Observed/Tested only for transcript ownership:** `desktop.spec.ts:1702-1705`; the marker itself was not asserted.
- **Result:** blocked

## 10. Manual rename updates the selected chat title

**Observable claim:** Saving a non-empty value through **Rename session** changes the selected header and matching rail-row title.

- **Setup:** Open a ready chat with a known default title.
- **Steps:** Activate **Rename session**; replace the value with `Release review`; activate **Save**; switch away and back.
- **Expected result:** The header and rail row show `Release review` after save and after reopening the chat.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with writable user data and a fixture runtime that accepts title updates.
- **Evidence:** **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1339-1365,2531-2543` and `packages/desktop/src/main/desktop-host.ts:476-490`. No executed Electron journey used the rename control.
- **Result:** blocked

## 11. First-prompt auto-title replaces only a default-looking title

**Observable claim:** A first prompt replaces a default-looking chat title with a cleaned short title while preserving an already explicit title.

- **Setup:** Create one untitled chat and one manually titled chat.
- **Steps:** Submit a distinctive first prompt in each; inspect the header and rail after runtime title events settle.
- **Expected result:** The untitled chat receives a cleaned title no longer than 38 characters; the explicit title is not overwritten by the renderer's first-prompt auto-title path.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with deterministic RPC fixture.
- **Evidence:** **Code-established:** `OmpChat.svelte:1155-1168` and `desktop-host.ts:1436-1452`. The passing streaming journey submitted a first prompt but did not assert title behavior.
- **Result:** blocked

## 12. A dormant chat reopens with its saved history

**Observable claim:** After a ready chat becomes dormant through the five-minute idle policy, selecting it resumes the chat and restores its prior transcript.

- **Setup:** Create a chat with a completed transcript; leave its resident runtime ready and unused for more than five minutes without exiting the app.
- **Steps:** Wait for dormancy; select another chat; return to the dormant chat.
- **Expected result:** The chat remains in the rail, transitions through opening, becomes ready, and shows its saved transcript without duplicate entries.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with controllable time or a bounded residency test mode.
- **Evidence:** **Code-established:** `packages/desktop/src/main/desktop-host.ts:190-197,1094-1150` and `packages/desktop/src/main/runtime-supervisor.ts:520-545`. **Test-specified only:** `packages/desktop/test/runtime-supervisor.test.ts:177-192`, **“evicts after idle timeout and touch resets the deadline”**. The package unit run did not complete; see [`../bug-triage.md`](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** blocked

## 13. Runtime pressure does not evict active work

**Observable claim:** Opening a fourth recent chat can make the least-recently-used idle chat dormant without stopping a running or leased chat.

- **Setup:** Open four saved chats; keep a turn running in one and make another idle chat least recently used.
- **Steps:** Open enough chats to exceed the three-resident-runtime cap; inspect running work and reopen the evicted idle chat.
- **Expected result:** The active turn continues; the least-recently-used idle chat resumes on selection with its history intact.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with deterministic held-turn fixture.
- **Evidence:** **Code-established:** `desktop-host.ts:190-197` and `runtime-supervisor.ts:320-335,498-518`. **Test-specified only:** `packages/desktop/test/runtime-supervisor.test.ts:130-175`. The package unit run did not complete; see [`../bug-triage.md`](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** blocked

## 14. An active turn exposes one turn-level Stop control

**Observable claim:** While a turn is active, OMP Chat exposes exactly one enabled control named **Stop generation**.

- **Setup:** Open a fixture chat in ready state.
- **Steps:** Submit `hold current turn`; inspect the active-turn banner and composer while the turn remains held.
- **Expected result:** Exactly one **Stop generation** control is visible and enabled; idle **Send message** is replaced by **Steer current turn**.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with deterministic held-turn fixture.
- **Evidence:** **Observed/Tested:** `bun run test:e2e:browser` passed 24/24; `packages/desktop/e2e/desktop.spec.ts:1707-1746`, **“routes Enter to steering while a turn is active”**, asserts one enabled `.turn-stop-btn` with accessible name **Stop generation**.
- **Result:** pass

## 15. Activating Stop aborts only the current turn

**Observable claim:** Activating **Stop generation** ends the current turn, reports **Turn stopped**, reconciles its optimistic transcript, and leaves the chat runtime ready for another prompt.

- **Setup:** Open a ready chat; stage an attachment; start a held turn that has emitted an optimistic user entry and running placeholder.
- **Steps:** Activate **Stop generation**; wait for abort acknowledgement; submit a second ordinary prompt.
- **Expected result:** The submitted user entry remains, the running placeholder is removed, staged attachments follow the documented restoration policy, **Turn stopped** appears once, and the next prompt can run in the same chat.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with deterministic abort acknowledgement.
- **Evidence:** **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1226-1239`. The passing active-turn journey asserted Stop visibility but never activated it; no passing mounted journey verifies reconciliation.
- **Result:** blocked

## 16. Session stop is distinguishable from turn Stop

**Observable claim:** If session stop is product-accessible, it is labelled and confirmed as stopping the OMP session rather than appearing as a second ambiguous **Stop generation** action.

- **Setup:** Open a ready chat, then repeat while a turn is running.
- **Steps:** Inspect the header, rail-row actions, and active-turn controls for a session-level stop; activate it if present.
- **Expected result:** The active-turn action remains **Stop generation**. A session-level action, if intentionally exposed, clearly says it stops the OMP session, confirms interruption while running, and leaves the chat record dormant and reopenable.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with deterministic runtime.
- **Evidence:** **Code-established but reachability unresolved:** `OmpChat.svelte:891-906` defines the confirmation and `desktop-host.ts:470-473` stops the runtime, but no renderer invocation of `stopSession` was identified. The executed turn journey only establishes one visible **Stop generation** control.
- **Result:** blocked

## 17. An unmounted OMP runtime failure offers Reconnect on return

**Observable claim:** If an inactive chat's OMP runtime fails, selecting that chat reveals **Runtime stopped unexpectedly** and one usable **Reconnect** action.

- **Setup:** Open chats A and B; leave A resident; select B; retain a valid saved OMP session file for A.
- **Steps:** Terminate A's OMP child process while A is unmounted from the active transcript; select A; activate **Reconnect**.
- **Expected result:** A's error state is visible on return; **Reconnect** starts/resumes A from the saved file; the prior transcript converges without duplicates or loss.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with controllable OMP child process.
- **Evidence:** **Code-established:** `OmpChat.svelte:874-889,2316-2325,2594-2595` and `packages/desktop/src/main/desktop-host.ts:372-383`. No passing mounted Electron journey forced disconnect/reconnect. Workspace-runtime reconnect is a separate lifecycle; its missing shell feedback is filed at [`CHAT-002`](../bug-triage.md#chat-002--workspace-reconnect-and-outer-shell-errors-are-not-rendered).
- **Result:** blocked

## 18. Relaunch restores chat history and the active selection

**Observable claim:** A clean quit and relaunch restore the previously active chat's title and transcript while starting all other saved chats dormant.

- **Setup:** Create two chats in one folder; rename them; complete a turn in each; leave one selected; quit cleanly.
- **Steps:** Relaunch with the same user-data directory; inspect the selected row and transcript; select the other chat.
- **Expected result:** The previously active chat opens first with its saved title/history; the other remains selectable and restores its own history when opened; neither transcript contains duplicates from the other.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell, persistent isolated user data reused across launches.
- **Evidence:** **Code-established:** `packages/desktop/src/main/session-registry.ts:30-115`, `desktop-host.ts:217-220,360-383,1094-1150`, and `OmpChat.svelte:626-635`. **Test-specified only:** `packages/desktop/test/desktop-host.test.ts:272-301`. No executed Electron journey relaunched and reopened history.
- **Result:** blocked

## 19. OMP Chat provides no conversation-deletion action

**Observable claim:** A user cannot delete a chat session from its rail row, transcript header, Settings, or keyboard actions in the current product.

- **Setup:** Create at least two chats in one rail workspace, including one dormant chat.
- **Steps:** Inspect every chat-row and header action; open Settings; try documented keyboard actions; distinguish browser-tab and terminal close controls.
- **Expected result:** No action claims to delete or remove a chat; browser and terminal close actions do not remove chat rows or OMP history.
- **Priority:** P2
- **Device or environment:** macOS arm64, actual Electron shell with isolated user data.
- **Evidence:** **Code-established only:** `packages/desktop/src/renderer/ui/organisms/SessionRail.svelte:43-125`, `OmpChat.svelte:2504-2605`, and `packages/desktop/src/shared/contracts.ts:671-757` expose no chat deletion. The required product decision and mounted resolution threshold are filed at [`CHAT-011`](../bug-triage.md#chat-011--conversation-deletion-has-no-product-path).
- **Result:** blocked

## 20. Draft ownership is explicit across chat selection

**Observable claim:** Switching from chat A to chat B applies one intentional, visible ownership rule to both draft text and staged attachments.

- **Setup:** In chat A, type `draft for A` and stage `a.md`; leave both unsubmitted.
- **Steps:** Select chat B; inspect its composer; return to A; relaunch and inspect both chats again.
- **Expected result:** Text and attachments either remain per-chat, move together as a global composer, or are discarded only after explicit notice/confirmation; they do not silently diverge.
- **Priority:** P1
- **Device or environment:** macOS arm64, actual Electron shell with isolated persistent user data.
- **Evidence:** **Observed/Tested only for attachment release:** `desktop.spec.ts:1210-1269` proves attachments are cleared at a session boundary. **Code-established:** `OmpChat.svelte:647-710` keeps one renderer draft while releasing visible attachments. The unresolved split rule is filed at [`CHAT-006`](../bug-triage.md#chat-006--draft-and-attachment-ownership-diverge-on-chat-switches).
- **Result:** blocked

## Evidence boundary

- Revision anchor: `c125341133ff90a29fe266e1b166bac0183338c8`
- Evidence date: 2026-08-25
- Working-tree boundary: relevant desktop sources may be modified or untracked; evidence describes the working tree anchored at that commit.
- Executed runtime: `bun run test:e2e:browser` passed 24/24, `bunx playwright test e2e/omp-selection.spec.ts` passed 8/8, and `GRADIVUS_REAL_OMP=1 bunx playwright test --config playwright.real.config.ts` passed 1/1 on macOS arm64. Only the named `desktop.spec.ts` journeys above support passing claims in this checklist. **Post-cutover status:** rerun under the renamed variables on macOS arm64; `bun run test:e2e:browser` passed 24/24, the selection suite passed 8/8, and the real-runtime journey passed 1/1.
- Unit boundary: `bun run test` failed to complete; unit-only assertions are test-specified rather than passing evidence. See [`../bug-triage.md`](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).

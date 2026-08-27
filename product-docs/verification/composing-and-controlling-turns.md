# Verification: composing and controlling turns

**Coverage status: drafted.** The executed Electron suite establishes the normal Send, local-command, recovery, Retry, Steer, Queue, runtime-disclosure, slash-menu-dismissal, and background-completion claims below. P1 mounted Stop reconciliation and non-composable-boundary admission remain blocked; the latter is filed as CHAT-005. Runtime reconnect, modifier apply timing, complete keyboard semantics, and acknowledgement-order coverage are not counted as passing from source or unit-only assertions.

The evidence date is 2026-08-25. The working tree is anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources and tests may be modified or untracked. Executed results on macOS arm64 were `desktop.spec.ts` 24/24 passed and `real.spec.ts` 1/1 passed. `bun run test` failed, so unit-only claims remain test-specified rather than passing.

## P1 — A primary Send converges to one user entry

- **Setup:** Start the deterministic Electron fixture with one ready Work session and a visible empty composer.
- **Steps:** Enter `normal streaming turn`, press Enter once, and wait for the fixture's final assistant response.
- **Expected result:** The conversation transcript contains the completed fixture response and exactly one user entry for the submitted request.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer and deterministic chat RPC fixture.
- **Evidence:** Observed and Tested by `packages/desktop/e2e/desktop.spec.ts:179-227`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys”**, especially lines 203-204; executed in the 24/24 passing `desktop.spec.ts` run.
- **Result:** pass

## P1 — A submitted primary message shows active feedback before completion

- **Setup:** Start the deterministic Electron fixture in a ready chat.
- **Steps:** Submit `normal streaming turn` and inspect the status region before the final response arrives.
- **Expected result:** A visible status reports turn progress, generation, or reasoning before the final assistant response appears.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer and deterministic chat RPC fixture.
- **Evidence:** Observed and Tested by `desktop.spec.ts:179-227`, same named test, line 203; executed in the 24/24 passing run.
- **Result:** pass

## P1 — A local command returns transcript output

- **Setup:** Use the deterministic Electron fixture after the composer has returned to a usable state.
- **Steps:** Enter `/status` and press Enter.
- **Expected result:** The conversation transcript shows `Fixture status: ready`.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer and deterministic chat RPC fixture.
- **Evidence:** Observed and Tested by `desktop.spec.ts:179-227`, same named test, line 207; executed in the 24/24 passing run. The no-agent outcome is Code-established at `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1301-1311`.
- **Result:** pass

## P1 — A delayed prompt-start failure restores the submitted draft

- **Setup:** Start the deterministic Electron fixture and configure its next prompt to fail after initial active feedback.
- **Steps:** Submit `delayed error` and wait for the recovery surface.
- **Expected result:** **Prompt could not start** reports the fixture rejection and the composer again contains `delayed error`.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer with deterministic delayed prompt rejection.
- **Evidence:** Observed and Tested by `desktop.spec.ts:179-227`, same named test, line 206; executed in the 24/24 passing run.
- **Result:** pass

## P1 — Retry reuses a restored attachment

- **Setup:** Start the attachment fixture with the next primary prompt configured to fail immediately; stage `retry.txt` without draft text.
- **Steps:** Submit the attachment-only request, wait for **Prompt could not start**, and activate **Retry**.
- **Expected result:** Retry admits the same staged file reference and the attachment chip disappears after successful admission.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer, deterministic rejection, and isolated temporary attachment store.
- **Evidence:** Observed and Tested by `desktop.spec.ts:1148-1174`, **“restores and retries an attachment-only prompt after immediate failure”**; executed in the 24/24 passing run.
- **Result:** pass

## P1 — Delayed failure preserves newer input in deterministic order

- **Setup:** Configure a delayed prompt rejection; stage `original.md`, submit `original request`, then type `newer draft` and stage `new.md` before rejection arrives.
- **Steps:** Wait for the prompt recovery card and inspect the composer and attachment chips.
- **Expected result:** The composer contains `original request`, a blank separator, then `newer draft`, and the chips are ordered `original.md`, `new.md`.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer with deterministic delayed rejection and isolated attachment store.
- **Evidence:** Observed and Tested by `desktop.spec.ts:1175-1208`, **“preserves newer draft and newly staged files across delayed prompt failure”**, especially lines 1192-1194; executed in the 24/24 passing run.
- **Result:** pass

## P1 — Enter steers while a turn is active

- **Setup:** Start the held-turn fixture and submit `hold current turn`.
- **Steps:** Wait for active feedback, type `steer the current turn`, and press Enter.
- **Expected result:** The active turn accepts the input as steering and completes with `Held turn completed after steering.` rather than starting an independent primary turn.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer and deterministic held-turn fixture.
- **Evidence:** Observed and Tested by `desktop.spec.ts:1707-1747`, **“routes Enter to steering while a turn is active”**; executed in the 24/24 passing run.
- **Result:** pass

## P1 — Queue defers a follow-up until after the active turn

- **Setup:** Start the held-turn follow-up fixture, submit the holding prompt, stage `queue.md` and `queue.png`, and enter `queue with files`.
- **Steps:** Open More actions and activate **Queue for the next turn**; after the injected first delivery failure, activate Queue again.
- **Expected result:** The queued request completes after the active turn with `Follow-up completed after the active turn.`
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer, deterministic follow-up fixture, and isolated attachment store.
- **Evidence:** Observed and Tested by `desktop.spec.ts:1303-1342`, **“queues exact follow-up attachments and cleans retained files on teardown”**, especially lines 1313-1331; executed in the 24/24 passing run. Retained-byte lifetime is tracked separately in [`../bug-triage.md#chat-007--successful-steer-and-queue-attachments-remain-retained`](../bug-triage.md#chat-007--successful-steer-and-queue-attachments-remain-retained).
- **Result:** pass

## P1 — Background completion remains with the originating chat

- **Setup:** Start the two-chat deterministic fixture with chat A and chat B.
- **Steps:** Start a delayed turn in chat A, switch to chat B and complete a normal turn, then return to chat A.
- **Expected result:** Chat A shows its delayed completion when reopened; that completion does not appear in chat B's transcript.
- **Priority:** P1
- **Device or environment:** macOS arm64; Electron renderer with two fixture-backed chat sessions.
- **Evidence:** Observed and Tested by `desktop.spec.ts:1702-1706`, **“keeps background completion attached to its originating chat”**; executed in the 24/24 passing run.
- **Result:** pass

## P1 — Stop reconciles the mounted active turn

- **Setup:** Start a deterministic held turn with a submitted user entry and staged attachments captured in the pending turn.
- **Steps:** Activate **Stop generation** once and wait for abort success; repeat in a run where abort rejects.
- **Expected result:** Success sends one abort, retains the submitted user entry, removes the optimistic reasoning placeholder, restores pending attachments, shows **Turn stopped**, and removes live controls; rejection shows failure and leaves the active turn available for recovery.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron renderer with controllable abort success and rejection.
- **Evidence:** Blocked. `desktop.spec.ts:1707-1747` only proves Stop is visible, named, and enabled; it never activates it. Production behavior is Code-established at `OmpChat.svelte:1226-1260,2326-2339`, while copied unit harnesses are not mounted evidence. The gap is noted in [`../bug-triage.md`](../bug-triage.md), but no dedicated Stop item currently defines its resolution threshold.
- **Result:** blocked

## P1 — Non-composable states reject every composer action

- **Setup:** Preserve a non-empty draft while moving the selected chat through loading, starting, stopping, error, and a rapid stale-selection boundary.
- **Steps:** Attempt Send, Enter, Steer, Queue, and attachment admission in each state.
- **Expected result:** No action dispatches against the unavailable or stale chat, and action availability matches the composer's authoritative enabled state.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron renderer with controllable session state and selection timing.
- **Evidence:** Blocked by a suspected predicate mismatch in `OmpChat.svelte:552-566,1109-1116,2691-2734`; no executed mounted journey covers it. Filed as [`../bug-triage.md#chat-005--send-can-remain-actionable-while-the-chat-cannot-compose`](../bug-triage.md#chat-005--send-can-remain-actionable-while-the-chat-cannot-compose).
- **Result:** blocked

## P2 — Runtime selection updates the visible summary

- **Setup:** Start the fixture runtime picker in Comfortable density.
- **Steps:** Open runtime settings, choose provider **Alternate**, observe model **Compact Fixture**, choose thinking level **high**, and close with Escape.
- **Expected result:** The collapsed runtime summary shows Alternate, Compact Fixture, and high after the disclosure closes.
- **Priority:** P2
- **Device or environment:** macOS arm64; Electron renderer and deterministic runtime metadata fixture.
- **Evidence:** Observed and Tested by `desktop.spec.ts:228-305`, **“keeps the runtime summary and disclosure usable at both densities”**, especially lines 238-282; executed in the 24/24 passing run.
- **Result:** pass

## P2 — Context disclosure closes and restores focus

- **Setup:** Start the runtime-disclosure fixture and locate the **Context window** trigger.
- **Steps:** Open the context disclosure and press Escape.
- **Expected result:** The disclosure closes and keyboard focus returns to its trigger.
- **Priority:** P2
- **Device or environment:** macOS arm64; Electron renderer at Compact density.
- **Evidence:** Observed and Tested by `desktop.spec.ts:228-305`, same named test, lines 293-301; executed in the 24/24 passing run.
- **Result:** pass

## P2 — Slash-menu Escape dismisses without clearing the draft

- **Setup:** Focus the empty composer in the mounted Electron fixture.
- **Steps:** Enter `/`, wait for the slash-command listbox, and press Escape.
- **Expected result:** The menu closes, the composer remains focused, and the draft remains `/`.
- **Priority:** P2
- **Device or environment:** macOS arm64; Electron renderer at Comfortable and Compact densities.
- **Evidence:** Observed and Tested by `desktop.spec.ts:466-973`, **“keeps the Command Deck composer as one usable surface at both densities”**, especially lines 950-968; executed in the 24/24 passing run.
- **Result:** pass

## P2 — Every slash-command selection key follows the documented rule

- **Setup:** Open a slash menu with multiple command matches in a mounted composer.
- **Steps:** Use Up, Down, Tab, Enter on a non-exact match, Enter on an exact match, Shift+Enter, and an IME composition event in separate interactions.
- **Expected result:** Up/Down wrap, Tab inserts, non-exact Enter inserts, exact Enter submits, Shift+Enter adds a line break, and IME composition does not submit.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron renderer with an IME-capable input path.
- **Evidence:** Blocked. The branches are Code-established at `OmpChat.svelte:1736-1779`; the executed Electron journey covers only slash ARIA and Escape. No dedicated triage item exists in [`../bug-triage.md`](../bug-triage.md).
- **Result:** blocked

## P2 — The live banner reports elapsed time and throughput

- **Setup:** Start a fixture turn that remains active long enough to advance elapsed time and publishes positive `tokensPerSecond` metrics.
- **Steps:** Observe the active banner before and after at least one elapsed-time tick.
- **Expected result:** The elapsed display advances from its initial value and a rounded `tok/s` value appears while throughput is positive.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron renderer with deterministic timing and throughput metrics.
- **Evidence:** Blocked. Active feedback is passing mounted evidence, but no executed assertion checks timer advancement or throughput. Code-established at `OmpChat.svelte:527-548,2645-2655`; `test/chat-turn-banner.test.ts:96-230` is unit-only copied logic and is not passing mounted evidence. No dedicated triage item exists in [`../bug-triage.md`](../bug-triage.md).
- **Result:** blocked

## P2 — Runtime failure offers a working Reconnect path

- **Setup:** Start a mounted chat, force its OMP process or RPC connection to fail while a turn is active, and preserve its saved OMP session file.
- **Steps:** Wait for the runtime error card, activate **Reconnect**, and wait for the chat to resume.
- **Expected result:** **Runtime stopped unexpectedly** appears, Reconnect resumes the same chat session, and the recovered transcript contains no duplicate submitted entry.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron renderer with controllable OMP process failure and resume.
- **Evidence:** Blocked. The error/recovery surface is Code-established at `OmpChat.svelte:2314-2340,2594`; no passing mounted Electron journey forced or completed this path. Workspace-runtime reconnect entry CHAT-002 is a different lifecycle, so this OMP Chat gap has no dedicated item in [`../bug-triage.md`](../bug-triage.md).
- **Result:** blocked

## P2 — Mid-turn runtime changes have explicit apply timing

- **Setup:** Start a held turn, then change provider, model, thinking level, and plan mode one at a time while it remains active.
- **Steps:** Complete the active turn and submit one later message after each change.
- **Expected result:** The interface makes clear whether each changed value applies to the active turn, the next admitted steering or queued message, or the next primary turn.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron renderer and deterministic runtime reporting effective configuration.
- **Evidence:** Blocked. Executed evidence changes runtime controls only while idle. Production control paths are in `OmpChat.svelte:320-373,2435-2442,2691-2734`, but their effect on already-running work is not established. No dedicated triage item exists in [`../bug-triage.md`](../bug-triage.md).
- **Result:** blocked

## P2 — Prompt result order does not duplicate or strand feedback

- **Setup:** Mount the Electron renderer with a fixture that can emit a correlated prompt result before acknowledgement, after acknowledgement, and concurrently with runtime state changes.
- **Steps:** Submit the same observable request once under each ordering and wait for settlement.
- **Expected result:** Each ordering leaves one canonical user entry, no optimistic reasoning placeholder, and one final completion or recovery surface.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron renderer with deterministic RPC event ordering.
- **Evidence:** Blocked. Early-result handling is Code-established at `OmpChat.svelte:1167-1177,1289-1317,2300-2311` and test-specified in `packages/desktop/test/rpc-client.test.ts:141-162`, but the failed `bun run test` is not passing evidence and no executed Electron test varies ordering. No dedicated triage item exists in [`../bug-triage.md`](../bug-triage.md).
- **Result:** blocked

## P3 — The compiled runtime completes a local context command

- **Setup:** Launch the Electron app with `GRADIVUS_REAL_OMP=1` and the compiled OMP runtime.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Steps:** Submit `/context` through OMP Chat.
- **Expected result:** The conversation transcript shows the compiled runtime's context output without requiring an external provider turn.
- **Priority:** P3
- **Device or environment:** macOS arm64; Electron app and compiled local OMP runtime.
- **Evidence:** Observed and Tested by `packages/desktop/e2e/real.spec.ts:19-48`, **“runs /context through the compiled OMP Chat runtime”**; executed 1/1 passing.
- **Result:** pass

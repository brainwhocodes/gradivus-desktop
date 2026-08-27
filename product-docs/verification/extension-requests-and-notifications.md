# Extension requests and notifications verification

**Feature:** [`../features/extension-requests-and-notifications.md`](../features/extension-requests-and-notifications.md)  
**Document status:** drafted  
**Evidence date:** 2026-08-25  
**Revision boundary:** working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop files may be modified or untracked.

## ERN-01 — Show and dismiss an in-app notification

**Observable claim:** An extension warning appears as a manually dismissible in-app alert.

- **Setup:** Launch the fixture-backed Electron app with `GRADIVUS_SPECIAL_MESSAGES=1` and open the fixture inspector chat.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Steps:** Submit `/fixture-special`; wait for the warning notification; inspect its accessibility role; activate **Dismiss notification**.
- **Expected result:** One warning toast is visible with `role=alert`; activating **Dismiss notification** hides it while the composer remains usable.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and deterministic special-message fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1748-1822`, **“renders semantic transcript messages,”** passed in the 24/24 `desktop.spec.ts` run; lines 1784-1802 assert the fixture command, visible warning toast, dismissal, and usable composer.
- **Result:** pass

## ERN-02 — Complete each modal request once

**Observable claim:** Select, confirm, input, and editor requests each present the matching controls and close only after one accepted response.

- **Setup:** A mounted Electron fixture capable of issuing `select`, `confirm`, `input`, and `editor` requests and recording the response envelope for each method.
- **Steps:** Issue each method in turn; choose an option; exercise confirm **Cancel** and **Confirm** on separate requests; enter and submit input/editor text; exercise input/editor **Cancel**; inspect recorded responses and modal visibility.
- **Expected result:** Select sends the chosen option; confirm sends the selected boolean; input/editor submit their current value or explicit cancellation; the accepted response clears the modal exactly once; none of the requests becomes a conversation transcript approval entry.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with a deterministic extension-request fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2207-2212,2419-2433,3150`. No executed Electron journey can issue and record these modal methods. The missing mounted-modal path is tracked with the pending-request visibility blocker in [`CHAT-001`](../bug-triage.md#chat-001--an-extension-request-can-be-lost-after-switching-chats).
- **Result:** blocked

## ERN-03 — Mask sensitive input

**Observable claim:** A sensitive input request uses a password-masked field labelled **Sensitive input** and returns the entered value only on explicit submission.

- **Setup:** A mounted Electron fixture that emits a sensitive `input` request with placeholder and prefill and records its response.
- **Steps:** Open the request; inspect the input type, accessible label, visible value treatment, and initial prefill; type a replacement; activate **Submit**.
- **Expected result:** Characters are visually masked; the field is labelled **Sensitive input**; the submitted response contains the current value; the modal closes only after acceptance; no secret appears in the conversation transcript.
- **Priority:** P2
- **Device or environment:** macOS arm64, mounted Electron renderer with a deterministic sensitive-input fixture and accessibility inspection.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:3150`. No executed Electron journey opens this modal. The missing modal verification and recovery path are linked to [`CHAT-001`](../bug-triage.md#chat-001--an-extension-request-can-be-lost-after-switching-chats).
- **Result:** blocked

## ERN-04 — Keep a request recoverable across chat switching

**Observable claim:** A request owned by chat A remains visible or explicitly recoverable after the user visits chat B and returns to chat A.

- **Setup:** Two chat sessions and an extension fixture that can delay a `select`, `confirm`, `input`, or `editor` request from chat A until chat B is active.
- **Steps:** Start the delayed request in chat A; switch to chat B before delivery; wait; return to chat A; inspect for the modal or a session-rail recovery state; respond once if available.
- **Expected result:** The originating chat exposes a durable pending-request model, replayed modal, or explicit cancellation/recovery action, and OMP does not remain invisibly blocked.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with two chats and delayed extension delivery.
- **Evidence:** **Suspected source defect, not runtime-observed.** The active-session guard precedes extension routing in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2342-2433`, while `packages/desktop/src/main/desktop-host.ts:1504-1538` retains only an in-memory outstanding identifier and method. The executed suite has no pending-extension chat-switch journey. Tracked in [`CHAT-001`](../bug-triage.md#chat-001--an-extension-request-can-be-lost-after-switching-chats).
- **Result:** blocked

## ERN-05 — Preserve a pending request through renderer recreation

**Observable claim:** Reloading or relaunching while a modal is pending restores the request or visibly cancels it so OMP is not left waiting without a surface.

- **Setup:** A chat with a pending confirm request and a fixture that records cancellation, replay, and continuation after renderer reload or app relaunch.
- **Steps:** Open the confirm modal; reload the renderer; repeat with full app exit/relaunch; reopen the originating chat; inspect the modal, transcript, rail, and fixture state.
- **Expected result:** Each interruption produces one explicit outcome: replay the pending request, cancel it and let OMP continue, or show a durable recovery action. Silent loss is not acceptable.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and relaunch-capable extension fixture.
- **Evidence:** **Code-established limitation and Open question.** Pending modal state is renderer-local in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:132,2207-2212,2430`, and no pending extension appears in the chat snapshot contract. No executed Electron journey reloads or relaunches with a pending request. Tracked with the stranded-request blocker in [`CHAT-001`](../bug-triage.md#chat-001--an-extension-request-can-be-lost-after-switching-chats).
- **Result:** blocked

## ERN-06 — Provide predictable modal cancellation and focus

**Observable claim:** Every extension modal provides a keyboard-reachable cancellation path, contains focus while open, and returns focus to a meaningful chat control when closed.

- **Setup:** A mounted Electron fixture capable of opening all four modal methods, plus keyboard and Axe inspection.
- **Steps:** Open each modal; record initial focus; traverse with Tab and Shift+Tab; try Escape and backdrop click; use the visible cancel action where present; close by successful response; inspect returned focus and serious/critical accessibility findings.
- **Expected result:** Focus starts inside the modal and remains contained; each method has a documented cancellation path; closure returns focus to the invoking or composer control; there are no serious or critical Axe violations. If Escape/backdrop intentionally do nothing, the explicit control and accessible instructions make that clear.
- **Priority:** P2
- **Device or environment:** macOS arm64, mounted Electron renderer with keyboard and Axe tooling.
- **Evidence:** **Code-established gap.** `packages/desktop/src/renderer/ui/molecules/ModalShell.svelte:39-65` only handles Escape when `cancelable`/`onclose` is supplied; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:3150` supplies neither and select has no Cancel control. The passing Agent Hub modal Axe check does not open an extension modal. Missing mounted-modal verification is linked to [`CHAT-001`](../bug-triage.md#chat-001--an-extension-request-can-be-lost-after-switching-chats).
- **Result:** blocked

## ERN-07 — Apply immediate extension methods to the intended surface

**Observable claim:** Immediate methods update only their intended local surface: editor text replaces the composer draft, widget text appears by the composer, and status/title methods either render explicitly or report unsupported behavior.

- **Setup:** A mounted Electron fixture that emits `set_editor_text`, `setWidget`, `setStatus`, and `setTitle` with recognizable values while the composer already contains a draft.
- **Steps:** Emit each method separately; inspect composer text, widget status, visible chrome, transcript, and error feedback.
- **Expected result:** `set_editor_text` visibly replaces the draft; `setWidget` visibly replaces the composer widget; no method adds an approval to the transcript; `setStatus` and `setTitle` have an explicit user-visible effect or an explicit unsupported response rather than silently disappearing.
- **Priority:** P3
- **Device or environment:** macOS arm64, mounted Electron renderer with a controllable extension fixture.
- **Evidence:** **Code-established** draft/widget behavior and a visibility gap in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2425-2429,2679`. No rendered use of `extensionStatus` or `extensionTitle` was found, and no executed journey covers these methods.
- **Result:** blocked

## ERN-08 — Open an allowed external URL and finish locally

**Observable claim:** An `open_url` request uses the safe external-link path and reports the extension interaction as cancelled after the browser handoff.

- **Setup:** A mounted Electron fixture that emits one allowed HTTPS URL and one rejected URL and records extension responses.
- **Steps:** Issue the allowed URL; observe the external-open request and response. Issue the rejected URL; inspect error feedback and response state.
- **Expected result:** The allowed URL opens externally and the extension receives `cancelled: true`; the rejected URL does not open and OMP Chat shows **Action failed** without falsely completing the request.
- **Priority:** P3
- **Device or environment:** macOS arm64, mounted Electron renderer with external opening intercepted and a deterministic extension fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2430-2433` and the safe external-URL boundary in `packages/desktop/src/main/guards.ts:45-55`. No executed Electron extension journey covers `open_url`.
- **Result:** blocked

## ERN-09 — Replace and dismiss singleton notifications

**Observable claim:** A later extension notification replaces the current in-app notice, and manual dismissal removes the visible notice without creating notification history.

- **Setup:** A mounted Electron fixture that emits two distinguishable notifications in sequence.
- **Steps:** Emit the first notice; emit the second before dismissing; inspect the toast surface and transcript; dismiss the second; look for a notification center or recoverable first notice.
- **Expected result:** Only the second notice remains visible; neither notice appears as a transcript approval; dismissal clears the toast; no notification center or prior-notice history is exposed.
- **Priority:** P3
- **Device or environment:** macOS arm64, mounted Electron renderer with sequential extension notifications.
- **Evidence:** Manual dismissal is **Observed and Tested** by `packages/desktop/e2e/desktop.spec.ts:1784-1802`, **“renders semantic transcript messages.”** Replacement and absence of history are **Code-established** by the singleton notice state and toast rendering in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:120,2426,2476-2482,3148`; the executed journey emitted only one visible warning.
- **Result:** blocked

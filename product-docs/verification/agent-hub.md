# Agent Hub verification

**Feature:** [`../features/agent-hub.md`](../features/agent-hub.md)  
**Document status:** drafted  
**Evidence date:** 2026-08-25  
**Revision boundary:** working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop files may be modified or untracked.

## AH-01 — Open and close the chat-scoped inspector

**Observable claim:** Opening Agent Hub shows the active chat's retained-agent roster, and closing it returns focus to the Agent Hub header control.

- **Setup:** Launch the fixture-backed Electron app with `GRADIVUS_TIMELINE_FIXTURE=1`, open the fixture inspector chat, and leave the normal OMP Chat composer focused.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Steps:** Activate **Open Agent Hub**; inspect the roster and selected detail; activate **Close Agent Hub session**; reopen Agent Hub and press Escape.
- **Expected result:** The inspector exposes an **Agents in this chat** roster and selected participant detail. Both close actions hide the inspector and return focus to the Agent Hub header control without changing the conversation transcript.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and deterministic chat RPC fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1513-1560`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## AH-02 — Review a retained transcript

**Observable claim:** Selecting a retained agent opens its bounded transcript in a separately labelled Agent Hub log.

- **Setup:** Use the same fixture chat with **Fixture Verifier** retained in Agent Hub.
- **Steps:** Open Agent Hub; select **Fixture Verifier**; inspect the participant detail and transcript region.
- **Expected result:** The detail identifies **Fixture Verifier**, and a log labelled **Fixture Verifier transcript** contains the retained collaboration transcript without replacing or navigating the main conversation transcript.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and deterministic chat RPC fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1542-1556`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run. Message bounding is additionally **Code-established** by `packages/desktop/src/renderer/ui/organisms/AgentHubPanel.svelte:21-113,261-304`.
- **Result:** pass

## AH-03 — Revive and message a parked agent

**Observable claim:** A parked writable agent can be revived and then receives a focused message through Agent Hub.

- **Setup:** Open Agent Hub in the fixture chat and select parked **Fixture Verifier**.
- **Steps:** Activate **Revive agent**; enter `Check the activity summary.` in **Message Fixture Verifier**; activate **Send message**.
- **Expected result:** The participant changes to `idle`; the message composer is available; after sending, Agent Hub shows `Received: Check the activity summary.` in the participant transcript.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and deterministic chat RPC fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1561-1572`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## AH-04 — Confirm kill and retain aborted history

**Observable claim:** Confirming **Kill agent** aborts a mutable agent but preserves its transcript as read-only history.

- **Setup:** Select the revived **Fixture Verifier** after AH-03.
- **Steps:** Activate **Kill agent**; accept the native confirmation; inspect the roster state, detail notice, transcript, and available actions.
- **Expected result:** The native confirmation states that the transcript remains available as history. After acceptance, the roster identifies the participant as `aborted`/**History**, the transcript remains reviewable, and message, revive, and kill actions are unavailable.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and deterministic chat RPC fixture with Playwright accepting the native dialog.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1573-1576`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run. Confirmation and read-only transition are **Code-established** by `packages/desktop/src/renderer/ui/organisms/AgentHubPanel.svelte:152-166,229-258`.
- **Result:** pass

## AH-05 — Keep advisors read only

**Observable claim:** An advisor transcript can be reviewed but cannot receive messages or lifecycle actions.

- **Setup:** Open Agent Hub in the fixture chat and select **Fixture Advisor**.
- **Steps:** Inspect the advisor label, transcript notice, message fields, and lifecycle controls.
- **Expected result:** The detail says the advisor is read only; no **Message Fixture Advisor** field is present; revive and kill controls are absent; its transcript remains available for review.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer and deterministic chat RPC fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1577-1581`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## AH-06 — Mark unseen participant activity unread

**Observable claim:** Activity for a participant not selected in the open Agent Hub creates a participant unread marker and increments the Agent Hub header count until reviewed.

- **Setup:** A fixture or live local OMP chat with at least two retained agents that can emit independently timed progress updates.
- **Steps:** Open Agent Hub; select agent A; cause agent B to update; inspect agent B and the Agent Hub header; select agent B; close and reopen Agent Hub.
- **Expected result:** Agent B receives an unread marker and the header count increases while A is selected. Selecting B clears B's marker; opening Agent Hub clears the chat's unread set.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a controllable multi-agent OMP fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2014-2051,2093-2105,2154-2165`. The executed Electron fixture did not assert unread dots or counts.
- **Result:** blocked

## AH-07 — Refresh and page a retained transcript

**Observable claim:** Refreshing a retained transcript appends the next retained page without duplicates, unless the runtime explicitly resets the loaded transcript.

- **Setup:** A retained agent transcript larger than one Agent Hub message page.
- **Steps:** Select the agent; load its transcript; activate **Refresh transcript**; cause or request another page; compare role-and-text order and duplicates.
- **Expected result:** Ordinary refresh pages append once in order from the current retained byte position. A response explicitly marked as a reset replaces the loaded messages. Loading and error states remain within the selected participant's transcript region.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a deterministic paged retained-agent transcript.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2065-2090` and `packages/desktop/src/renderer/ui/organisms/AgentHubPanel.svelte:261-304`. No executed Electron journey used a multi-page retained transcript.
- **Result:** blocked

## AH-08 — Keep Agent Hub detail separate from the conversation transcript

**Observable claim:** Agent lifecycle/progress updates change Agent Hub without inserting the retained agent's detailed transcript into the main conversation transcript.

- **Setup:** A fixture agent that emits lifecycle, progress, retained messages, and an optional Hub tool or delegated-work summary.
- **Steps:** Record the main transcript; open Agent Hub; let the agent progress and emit retained messages; compare both surfaces.
- **Expected result:** Detailed retained messages appear only in Agent Hub. The main transcript may show a Hub tool row or semantic dispatch/completion summary, but not a duplicate of the retained transcript.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with a controllable agent lifecycle fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/main/desktop-host.ts:1380-1394` and the transcript/Agent Hub routing described in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2342-2351`. The executed journey did not assert absence of detailed agent messages from the main transcript.
- **Result:** blocked

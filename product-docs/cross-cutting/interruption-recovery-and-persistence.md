# Interruption, recovery, and persistence

## Scope

This document defines behavior shared whenever an OMP Chat interaction is completed, cancelled, interrupted, resumed, or reconstructed after relaunch. It covers ownership across chat switches, immediate and delayed failures, **Stop**, OMP-chat **Reconnect**, automatic workspace-runtime reconnection, app exit, and the boundary between durable history and live-only interface state. Detailed controls remain with the owning feature documents.

## Ownership rules

The first recovery rule is that work returns to the container that admitted it.

| State or artifact | Owner | Boundary | Externally observable rule | Evidence |
| --- | --- | --- | --- | --- |
| Active turn and its completion | Originating chat session | OMP process plus renderer correlation | Switching chats does not stop the turn. Completion stays in the originating chat and the rail can mark it unseen. | **Tested:** `packages/desktop/e2e/desktop.spec.ts:1702-1706`, **“keeps background completion attached to its originating chat”**, passed in the 24-test Electron journey. **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2294-2433`. |
| Canonical conversation transcript | OMP session | OMP JSONL history | Opening or resuming a chat reconstructs saved history; the first view is a bounded tail with older-page loading. | **Code-established:** `packages/desktop/src/main/desktop-host.ts:360-390,1090-1203`; `packages/desktop/src/main/transcript-store.ts:5-173`. |
| Pending turn input | Originating chat session | Live request correlation | Prompt failure restores the submitted input and does not overwrite a newer draft or newly staged files. | **Tested:** `packages/desktop/e2e/desktop.spec.ts:1148-1209`, **“restores and retries an attachment-only prompt after immediate failure”** and **“preserves newer draft and newly staged files across delayed prompt failure”**. |
| Draft text | One renderer-local composer | Renderer lifetime | Current code carries the draft to the chat selected next, but does not preserve it across process exit. This ownership is not a settled product rule. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:625-730`. **Decision required:** [`CHAT-006`](../bug-triage.md#chat-006--draft-and-attachment-ownership-diverge-on-chat-switches). |
| Staged attachments | Selected chat session | Temporary attachment store | A successful chat/workspace boundary releases visible staged files; cancelling the workspace chooser preserves them. Late staging releases itself rather than entering the new chat. | **Tested:** `packages/desktop/e2e/desktop.spec.ts:1210-1269,1343-1383`. See [Attachments](../features/attachments.md). |
| Timeline follow and open disclosures | Selected chat in the renderer | Renderer lifetime | Scrolling one chat up does not pause another chat, but follow position and disclosure-open state are not established as durable after relaunch. | **Tested:** `packages/desktop/e2e/desktop.spec.ts:1459-1511`, **“keeps timeline activity paused while reading history and renders bounded file summaries”**. **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:473-535,769-838`. |
| Extension request | Chat that issued the request | Outstanding live request | It is modal and blocks OMP until answered or cancelled; it is not transcript history. A request arriving after the user switches chats can currently be lost. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2206-2275,2340-2433`; `packages/desktop/src/main/desktop-host.ts:1504-1538`. **Suspected:** [`CHAT-001`](../bug-triage.md#chat-001--an-extension-request-can-be-lost-after-switching-chats). |
| Application-setting mutation | Local installation | Machine-local settings file | Closing Settings does not cancel a queued write. Success survives relaunch; failure retains the old snapshot and reports an error. | **Code-established:** `packages/desktop/src/renderer/ui/pages/App.svelte:174-271`; `packages/desktop/src/main/app-settings.ts:103-174`. |
| Browser selection delivery | Originating browser card with an explicit target chat | Host-owned in-flight request | Success or error stays in the browser card until the user closes it; reporting waits for fixture acceptance. | **Tested:** `packages/desktop/e2e/omp-selection.spec.ts:743-791`, **“Send to Chat reports only after fixture acceptance and closes cleanly”** and **“inline result and delivery error stay in the card until Close”**. |

The split draft/attachment behavior is intentionally documented as unresolved rather than normalized into a guarantee.

## Completion, cancellation, and error matrix

| Interaction | Clean completion | Explicit cancel or Stop | Error or interruption | What remains reviewable |
| --- | --- | --- | --- | --- |
| Primary message | Canonical user, reasoning/tool activity, and assistant outcome remain in the conversation transcript; live controls disappear. A local command may complete without invoking the agent. | Successful **Stop** keeps the submitted user entry, removes the optimistic reasoning placeholder, restores pending attachments, and shows **Turn stopped**. The mounted Stop result is not covered by a passing Electron journey. | A start/delivery failure rolls back optimistic entries, restores original input before newer input, and shows a prompt recovery card plus error feedback. OMP process loss moves the chat to an error state with **Reconnect**. | Transcript history is durable when OMP recorded it; recovery-card and toast state are live UI. Sources: `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1109-1319,2316-2340,2594-2680`. |
| Steering message | Admission feedback appears and the active turn continues. | There is no separate cancel-after-admission action. Stopping the turn uses the primary **Stop** path. | Admission failure restores the steering draft and attachments for another attempt. | Successful steering becomes part of the originating chat's runtime history. Attachment release timing after success is unresolved in [`CHAT-007`](../bug-triage.md#chat-007--successful-steer-and-queue-attachments-remain-retained). |
| Queued follow-up | The message waits for the next turn and remains owned by the originating chat. | There is no documented queue editor or remove action after admission. | Failed admission produces dismissible error feedback and supports another attempt with the retained input. | Exact transport and teardown cleanup passed in `packages/desktop/e2e/desktop.spec.ts:1303-1342`, **“queues exact follow-up attachments and cleans retained files on teardown”**. |
| Attachment staging | Accepted files become removable chips; invalid batches are rejected atomically. | Picker cancellation changes nothing. Removing a chip releases it; release failure restores the chip. | A staging, size, count, or quota error leaves previously admitted chips and draft intact. A successful chat boundary releases staged files. | Temporary bytes are not conversation history. See `packages/desktop/e2e/desktop.spec.ts:975-1147,1210-1269,1343-1383`. |
| Extension request | A valid response closes the modal and lets OMP continue. | Explicit **Cancel** returns a negative/empty response where the request type supports it. Extension dialogs do not establish backdrop or Escape cancellation. | Response failure shows **Action failed** and leaves the request pending. Switching chats, renderer loss, or exit can lose the live-only request. | No normal transcript entry records the question or answer. See `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2206-2275,2421-2433,3147-3150`. |
| Application-setting mutation | The persisted snapshot is applied and Settings reports the updated label. | Closing Settings is navigation, not rollback. Reset writes a new default snapshot rather than undoing history. | The old snapshot remains and an error is shown. A later serialized mutation can replace earlier status copy. | The saved settings value survives relaunch; the saving/success/error message does not. See `packages/desktop/src/renderer/ui/pages/App.svelte:174-271`; `packages/desktop/src/main/app-settings.ts:136-174`. |
| Provider/account action | OMP returns a new provider/account snapshot after sign-in, sign-out, lock, failover, or removal. | Browser sign-in/private steps expose explicit cancellation; removal requires native confirmation. | Runtime/provider errors remain action feedback, not an offline queue. Lock/failover outcome under an unavailable account is open. | Account identity and status can be shown; credentials remain in the local OMP runtime. See `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1640-1735,2206-2275,3051-3144`. |
| Browser selection delivery | Accepted delivery is reported in the originating browser card and the target chat receives the work. | Closing the card ends the review surface after a result. Pending cancellation semantics are not established. | Inline or delivery failure stays in the card until **Close**. | The browser card owns delivery feedback; any accepted chat result belongs to the target chat. See `packages/desktop/e2e/omp-selection.spec.ts:743-791`. |
| Local terminal drawer | Hide/show and ordinary renderer reload can replay from the retained byte offset without adding shell traffic to the conversation transcript. | Exiting or explicitly closing the shell ends that PTY; switching chats closes the visible drawer. | Shell startup/stream failures use drawer-local feedback. Workspace-client replacement resubscribes from the retained offset. | Terminal replay is separate from conversation history. See `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:1-217`; `packages/desktop/test/workspace-host-reconnect.test.ts:89-145`. |

## Relaunch: what returns and what is lost

### Returns after a successful save

- Chat-session records, their local folders, titles, timestamps, active pointers, OMP session identifiers, and resume files are read from the desktop session registry. Saved records begin as dormant runtimes; opening one starts or resumes OMP (`packages/desktop/src/main/session-registry.ts:18-115,138-182`; `packages/desktop/src/main/desktop-host.ts:217-220,360-390`).
- OMP reconstructs durable conversation history from its session file. Gradivus presents a bounded latest slice and can page older entries (`packages/desktop/src/main/desktop-host.ts:386-408,1191-1220`).
- Application settings survive relaunch after their write succeeds (`packages/desktop/src/main/app-settings.ts:103-174`).
- Workspace-authority browser and terminal records are durable through the local workspace runtime. This is separate from OMP Chat's own chat registry.

### Live-only state is not established as durable

- unsubmitted draft text;
- staged attachment chips and their temporary store ownership after full teardown;
- toast notifications and action-error messages;
- an open prompt recovery card once the renderer/runtime is reconstructed;
- pending extension dialogs and their outstanding question;
- open Reasoning, transcript, or diff disclosures;
- renderer-local timeline follow/unseen intent;
- current focus and modal state; and
- an in-progress setting status message after the underlying mutation has already succeeded or failed.

**Inference:** after a hard renderer or app loss, only entries returned by OMP history and state returned by durable stores can be reconstructed. The passing Electron journeys did not relaunch with a draft, active turn, pending extension request, or open disclosure, so this consequence remains unobserved.

Registry corruption is handled below the UI by preserving the invalid file under a corrupt-file name and starting from a repaired/empty state, and the recovery warning is surfaced as a one-time **Recovery warning** toast after the window finishes loading (`packages/desktop/src/main/session-registry.ts:30-70`; `packages/desktop/src/main/desktop-host.ts:215-229`; `packages/desktop/src/main/main.ts:356-362`).

## Reconnect is two different recoveries

> Technical note: **Reconnect** in OMP Chat resumes one errored OMP chat from its saved OMP session file. Automatic workspace-runtime reconnection replaces the local authority client used by the outer workspace shell. They do not have the same state, controls, or evidence.

### Errored OMP chat

Unexpected child-process or RPC loss changes the chat to error, rolls back a pending optimistic turn, and presents **Runtime stopped unexpectedly** with **Reconnect**. Reconnect calls resume and requires a saved, non-empty OMP session file (`packages/desktop/src/main/rpc-process.ts:215-238,287-324`; `packages/desktop/src/main/desktop-host.ts:371-389`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:874-889,2316-2325,2594`).

No passing mounted Electron journey forced this failure and activated **Reconnect**. Whether partial assistant/tool output, staged input, and repeated reconnect attempts converge without duplication remains open.

### Workspace runtime

Unexpected authority-client loss triggers bounded automatic attempts: a transient **Reconnecting to the workspace runtime…** notice while retrying, **Workspace runtime disconnected** after an unexpected loss, and — after ten failed attempts with capped backoff — the persistent **Workspace runtime unreachable** error with **Retry** and dismiss controls. Terminal resubscription retains its byte offset (`packages/desktop/src/main/runtime-reconnect.ts`; `packages/desktop/src/renderer/ui/pages/App.svelte`; test-specified `packages/desktop/test/runtime-reconnect.test.ts:26-84`, `packages/desktop/test/workspace-host-reconnect.test.ts:89-145`).

Rendering of this ladder was the resolved defect [`CHAT-002`](../bug-triage.md#chat-002--workspace-reconnect-and-outer-shell-errors-are-not-rendered): the shell previously computed reconnect and action-error messages without rendering them. The unit suite now proves the emission sequence; a mounted Electron journey that severs the runtime and observes the full ladder remains open (see [OMP runtime connection](../features/omp-runtime-connection.md)).

## Owning feature documents

- Chat creation, switching, resume, dormant runtimes, rename, and session-level stop: [Workspaces and chat sessions](../features/workspaces-and-chat-sessions.md).
- Primary turns, Steer, Queue, Stop, rollback, and Retry: [Composing and controlling turns](../features/composing-and-controlling-turns.md).
- Temporary input ownership and cleanup: [Attachments](../features/attachments.md).
- Durable transcript, bounded history, follow state, and background completion: [Reviewing the conversation transcript](../features/reviewing-the-conversation-transcript.md).
- Ephemeral blocked input and toast feedback: [Extension requests and notifications](../features/extension-requests-and-notifications.md).
- Terminal replay and process lifetime: [Local terminal drawer](../features/local-terminal-drawer.md).
- Settings/account persistence and action lifecycles: [Settings and provider accounts](../features/settings-and-provider-accounts.md).
- Browser-owned delivery feedback: [Browser selection to chat](../features/browser-selection-to-chat.md).

## Revision and evidence limits

- Source revision: working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources may be modified or untracked relative to that commit.
- Evidence date and environment: 2026-08-25, macOS arm64.
- Runtime evidence: `desktop.spec.ts` **24/24 passed**, `omp-selection.spec.ts` **8/8 passed**, and `real.spec.ts` **1/1 passed** in real Electron windows. The specific passing journeys are named above.
- Separate test evidence: the package-level `bun run test` failed; source-only unit assertions and copied harnesses are **test-specified**, not passing evidence.
- Evidence limits: no passing mounted journey activated Stop, forced OMP-chat Reconnect, exhausted workspace-runtime reconnect, relaunched with live-only state, or preserved a pending extension request through navigation/exit. Those behaviors remain **Code-established**, **Inference**, or **Open question** as labelled and are linked to [`bug-triage.md`](../bug-triage.md).

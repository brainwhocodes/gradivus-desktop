# Attachment verification

## Summary

**Feature status: Drafted.** These checks verify the user-visible attachment contract in [Attachments](../features/attachments.md). A `pass` below is backed by an executed mounted Electron journey from the reported macOS arm64 `desktop.spec.ts` **24/24 passed** run. Source-only and unit-only assertions remain `blocked`, even when the implementation is clear. The working tree is anchored at `c125341133ff90a29fe266e1b166bac0183338c8` on evidence date 2026-08-25; relevant desktop files may be modified or untracked.
The exact documented ceilings are **512 KiB inline text**, **16 MiB spilled prompt**, **25 MiB file**, **20 MiB image**, **32 MiB batch**, **12 items**, and **64 MiB retained store**.

## ATT-01 — An attachment-only primary request is admitted

- **Setup:** Open a ready OMP Chat fixture session with an empty **Message OMP** composer.
- **Steps:** Use **Attach** to choose a small text file and a PNG-signature file; remove and re-add the text file; leave the composer empty; press Enter.
- **Expected result:** **FILE** and **IMG** chips appear before submission; the empty-text submission is admitted once; both chips clear; the primary route receives one generic file reference and one native image; temporary files are removed after successful completion.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with the deterministic OMP fixture.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:975-1019`, exact test **“stages picker files with exact native transport and supports attachment-only send”**, in the executed 24/24 passing run.
- **Result:** `pass`

## ATT-02 — Content determines FILE versus IMG routing

- **Setup:** Open a ready fixture chat and prepare one ordinary text payload plus PNG bytes named `screen.dat` and declared `text/plain`.
- **Steps:** Stage both files and submit them.
- **Expected result:** The ordinary payload is shown/routed as **FILE** through an absolute temporary-file reference; the PNG-signature payload is shown/routed as **IMG** with byte-exact `image/png` native image content, regardless of extension and declared MIME type.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with attachment capture enabled.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:975-1019`; capture assertions at `:1005-1014` verify route, envelope kinds, absolute reference, byte count, SHA-256, MIME, base64 validity, and cleanup. Code routing is in `packages/desktop/src/main/prompt-attachments.ts:40-75,100-135`.
- **Result:** `pass`

## ATT-03 — Text larger than 512 KiB becomes one PROMPT attachment

- **Setup:** Open a ready fixture chat; prepare composed UTF-8 plain text of 512 KiB plus one byte, including text before and after the insertion point.
- **Steps:** Paste the middle segment as `text/plain`, confirm the chip, submit, then separately fill another 512-KiB-plus-one draft programmatically.
- **Expected result:** The complete composed value becomes one **PROMPT** chip named **Pasted prompt**; the composer does not embed the oversized body; submission routes a byte-exact absolute prompt reference as the complete request; successful completion removes the chip and temporary file; programmatic oversized text follows the same staging path and remains removable.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic attachment capture.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1058-1103`, exact test **“spills oversized pasted and programmatic text without embedding it”**, in the executed 24/24 passing run.
- **Result:** `pass`

## ATT-04 — Thirteen items are rejected while twelve items are admitted

- **Setup:** Open a ready fixture chat with no staged items and prepare 13 one-byte files.
- **Steps:** Select all 13 in one batch; then select exactly 12 one-byte files; with those 12 present, attempt to spill a 512-KiB-plus-one draft.
- **Expected result:** The 13-item batch adds no chip and announces **You can attach up to 12 files.** Exactly 12 chips are admitted. A PROMPT spill attempted as a thirteenth item is rejected without changing the 12 chips or draft.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with the deterministic fixture.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1105-1146`, especially `:1115-1118,1135-1141`, exact test **“rejects attachment count, size, image, cumulative, and spill limits atomically”**.
- **Result:** `pass`

## ATT-05 — A file above 25 MiB is rejected atomically

- **Setup:** Open a ready fixture chat with no staged items and prepare a generic file of 25 MiB plus one byte.
- **Steps:** Choose the file with the attachment input.
- **Expected result:** OMP Chat announces that the named file exceeds the **25 MiB attachment limit**, adds no chip, and leaves prior composer content unchanged.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with fixture-generated bytes.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1119-1121` inside **“rejects attachment count, size, image, cumulative, and spill limits atomically”** in the executed 24/24 passing run.
- **Result:** `pass`

## ATT-06 — An image above 20 MiB is rejected atomically

- **Setup:** Open a ready fixture chat and prepare PNG-signature content totaling 20 MiB plus one byte, with a misleading generic filename and MIME type.
- **Steps:** Choose the payload as an attachment.
- **Expected result:** Byte inspection classifies it as an image, announces **image attachment exceeds 20 MiB**, and adds no chip.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with fixture-generated bytes.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1125-1128` inside the executed exact test **“rejects attachment count, size, image, cumulative, and spill limits atomically”**.
- **Result:** `pass`

## ATT-07 — A staged batch above 32 MiB is rejected atomically

- **Setup:** Open a ready fixture chat; prepare two 17-MiB files, then separately stage one valid 20-MiB file and prepare a 13-MiB addition.
- **Steps:** Select the two 17-MiB files together; then stage the 20-MiB file and attempt to add the 13-MiB file.
- **Expected result:** Both over-32-MiB attempts announce **Attachments exceed the 32 MiB batch limit.** The first attempt adds nothing; the second preserves the already admitted 20-MiB chip and adds none of the rejected batch.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with fixture-generated bytes.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1122-1124,1129-1134` inside **“rejects attachment count, size, image, cumulative, and spill limits atomically”**.
- **Result:** `pass`

## ATT-08A — Exactly 512 KiB of UTF-8 text remains inline

- **Setup:** In separate clean chats, prepare composed UTF-8 values of exactly 512 KiB and 512 KiB plus one byte, including a multibyte boundary case.
- **Steps:** Submit each value through the mounted composer and inspect chips plus captured primary transport.
- **Expected result:** Exactly **512 KiB inline text** is sent without a PROMPT chip; the next byte stages one **Pasted prompt** instead of embedding the body; byte count, not character count, controls the boundary.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic UTF-8 generation and attachment capture.
- **Evidence:** **Blocked.** The passing journey verifies the 512-KiB-plus-one spill but not exact-512-KiB inline admission or a multibyte boundary (`packages/desktop/e2e/desktop.spec.ts:1058-1103`). Enforcement is **Code-established** in `packages/desktop/src/shared/contracts.ts:8` and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1010-1057`. Unit-only evidence cannot pass this item; package unit execution is blocked under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-08B — Exactly 16 MiB is the spilled-PROMPT ceiling

- **Setup:** In separate clean chats, prepare oversized UTF-8 prompt values of exactly 16 MiB and 16 MiB plus one byte, each within the current count and visible-batch allowance.
- **Steps:** Stage each value through the mounted composer and inspect chip, live status, captured prompt reference, and temporary-store contents.
- **Expected result:** Exactly **16 MiB spilled prompt** is admitted as one **Pasted prompt**; the next byte is rejected atomically with **prompt text exceeds 16 MiB** and leaves no partial chip or file.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic UTF-8 generation and filesystem inspection.
- **Evidence:** **Blocked.** The executed Electron spill is only slightly above 512 KiB (`packages/desktop/e2e/desktop.spec.ts:1058-1103`). The 16-MiB boundary is **Code-established** in `packages/desktop/src/shared/contracts.ts:9` and `packages/desktop/src/main/prompt-attachments.ts:78-97`. Unit-only evidence cannot pass this item; package unit execution is blocked under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-08C — Exactly 25 MiB is admitted for a generic file

- **Setup:** Prepare non-image files of exactly 25 MiB and 25 MiB plus one byte in separate clean chats.
- **Steps:** Stage each through the mounted picker or file drop and inspect chips, live status, and temporary-store contents.
- **Expected result:** Exactly **25 MiB file** content is admitted as **FILE**; the next byte is rejected atomically with the 25-MiB limit message.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic non-image bytes and sufficient temporary disk space.
- **Evidence:** **Blocked.** Rejection at 25 MiB plus one byte passes (`packages/desktop/e2e/desktop.spec.ts:1119-1121`), but exact-25-MiB acceptance is not exercised. The accepted boundary is **Code-established** in `packages/desktop/src/shared/contracts.ts:10` and `packages/desktop/src/main/prompt-attachments.ts:181-211`. Package unit execution is blocked under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-08D — Exactly 20 MiB is admitted for a recognized image

- **Setup:** Prepare valid supported-image bytes of exactly 20 MiB and 20 MiB plus one byte in separate clean chats.
- **Steps:** Stage each through the mounted picker or file drop and inspect chip kind, live status, native-image capture, and temporary-store contents.
- **Expected result:** Exactly **20 MiB image** content is admitted as **IMG** and routed natively; the next byte is rejected atomically with the 20-MiB image message.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic valid image bytes and attachment capture.
- **Evidence:** **Blocked.** Rejection at 20 MiB plus one byte passes (`packages/desktop/e2e/desktop.spec.ts:1125-1128`), but exact-20-MiB acceptance is not exercised. The accepted boundary is **Code-established** in `packages/desktop/src/shared/contracts.ts:11` and `packages/desktop/src/main/prompt-attachments.ts:40-75`. Package unit execution is blocked under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-08E — Exactly 32 MiB is admitted as the visible batch

- **Setup:** Prepare one or more individually valid items totaling exactly 32 MiB and another set totaling 32 MiB plus one byte in separate clean chats.
- **Steps:** Stage both batches through the mounted picker or file drop and inspect chip count, live status, and temporary-store contents.
- **Expected result:** Exactly **32 MiB batch** content is admitted atomically; the next byte is rejected atomically with the 32-MiB batch message and creates no partial chip or file.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic bytes and sufficient temporary disk space.
- **Evidence:** **Blocked.** Over-limit rejection passes (`packages/desktop/e2e/desktop.spec.ts:1122-1134`), but exact-32-MiB acceptance is not exercised. The accepted boundary is **Code-established** in `packages/desktop/src/shared/contracts.ts:12` and `packages/desktop/src/main/prompt-attachments.ts:100-135,181-211`. Package unit execution is blocked under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-09 — Rejected staging leaves the existing batch unchanged

- **Setup:** Open a ready fixture chat, stage one valid 20-MiB file, and prepare an incoming file that would take the visible batch above 32 MiB.
- **Steps:** Attempt the addition, inspect chips, remove the existing file, then stage 12 small files and attempt an oversized PROMPT spill.
- **Expected result:** Every invalid incoming batch adds zero chips and preserves every previously admitted chip plus the draft; removal remains available afterward.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1105-1146`, exact test **“rejects attachment count, size, image, cumulative, and spill limits atomically”**.
- **Result:** `pass`

## ATT-10 — Immediate primary failure restores an attachment-only request for exact retry

- **Setup:** Launch a ready fixture chat configured to reject the next primary request immediately; stage one text file and leave the composer empty.
- **Steps:** Press Enter, inspect the recovery card and chip, activate **Retry**, then inspect the second captured request and temporary path.
- **Expected result:** Failure shows the recovery card; the same chip and Retry action are available; Retry reuses the same staged path and byte hash exactly once; successful retry clears the chip and removes the temporary file.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with immediate fixture rejection and attachment capture.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1148-1174`, exact test **“restores and retries an attachment-only prompt after immediate failure”**.
- **Result:** `pass`

## ATT-11 — Delayed primary failure restores original input before newer input

- **Setup:** Launch a fixture chat configured to reject the next primary request after admission; stage `original.md`, enter `original request`, and submit.
- **Steps:** While the turn is pending, enter `newer draft` and stage `new.md`; wait for failure; inspect the composer and chip order; activate Retry.
- **Expected result:** Text restores as `original request`, a blank line, then `newer draft`; chips restore as `original.md` before `new.md`; Retry transmits both files in that order; successful completion clears both chips and releases both paths.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with delayed fixture rejection.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1175-1208`, exact test **“preserves newer draft and newly staged files across delayed prompt failure”**.
- **Result:** `pass`

## ATT-12 — Local-only completion leaves staged attachments available

- **Setup:** Open a ready fixture chat, stage `local.md`, and enter `/status`.
- **Steps:** Submit the command, inspect command output and the attachment chip, remove the chip with the keyboard, and inspect the temporary store.
- **Expected result:** The local command output appears while `local.md` remains staged; keyboard removal removes its chip and temporary path without starting an attachment-consuming agent turn.
- **Priority:** P2
- **Device or environment:** Mounted Electron on macOS arm64 with the deterministic local-command fixture.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1210-1244`, exact test **“retains local-command attachments and isolates session switching”**.
- **Result:** `pass`

## ATT-13 — A successful chat-session boundary releases visible and late attachments

- **Setup:** Open two fixture chats; stage one file in chat A, and separately begin one deliberately slow file drag in chat A.
- **Steps:** Switch to chat B and back after ordinary staging; repeat while slow staging is unresolved, resolve it after switching, then return to chat A.
- **Expected result:** The ordinary chip does not appear in chat B or return in chat A; the late staging result never appears; the attachment trigger recovers; all affected temporary files are released.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with two chat sessions and controlled slow file reading.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1210-1268`, exact tests **“retains local-command attachments and isolates session switching”** and **“releases a slow staging result at a session boundary”**. The divergence from carried draft ownership is a product decision in [CHAT-006](../bug-triage.md#chat-006--draft-and-attachment-ownership-diverge-on-chat-switch).
- **Result:** `pass`

## ATT-14 — A canceled workspace chooser preserves chips and a successful workspace change releases them

- **Setup:** Open workspace A, stage `session-a.md`, and prepare workspace B.
- **Steps:** Invoke **Create new workspace** and cancel the chooser; invoke it again and accept workspace B; submit a prompt in B and inspect capture/store state.
- **Expected result:** Canceling preserves the chip in workspace A; accepting B clears and releases it; the first primary request in B carries no reference from A.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with controlled native-dialog responses and two workspaces.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1343-1383`, exact test **“isolates attachments across successful workspace creation”**. Intended draft/attachment boundary ownership remains filed in [CHAT-006](../bug-triage.md#chat-006--draft-and-attachment-ownership-diverge-on-chat-switch).
- **Result:** `pass`

## ATT-15 — Failed Steer restores the batch once and successful Steer sends exact content

- **Setup:** Start a held active turn; configure the first Steer to fail; stage `steer.md` and `steer.png`; enter `steer with files`.
- **Steps:** Press Enter once for the failing Steer, inspect restored text/chips, then press Enter once to retry; inspect both captures and the completed transcript.
- **Expected result:** Failure restores one copy of the draft and each chip; retry routes through Steer with byte-exact native PNG content and no visible duplicate chip; the held turn completes after steering.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with held-turn and one-shot Steer rejection fixtures.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1270-1301`, exact test **“steers with exact attachments, rolls back once, and retains the admitted files”**.
- **Result:** `pass`

## ATT-16 — Successful Steer bytes are released at a defined consumption point

- **Setup:** Start a held turn, stage one generic file for Steer, admit it successfully, and keep the resident runtime alive.
- **Steps:** Observe the temporary path after admission, after the correlated Steer effect, after active-turn completion, and before teardown; then attempt enough new staging to approach the 64-MiB retained-store quota.
- **Expected result:** The product-defined consumption acknowledgement releases the successful Steer path before teardown, and its bytes stop counting toward the **64 MiB retained store** without compromising exact transport.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with attachment path capture and retained-quota inspection.
- **Evidence:** **Blocked.** The passing journey establishes exact transport and that the file remains after successful Steer (`packages/desktop/e2e/desktop.spec.ts:1270-1301`); it does not establish an earlier safe release. The unresolved lifecycle and quota consequence are filed in [CHAT-007](../bug-triage.md#chat-007--successful-steer-and-queue-attachments-remain-retained).
- **Result:** `blocked`

## ATT-17 — Failed Queue restores the batch and successful Queue cleans it on teardown

- **Setup:** Start a held active turn; configure the first follow-up to fail; stage `queue.md` and `queue.png`; enter `queue with files`.
- **Steps:** Choose **Queue for the next turn**, dismiss the error, retry Queue, wait for follow-up completion, then close the app and inspect retained paths/store contents.
- **Expected result:** Failure restores the chip and keeps Queue available; retry routes one byte-exact image and file batch; chips clear; the follow-up completes after the active turn; app teardown removes every captured retained path and empties the temporary store.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with held-turn, one-shot follow-up rejection, and filesystem inspection.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1303-1342`, exact test **“queues exact follow-up attachments and cleans retained files on teardown”**.
- **Result:** `pass`

## ATT-18 — Successful Queue bytes are released before teardown at a defined consumption point

- **Setup:** Start a held turn, successfully queue one generic-file follow-up, and keep the resident runtime alive after the follow-up completes.
- **Steps:** Observe the captured temporary path at queue admission, active-turn completion, follow-up completion, and before process teardown; attempt subsequent staging near the retained-store quota.
- **Expected result:** A defined follow-up consumption acknowledgement releases the successful Queue path and removes its bytes from the **64 MiB retained store** before teardown.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with attachment path capture and retained-quota inspection.
- **Evidence:** **Blocked.** The passing journey proves exact Queue transport and teardown cleanup but deliberately observes the path retained before teardown (`packages/desktop/e2e/desktop.spec.ts:1303-1342`). The lifecycle decision is filed in [CHAT-007](../bug-triage.md#chat-007--successful-steer-and-queue-attachments-remain-retained).
- **Result:** `blocked`

## ATT-19 — Store-wide retained quota rejects the byte that exceeds 64 MiB without damaging retained items

- **Setup:** In one resident chat runtime, create admitted-but-retained batches totaling exactly 64 MiB using successful Steer/Queue lifetimes, then prepare one additional byte while preserving identifiers for every retained item.
- **Steps:** Stage through the exact quota, attempt the additional byte, inspect live status, existing retained paths, and ability to release/teardown cleanly.
- **Expected result:** Exactly **64 MiB retained store** remains usable; the next byte is rejected atomically with quota feedback; no existing retained item is removed or corrupted; explicit release or host teardown returns storage to zero.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with deterministic large files, filesystem inspection, and sufficient temporary disk space.
- **Evidence:** **Blocked.** The 64-MiB quota is only **Code-established** in `packages/desktop/src/main/prompt-attachments.ts:19-20,34-75,175-178`. No executed Electron journey reaches the quota. The retention mechanism that makes the quota user-relevant is filed in [CHAT-007](../bug-triage.md#chat-007--successful-steer-and-queue-attachments-remain-retained); package unit evidence is not passing evidence under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-20 — File drag status and chip removal remain accessible at narrow reduced-motion settings

- **Setup:** Launch compact density with reduced motion at 760×620; enter a draft; prepare a non-file drag, a file drag, and several very long filenames.
- **Steps:** Dispatch non-file drag, file enter/leave/drop, stage six long-name files, focus a **Remove** button, press Enter, run Axe, inspect overflow and active animations.
- **Expected result:** Non-file drag shows no overlay; file enter shows the polite **Drop files to attach** status and leave removes it; drop preserves the draft and creates chips; keyboard removal works; no document overflow or composer animation appears; Axe reports no serious/critical violations.
- **Priority:** P2
- **Device or environment:** Mounted Electron on macOS arm64, compact density, reduced motion, 760×620 viewport, synthetic DataTransfer.
- **Evidence:** **Tested** by `packages/desktop/e2e/desktop.spec.ts:1021-1056`, exact test **“keeps file drag overlay accessible and overflow-safe at narrow reduced-motion settings”**.
- **Result:** `pass`

## ATT-21 — Picker, chip, removal, and status states expose stable accessible names

- **Setup:** Open a ready fixture chat with keyboard and accessibility-tree inspection available.
- **Steps:** Focus **Attach files**, open **Choose files to attach**, stage FILE/IMG/PROMPT examples, inspect **Attached files**, status changes, and each **Remove _name_** control; remove one chip from the keyboard.
- **Expected result:** The trigger, hidden picker, chip group, and removal buttons expose their documented accessible names; drag/staging/ready/error feedback is a polite live status; visible FILE/IMG/PROMPT labels and file names/sizes remain readable without being the only removal affordance.
- **Priority:** P2
- **Device or environment:** Mounted Electron on macOS arm64 with Playwright role queries and Axe.
- **Evidence:** **Tested** for trigger/group/removal roles, keyboard removal, live drag status, narrow overflow, and no serious/critical Axe violations in `packages/desktop/e2e/desktop.spec.ts:975-1056`; **Code-established** markup is in `packages/desktop/src/renderer/ui/organisms/Composer.svelte:200-266` and `packages/desktop/src/renderer/ui/molecules/AttachmentChip.svelte:13-18`.
- **Result:** `pass`

## ATT-22 — Clipboard image/file paste has an intentional, visible contract

- **Setup:** Open a ready chat with no chips; place one image and one generic file on the system clipboard, both with and without accompanying `text/plain` data.
- **Steps:** Paste into **Message OMP** using the native clipboard and inspect draft, chips, polite status, and attachment store.
- **Expected result:** The product either stages clipboard images/files exactly like picker/drop input or clearly communicates that the channel is unsupported; it does not silently discard attachment intent or misroute binary bytes as plain text.
- **Priority:** P2
- **Device or environment:** Mounted Electron on macOS arm64 using the native clipboard rather than synthetic text-only DataTransfer.
- **Evidence:** **Blocked.** Source reads only `clipboardData.getData("text/plain")` in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1046-1057`; no mounted journey supplies clipboard files/images. This is an open product decision rather than a currently filed behavior defect.
- **Result:** `blocked`

## ATT-23 — Native picker cancellation and source/storage failures preserve the current batch atomically

- **Setup:** Open a ready chat with an existing valid chip and draft; prepare native picker cancel, an unreadable source, temporary-directory permission denial, disk-full staging, and retained-quota exhaustion.
- **Steps:** Trigger each condition separately through the native picker or Finder drag and inspect chips, draft, live status, temporary files, and control availability.
- **Expected result:** Cancel changes nothing; each failure announces one actionable attachment status, admits none of the failed incoming batch, preserves the existing chip and draft, removes partial temporary files, and returns controls to an operable state.
- **Priority:** P2
- **Device or environment:** Mounted Electron on macOS arm64 with native picker/Finder and fault-injected filesystem conditions.
- **Evidence:** **Blocked.** Atomic cleanup is **Code-established** in `packages/desktop/src/main/prompt-attachments.ts:40-75` and ordinary invalid-batch atomicity passes in `packages/desktop/e2e/desktop.spec.ts:1105-1146`, but none of these native cancellation/permission/disk conditions was executed. No specific suspected product defect is currently filed; package unit execution remains blocked under [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Result:** `blocked`

## ATT-24 — Stop restores a primary batch without duplicating or prematurely releasing it

- **Setup:** Start a primary attachment-only turn with acknowledgement held; keep the originating chat selected; prepare one accepted Stop and one rejected Stop scenario.
- **Steps:** Activate **Stop generation** during the active turn; inspect abort count, submitted user row, pending assistant row, chips, status notice, temporary paths, and live controls; repeat with abort rejection.
- **Expected result:** Accepted Stop sends one abort, retains the submitted user row, removes the pending assistant placeholder, restores exactly one copy of each primary chip, keeps its bytes available, announces **Turn stopped**, and reaches the final ready state; rejected Stop shows error without fabricating completion or losing the batch.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with controlled prompt acknowledgement and abort responses.
- **Evidence:** **Blocked.** Stop reconciliation is **Code-established** in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1226-1266`, but the executed Electron journey only verifies that Stop is present/enabled and never activates it (`packages/desktop/e2e/desktop.spec.ts:1707-1747`). No dedicated Stop triage item currently exists; this unresolved mounted verification keeps the feature Drafted.
- **Result:** `blocked`

## ATT-25 — Attach, Send, Steer, and Queue cannot target a stale chat during boundary states

- **Setup:** Prepare a non-empty draft and staged file, then move the selected chat through loading, starting, stopping, error, rapid chat switch, and successful workspace switch states.
- **Steps:** Attempt picker/drop admission and activate or press Enter for Send, Steer, and Queue at each transition; inspect IPC capture for target session identifiers.
- **Expected result:** Every control and keyboard handler rejects stale targeting; no request carries the old chat's attachment identifiers after the selection token or active chat changes.
- **Priority:** P1
- **Device or environment:** Mounted Electron on macOS arm64 with controllable runtime states, slow session opening, and IPC capture.
- **Evidence:** **Blocked.** Session-switch release and late-staging isolation pass in `packages/desktop/e2e/desktop.spec.ts:1210-1268,1343-1383`, but not every non-composable state or action handler is exercised. The suspected stale-admission risk is filed in [CHAT-005](../bug-triage.md#chat-005--send-can-remain-actionable-while-the-chat-cannot-compose).
- **Result:** `blocked`

## Evidence boundary

- **Runtime/Tested:** `packages/desktop/e2e/desktop.spec.ts` 24/24 passed on macOS arm64. Only items citing one of those mounted journeys are marked `pass`.
- **Test-specified:** `packages/desktop/test/prompt-attachments.test.ts:19-92`, `packages/desktop/test/desktop-host.test.ts:328-371`, and `packages/desktop/test/chat-progress-feedback.test.ts:289-716` are not passing evidence here. `bun run test` failed and is recorded in [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).
- **Code-established:** `packages/desktop/src/shared/contracts.ts:8-32`, `packages/desktop/src/main/prompt-attachments.ts:19-228`, `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:625-730,840-860,921-1318`, `packages/desktop/src/renderer/ui/organisms/Composer.svelte:200-318`, and `packages/desktop/src/renderer/ui/molecules/AttachmentChip.svelte:13-18`.
- **Open question:** exact accepted byte boundaries, 64-MiB mounted quota behavior, native failure conditions, clipboard images/files, Stop reconciliation, stale admission, and the final Steer/Queue consumption release point remain blocked or decision-dependent.

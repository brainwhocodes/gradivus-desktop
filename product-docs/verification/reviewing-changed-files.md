# Reviewing changed files verification

**Feature:** [`../features/reviewing-changed-files.md`](../features/reviewing-changed-files.md)  
**Document status:** drafted  
**Evidence date:** 2026-08-25  
**Revision boundary:** working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop files may be modified or untracked.

## RCF-01 — Open the active chat's Files inspector

**Observable claim:** Opening **Files** shows recent file activity owned by the active chat and closing it hides the inspector without changing the transcript.

- **Setup:** Launch the inspector fixture chat with `GRADIVUS_TIMELINE_FIXTURE=1`; complete `activity wave` and `normal streaming turn` so file activity exists.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Steps:** Activate the **Files** tab/control; inspect the heading and recent-activity list; close Files from the header; reopen it.
- **Expected result:** The inspector is headed **Files**, its **Recent file and Agent Hub activity** list includes `activity.txt` and `result.txt`, closing hides the inspector, and reopening restores the chat-scoped activity list.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with deterministic inspector/timeline fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1513-1607`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run; Files assertions are at `:1583-1593`.
- **Result:** pass

## RCF-02 — Focus a file activity in the conversation transcript

**Observable claim:** **Focus in chat** centers the originating transcript activity without pausing subsequent timeline follow.

- **Setup:** Use the open Files inspector with a visible read activity and the transcript currently following the latest entry.
- **Steps:** Activate **Focus read activity in the chat timeline**; inspect **Jump to latest**; submit `normal streaming turn`; wait for completion and measure distance from the bottom.
- **Expected result:** The originating transcript activity is brought into view, **Jump to latest** remains hidden, and the later streamed turn finishes with the transcript at the bottom.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with deterministic inspector/timeline fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1591-1599`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## RCF-03 — Open and close a text diff

**Observable claim:** Activating **Review diff** for a successful changed file opens a labelled Git diff modal with patch content and a working close action.

- **Setup:** Use the fixture Files inspector after `result.txt` has been created successfully.
- **Steps:** Activate **Review the current diff for result.txt**; inspect the dialog label and patch content; activate **Close git diff**.
- **Expected result:** A dialog labelled **Git diff for result.txt** contains `Fixture result`; closing removes the dialog without removing the Files activity or transcript entry.
- **Priority:** P1
- **Device or environment:** macOS arm64, mounted Electron renderer with deterministic current-diff fixture.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1600-1602`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls,”** passed in the 24/24 `desktop.spec.ts` run.
- **Result:** pass

## RCF-04 — Review current state rather than a historical tool snapshot

**Observable claim:** Reopening a changed file's diff after another actor changes that file shows the newer current working-tree patch, not the patch captured when the original tool completed.

- **Setup:** A fixture chat whose completed tool changes `result.txt`, plus a controllable external editor or fixture RPC that can modify the same file after tool completion.
- **Steps:** Open and record the first diff; close it; change `result.txt` outside the recorded tool event; reopen **Review diff**; compare status, counts, and patch text with both versions.
- **Expected result:** The reopened modal describes the newer workspace/Git state. It does not preserve or label the original tool-time patch as historical evidence.
- **Priority:** P2
- **Device or environment:** macOS arm64 Electron app with a writable Git workspace and deterministic post-tool external mutation.
- **Evidence:** **Code-established** by the on-demand `loadFileDiff` path in `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:734-766` and `packages/desktop/src/main/desktop-host.ts:994-1014`. The executed Electron journey opened one current fixture diff but did not mutate the file and reopen it, so the historical-versus-current distinction was not runtime-observed. This is a missing verification scenario, not a suspected defect; no bug-triage entry applies.
- **Result:** blocked

## RCF-05 — Exclude unsuccessful changes from the Files inventory

**Observable claim:** A running or failed write/edit never appears as a successful changed-file entry and never displaces the latest successful entry for the same path.

- **Setup:** A fixture chat with one successful write to `same.txt`, followed by one running edit and one failed edit to `same.txt`.
- **Steps:** Open Files after the successful write; emit the running edit; emit its failure; inspect changed-file rows and ordering after each state.
- **Expected result:** One successful `same.txt` entry remains throughout. The running/failed edits are not labelled as completed changed-file inventory and do not replace or duplicate the earlier successful entry.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with controllable tool status and file metadata events.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/organisms/FileActivityPanel.svelte:68-134` and `packages/desktop/src/shared/projection.ts:16-25`. Repository assertions in `packages/desktop/test/transcript-projection.test.ts:430-495` were not executed, and the passing Electron Files journey did not emit a failed write/edit.
- **Result:** blocked

## RCF-06 — Keep file activity previews bounded

**Observable claim:** Files limits read/write previews to 12 lines, edit previews to 40 lines, each line to 320 characters, and displayed labels to 180 characters while disclosing available read expansion.

- **Setup:** A fixture chat with a read and write over 12 lines, an edit input over 40 lines, a preview line over 320 characters, and a path over 180 characters.
- **Steps:** Open Files; count initial and expanded read lines; count write/edit lines; inspect the long line and path for visible ellipses.
- **Expected result:** Read initially shows three lines and no more than twelve after **Show N more lines**; write shows no more than twelve; edit shows no more than forty; long lines and labels are visibly bounded.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with deterministic oversized file-activity fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/organisms/FileActivityPanel.svelte:39-61,68-135,159-224`. The executed journey at `packages/desktop/e2e/desktop.spec.ts:1459-1511` observed read/write/edit summaries and preview text, but it did not assert each numerical cap or ellipsis boundary.
- **Result:** blocked

## RCF-07 — Enable transcript diff only after successful completion

**Observable claim:** A transcript file's **View diff** control stays disabled while its tool is running and after tool failure, then enables only on successful completion.

- **Setup:** A fixture tool row with a changed-file path that can transition through running, error, reset, and successful complete states.
- **Steps:** Inspect **View diff** at each state and try keyboard/pointer activation while disabled and enabled.
- **Expected result:** Running and error states expose no actionable diff. Successful complete enables the control and opens review for the path without adding a separate tool-result row.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with controllable tool lifecycle fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/organisms/TimelineEntry.svelte:138-201`, especially the disable condition at `:190-195`. No executed Electron journey inspected the same file button across lifecycle states.
- **Result:** blocked

## RCF-08 — Open a reviewed path in the workspace editor

**Observable claim:** **Open file** delegates an available reviewed path to the operating system's workspace editor behavior and surfaces a failure without closing file review.

- **Setup:** A writable fixture workspace with a known text file and an operating-system handler; also prepare an invalid or rejected target.
- **Steps:** In Files, activate **Open file** for the known path; observe the external open/reveal behavior; return and activate the invalid target.
- **Expected result:** The valid target opens or reveals through the desktop shell. A rejected target produces visible OMP Chat error feedback, while the Files inspector and transcript remain available.
- **Priority:** P3
- **Device or environment:** macOS arm64 packaged or development Electron app with controlled OS file handler behavior.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/organisms/FileActivityPanel.svelte:227-245`, `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2199-2205`, and `packages/desktop/src/main/desktop-host.ts:1017-1026`. The executed Electron Files journey did not activate **Open file**.
- **Result:** blocked

## RCF-09 — Render every non-text and failure diff state

**Observable claim:** The diff modal visibly distinguishes `clean`, `binary`, `unavailable`, and request-error outcomes.

- **Setup:** Deterministic diff fixtures returning each non-text status plus one rejected request.
- **Steps:** Open each target with **Review diff**; inspect heading, status, message, alert role, and **Open file** availability.
- **Expected result:** `clean` says **No Git changes**; `binary` says **Binary change**; `unavailable` says **No text preview** and disables **Open file**; a rejected request says **Diff unavailable** in an alert.
- **Priority:** P3
- **Device or environment:** macOS arm64 mounted Electron renderer with deterministic diff-state RPC fixtures.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/organisms/FileDiffInspector.svelte:22-62` and accepted statuses in `packages/desktop/src/main/desktop-host.ts:1878-1913`. Only the text-patch state was exercised in the passing Electron journey.
- **Result:** blocked

## RCF-10 — Disclose a capped patch without changing complete counts

**Observable claim:** A current text diff over the preview limit displays a cap notice while addition/deletion counts still describe the complete patch.

- **Setup:** A Git workspace with one file whose current patch exceeds 2,000 lines or 256 KiB and known full addition/deletion totals.
- **Steps:** Open **Review diff**; inspect rendered line count, cap notice, and summary counts; compare counts with the known full patch.
- **Expected result:** The modal renders only the bounded patch, states **Preview capped at 2,000 lines or 256 KiB. Counts cover the complete patch.**, and shows the full known addition/deletion totals.
- **Priority:** P3
- **Device or environment:** macOS arm64 Electron app with deterministic oversized Git diff fixture.
- **Evidence:** **Code-established** by `packages/desktop/src/renderer/ui/organisms/FileDiffInspector.svelte:41-61`; diff validation preserves provided full counts in `packages/desktop/src/main/desktop-host.ts:1878-1901`. No executed Electron journey used an oversized patch.
- **Result:** blocked

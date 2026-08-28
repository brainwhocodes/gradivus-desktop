# Bug triage

This file records suspected product defects and verification blockers discovered while documenting OMP Chat. A source-derived item is not presented as runtime fact until its reproduction passes. Severity measures user impact, not implementation effort.

## Status vocabulary

- **Observed:** reproduced in a running Electron application.
- **Tested:** an executable regression assertion establishes the failure.
- **Suspected:** production code contains the failure path, but the user-visible outcome has not been reproduced.
- **Decision required:** current behavior is established, but desired product behavior is unspecified.
- **Verification blocker:** the evidence pipeline cannot complete.

## CHAT-001 — An extension request can be lost after switching chats

- **Status:** **Resolved** (2026-08-25)
- **Severity:** High
- **Evidence:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2340-2433`; `packages/desktop/src/main/desktop-host.ts:1504-1538`
- **Product impact:** OMP can remain blocked waiting for a response while the user has no visible modal or recovery action.

### Reproduction

1. Open chat A and start work that produces an extension `select`, `confirm`, `input`, or `editor` request after a delay.
2. Switch to chat B before the request arrives.
3. Wait for chat A's request, then return to chat A.
4. Check whether the extension dialog appears and whether OMP can continue.

### Rationale

The renderer returns early for non-active-session events before it routes extension requests. The main process tracks only an outstanding request identifier and the chat snapshot does not replay the pending request.

### Decision needed

Choose a durable pending-request model: replay the request on chat activation, show a session-rail blocked marker, or cancel the request explicitly when its chat loses the surface. Silent loss is not acceptable.

### Resolution threshold

A mounted Electron test switches away before request arrival, returns, responds once, and observes the originating turn continue without duplicate or stranded requests.

### Resolution

Resolved 2026-08-25 by replay-on-activation. `RuntimeSession.outstandingExtensions` stores the full `RpcExtensionUIRequest`; `SessionSnapshot.pendingExtension` replays the request through `openSession`/`selectSession`, and the renderer dedupes responses by request id so a late live push cannot double-route.

**Verification:** `test/desktop-host.test.ts` covers outstanding-request exposure and consumption; Electron journey “replays a backgrounded extension request when returning to its chat” (fixture control `GRADIVUS_EXTENSION_DELAY_MS`) passes in the 26/26 `test:e2e:browser` run.

## CHAT-002 — Workspace reconnect and outer-shell errors are not rendered

- **Status:** **Resolved** (2026-08-25)
- **Severity:** High
- **Evidence:** `packages/desktop/src/renderer/ui/pages/App.svelte:563-603,650-754`
- **Product impact:** The workspace can reconnect, exhaust retries, or reject a browser action without visible feedback; the user may read the app as frozen or successful.

### Reproduction

1. Launch the Electron app with a usable workspace.
2. Interrupt the local workspace-runtime connection.
3. Observe the shell during reconnect and after retry exhaustion.
4. Trigger a rejected outer-shell browser action and check for a toast or alert.

### Rationale

The shell assigns reconnect notices and action errors to `notice` and `errorMessage`, but its markup does not render either variable. `Toast` is imported but unused in the shell.

### Decision needed

Render shell-scoped status/error feedback with a stable retry-exhausted state. Define whether successful reconnect notices persist, dismiss automatically, or enter an event history.

### Resolution threshold

An Electron test observes a visible reconnecting state, a connected recovery state, and a persistent retry-exhausted error with a recovery action.

### Resolution

Resolved 2026-08-25. Reconnect lifecycle moved into `driveRuntimeReconnect` (`src/main/runtime-reconnect.ts`), which emits `connection-state: disconnected` with `retryExhausted` after ten failed attempts. `App.svelte` renders `notice`/`errorMessage` through `Toast`: transient reconnecting notice cleared on `connected`, browser-action errors visible, and a persistent retry-exhausted error whose Retry action calls the new `GradivusApi.reconnectRuntime()` (`gradivus:runtime-reconnect`).

**Verification:** `test/runtime-reconnect.test.ts` (7 tests) proves emission including exhaustion; full `test:e2e:browser` run passes with shell feedback mounted.

## CHAT-004 — “Full” large reasoning remains truncated

- **Status:** **Resolved** (2026-08-25)
- **Severity:** Medium
- **Evidence:** `packages/desktop/src/main/desktop-host.ts:1873-1875`; `packages/desktop/src/renderer/ui/organisms/TimelineEntry.svelte:215-232`
- **Product impact:** A user explicitly asking to open the full reasoning record can still receive only a 16 KiB preview without a path to the remainder.

### Reproduction

1. Restore a chat containing a reasoning record larger than 64 KiB.
2. Open the **Reasoning** disclosure that advertises loading the full record.
3. Compare the rendered text with the stored record and look for the truncation marker.

### Rationale

The host hydrates the large record on demand, but the renderer applies a smaller display cap and labels the result as truncated for responsiveness.

### Decision needed

Either provide a complete secondary viewer/download path or relabel the control as a larger bounded preview and disclose the exact limit before activation.

### Resolution threshold

The interaction either exposes all bytes through an intentional full-view surface or never claims that a bounded preview is full.

### Resolution

Resolved 2026-08-25 as bounded-preview honesty. The renderer cap now matches the host hydration bound via shared `REASONING_PREVIEW_LIMIT = 64 * 1024` in `TimelineEntry.svelte`, and the truncation marker discloses the exact limit (“[Preview truncated · showing first 64 KiB]”). No surface claims the full record for a bounded preview.

**Verification:** copy audit over `TimelineEntry.svelte` shows no remaining full-record claim; hydrated 64 KiB records render without a second truncation.

## CHAT-005 — Send can remain actionable while the chat cannot compose

- **Status:** **Resolved** (2026-08-25)
- **Severity:** High
- **Evidence:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:552-566,1109-1116,2691-2734`; `packages/desktop/src/renderer/ui/organisms/Composer.svelte:291-335`
- **Product impact:** A retained draft may invoke Send or Steer against a starting, stopping, errored, loading, or stale session boundary.

### Reproduction

1. Enter a non-empty draft in a ready chat.
2. Move the chat into a non-composable state without setting the attachment/spill busy flags, such as an OMP runtime error or a rapid chat boundary.
3. Inspect and activate **Send**.
4. Check whether a request is dispatched against the old or errored chat.

### Rationale

The textarea and runtime controls use `canCompose`. The Send-disabled expression uses only content and composer-busy state, and `sendPrimary` does not guard `canCompose` or active-session identity.

### Decision needed

Make action availability and action admission share one authoritative predicate. A disabled control alone is insufficient; the handler must reject stale state too.

### Resolution threshold

Mounted tests prove Send, Steer, Queue, Enter, and attachment admission cannot target a chat when `canCompose` is false or the selection token has changed.

<a id="chat-006--draft-and-attachment-ownership-diverge-on-chat-switch"></a>

### Resolution

Resolved 2026-08-25. A single authoritative predicate (`ensureCanCompose`, capturing session id plus selection token) gates handler admission in `sendPrimary`, `sendSteer`, `queueFollowUp`, both Enter branches, `stageFiles`, `spillPromptText`, and `removeAttachment`; Send/Retry/Steer/Queue disabled expressions share it, and Composer’s hidden file input guards its own change event.

**Verification:** Electron journeys covering Enter-to-steer routing, attachment staging boundaries, and composer readiness all pass in the 26/26 `test:e2e:browser` run.

## CHAT-006 — Draft and attachment ownership diverge on chat switches

- **Status:** **Resolved** (2026-08-25)
- **Severity:** Medium
- **Evidence:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:625-730`
- **Product impact:** Switching chats carries typed text into the destination while releasing staged attachment chips from the origin, making a composed request change meaning across a container boundary.

### Reproduction

1. In chat A, type a draft and stage one file.
2. Switch to chat B.
3. Compare the destination draft and attachments.
4. Return to chat A and check whether either input is restored.

### Rationale

The renderer stores one draft variable outside the keyed chat boundary, but explicitly releases and clears attachments on successful selection. Existing E2E covers attachment isolation, not the intended draft rule.

### Decision needed

Choose and document one model: per-chat drafts and attachments; a single global composer that moves both; or explicit confirmation before discarding/moving either. The current split model should not remain accidental.

### Resolution threshold

A product decision is encoded in mounted session-switch and relaunch tests, with visible copy when input is intentionally discarded.

### Resolution

Resolved 2026-08-25 as per-chat composer ownership. Drafts are stashed per session at the selection boundary and restored on return, so neither the draft nor staged attachments cross a chat boundary; each chat remembers its own draft while the session lives. Switching to an empty kind stashes and clears the draft instead of leaking it into the welcome state or the next chat; deleting a chat drops its draft. Drafts are intentionally in-memory only and never reach `sessions-v1.json`.

**Verification:** Electron journey “keeps drafts scoped to their chat across session switches and relaunch” asserts empty-on-switch, per-chat restore both directions, and that persisted registry bytes contain no draft text; passes in the 27/27 `test:e2e:browser` run.


## CHAT-007 — Successful Steer and Queue attachments remain retained

- **Status:** **Resolved** (2026-08-25)
- **Severity:** Medium
- **Evidence:** `packages/desktop/src/main/prompt-attachments.ts:20-228`; `packages/desktop/e2e/desktop.spec.ts` tests “steers with exact attachments…” and “queues exact follow-up attachments…”
- **Product impact:** Successful active-turn messages can retain temporary files until runtime teardown and consume the 64 MiB retained quota, preventing later attachment staging.

### Reproduction

1. Start a held turn.
2. Steer with attachments and separately queue a follow-up with attachments.
3. Wait for admission and completion.
4. Inspect retained temporary bytes and attempt additional staging near the 64 MiB store quota.

### Rationale

Primary success releases its attachment batch. Existing Steer/Queue E2E intentionally expects admitted files to remain until teardown, but the user-facing lifetime and quota consequence are not defined.

### Decision needed

Define the safe release signal for active-turn and queued-message attachments. If retention is required until runtime consumption, expose quota state and release immediately after a correlated consumption acknowledgement.

### Resolution threshold

Exact-byte transport remains correct while a bounded test proves release at the chosen lifecycle point and no admitted request loses its files.

### Resolution

Resolved 2026-08-25: attachments release immediately after successful admission acknowledgement. Successful steer and queue batches are released once the runtime accepts them (matching primary-prompt semantics); rejected attempts still restore chips and retain staged files. `PromptAttachmentStore.release` also removes the lazily created temp directory when the store empties, so “nothing retained” is literal.

**Verification:** `test/prompt-attachments.test.ts` proves resolve-retains/release-cleans semantics; E2E A9/A10 now assert release-at-admission and an empty store before teardown, passing in the 26/26 run.

## CHAT-008 — “Default root directory” does not set the new-workspace default

- **Status:** **Resolved** (2026-08-25)
- **Severity:** Medium
- **Evidence:** `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:208-214`; `packages/desktop/src/main/workspace-host.ts:1572-1577`; `packages/desktop/src/main/desktop-host.ts:321-331`
- **Product impact:** A user can save a setting described as the root for new workspaces, then see no effect when choosing a workspace.

### Reproduction

1. Set **Default root directory** to a valid folder.
2. Return to OMP Chat and choose **Create new workspace**.
3. Inspect the native folder picker's initial directory and the created chat's folder.
4. Open a Local terminal with no stronger workspace cwd and compare its starting directory.

### Rationale

The setting's only identified production consumer is a terminal cwd fallback. New chat creation always opens the directory picker without consuming the preference.

### Decision needed

Either apply the preference to workspace creation or rename the setting to describe its terminal fallback behavior. Validate existence and directory type at the point of use.

### Resolution threshold

The label, help text, picker behavior, and terminal fallback all describe and implement the same scope.

### Resolution

Resolved 2026-08-25 by applying the preference. `chooseAndCreate` seeds the directory picker with the saved `workspace.defaultPath` validated as an existing directory (`DesktopHost#savedWorkspaceDefaultPath` via read-only `loadPersistedGradivusSettings`); invalid saved paths fall back cleanly without surfacing stale state. The terminal-cwd consumer is unchanged, so label, help text, picker, and fallback now agree.

**Verification:** `test/app-settings.test.ts` loader cases and `test/e2e-chat-progress.test.ts` chooseAndCreate assertions cover valid, missing, and file-not-directory saved paths.

## CHAT-009 — Auth discovery failure can look like an available provider

- **Status:** **Resolved** (2026-08-25)
- **Severity:** High
- **Evidence:** `packages/desktop/src/main/desktop-host.ts:1226-1240`
- **Product impact:** During an OMP/auth-runtime or offline failure, Settings can present ChatGPT Plus/Pro as available and signed out instead of explaining that provider status could not be loaded.

### Reproduction

1. Make the auth/settings RPC client unavailable before provider discovery.
2. Open Settings → Accounts.
3. Compare the provider list and global status with the underlying failure.
4. Attempt sign-in and observe whether the first explicit error arrives only then.

### Rationale

The provider-discovery catch path returns a synthetic available, signed-out provider. That fallback conflates “provider exists” with “status could not be discovered.”

### Decision needed

Represent discovery failure explicitly and keep the last known snapshot separate from availability. Do not invent an available provider as error recovery.

### Resolution threshold

A failure-path test shows an unavailable/unknown status with actionable error copy and no false sign-in affordance.

### Resolution

Resolved 2026-08-25. The synthetic available provider is deleted; discovery failure (unsuccessful response or thrown error) returns an empty list and emits a `gradivus:auth` error event carrying the actionable message (sentinel provider `AUTH_DISCOVERY_PROVIDER`). The Accounts panel shows an explicit “Provider status could not be loaded” alert, offers no sign-in while unknown, and clears the error on the next successful snapshot. Sign-in/sign-out against an unknown provider fail fast with an accurate message.

**Verification:** `test/desktop-host.test.ts` discovery-failure cases prove empty-list plus event emission, and that success emits nothing.

## CHAT-010 — The desktop unit-test command does not complete

- **Status:** **Resolved** (2026-08-25)
- **Severity:** Medium
- **Evidence:** 2026-08-25 `bun run test` from `packages/desktop`: 28 passed files, `test/markdown-keywords.test.ts` failed to resolve `bun:test` under Vitest, two worker exits, and Node heap out of memory.
- **Product impact:** Product documentation cannot treat the package unit suite as current passing evidence; regressions outside the passing Electron journeys can be hidden.

### Reproduction

1. From `packages/desktop`, run `bun run test` in this working tree.
2. Observe the Vitest result and worker process output.

### Rationale

The package script invokes Vitest while one file imports `bun:test`; the run also exceeded the worker heap. These may be independent failures and should be diagnosed separately rather than suppressed.

### Decision needed

Choose one supported runner contract for every test file and a full-suite-safe worker/memory configuration. Preserve behavior assertions; do not skip the failing file or merely raise memory without identifying the leak.

### Resolution threshold

`bun run test` completes with every test file collected by its intended runner, no unhandled worker exits, and bounded memory on the supported workstation class.

### Resolution

Resolved 2026-08-25 with one supported runner contract. `markdown-keywords.test.ts` now imports Vitest like the other 31 files; `vitest.config.ts` bounds fan-out (forks pool, `maxWorkers: 2`). The worker OOMs were root-caused to a microtask busy-loop in `WorkspaceHost.#waitForInspectorAction`, which now yields (16 ms) between empty polls — a production fix, not a memory raise.

**Verification:** `bun run test` completes 32 files / 226 tests with zero unhandled worker exits on the supported workstation class.

## CHAT-011 — Conversation deletion has no product path

- **Status:** **Resolved** (2026-08-25)
- **Severity:** Low
- **Evidence:** No delete/remove operation in `packages/desktop/src/shared/contracts.ts:671-762`, preload/main session IPC, `SessionRail.svelte`, or `OmpChat.svelte`.
- **Product impact:** A user can create and rename chats but cannot remove obsolete or sensitive conversation records from the rail through the desktop interface.

### Reproduction

1. Create multiple chats in one rail workspace.
2. Inspect chat-row context actions, header actions, Settings, and keyboard commands.
3. Attempt to remove one chat without deleting user-data files manually.

### Rationale

The current API and renderer expose create, open, rename, stop, abort, and resume but no conversation deletion. Browser-tab and terminal close actions are unrelated.

### Decision needed

Confirm whether permanent deletion is intentionally unsupported. If added, define confirmation, active-chat fallback, resident runtime shutdown, registry removal, OMP transcript retention/deletion, attachment cleanup, and recovery from partial failure.

### Resolution threshold

The product either documents intentional retention and a supported external cleanup path, or provides an atomic deletion interaction with a mounted recovery test.

### Resolution

Resolved 2026-08-25 by shipping deletion. New `deleteSession` API/IPC (`gradivus:delete`) stops a resident runtime, closes its attachment store, removes the registry record (active pointer falls back to the most recent remaining chat of that kind, else null), and returns the post-delete snapshot. The rail gains a per-row delete affordance behind a confirm dialog that explicitly discloses the OMP transcript file remains on disk.

**Verification:** `test/session-registry.test.ts` covers removal persistence, active fallback ordering, last-of-kind clearing, and unknown-id rejection; Electron journey “deletes a chat after confirmation…” asserts copy disclosure, rail update, fallback selection, and persisted registry.

## CHAT-012 — The composer footer loses its attachment bar at narrow widths

- **Status:** **Resolved** (2026-08-28)
- **Severity:** Medium
- **Evidence:** The geometry journey failed on Windows x64 with `narrowGeometry.attachmentRect` null at `packages/desktop/e2e/desktop.spec.ts:743` because the working tree had moved `.composer-attachment-bar` from `.composer-actions` into `.composer-top-bar`, while the journey (and the shipped footer CSS) codify the footer placement.
- **Product impact:** At narrow widths the attachment shelf is missing from the composer footer, so the staged-attachment affordance and the documented one-surface composer contract (attachment shelf above tools and action rail) are not rendered.

### Reproduction

1. Launch the packaged Electron app with the fixture chat.
2. Resize the window to 920, 760, and 720 px width.
3. Inspect `.composer-actions` for `.composer-attachment-bar`.

### Rationale

The composer was restructured in the working tree (the runtime picker and send controls were re-laid-out); the narrow-width footer no longer renders the attachment bar the geometry journey requires. The same journey codifies the intended wide layout: attachment bar leftmost, then runtime picker, context meter, and the send button rightmost with compact gaps.
### Decision needed

Resolved by decision, amended 2026-08-28 by product decision. Final contract: the attachment shelf is the only control that renders above the chat textarea (first child of `.composer-top-bar`, spanning the composer width); the composer footer holds only the runtime picker, context meter, and **Send**/**Steer** action as a right-aligned cluster with the primary action flush to the footer's lower right at every width. The textarea height limits match the codified contract (42/160 px comfortable, 36/144 px compact). The geometry journey now codifies shelf-above-input plus the right-aligned footer at 920/760/720 px, and the two attachment journeys assert the shelf above the input.

### Resolution threshold

Met 2026-08-28: `packages/desktop/e2e/desktop.spec.ts` **"keeps the Command Deck composer as one usable surface at both densities"** passes at both densities and all three narrow widths, and the full desktop Playwright suite passes on Windows x64 against the rebuilt packaged bundle.

## CHAT-013 — Browser pane right-click menu items do nothing

- **Status:** **Resolved** (2026-08-28)
- **Severity:** Medium
- **Evidence:** `packages/desktop/src/main/workspace-host.ts:1690-1699` builds the native pane context menu (**Split Right**, **Split Down**, **Close Pane**) and emits a `pane-context-action` workspace event (`packages/desktop/src/shared/contracts.ts:623`), but no renderer or main-process subscriber handles the event — the renderer has no `pane-context-action` reference at all.
- **Product impact:** Right-clicking a browser pane shows working-looking menu items that have no effect, while the package README documents “Right-click any browser pane to split it right or down, or to close it” as supported behavior. Toolbar split/close buttons work.

### Reproduction

1. Launch the app and open a browser tab.
2. Right-click inside the browser pane.
3. Choose **Split Right** (or **Split Down** / **Close Pane**).
4. Observe the pane layout.

### Rationale

The menu was wired to an event contract that was never consumed. Unit tests (`test/workspace-host-pane-menu.test.ts`) assert only main-side label/enabled/event behavior, so the gap is invisible to them.

### Decision needed

Resolved by handling the event. The shell's workspace-event handler (`App.svelte` `handleWorkspaceEvent`) now consumes `pane-context-action`: it locates the owning browser tab and routes `close` to the same `closeBrowserPane` path as the toolbar, and `split-columns`/`split-rows` to the same `splitBrowser` path. Unknown pane ids are dropped silently.

### Resolution threshold

Met 2026-08-28. New Electron journey **“routes native pane context menu actions to pane splits and close”** (`e2e/desktop.spec.ts`) emits the `pane-context-action` workspace event exactly as the native menu click does (`workspace-host.ts` `#send` → `gradivus:workspace`) and observes split-columns (1→2 panes), split-rows (2→3 panes), and close (3→2, pane id removed). Combined with the existing main-side unit test (`test/workspace-host-pane-menu.test.ts` proves menu click → event emission), the full chain menu click → event → split/close is covered. Passes in the full desktop Playwright run on Windows x64.

## CHAT-014 — Gradivus exits silently when the workspace runtime cannot start

- **Status:** **Resolved** (2026-08-28)
- **Severity:** High
- **Evidence:** `packages/desktop/src/main/main.ts:209-233` catches workspace-runtime and workspace-authority startup failures, logs them (`RUNTIME STARTUP ERROR:` / `WORKSPACE AUTHORITY ERROR:`), and exits; no dialog, window, or error surface appears. Spawn-failure wording exists in `packages/workspace-runtime/src/bootstrap.ts:329`.
- **Product impact:** On a packaged install with a broken bundled runtime (or a development tree missing the compiled OMP binary), launching Gradivus appears to do nothing. The only diagnostics are log files.

### Reproduction

1. Rename or remove the packaged OMP executable (or the development `dist/omp` binary).
2. Launch Gradivus.
3. Observe that no window appears and the process exits.

### Rationale

>The startup sequence creates the window only after the daemon is running, and the failure path exits before any UI exists. The development-missing-binary case has an explicit message in the log, but nothing user-visible.

### Decision needed

Resolved with a native error dialog. Both startup-failure catch blocks in `main.ts` now call `showFatalStartupError` before quitting: `dialog.showErrorBox` renders the failure heading ("Gradivus runtime failed to start" / "Gradivus workspace failed to initialize"), the underlying error text, and a logs pointer (`Logs: ~/.omp/logs/`). The app quits after the user dismisses the dialog.

### Resolution threshold

Met 2026-08-28 (Observed, Windows x64). In the packaged build with `resources/omp.exe` removed, launch shows a modal native error dialog — heading "Gradivus runtime failed to start", body "Workspace runtime server failed to start at …omp.exe: spawn … ENOENT" plus the logs pointer (dialog text read back via UI Automation) — instead of exiting silently. Dismissing the dialog exits the app cleanly; `omp.exe` was restored afterwards.

## Triage review rule

When an item is reproduced, replace source-predicted wording with exact observed setup, visible result, platform, and evidence. When resolved, keep the entry with resolution revision and the verification claim that prevents recurrence; do not silently delete the historical decision.
# Verify Settings and provider accounts

**Documentation status:** drafted. Passing items use fixture-backed Playwright journeys in the actual Electron application. Provider/auth claims are deliberately blocked unless the mounted journey exercised them; no real provider sign-in or account mutation was run. Evidence date: 2026-08-25. Working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources and tests may be modified or untracked.

## ST-01 — Opening Settings routes away from the workspace and focuses Search

- **Setup:** Open a ready OMP Chat workspace.
- **Steps:** Activate **Open settings** and inspect the routed page and focused element.
- **Expected result:** A **Settings** heading replaces the workspace surface and **Search settings** has focus.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic OMP fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:208-212`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys,”** in the 24/24 passing Electron run.
- **Result:** pass

## ST-02 — Settings search filters categories and manages focus

- **Setup:** Open Settings with entries present in Session, OMP defaults, Access, and Application.
- **Steps:** Search for a unique setting, inspect category counts and live announcement, choose a matching category, search for a nonexistent term, then press Escape twice.
- **Expected result:** Matching counts and categories update; category selection focuses its heading; no match shows a recovery state; first Escape clears Search and refocuses it; second Escape closes Settings and restores the invoking control's focus.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic Settings data.
- **Evidence:** **Code-established and unit-test-specified, not executed in Electron.** `packages/desktop/src/renderer/ui/organisms/SettingsShell.svelte:69-128,132-215` and `packages/desktop/src/renderer/ui/pages/App.svelte:464-493,620-634` implement the behavior. `packages/desktop/test/settings-search.test.ts:21-155` is unit-only and `bun run test` failed.
- **Result:** blocked

## ST-03 — Back to workspace closes the Settings route

- **Setup:** Open routed Settings from OMP Chat.
- **Steps:** Navigate to Application Appearance, then select **Back to workspace**.
- **Expected result:** Settings closes and the OMP Chat composer is visible again without creating another workspace tab.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic OMP fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:209-223`, the current OMP Chat Settings journey, in the 24/24 passing Electron run.
- **Result:** pass

## ST-04 — A pending Settings refresh survives route close and reopen

- **Setup:** Launch the Settings fixture with a delayed settings response.
- **Steps:** Open Settings, start or observe Refresh, close Settings while Refresh is disabled, then reopen before the response settles.
- **Expected result:** Reopened Settings still shows the pending Refresh state, then enables Refresh when the original request finishes.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with `GRADIVUS_SETTINGS_RESPONSE_DELAY=250`.
- **Post-cutover status:** rerun under the renamed variables on macOS arm64; the desktop Electron suite passed 24/24 (`test:e2e:browser`) and the selection suite passed 8/8 (`test:e2e:selection`).
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1384-1407`, **“reopens settings after a delayed refresh closes,”** in the 24/24 passing Electron run.
- **Result:** pass

## ST-05 — Routed Settings detaches and restores the selected native browser view

- **Setup:** Open a browser tab to the local browser fixture and record its native view identity and URL.
- **Steps:** Open Application Settings over the browser, then select **Back to workspace**.
- **Expected result:** The native browser view is detached while Settings is open and restored with the same identity, URL, and selected tab afterward.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application and loopback browser fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1409-1456`, **“detaches the active browser view while routed settings are open,”** in the 24/24 passing Electron run.
- **Result:** pass

## ST-06 — Interface density applies immediately after save

- **Setup:** Open Settings → Application → Appearance with Comfortable density.
- **Steps:** Choose **Compact** and inspect the desktop root before leaving Settings.
- **Expected result:** The desktop density becomes Compact during the same Settings visit.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with isolated user data.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:212-218`, the current OMP Chat Settings journey, in the 24/24 passing Electron run.
- **Result:** pass

## ST-07 — Theme selection updates renderer, native, browser, and terminal surfaces

- **Setup:** Open the mounted desktop with browser and Local terminal surfaces available.
- **Steps:** Select Dark and Light, then select System and change the emulated operating-system scheme.
- **Expected result:** The resolved palette updates all inspected surfaces without losing active browser or terminal state.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with controlled color-scheme emulation.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1823-2130`, **“applies AAA neutral palettes in dark and light modes,”** in the 24/24 passing Electron run.
- **Result:** pass

## ST-08 — Reduce motion and tool-detail preferences apply without restart

- **Setup:** Open a transcript with tool detail and an animating interface state, then open Application Appearance/Behavior.
- **Steps:** Toggle **Reduce motion** and **Show tool details** during the same application run.
- **Expected result:** Interface motion is reduced immediately and transcript tool previews/argument badges follow the tool-detail preference without restarting OMP.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with a tool entry and motion-capable surface.
- **Evidence:** **Code-established, not executed as preference changes.** `packages/desktop/src/renderer/ui/pages/App.svelte:161-171` applies motion state and `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:121-152` exposes both controls. The executed reduced-motion journey started from fixture settings rather than changing both fields.
- **Result:** blocked

## ST-09 — Application settings persist and Reset is a new commit, not undo

- **Setup:** Use isolated user data, change multiple Application settings, quit, and relaunch.
- **Steps:** Confirm the changed values after relaunch, select **Reset application defaults**, quit, and relaunch again; look for undo/redo controls.
- **Expected result:** Saved values survive the first relaunch; Reset persists defaults for the second relaunch; no Settings undo/redo action appears.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with isolated user data and two relaunches.
- **Evidence:** **Unit-test-specified and code-established, not executed in Electron.** `packages/desktop/src/main/app-settings.ts:103-174` persists serialized snapshots and `packages/desktop/src/renderer/ui/pages/App.svelte:174-271` implements save/reset status. `packages/desktop/test/app-settings.test.ts:18-149` is unit-only and `bun run test` failed.
- **Result:** blocked

## ST-10 — Runtime, OMP defaults, Accounts, and Application remain distinct scopes

- **Setup:** Open Settings with a running chat, OMP-reported defaults, provider fixture data, and local Application settings.
- **Steps:** Visit Session → Runtime, each OMP defaults category, Access → Accounts, and Application categories; switch to another chat and revisit Runtime.
- **Expected result:** Runtime changes target only the active chat; OMP defaults remain OMP-owned; Accounts shows provider/account state; Application values remain machine-local and unchanged by chat switching.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with two chats and deterministic settings/auth fixtures.
- **Evidence:** **Code-established, partially observed.** `packages/desktop/src/renderer/ui/organisms/SettingsShell.svelte:17-49` defines the visible hierarchy and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2827-3144` renders scope-specific content. The executed journey visited Application Appearance and Accounts but did not prove ownership across all four scopes and two chats.
- **Result:** blocked

## ST-11 — OMP defaults disclose immediate versus next-session timing

- **Setup:** Provide one runtime-reported OMP default with `immediate` timing and one with `next-session` timing.
- **Steps:** Change both values, inspect their badges/status, then reconnect or create a session.
- **Expected result:** The next-session value shows **Next session** and confirms **Starts with the next session**; the immediate value does not claim a restart requirement.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with controllable OMP settings fixture.
- **Evidence:** **Code-established, not executed.** Timing is contracted at `packages/desktop/src/shared/contracts.ts:82-92` and rendered at `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1475-1487,3007-3039`. No passing Electron journey changed both timing classes and reconnected.
- **Result:** blocked

## ST-12 — Active Runtime controls are unavailable for a stopped or errored chat

- **Setup:** Have one running chat and one stopped or errored chat.
- **Steps:** Open Session → Runtime for each chat and activate Resume for the unavailable state.
- **Expected result:** Running chat controls target that active session; stopped/error shows a Resume requirement and does not permit model/turn-behavior mutation until the session is running.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with controllable chat runtime states.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2856-2995` gates Runtime controls by current chat state. The executed Settings journey did not stop/error a chat from this route.
- **Result:** blocked

## ST-13 — Terminal settings split live appearance from next-PTY shell selection

- **Setup:** Open Local terminal, then Settings → Application → Terminal.
- **Steps:** Change font family, size, cursor style/blink, and scrollback; change Shell; inspect the open PTY, then restart it.
- **Expected result:** Appearance fields affect the open terminal; Shell does not replace the running process and is used for the newly opened PTY.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with two valid shell executables.
- **Evidence:** **Code-established, not executed.** Controls are in `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:156-194`; live renderer settings are in `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:36-44`; shell selection occurs at `packages/desktop/src/main/workspace-host.ts:1427-1447`.
- **Result:** blocked

## ST-14 — Browser homepage and search template affect only later navigation

- **Setup:** Open one existing browser pane, then Settings → Application → Browser.
- **Steps:** Change **Default homepage URL** and **Search engine URL template**; create a new browser tab and submit plain search text.
- **Expected result:** The existing page remains at its current URL; the new tab uses the homepage and the later plain-text navigation uses the changed `%s` template.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with loopback-safe URLs.
- **Evidence:** **Code-established and unit-test-specified, not executed.** `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:196-206`, `packages/desktop/src/renderer/ui/pages/App.svelte:426-458`, and `packages/desktop/src/main/workspace-host.ts:718-748` establish consumption. Unit-only host assertions cannot pass this item.
- **Result:** blocked

## ST-15 — Default root copy and workspace behavior agree

- **Setup:** Set **Default root directory** to a valid folder different from the current chat workspace.
- **Steps:** Choose **Create new workspace**, inspect the native picker's initial folder and created chat, then compare a newly opened terminal fallback.
- **Expected result:** The label, help text, picker behavior, created workspace, and terminal fallback describe and use one consistent scope.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with two temporary directories.
- **Evidence:** **Verification blocker filed in triage.** Source predicts the setting is consumed only by a terminal fallback, not new-workspace creation: `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:208-214`, `packages/desktop/src/main/workspace-host.ts:1550-1577`, and `packages/desktop/src/main/desktop-host.ts:321-331`. See [`CHAT-008`](../bug-triage.md#chat-008--default-root-directory-does-not-set-the-new-workspace-default).
- **Result:** blocked

## ST-16 — Accounts renders an OMP-reported provider without exposing credentials

- **Setup:** Launch the deterministic fixture that reports ChatGPT Plus/Pro provider status.
- **Steps:** Open Settings → Accounts and inspect Provider access.
- **Expected result:** The OMP-reported provider name appears in Provider access; no credential material is displayed in that provider row.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic provider fixture, not a real provider.
- **Evidence:** **Observed and Tested for fixture provider presentation only.** Executed `packages/desktop/e2e/desktop.spec.ts:219-221`, the current OMP Chat Settings journey, in the 24/24 passing Electron run. It does not establish real discovery or token redaction from an authenticated provider response.
- **Result:** pass

## ST-17 — Provider sign-in uses the official browser flow and private follow-up input

- **Setup:** Use an available test provider whose OMP login requests an external URL and then sensitive input.
- **Steps:** Select **Sign in**, inspect the opened URL/status, complete one **Private sign-in step**, and repeat with explicit Cancel.
- **Expected result:** Sign-in opens the provider's allowed official browser URL, private input is masked, Submit returns the value only to local OMP, and Cancel sends an empty response without exposing a token in the renderer.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with a non-production controllable auth provider and no real credentials.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/desktop-host.ts:1243-1263,1307-1341` handles browser/private steps and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2206-2274,3147` presents them. No real or simulated mounted auth flow was run.
- **Result:** blocked

## ST-18 — Provider sign-out refreshes connection state

- **Setup:** Present a safely authenticated test provider in Accounts.
- **Steps:** Select **Sign out** and inspect the provider row and status after OMP responds.
- **Expected result:** The provider changes from Connected to its OMP-reported signed-out state and a completion/error message is visible; no undo action appears.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with disposable non-production auth state.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/desktop-host.ts:283-290` and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2250-2260,3069-3083` implement the transition. The passing Accounts visit did not sign out.
- **Result:** blocked

## ST-19 — OAuth account details show identity and routing state, not tokens

- **Setup:** Seed OMP with multiple disposable OAuth account identities for one provider.
- **Steps:** Open Accounts → OAuth accounts and inspect each row.
- **Expected result:** Rows show provider/account identity, active/available state, and Locked state where applicable; access and refresh tokens are absent.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with redacted disposable OAuth fixture data.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:3091-3138` renders identity/routing state and the local/redacted boundary. No passing Electron journey supplied OAuth account details.
- **Result:** blocked

## ST-20 — Routing lock and account failover update OMP-owned state

- **Setup:** Seed two available OAuth accounts for one provider with no initial lock and failover disabled.
- **Steps:** Lock one account, enable failover, clear the lock, and inspect returned state after each action.
- **Expected result:** **Lock** becomes **Clear lock** for the pinned identity, failover status follows OMP's response, and neither action is presented as encryption or workspace read-only state.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with disposable multi-account OMP fixture.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1679-1707,3091-3138` and `packages/desktop/src/main/desktop-host.ts:238-259` implement the transitions. Lock/failover precedence when the pinned account is unavailable remains open.
- **Result:** blocked

## ST-21 — Confirmed OAuth account removal is destructive and has no undo

- **Setup:** Seed a disposable OAuth account that can be safely removed.
- **Steps:** Select Remove and cancel once; repeat and confirm; inspect Accounts and search for undo/restore.
- **Expected result:** Cancel preserves the account; confirmation removes it from the OMP-returned snapshot; no undo or restore control appears.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with disposable OAuth fixture data.
- **Evidence:** **Code-established, not executed.** Native confirmation and removal are implemented at `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1709-1723,3115-3133` and `packages/desktop/src/main/desktop-host.ts:261-268`. No passing Electron journey removed an account.
- **Result:** blocked

## ST-22 — Provider discovery failure is distinguishable from provider availability

- **Setup:** Make the local auth/settings RPC client unavailable before opening Accounts.
- **Steps:** Open Settings → Accounts and compare the visible provider state with the underlying discovery failure.
- **Expected result:** Settings reports that provider status could not be loaded and does not synthesize an apparently Available provider.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with auth-client failure injection.
- **Evidence:** **Verification blocker filed in triage.** `packages/desktop/src/main/desktop-host.ts:1226-1240` currently catches discovery failure and returns an available, signed-out OpenAI/Codex provider. See [`CHAT-009`](../bug-triage.md#chat-009--auth-discovery-failure-can-look-like-an-available-provider).
- **Result:** blocked

## ST-23 — Desktop Settings has no API-key entry form

- **Setup:** Open every Settings scope and search for API key, token, secret, and each available provider name.
- **Steps:** Inspect all matching controls and provider actions.
- **Expected result:** No desktop form asks for an API key or displays credential material; supported access actions are runtime-reported provider sign-in/sign-out and OAuth account routing/removal.
- **Priority:** P3
- **Device or environment:** macOS arm64; mounted Electron application with representative runtime-reported settings/providers.
- **Evidence:** **Code-established, not runtime-verified.** The routed settings inventory and controls in `packages/desktop/src/renderer/ui/organisms/SettingsShell.svelte:17-49`, `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:68-216`, and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2827-3144` expose no API-key form. Absence was not exhaustively checked in the passing journey.
- **Result:** blocked

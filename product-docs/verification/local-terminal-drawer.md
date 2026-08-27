# Verify the Local terminal drawer

**Documentation status:** drafted. The passing items below come from fixture-backed Playwright journeys in the actual Electron application. Source-only and unit-only claims remain blocked. Evidence date: 2026-08-25. Working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources and tests may be modified or untracked.

## LT-01 — Show reveals the drawer and updates the control state

- **Setup:** Open a seeded, ready OMP Chat session with the Local terminal drawer hidden.
- **Steps:** Activate **Show local terminal**, then inspect the drawer and the same header control.
- **Expected result:** The drawer becomes visible, the control becomes **Hide local terminal**, and `aria-expanded` changes from `false` to `true`.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with the deterministic OMP fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1608-1638`, **“opens the current chat local terminal drawer without changing chat state,”** in the 24/24 passing Electron run.
- **Result:** pass

## LT-02 — The running shell accepts local input

- **Setup:** Open the Local terminal drawer in the fixture workspace and wait for status `running`.
- **Steps:** Focus the terminal canvas, type a `printf` command, press Enter, and inspect the rendered byte offset.
- **Expected result:** The shell remains running and its rendered output offset advances after the command.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with local fixture workspace runtime.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1639-1662`, the Local terminal journey, in the 24/24 passing Electron run.
- **Result:** pass

## LT-03 — An exited shell can restart

- **Setup:** Open a running Local terminal shell.
- **Steps:** Type `exit`, wait for **Restart shell**, activate it, then run another `printf` command.
- **Expected result:** Exit reveals **Restart shell**; restart returns the status to `running`; the new shell accepts input and advances output.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic local shell fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1663-1676`, the Local terminal journey, in the 24/24 passing Electron run.
- **Result:** pass

## LT-04 — Hide and show preserve shell replay position

- **Setup:** Open a running Local terminal, produce output, and record its rendered byte offset.
- **Steps:** Activate **Hide local terminal**, activate **Show local terminal**, and inspect the reopened offset before entering more input.
- **Expected result:** The reopened drawer begins at or after the pre-hide offset and the same shell can continue producing output.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic local shell fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1677-1695`, the Local terminal journey, in the 24/24 passing Electron run.
- **Result:** pass

## LT-05 — Shell use does not add conversation transcript content

- **Setup:** Capture the visible conversation transcript before opening the Local terminal.
- **Steps:** Open the drawer, run commands, exit/restart, hide, show, and run another command; compare the transcript afterward.
- **Expected result:** The conversation transcript text is unchanged by Local terminal input, output, hide/show, exit, and restart.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with deterministic OMP and shell fixtures.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1619-1620,1679-1696`, **“opens the current chat local terminal drawer without changing chat state,”** in the 24/24 passing Electron run.
- **Result:** pass

## LT-06 — The current drawer exposes one Local terminal shell, not two mode buttons

- **Setup:** Open the Local terminal drawer in the current working-tree Electron surface.
- **Steps:** Inspect the drawer title and search for buttons named **Agent activity** and **Shell**.
- **Expected result:** The title is **Local terminal** and neither mode button is present.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with deterministic fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1639-1643`, the Local terminal journey, in the 24/24 passing Electron run. This verifies the current single-shell presentation, not the two-channel product intent in `packages/desktop/README.md:26-31`.
- **Result:** pass

## LT-07 — A chat shell starts in the selected chat workspace

- **Setup:** Create two chat sessions with distinct local workspace paths and put path-identifying files in each.
- **Steps:** Open Local terminal in each chat and print the working directory.
- **Expected result:** Each shell starts at its owning chat session's exact workspace path, independent of the currently active authority-workspace fallback.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with two temporary workspaces.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/workspace-host.ts:1368-1393,1425-1474` resolves the chat session cwd and passes it to the detached PTY. The executed Local terminal journey did not assert `pwd` across chats.
- **Result:** blocked

## LT-08 — Drawer resize preserves the running process

- **Setup:** Open a running Local terminal and start a process that prints a stable marker before and after a delay.
- **Steps:** Resize the window and drawer while output is in flight, then enter another command.
- **Expected result:** Columns and rows update without restarting the PTY, losing focus permanently, duplicating output, or changing the conversation transcript.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application at wide and narrow viewports.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:46-61,87-92` resizes the existing renderer and PTY. No executed Electron journey resized the drawer while shell output was active.
- **Result:** blocked

## LT-09 — Renderer reload reattaches without losing or duplicating shell output

- **Setup:** Open a running Local terminal, produce identifiable output, and record the visible offset.
- **Steps:** Reload the renderer, reopen Local terminal, and continue the same process.
- **Expected result:** The existing PTY is reattached from a monotonic offset; retained output is neither duplicated nor silently replaced by a new shell.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with reload available and isolated user data.
- **Evidence:** **Inference and code support only.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:94-151,153-205` and `packages/desktop/src/main/workspace-host.ts:1398-1422` implement presentation reattachment. No executed Electron journey reloaded the renderer.
- **Result:** blocked

## LT-10 — Workspace-runtime reconnect resumes from the retained byte offset

- **Setup:** Open a Local terminal, consume output through a known byte offset, and replace or disconnect the workspace-runtime client.
- **Steps:** Reconnect the workspace runtime and wait for terminal resubscription.
- **Expected result:** Subscription resumes at the retained offset rather than from zero, without duplicate earlier output.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with controllable workspace-runtime replacement.
- **Evidence:** **Test-specified, not passing Electron evidence.** `packages/desktop/test/workspace-host-reconnect.test.ts:89-144`, **“retains terminal byte offset across replaceClient and resubscribes from that offset,”** asserts the host behavior, but unit-only assertions cannot pass this item and `bun run test` failed.
- **Result:** blocked

## LT-11 — Session and workspace boundaries clean up only the ephemeral chat PTY

- **Setup:** Open one Local terminal and one durable workspace terminal, then prepare a second chat in another workspace.
- **Steps:** Switch chats/workspaces, restart the chat session, explicitly close/restart the Local terminal, and inspect both terminal records and processes.
- **Expected result:** The previous ephemeral chat PTY is closed at each ownership boundary while the durable workspace terminal remains unaffected.
- **Priority:** P1
- **Device or environment:** macOS arm64; mounted Electron application with two workspaces and durable terminal-pane access.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:647-709`, `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:177-205`, and `packages/desktop/src/main/workspace-host.ts:1394-1415,1491-1515` establish cleanup paths. No passing Electron journey exercised all ownership boundaries.
- **Result:** blocked

## LT-12 — Replay eviction and terminal errors are visible

- **Setup:** Configure bounded terminal retention, generate enough output to evict early bytes, then force a terminal creation or runtime error.
- **Steps:** Reattach from an old offset and inspect the drawer; repeat with a failed shell.
- **Expected result:** Evicted replay shows **Earlier shell output was evicted; showing the available replay.** A terminal failure shows an alert and **Restart shell**.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with controllable terminal retention and failure injection.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:102-125,153-174,208-220` renders the states. The passing terminal journey covered normal exit/restart, not truncation or failure.
- **Result:** blocked

## LT-13 — Theme changes preserve a running terminal's state

- **Setup:** Open Local terminal in a seeded Electron chat with output already rendered.
- **Steps:** Change between Dark, Light, and System themes while keeping the terminal open; inspect the terminal palette and output offset.
- **Expected result:** Terminal colors follow the selected/resolved desktop theme while the active shell and replay offset remain stable.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with controlled OS color-scheme emulation.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1823-2130`, **“applies AAA neutral palettes in dark and light modes,”** in the 24/24 passing Electron run; the journey opens the terminal and asserts theme/replay stability.
- **Result:** pass

## LT-14 — Terminal appearance applies live and shell selection applies to the next PTY

- **Setup:** Open Local terminal, then open Settings → Application → Terminal.
- **Steps:** Change font family, size, cursor style/blink, and scrollback; then change Shell and restart the PTY.
- **Expected result:** Renderer appearance changes affect the open terminal without process replacement, while the changed Shell is used only by the newly opened PTY.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with two valid local shell executables.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:36-44,63-92` applies live renderer settings and `packages/desktop/src/main/workspace-host.ts:1427-1447` chooses the shell at PTY creation. No passing Electron journey changed these fields.
- **Result:** blocked

## LT-15 — Default root does not replace the chat session workspace

- **Setup:** Set **Default root directory** to a valid folder different from the selected chat's workspace.
- **Steps:** Open Local terminal from that chat and print the working directory; separately create a durable terminal where the fallback applies.
- **Expected result:** Local terminal remains rooted at the chat workspace; product copy clearly distinguishes that behavior from any durable-terminal fallback.
- **Priority:** P2
- **Device or environment:** macOS arm64; mounted Electron application with two temporary directories.
- **Evidence:** **Verification blocker filed in triage.** Source assigns chat-terminal cwd from the session in `packages/desktop/src/main/workspace-host.ts:1368-1474` but consumes Application `workspace.defaultPath` in a different terminal path at `:1550-1577`. The user-facing mismatch is [`CHAT-008`](../bug-triage.md#chat-008--default-root-directory-does-not-set-the-new-workspace-default).
- **Result:** blocked

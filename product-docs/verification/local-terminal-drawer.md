# Verify the Local terminal drawer

**Documentation status:** drafted. The passing items below come from fixture-backed Playwright journeys in the actual Electron application, executed on Windows x64 where the drawer uses the `wterm-dom` engine. Source-only and unit-only claims remain blocked. Evidence date: 2026-08-28. Working tree anchored at `ac5f533bb245ef7f911dfc165c7c39356a2ac639` with the uncommitted cross-platform terminal-renderer cutover applied; relevant desktop sources and tests may be modified or untracked. The earlier macOS arm64 evidence from 2026-08-25 remains recorded in the feature document.

## LT-01 — Show reveals the drawer and updates the control state

- **Setup:** Open a seeded, ready chat session with the terminal drawer hidden.
- **Steps:** Activate **Show terminal**, then inspect the drawer and the same header control.
- **Expected result:** The drawer becomes visible, the control becomes **Hide terminal**, and `aria-expanded` changes from `false` to `true`.
- **Priority:** P1
- **Device or environment:** Windows x64; mounted Electron application with the deterministic OMP fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1981-1984`, **“opens the current chat terminal drawer without changing chat state,”** in the 36/36-passing Electron run.
- **Result:** pass

## LT-02 — The running shell accepts local input

- **Setup:** Open the terminal drawer in the fixture workspace and wait for status `running`.
- **Steps:** Focus the **Shell terminal** region, type a `printf` command, press Enter, and inspect the rendered byte offset.
- **Expected result:** The shell remains running and its rendered output offset advances after the command.
- **Priority:** P1
- **Device or environment:** Windows x64; mounted Electron application with local fixture workspace runtime; `wterm-dom` engine.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:2053-2060`, the terminal journey, in the 36/36-passing Electron run.
- **Result:** pass

## LT-03 — An exited shell can restart

- **Setup:** Open a running terminal shell.
- **Steps:** Type `exit`, wait for **Restart shell**, activate it, then run another `printf` command.
- **Expected result:** Exit reveals **Restart shell**; restart returns the status to `running`; the new shell accepts input and advances output.
- **Priority:** P1
- **Device or environment:** Windows x64; mounted Electron application with deterministic local shell fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:2061-2074`, the terminal journey, in the 36/36-passing Electron run.
- **Result:** pass

## LT-04 — Hide and show preserve shell replay position

- **Setup:** Open a running terminal, produce output, and record its rendered byte offset.
- **Steps:** Activate **Hide terminal**, activate **Show terminal**, and inspect the reopened offset before entering more input.
- **Expected result:** The reopened drawer begins at or after the pre-hide offset and the same shell can continue producing output.
- **Priority:** P1
- **Device or environment:** Windows x64; mounted Electron application with deterministic local shell fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:2075-2093`, the terminal journey, in the 36/36-passing Electron run.
- **Result:** pass

## LT-05 — Shell use does not add conversation transcript content

- **Setup:** Capture the visible conversation transcript before opening the terminal.
- **Steps:** Open the drawer, run commands, exit/restart, hide, show, and run another command; compare the transcript afterward.
- **Expected result:** The conversation transcript text is unchanged by terminal input, output, hide/show, exit, and restart.
- **Priority:** P1
- **Device or environment:** Windows x64; mounted Electron application with deterministic OMP and shell fixtures.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:1950-1951,2080,2094`, **“opens the current chat terminal drawer without changing chat state,”** in the 36/36-passing Electron run.
- **Result:** pass

## LT-06 — The current drawer exposes one interactive shell, not two mode buttons

- **Setup:** Open the terminal drawer in the current working-tree Electron surface.
- **Steps:** Inspect the drawer and search for buttons named **Agent activity** and **Shell**.
- **Expected result:** Neither mode button is present; the interactive area is a region named **Shell terminal**; the drawer has no visible title.
- **Priority:** P2
- **Device or environment:** Windows x64; mounted Electron application with deterministic fixture.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:2028,2039-2040`, the terminal journey, in the 36/36-passing Electron run. This verifies the current single-shell presentation, not the two-channel product intent in `packages/desktop/README.md`.
- **Result:** pass

## LT-07 — A chat shell starts in the selected chat workspace

- **Setup:** Create two chat sessions with distinct local workspace paths and put path-identifying files in each.
- **Steps:** Open the terminal drawer in each chat and print the working directory.
- **Expected result:** Each shell starts at its owning chat session's exact workspace path, independent of the currently active authority-workspace fallback.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with two temporary workspaces.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/workspace-host.ts:1363-1393,1425-1474` resolves the chat session cwd and passes it to the detached PTY. The executed terminal journey did not assert `pwd` across chats.
- **Result:** blocked

## LT-08 — Drawer resize preserves the running process

- **Setup:** Open a running terminal and start a process that prints a stable marker before and after a delay.
- **Steps:** Resize the window and drawer while output is in flight, then enter another command.
- **Expected result:** Columns and rows update without restarting the PTY, losing focus permanently, duplicating output, or changing the conversation transcript.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application at wide and narrow viewports.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:77-85` forwards measured resizes; `wterm-renderer.ts:75-84` and `ghostty-web-renderer.ts:43-51` clamp and deduplicate them. The executed journey changed viewport size before opening but did not resize while output was active.
- **Result:** blocked

## LT-09 — Renderer reload reattaches without losing or duplicating shell output

- **Setup:** Open a running terminal, produce identifiable output, and record the visible offset.
- **Steps:** Reload the renderer, reopen the terminal drawer, and continue the same process.
- **Expected result:** The existing PTY is reattached from a monotonic offset; retained output is neither duplicated nor silently replaced by a new shell.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with reload available and isolated user data.
- **Evidence:** **Inference and code support only.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:95-151,153-203` and `packages/desktop/src/main/workspace-host.ts:1394-1422` implement presentation reattachment. No executed Electron journey reloaded the renderer.
- **Result:** blocked

## LT-10 — Workspace-runtime reconnect resumes from the retained byte offset

- **Setup:** Open a terminal, consume output through a known byte offset, and replace or disconnect the workspace-runtime client.
- **Steps:** Reconnect the workspace runtime and wait for terminal resubscription.
- **Expected result:** Subscription resumes at the retained offset rather than from zero, without duplicate earlier output.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with controllable workspace-runtime replacement.
- **Evidence:** **Test-specified, not passing Electron evidence.** `packages/desktop/test/workspace-host-reconnect.test.ts:89-144`, **“retains terminal byte offset across replaceClient and resubscribes from that offset,”** asserts the host behavior, but no mounted journey exercised a runtime reconnect.
- **Result:** blocked

## LT-11 — Session and workspace boundaries clean up only the ephemeral chat PTY

- **Setup:** Open one chat terminal and one durable workspace terminal, then prepare a second chat in another workspace.
- **Steps:** Switch chats/workspaces, restart the chat session, explicitly close/restart the terminal, and inspect both terminal records and processes.
- **Expected result:** The previous ephemeral chat PTY is closed at each ownership boundary while the durable workspace terminal remains unaffected.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with two workspaces and durable terminal-pane access.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte` terminal ownership and toggle behavior, `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:177-203`, and `packages/desktop/src/main/workspace-host.ts:1394-1415,1487-1515` establish cleanup paths. No passing Electron journey exercised all ownership boundaries.
- **Result:** blocked

## LT-12 — Replay eviction and terminal errors are visible

- **Setup:** Configure bounded terminal retention, generate enough output to evict early bytes, then force a terminal creation or runtime error.
- **Steps:** Reattach from an old offset and inspect the drawer; repeat with a failed shell.
- **Expected result:** Evicted replay shows **Earlier shell output was evicted; showing the available replay.** A terminal failure shows an alert and **Restart shell**.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application with controllable terminal retention and failure injection.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:103-125,153-174,206-215` renders the states. The passing terminal journey covered a synthetic WASM-fetch failure and normal exit/restart, not replay eviction.
- **Result:** blocked

## LT-13 — Theme changes preserve a running terminal's state

- **Setup:** Open the terminal drawer in a seeded Electron chat with output already rendered.
- **Steps:** Change between Dark, Light, and System themes while keeping the terminal open; inspect the terminal palette and output offset.
- **Expected result:** Terminal colors follow the selected/resolved desktop theme while the active shell and replay offset remain stable.
- **Priority:** P2
- **Device or environment:** Windows x64; mounted Electron application with controlled OS color-scheme emulation.
- **Evidence:** **Observed and Tested.** Executed `packages/desktop/e2e/desktop.spec.ts:2322` **“applies AAA neutral palettes in dark and light modes,”** which opens the terminal and asserts theme/replay stability; passed in the 36/36-passing Electron run.
- **Result:** pass

## LT-14 — Terminal appearance applies live and font/scrollback settings apply on the next shell

- **Setup:** Open the terminal drawer, then open Settings → Application → Terminal.
- **Steps:** Change cursor style/blink and observe the open shell; change font family, font size, and scrollback and observe the open shell, then restart it.
- **Expected result:** Cursor and theme changes affect the open shell without process replacement; font family, font size, and scrollback changes apply only after the shell is next opened or restarted, as the settings copy states.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:40-47,58-67` applies live appearance and creation-time configuration; `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:163-193` carries the next-open/restart helper text. No passing Electron journey changed these fields live.
- **Result:** blocked

## LT-15 — Default root does not replace the chat session workspace

- **Setup:** Set **Default root directory** to a valid folder different from the selected chat's workspace.
- **Steps:** Open the terminal drawer from that chat and print the working directory; separately create a durable terminal where the fallback applies.
- **Expected result:** The chat terminal remains rooted at the chat workspace; product copy clearly distinguishes that behavior from any durable-terminal fallback.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application with two temporary directories.
- **Evidence:** **Verification blocker filed in triage.** Source assigns chat-terminal cwd from the session in `packages/desktop/src/main/workspace-host.ts:1363-1474` but consumes Application `workspace.defaultPath` in a different terminal path. The user-facing mismatch is tracked in [`CHAT-008`](../bug-triage.md#chat-008--default-root-directory-does-not-set-the-new-workspace-default).
- **Result:** blocked

## LT-16 — The drawer reports the platform-selected terminal renderer

- **Setup:** Launch the packaged Electron application on a known host platform and open the terminal drawer.
- **Steps:** Inspect `data-terminal-renderer` on the drawer shell before and after a shell restart.
- **Expected result:** The attribute is `wterm-dom` on Windows and `ghostty-web` on macOS/Linux, and it does not change across restarts.
- **Priority:** P1
- **Device or environment:** Windows x64 executed; macOS/Linux asserted by the same spec but not run in this pass.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1986-1988,2053-2054` asserts the attribute against `process.platform`; passed as `wterm-dom` in the 36/36-passing Electron run. `packages/desktop/test/terminal-renderer-selection.test.ts` passed 4/4 on Windows x64 for the routing contract.
- **Result:** pass

## LT-17 — A failed WebAssembly fetch is visible and recoverable

- **Setup:** Open the terminal drawer with the first `.wasm` request forced to fail with a synthetic 404.
- **Steps:** Observe the drawer, restore the original fetch, activate **Restart shell**, and capture `.wasm` responses, page errors, and console errors during the retry.
- **Expected result:** The drawer shows an alert and **Restart shell** without falling back to the other engine; the restart produces a real HTTP 200 `.wasm` response and no page or console errors.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application served through its custom protocol, exercising the emitted asset path.
- **Evidence:** **Observed and Tested.** `packages/desktop/e2e/desktop.spec.ts:1966-2026` runs the synthetic-404-to-recovery journey, including `wasmResponses` containing 200 and empty `pageErrors`/`consoleErrors`; passed in the 36/36-passing Electron run.
- **Result:** pass

## LT-18 — The macOS/Linux renderer journey passes on its own host

- **Setup:** On a macOS or Linux host, run the same terminal journey.
- **Steps:** Execute `packages/desktop/e2e/desktop.spec.ts` **“opens the current chat terminal drawer without changing chat state.”**
- **Expected result:** The journey passes with `data-terminal-renderer="ghostty-web"` and a real 200 Ghostty WASM response through the packaged protocol.
- **Priority:** P2
- **Device or environment:** macOS arm64 or x64 (or Linux); packaged Electron application.
- **Evidence:** **Not run in this pass.** The 2026-08-25 macOS run predates the renderer cutover; the shared spec's platform branch is symmetric but no macOS host executed the cutover journey.
- **Result:** blocked

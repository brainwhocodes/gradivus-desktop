# Verify the OMP runtime connection

**Documentation status:** drafted. Passing items come from the fixture-backed Electron journeys and the real-runtime journey executed on Windows x64 on 2026-08-28. Working tree anchored at `ac5f533bb245ef7f911dfc165c7c39356a2ac639` with the cross-platform terminal-renderer cutover applied.

## OC-01 — Launch ends the connecting overlay and yields usable chats

- **Setup:** Launch the packaged app with a seeded workspace.
- **Steps:** Watch the stage from launch until the composer is ready.
- **Expected result:** The **Connecting to the workspace runtime…** status covers the stage until the workspace hydrates, then clears and the chat composer becomes usable.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** Every fixture journey waits on the composer (for example `packages/desktop/e2e/desktop.spec.ts:184`). Passed in the 36/36 run.
- **Result:** pass

## OC-02 — A chat's OMP runtime starts on open and streams its history

- **Setup:** Seed a registry with a chat that has saved history.
- **Steps:** Launch the app and select the chat.
- **Expected result:** Selecting the chat starts its runtime, and the saved transcript pages in without user action; the chat becomes ready for new turns.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application with deterministic RPC fixture.
- **Evidence:** **Observed and Tested.** Seeded-chat journeys restore history and accept new prompts (for example `packages/desktop/e2e/desktop.spec.ts:179-259`). Passed in the 36/36 run.
- **Result:** pass

## OC-03 — The real compiled OMP runtime answers through the Electron chat path

- **Setup:** Build the packaged app and set `GRADIVUS_REAL_OMP=1`.
- **Steps:** Run the real-runtime journey, which boots the compiled OMP, seeds a chat, and submits `/context`.
- **Expected result:** The real runtime starts, accepts the prompt, and returns the context-window report inside the chat transcript.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application with the compiled OMP binary.
- **Evidence:** **Observed and Tested.** `GRADIVUS_REAL_OMP=1 bunx playwright test --config playwright.real.config.ts` passed 1/1 (6.1 s) on 2026-08-28.
- **Result:** pass

## OC-04 — Opening a fourth chat evicts the least-recently-used idle runtime

- **Setup:** Open three chats and let them become ready.
- **Steps:** Open a fourth chat; return to the first chat and submit a turn.
- **Expected result:** The fourth chat becomes ready; the least-recently-used idle chat's runtime was stopped transparently; returning to it restarts its runtime from the saved session and the turn proceeds.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with four chats.
- **Evidence:** **Test-specified, not passing Electron evidence.** `packages/desktop/test/runtime-supervisor.test.ts:59-330` asserts the resident cap and LRU eviction; no mounted journey opens four chats.
- **Result:** blocked

## OC-05 — An idle chat's runtime stops after five minutes and resumes on use

- **Setup:** Open a chat and make it ready.
- **Steps:** Wait five minutes without interacting, then submit a turn.
- **Expected result:** No visible change while idle; the next turn restarts the runtime from the saved session and the transcript is intact.
- **Priority:** P2
- **Device or environment:** Any supported host; mounted Electron application with a five-minute wait.
- **Evidence:** **Test-specified, not passing Electron evidence.** `packages/desktop/test/runtime-supervisor.test.ts` asserts idle-timeout eviction; not exercised mounted.
- **Result:** blocked

## OC-06 — A crashed runtime shows the error card and Reconnect recovers

- **Setup:** Start a turn in a chat whose runtime is live.
- **Steps:** Kill the chat's OMP process mid-turn; observe the chat; activate **Reconnect**.
- **Expected result:** The pending turn rolls back, the chat shows **Runtime stopped unexpectedly** with **Resume to reconnect and recover the saved transcript.**, and **Reconnect** restarts the runtime and restores the saved transcript.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with a killable runtime.
- **Evidence:** **Code-established, not executed.** `packages/desktop/src/main/rpc-process.ts:231-238,315-325` and `packages/desktop/src/renderer/ui/pages/OmpChat.svelte` establish the path; the fixture journeys do not kill the chat child.
- **Result:** blocked

## OC-07 — Workspace daemon loss shows the reconnect ladder and Retry recovers

- **Setup:** Launch the app connected.
- **Steps:** Sever the daemon connection; wait through retries; restore it; repeat to exhaustion without restoring.
- **Expected result:** **Reconnecting to the workspace runtime…** appears, then **Workspace runtime disconnected**, and after exhaustion the persistent **Workspace runtime unreachable** error with **Retry**, which reconnects when the daemon returns.
- **Priority:** P1
- **Device or environment:** Any supported host; mounted Electron application with a controllable daemon.
- **Evidence:** **Test-specified, not passing Electron evidence.** `packages/desktop/test/runtime-reconnect.test.ts:26-84` asserts the schedule and events; no mounted journey severs the daemon.
- **Result:** blocked

## OC-08 — Quit is staged and relaunch resumes chats from history

- **Setup:** Open two chats with history.
- **Steps:** Quit the app; relaunch; open both chats.
- **Expected result:** Quit stops runtimes cleanly; relaunch shows both chats with their transcripts; each chat's runtime starts again on open.
- **Priority:** P1
- **Device or environment:** Windows x64; packaged Electron application.
- **Evidence:** **Observed and Tested.** The drafts journey relaunches the app and reopens chats with state intact (`packages/desktop/e2e/desktop.spec.ts:2109-2147`). Passed in the 36/36 run.
- **Result:** pass

## OC-09 — Launch with an unusable runtime exits without a dialog

- **Setup:** Remove or rename the bundled OMP executable in a packaged build.
- **Steps:** Launch the app.
- **Expected result:** Currently: no window appears and the process exits. Filed as [`CHAT-014`](../bug-triage.md#chat-014--gradivus-exits-silently-when-the-workspace-runtime-cannot-start); this item passes only when a visible failure surface exists.
- **Priority:** P1
- **Device or environment:** Packaged install on any supported host.
- **Evidence:** **Code-established.** `packages/desktop/src/main/main.ts:209-233` exits after logging; not reproduced in this pass.
- **Result:** blocked

## OC-10 — `omp` run inside the chat terminal attaches as a separate agent

- **Setup:** Open the chat terminal drawer in a chat whose workspace has the OMP binary available on `PATH`.
- **Steps:** Run `omp` inside the drawer shell and start a session.
- **Expected result:** The drawer's `omp` is a separate process from the chat's runtime; it attaches to the workspace as an agent; the chat's own runtime is unaffected.
- **Priority:** P2
- **Device or environment:** Any supported host with the OMP executable on the drawer's `PATH`.
- **Evidence:** **Code-established, not executed.** `packages/coding-agent/src/desktop-terminal/runtime-attach.ts` and `packages/workspace-runtime/src/server.ts:717-752` establish the attach protocol and environment; `packages/desktop/e2e/terminal-fixture.cjs:48` asserts the environment variable only.
- **Result:** blocked

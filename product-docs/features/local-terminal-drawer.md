# Local terminal drawer

## Summary

**Status: drafted.** The **Local terminal drawer** is a chat-local bottom section opened from the transcript header with the terminal toggle (**Show terminal**/**Hide terminal**). The product model distinguishes a bounded, read-only **Agent activity** projection from an independent **Shell**, but the tested surface renders one interactive shell with no Agent activity/Shell mode buttons. Shell input and output stay outside OMP context and the conversation transcript. The shell starts in the selected chat session's workspace, survives hide/show and presentation reattachment, and is cleaned up at chat, workspace, session-runtime, or explicit-close boundaries without affecting durable workspace terminals. The terminal is drawn by the `ghostty-web` renderer with its Ghostty WebAssembly core on every supported platform. A failed WebAssembly fetch is visible as a failed shell with **Restart shell** rather than silently claiming that the shell is running.

## The simple case

The user activates **Show terminal** in a ready chat. The drawer opens below the transcript, reports `starting` and then `running`, loads the `ghostty-web` WebAssembly terminal core, focuses the shell, and starts a PTY in that chat session's workspace folder. Commands typed there behave like commands in an ordinary local shell. They are not sent as OMP requests and do not add rows to the conversation transcript. Selecting **Hide terminal** removes the drawer from view without ending its shell; showing it again reattaches from the last bounded output offset. If the shell exits, fails, or the WebAssembly core cannot be fetched, the drawer shows the state, exposes any error, and offers **Restart shell**.

## The interaction, event by event

### Starting

The transcript-header toggle begins as **Show terminal**, with `aria-expanded="false"`. Activating it changes the control to **Hide terminal**, reveals the divided bottom drawer, creates or reattaches the chat shell, sizes it to the available drawer, and focuses it. The shell is rooted at the selected chat session's exact local workspace path, even when a different authority workspace is active. Its executable comes from the application Terminal setting when a new PTY is created.

Opening the drawer initializes the `ghostty-web` terminal engine with its Ghostty WebAssembly core through the packaged app protocol on every supported platform. The renderer choice is exposed on the drawer shell as `data-terminal-renderer="ghostty-web"`, and the interactive area is a region named **Shell terminal**.

The conceptual **Agent activity** channel is read only and intentionally excludes arbitrary arguments, raw output, cwd, environment values, runtime tokens, and session IDs. The current tested renderer does not expose Agent activity as a selectable drawer mode; it exposes only the interactive shell. Agent/tool activity remains in the bounded conversation presentation rather than becoming shell input.

### Ending at once

Hiding the drawer immediately makes it unavailable for input but does not close the PTY or reset its output offset. Reopening it can therefore continue the same process. If creation cannot resolve a chat workspace, cannot reach the workspace runtime, or the terminal engine's WebAssembly core cannot be fetched, the drawer ends in `failed`, shows the error as an alert, and offers **Restart shell** instead of claiming that a shell is running.

### Becoming extended

The interaction becomes extended when the PTY remains open, produces more output than is currently rendered, is resized, or must reattach after renderer presentation loss or workspace-runtime client replacement. Output is tracked with monotonic byte offsets. The presentation requests replay from its last retained offset and ignores older duplicate frames. If earlier output is no longer retained, the drawer says **Earlier shell output was evicted; showing the available replay.**

> Technical note: the chat terminal is a detached, ephemeral PTY recorded by the workspace authority while its presentation is owned by the selected chat workspace. Recreating the renderer presentation can rebind the same workspace PTY from a retained byte offset; this is why hide/show or renderer reload need not replay output into OMP or create a conversation event.

### While extended

Input is serialized to the PTY, output is rendered locally, and drawer resize updates terminal columns and rows. The `ghostty-web` renderer measures grid changes through its resize observation and fit behavior. Dimensions use the same bounded 2–500 column/row contract and duplicate dimensions are suppressed.

Theme, cursor blink, and cursor style changes apply live to an open shell. Font family, font size, and scrollback are fixed when the shell is mounted; the settings surface states that they apply when the shell is next opened or restarted, and changing them does not kill a running shell. Shell executable changes affect newly opened PTYs. Resizing or changing appearance does not intentionally restart the process. A workspace-runtime reconnect resubscribes from the retained byte offset so already consumed output is not deliberately duplicated.

Switching to another chat closes the visible drawer. When the destination chat belongs to a different workspace path, the previous chat shell is closed before a shell is opened for the new workspace. Shell activity never changes the selected runtime, active turn, transcript contents, or durable browser/terminal panes.

### Finishing

Typing `exit` or otherwise ending the process changes the state to `exited` and reveals **Restart shell**. Restart closes the old PTY, disposes the terminal engine, clears the presentation replay offset, and creates a new shell using current new-terminal settings and `ghostty-web`. A successful WebAssembly load is cached for the rest of the app session, while a failed load clears the cache so **Restart shell** performs a real retry. Explicit terminal close, session/workspace switching, session-runtime restart, renderer component destruction, and application shutdown clean up the ephemeral chat PTY. Hiding alone is not completion. Durable workspace terminals are a separate container and are not closed by Local terminal cleanup.

```mermaid
stateDiagram-v2
  [*] --> Hidden
  Hidden --> Starting: Show terminal
  Starting --> Running: PTY ready and WASM core loaded
  Running --> Hidden: Hide
  Hidden --> Running: Show and reattach
  Running --> Exited: Process exits
  Starting --> Failed: Open, runtime, or WASM load error
  Running --> Failed: Terminal error
  Exited --> Starting: Restart shell
  Failed --> Starting: Restart shell (same engine)
  Running --> [*]: Chat/workspace/session cleanup
```

## Modifiers

| Modifier | Effect at start | Effect when changed mid-interaction |
| --- | --- | --- |
| Selected chat session | Supplies the local workspace path and owns the drawer presentation. | Switching chat sessions hides and destroys the current presentation; a different workspace path closes the previous ephemeral PTY before another can open. |
| Host platform | Every supported platform uses the `ghostty-web` WebAssembly terminal engine. | The same engine is used on every supported platform; there is no user-facing engine switch. |
| Agent activity versus Shell | Agent activity is a bounded, read-only projection; Shell is an interactive PTY whose input/output stays outside OMP context. The tested UI starts directly in the single interactive shell and shows no mode buttons. | No working-tree mode switch is exposed. Agent activity arriving during shell use remains conversation/agent presentation, not shell data. |
| Visibility | Hidden means no active shell input; showing creates or reattaches the shell and focuses it. | Hide preserves the PTY and replay offset; show reattaches and resizes without intentionally changing chat state. |
| Drawer size | Initial dimensions determine PTY columns and rows within bounded limits. | Resize updates the renderer and PTY dimensions; failures to report resize are ignored, so the shell remains usable at its last accepted dimensions. |
| Theme and terminal appearance | Current application theme and cursor settings configure the mounted terminal. | Theme, cursor blink, and cursor style changes apply live. Font family, font size, and scrollback changes wait for the next shell mount or **Restart shell**. |
| Shell executable | The application Terminal shell is used when the PTY is created. | Changing Shell does not replace the running PTY; it applies after restart or a newly opened terminal. |
| WebAssembly core availability | The `ghostty-web` engine fetches its packaged WebAssembly core when the shell mounts. | A failed fetch fails the shell visibly; **Restart shell** retries the same engine. A cached successful load is reused for later shells during the app session. |
| Replay availability | Reattachment begins at the retained monotonic byte offset. | New frames advance the offset; duplicate older frames are ignored, and lost earlier output produces a truncation status. |
| Workspace-runtime connection | A connected workspace runtime and a resolvable chat workspace are required to start. | Reconnection resubscribes from the retained offset; failure changes the drawer to `failed` and surfaces an error. |

## Cancel and interrupt

| Interrupt | Outcome and visible consequence |
| --- | --- |
| explicit abort | **Hide terminal** ends only the visible interaction; the shell remains running. `exit` ends the PTY and reveals **Restart shell**. There is no separate Ctrl+C interception: Ctrl+C is ordinary shell input for the foreground process. |
| doing something else mid-way | Switching chats closes the visible drawer and its presentation. Switching to another workspace closes the prior workspace's ephemeral chat PTY; Shell output remains outside both chat transcripts. |
| clean-completion event | A normal process exit changes status to `exited`; **Restart shell** starts a fresh PTY. Hiding is not clean completion because the process and replay offset remain. |
| environment failure | Workspace-runtime disconnection, PTY creation failure, write failure, terminal error, or an unfetchable WebAssembly core leaves the drawer visible when possible, changes status to `failed` or shows an alert, and offers restart. The drawer does not silently claim that a shell is running when its packaged WebAssembly asset is unavailable. There is no offline command queue. |
| page/process exit | Renderer presentation loss disposes the terminal engine and asks to close the known presentation; source and reconnect tests establish offset-aware reattachment paths, but exact renderer-reload survival was not exercised. Application shutdown closes ephemeral chat terminals; a hard process loss may leave authority state requiring recovery. |
| target changed elsewhere | If the authority terminal disappears or closes, the drawer becomes `exited`; if the selected chat/workspace changes, the old presentation no longer owns the visible drawer. Durable workspace-terminal changes do not become Local terminal output. |
| input-channel change | Keyboard and paste accepted by the terminal region become PTY input; pointer use only focuses or selects in the renderer. There is no second-device input, OMP steering conversion, or transcript mirroring. |

## Interactions with other systems

| Concern | Consequence |
| --- | --- |
| permissions | The shell uses the local workspace runtime rather than an embedded-site permission prompt. Its OS/filesystem permissions are those of the local PTY process; a read-only or inaccessible path can fail through ordinary shell/tool errors. |
| history or undo | Shell scrollback and offset replay are local terminal history, not conversation history or undo. Commands have no application-level undo; shell-native history depends on the configured shell. |
| containers or parents | The Local terminal drawer belongs to the selected chat session and its workspace path. Its ephemeral PTY is separate from durable workspace terminal panes and from OMP's conversation runtime. |
| locked or read-only state | No dedicated read-only terminal mode exists. A read-only workspace may allow the shell to open while later filesystem mutations fail. OAuth account routing lock and Agent Hub read-only state do not lock the shell. |
| offline behavior | The shell does not require a provider or internet connection, but it does require the local workspace runtime and a locally packaged WebAssembly core. Commands that need the network fail in their own output; there is no offline queue or custom offline state. |
| collaboration or multi-device behavior | Shell input/output is local and is not broadcast to remote users or other devices. Local OMP agents do not receive it unless a user separately includes its result in a request. |
| notifications | Starting, running, exited, failed, truncation, and error states appear inside the drawer. There is no operating-system notification, sound, or terminal notification history. |
| configuration and preferences | Application settings control terminal shell, font family, font size, cursor style/blink, scrollback, and theme. Shell changes apply to newly opened PTYs; theme and cursor changes apply live; font family, font size, and scrollback apply when the shell is next opened or restarted, as their settings copy states. The **Default root directory** setting does not override a chat shell's session workspace, and its mismatched workspace copy is tracked in [`CHAT-008`](../bug-triage.md#chat-008--default-root-directory-does-not-set-the-new-workspace-default). |

## Edge cases

- The Electron journey confirms that **Agent activity** and **Shell** are not rendered as mode buttons; the drawer exposes one interactive shell whose region is named **Shell terminal**. This differs from the two-channel product model and remains an open presentation question.
- The drawer has no visible title; the outer section is accessibly named **Local chat terminal** and the interactive area is a region named **Shell terminal**. Tests and UI logic address the region rather than assuming a specific internal element.
- `data-terminal-renderer` on the shell is `ghostty-web` on every supported platform.
- A failed WebAssembly fetch produces the failed state, an alert, and **Restart shell**; a later successful restart must produce a real HTTP 200 response for the `.wasm` asset with no console or page errors on the success path.
- The `ghostty-web` renderer's resize observation and fit behavior keep terminal dimensions within the bounded contract; platform-specific renderer branches are not required.
- Showing the drawer before a chat workspace can be resolved returns **Session workspace is unavailable** as a failed state.
- A disconnected workspace runtime returns a failed shell state instead of creating an unowned local process.
- Dimensions are bounded to 2–500 columns and rows; a zero-sized hidden element is not sent as a resize.
- Output that arrives before the engine mounts is buffered and then written in offset order.
- Output frames older than the retained replay offset are ignored to avoid visible duplication.
- Hide/show retains the shell and output offset. Restart intentionally clears both presentation output and replay offset for the new PTY.
- The chat shell always uses the chat session cwd. The application **Default root directory** is consumed by a different durable-terminal fallback, not by Local terminal creation.
- `omp` can run in the shell only when it is available on the inherited `PATH`; doing so is a separate local process and does not turn the drawer into the active OMP Chat runtime.

## Open questions and verification

### Source revision

- Working tree anchored at `ac5f533bb245ef7f911dfc165c7c39356a2ac639` with the uncommitted cross-platform terminal-renderer cutover applied.
- Evidence date: 2026-08-28.
- Boundary: relevant desktop sources and tests are modified or untracked, so this describes the working tree anchored at that commit, not a clean checkout.

### Runtime evidence

**Observed:** `packages/desktop/e2e/desktop.spec.ts` journey **“opens the current chat terminal drawer without changing chat state”** ran on Windows x64 against the packaged app. It failed the first WebAssembly fetch with a synthetic 404, showed the terminal alert and **Restart shell**, then restarted into a real HTTP 200 `.wasm` response with no page or console errors, typed fixture input, observed advancing output offsets, exited and restarted the shell, hid and reopened the drawer, and confirmed the conversation timeline did not change. The current renderer contract identifies the drawer engine as `ghostty-web` on every supported platform.

### Test evidence

**Tested:** `packages/desktop/test/terminal-renderer-selection.test.ts` passed all platform cases on Windows x64, establishing `ghostty-web` for Windows, macOS, Linux, and other supported platforms. `packages/desktop/test/theme-palette.test.ts` passed in the same run, retaining the shared terminal palette contrast guarantees. The full fixture-backed Playwright suite and the previous macOS terminal journey are recorded in [`../verification/local-terminal-drawer.md`](../verification/local-terminal-drawer.md). `packages/desktop/test/workspace-host-reconnect.test.ts:89-144`, **“retains terminal byte offset across replaceClient and resubscribes from that offset,”** remains unit-level support because the overall unit suite did not pass in this pass.

### Code evidence

**Code-established:** the renderer contract, platform-neutral dispatch, and creation-time versus live configuration split are established by `packages/desktop/src/renderer/terminal/terminal-renderer.ts`. The `ghostty-web` renderer's cached WebAssembly load, failure-clearing retry, resize behavior, disposal cleanup, and live `terminal.options` updates are established by `packages/desktop/src/renderer/terminal/ghostty-web-renderer.ts`. Drawer activation, live appearance, serialized writes, resize, monotonic replay, truncation/error feedback, restart, and presentation cleanup are established by `packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte`. Chat ownership and toggle behavior are established by `packages/desktop/src/renderer/ui/pages/OmpChat.svelte`. Workspace-rooted detached PTY creation, reuse, replacement, shell selection, and cleanup are established by `packages/desktop/src/main/workspace-host.ts`.

### Open questions

- **Open question:** Should the Local terminal drawer visibly expose separate **Agent activity** and **Shell** modes, or is the tested single-shell surface the intended clean cutover?
- **Open question:** Renderer reload, drawer resizing while a process emits output, workspace-runtime reconnect, and session switching have not been exercised end to end in Electron with the `ghostty-web` renderer.
- **Open question:** Exact cleanup after a hard Electron crash is not established; the source-backed presentation map is memory-owned and may not close a durable detached PTY after abrupt loss.
- **Open question:** Failed shell executable, inaccessible workspace, evicted replay, very large scrollback, clipboard behavior, and alternate shells remain runtime-verification gaps.
- **Open question:** The terminal journey on a non-Windows host has not been rerun since the renderer cutover; the shared spec's platform cases are symmetric but the executed evidence here is Windows x64.
- **Open question:** The user-facing scope of **Default root directory** remains unresolved in [`CHAT-008`](../bug-triage.md#chat-008--default-root-directory-does-not-set-the-new-workspace-default).

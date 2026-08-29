# Gradivus

Gradivus is a local workspace for Oh My Pi. It combines OMP Chat with
workspace-scoped terminal and browser surfaces, whether or not OMP is installed
on the shell's `PATH`.

## Workspace behavior

- Open OMP Chat or browser tabs from the top tab strip.
- Split a browser tab into browsers only.
- Arrange two browser panes as columns or rows. Three and four panes use a compact grid.
- Right-click any browser pane to split it right or down, or to close it.
- Keep the browser address bar inside each browser pane.
- Rename browser tabs and persist browser navigation in the workspace runtime.
- Use the active chat's Local terminal drawer for workspace-rooted shell sessions; its inherited environment is sanitized and its OMP attachment credentials are runtime-scoped.

Browser panes are sandboxed Electron `WebContentsView` instances projected from durable runtime browser records. Visible browser use remains available in every pane; runtime authorization is exact to the workspace, pane, terminal generation, and capability lease. Gradivus does not expose a global Electron CDP port or correlate targets by title or URL.

### OMP Chat terminal drawer

The active chat includes a lightweight **Local terminal** drawer without
restoring terminal tabs, pane chrome, or a second app shell. Its single
Show/Hide control lives in the chat header; the drawer remains a divided
bottom section of the chat surface:

- **Agent activity** shows a bounded, read-only command/status projection for
  the active chat. It does not expose arbitrary arguments, output, cwd,
  environment values, runtime tokens, or session IDs.
- **Shell** opens an independent, workspace-rooted PTY rendered by the
  `ghostty-web` renderer with its Ghostty WebAssembly core on every supported
  platform. Its input and output stay local to the drawer and never enter OMP
  context or the chat transcript.
- Hide/show, resize, and renderer reload preserve the shell session and use
  bounded monotonic output offsets. Switching workspaces, restarting the
  session, or explicitly closing the drawer cleans up only its ephemeral PTY;
  durable workspace terminals are unaffected.

### Chat activity and inspectors

Chat timeline follow state is scoped to each chat session. While the viewport
is at the bottom, tool and assistant activity keeps the timeline at the latest
item; scrolling upward pauses following without stealing the user's place.
**Jump to latest** returns to the bottom and resumes following. Selecting an
activity item does not change that follow intent.

The chat header exposes Agent Hub and Files inspector counts alongside the
terminal control. Agent Hub is scoped to the selected chat's coding-agent
process and shows retained agents, bounded progress, transcripts, unread state,
and lifecycle actions permitted for each row. The Files inspector shows safe,
bounded read previews and successful write/edit summaries or diffs, with
open-in-editor and full diff review where available; raw tool arguments and
results are not exposed.

## Theme

Gradivus uses a neutral black-and-white desktop theme in both light and
dark modes: light mode uses white and near-white surfaces with black text,
while dark mode uses black and near-black surfaces with white text. Crimson is
reserved for selected and active states, primary and destructive actions,
errors, the Gradivus mark, and the element inspector target; green and
amber identify success and warning notices. Readable text, configured terminal
colors, selected content, and meaningful state boundaries are designed for AAA
contrast, and keyboard focus remains a neutral two-band indicator. The
`dark`, `light`, and `system` preferences update renderer, native, terminal,
browser, and inspector surfaces together without losing active state.

## Settings and image tools

OMP Chat remains the primary interaction surface. If `omp` is available on the inherited `PATH`, it can still run from the Local terminal drawer; the desktop shell keeps browser, chat, and global configuration concerns separate.

The settings surface manages credential-free OMP defaults without opening a session runtime. Native image generation and delegated image inspection remain configurable under **Tools**, and changes persist through OMP's settings RPC.

Provider credentials stay outside the renderer. Settings show stored account identities and active or locked state, support an explicit per-provider account lock, sibling-account failover, account removal, and provider sign-in or sign-out.

## Launching

From this repository, an argument-free `omp` command opens Gradivus and uses the current directory as the workspace. The workspace runtime owns chat-drawer shell startup and injects only its trusted OMP executable directory into the drawer's `PATH`.

To keep normal terminal-only behavior when launching an installed OMP command outside Gradivus, run:

```sh
OMP_DESKTOP=0 omp
```

## Architecture

| Electron main process | `src/main/` | Window lifecycle, browser `WebContentsView` presentation, preload IPC, and runtime-client connection |
| Workspace runtime | `../workspace-runtime/` | Durable workspace document, terminal PTY services, capability leases, browser intent, and lifecycle effects |
| Preload bridge | `src/main/preload.ts` | Narrow, validated browser, chat-terminal, and workspace IPC boundary |
| Svelte renderer | `src/renderer/` | OMP Chat, browser tabs and panes, chat-terminal drawer, and responsive layout |
| Shared contracts | `src/shared/` and `../wire/` | Renderer IPC, workspace document, command, and terminal stream contracts |
| OMP backend | `../coding-agent/` | OMP process attached to a runtime-scoped chat-terminal lease |

Gradivus starts one workspace runtime daemon under the Electron user-data root. Desktop shutdown disconnects presentation clients while durable browser state and runtime-owned PTYs follow their explicit lifecycle; explicit runtime shutdown is separate.

## Requirements

- Windows 10 or 11 on x64, macOS, or Linux on a platform supported by the OMP backend and Electron.
- [Bun](https://bun.sh/) matching the workspace toolchain.
- Workspace dependencies installed from the repository root.

## Development

From the repository root:

```sh
bun install
cd packages/desktop
bun run backend:build
bun run start
```

`backend:build` compiles the OMP executable used by runtime-owned terminal shells. `start` builds that backend before launching Electron Forge with Vite development servers.

## Verification

```sh
cd packages/desktop
bun run check
bun run test
bun run test:e2e
```

The focused Vitest coverage verifies runtime-owned PTY startup, bounded terminal streams, durable command transitions, browser presentation, and native pane menu routing. The Playwright journey launches the real Electron shell and verifies:

- the OMP Chat workspace with browser surfaces, the Local terminal drawer, and neutral black/white settings and terminal themes;
- native image-generation and image-inspection settings persistence;
- provider sign-in, account lock/unlock, sibling failover, removal, and sign-out;
- runtime-owned shell startup through the workspace client and the
  platform-neutral `ghostty-web` WebAssembly terminal renderer;
- browser split invariants;
- native right-click split and close actions for browser panes;
- browser-local address bars, tab naming, durable navigation, and browser rehydration;
- presentation disconnect without browser closure on normal desktop shutdown;
- responsive layout, window controls, and serious accessibility violations.

## Packaging

```sh
bun run backend:build
bun run package
```

Electron Forge writes the unpacked application under `out/`. The packaged resources include the OMP executable used to bootstrap the workspace runtime, Gradivus's RPC defaults, and third-party notices.

## Local data and security

- Renderer context isolation, sandboxing, Electron fuses, and a restrictive content security policy remain enabled.
- Browser panes accept only HTTP and HTTPS navigation. Popups become new Gradivus browser tabs.
- Browser DevTools access binds to `127.0.0.1`; it is not exposed to the local network.
- Browser panes have Node integration disabled and deny permission requests by default.
- OMP owns provider credentials and session data under its local data directory.

## License and notices

Gradivus is licensed under the repository's [MIT License](../../LICENSE). Bundled icon, font, and terminal dependencies are recorded in [`THIRD_PARTY_LICENSES.txt`](./THIRD_PARTY_LICENSES.txt).

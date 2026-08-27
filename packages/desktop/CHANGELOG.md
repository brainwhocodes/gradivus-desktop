# Changelog

## [Unreleased]

### Breaking Changes

- Replaced the old Work/Code workspace shell with OMP Chat, browser workspace surfaces, and a chat-local terminal drawer.

### Added

- Added unified single-selection lifecycle with bounded DOM/screenshot capture and explicit awaited delivery.
- Added platform-normalized keyboard shortcuts (`Cmd` on macOS / `Ctrl` elsewhere) with active input and terminal canvas filtering.
- Added position-aware browser bounds with zoom factor scaling and automatic geometry recomputation.
- Added light/dark native browser background synchronization and live OS `nativeTheme` support.
- Added automatic reconnection to workspace runtime with bounded backoff and terminal offset replay.
- Added the ChatGPT OAuth settings flow and masked extension-input prompts for credentials that stay outside desktop transcripts.
- Added every OAuth login provider reported by OMP and categorized, session-independent agent defaults, including native image generation and inspection controls.
- Added browser-only splits, a Ghostty WebAssembly terminal drawer backed by the authoritative workspace runtime, and durable browser presentation rehydration.
- Added a native right-click pane menu for splitting browser panes right or down and closing them.
- Connected desktop settings across theme switching (`dark`, `light`, `system`), tab close confirmation gating, browser search engine templates, default workspace paths, and reactive Ghostty terminal font, cursor, and palette styling without relaunch.
- Added stored OAuth account management in settings, including lock/unlock, sibling failover, and account removal controls.
- Added the active-chat Local terminal drawer with a composer-controlled shell-only Ghostty PTY whose I/O stays outside OMP context.
- Added a header-controlled Show/Hide terminal action that preserves the chat PTY while hidden and closes it on restart, session destruction, or explicit close.
- Added session-scoped timeline follow and Jump to latest behavior that pauses when reading older activity and resumes only on explicit return to the bottom.
- Added Agent Hub and bounded Files inspectors beside chat, with retained-agent lifecycle controls, transcript access, safe read previews, and write/edit summaries.
- Added a unified, searchable settings shell with persistent workspace state, application UI preferences, and top-layer custom dropdowns for desktop-owned controls.
- Added host-owned multi-element selection queues with per-agent routing, retained output, queue progress, and an accessible docked renderer.

- Added composer file, image, and oversized-prompt attachments with trusted temporary staging, drag-and-drop, removable chips, vision transport, and cleanup on send, failure, and teardown.

- Added per-chat draft ownership: drafts stay with their chat across session switches, are restored on return, and never persist to disk.
- Added conversation deletion from the session rail with confirmation, active-chat fallback selection, and explicit disclosure that OMP transcript files remain on disk.
- Added a persistent retry-exhausted workspace error state with a Retry action (`GradivusApi.reconnectRuntime`).

### Changed

- Changed browser element selection to use a host-owned multi-element queue with deterministic agent swatches, explicit target-session routing, retained DOM/screenshot captures, and a single active BrowserView inspector.

- Changed the desktop theme to neutral black/white light and dark surfaces with restrained crimson selected, primary, destructive, error, brand, and inspector accents; green and amber remain semantic notice colors.
- Changed theme text and state treatment to use AAA contrast across readable surfaces, configured terminal colors, selected states, and required boundaries while preserving live `dark`, `light`, and `system` updates.
- Changed dark native and renderer neutral layers to the balanced charcoal ramp while preserving semantic colors, focus bands, and light-theme values.
- Changed ordinary neutral borders and agent swatch outlines to use the shared contrast-balanced `line` role (`#747474` dark / `#858585` light) while retaining secondary borders, semantic boundaries, and focus bands.
- Changed terminal PTYs, terminal output history, browser intent, and capability leases to be owned by one persistent workspace runtime daemon per Electron user-data root; normal desktop shutdown now disconnects presentation only.
- Changed desktop agent supervision to use an authenticated gRPC bidirectional stream over loopback HTTP/2 instead of child-process stdin/stdout framing.
- Limited native image generation to OpenAI API and ChatGPT/Codex subscription providers.
- Scoped browser navigation controls to browser panes; the chat terminal drawer never renders browser controls.
- Changed desktop session processes to a bounded three-runtime supervisor with FIFO admission, least-recently-used pressure eviction, and five-minute idle shutdown.
- Changed OMP chat turn tracking to reconcile prompt acknowledgements, asynchronous prompt results, local commands, steering, follow-ups, and background completions per session.

- Changed transcript history to render semantic, accessible system, IRC, advisor, activity, context, execution, and assistant-outcome entries, with severity-aware extension notifications.
- Changed the chat terminal drawer to a single composer-controlled shell surface with persistent PTY state, native terminal styling, and configured font/cursor/scrollback options.

- Fixed extension requests arriving while another chat is active being lost silently; pending requests now replay when returning to the originating chat.
- Fixed shell-level reconnect notices, disconnects, and browser action errors never rendering; retry exhaustion now shows a persistent recoverable error instead of silence.
- Fixed large reasoning disclosures implying a full record loads; previews disclose their 64 KiB bound and no longer double-truncate hydrated records.
- Fixed Send, Steer, Queue, Enter, and attachment staging acting against non-composable or stale-session chats; one authoritative admission predicate guards controls and handlers.
- Fixed successful steer and queue attachment batches being retained until teardown; they now release at admission acknowledgement and empty stores remove their temp directory.
- Fixed the Default root directory setting having no effect on new-workspace creation; it now seeds the folder picker after validation.
- Fixed auth provider discovery failures presenting a synthetic available provider; failures now show an explicit unavailable state with actionable copy and no sign-in affordance.
- Fixed the desktop unit suite failing to complete: unified tests on Vitest with bounded workers and removed an inspector wait busy-loop that starved workers.

### Fixed- Fixed RPC startup and reconnect ownership so dead children cannot publish ready, connect startup remains cancelable, and reconnect candidates close transactionally.
- Fixed packaged Electron journeys to launch the fused application through its DevTools endpoint without weakening production inspector fuses.
- Fixed ordinary optimistic chat turns to reconcile one canonical user item and isolate composer attachments across successful new-session creation.
- Fixed element-selection cancellation with generation-safe stale-result guards, transactional browser close behavior, and closed-pane cleanup.
- Fixed inline and chat execution results and errors to remain in the BrowserView card until acknowledged without detaching the native browser view.
- Fixed stale browser-bound updates during pane teardown from surfacing as unhandled renderer errors.
- Fixed the composer attachment-ready status lingering after its attachment is removed.
- Fixed Agent Hub and Files header controls to use readable text and toggle the inspector open or closed.
- Fixed internal developer, hidden custom/hook, and `todo_reminder` transcript entries leaking into desktop chat history while preserving visible custom messages and todo-clear status.

- Fixed `App.svelte` shortcut handler intercepting `Ctrl+W` in terminal/form fields.
- Fixed close operations (`closeBrowser`, `closeTab`, `closeTerminal`) tearing down resources before runtime confirmation.
- Fixed multi-pane split creation to atomically apply tab layout invariants.
- Fixed duplicate document synchronization during event batch delivery.
- Fixed stale incoming document URLs rolling back in-flight browser navigation.
- Fixed terminal failure states rendering as indefinite starting spinners.
- Fixed Bun workspace Electron discovery and Electron Forge's Vite 8 integration.
- Fixed overlapping provider-status refreshes and sign-in attempts stopping the shared authentication RPC process.
- Fixed Gradivus RPC sessions to expose native image generation as a direct tool instead of routing image requests through the generic xdev `write` surface.
- Fixed the new-tab menu being clipped or covered by an active native browser pane.
- Fixed OMP processes launched from the chat terminal drawer attaching only after a real session exists, using a terminal-scoped capability lease that is revoked on terminal replacement or close.
- Fixed workspace tabs using uniform widths that truncated titles instead of sizing to their full labels.
- Fixed development OMP executable resolution to fail fast with attempted paths and to resolve repository-root and `packages/desktop` launches to the built coding-agent binary.
- Fixed OMP chat state updates so running, ready, error, and stopped events update the active snapshot even when no timeline record is attached.
- Fixed prompt-result errors from locked OAuth accounts and other provider preflight failures to roll back optimistic chat turns, restore the draft, and keep recovery actions visible.
- Fixed chat-terminal presentation ordering so initial replay and startup errors reach the generated view, with monotonic offsets and cleanup after mount failure.
- Fixed live timeline updates stealing a manually scrolled viewport or entering a threshold dead zone while follow is paused.
- Fixed browser element inspection to preserve native surface bounds, prefer the click-time target over stale hover state, and use translucent theme-aware page highlights.
- Fixed BrowserView inspector cards, controls, queue dock, and state highlights following the shared dark/light theme palette instead of retaining stale dark-only colors.
- Fixed OMP Chat composer, modal, responsive rail, terminal, eyebrow, and toast styling regressions to use the semantic token contract and remain visible at compact sizes.

### Removed

- Removed the Electron-local terminal host, terminal bridge, and renderer-supplied terminal credential registration path.
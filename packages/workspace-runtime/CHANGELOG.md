# Changelog

## [Unreleased]

- Added the pure Workspace V1 reducer and application/schema contracts.
- Added immutable command application with authorization, revision, lifecycle, graph, and event ordering invariants.
- Added deterministic snapshot projection and typed effect intents for terminal, browser, agent, service, worktree, remote, and cleanup operations.

### Added

- Added atomic tab layout application to `terminal.open` and `browser.open` reducer mutations with automatic `grid` derivation for 3/4 panes.
- Added `onConnectionState` subscription to `WorkspaceClient` distinguishing requested from unexpected disconnects.
- Added runtime-owned terminal PTY sessions with bounded input, resize, output-history replay, transient subscriptions, and scoped child capabilities.
- Added `shell` and `args` validation to the `terminal.open` reducer allowlist and forwarded them to terminal process startup effects.
- Added an explicit runtime protocol revision to authenticated daemon handshakes so desktop clients can distinguish compatible resident runtimes from older ones.

### Changed

- Changed terminal effects and status transitions to execute in the authoritative daemon; desktop clients now disconnect without stopping durable panes or the runtime.
- Changed accepted terminal effects to execute exhaustively in reducer command order, chained per terminal resource, with visible failures instead of silently dropped or unsupported effect fallthrough.

- Changed queued element tasks to retain per-task agent role, capture mode, URL, and screenshot dimensions for authoritative sequential execution.

### Fixed

- Fixed close entity pane to automatically normalize `grid` tabs to `columns` when 2 panes remain.
- Fixed pre-readiness daemon startup failures to report spawn errors, child exits, and recent authenticated connection errors instead of only surfacing a generic readiness timeout.
- Fixed desktop startup reusing a resident daemon with an incompatible runtime protocol by orderly replacing it while preserving the persisted workspace document.

<p align="center">
  <img src="packages/desktop/resources/icon.png" width="132" alt="Gradivus logo">
</p>

<h1 align="center">Gradivus</h1>

<p align="center">
  A self-contained desktop command center for Oh My Pi.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-111111?logo=apple" alt="macOS Apple Silicon and Intel">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows11&logoColor=white" alt="Windows 10 and 11">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT License"></a>
</p>

Gradivus turns the OMP runtime into a focused Electron workspace. Chat with the agent, review its technical record, inspect changed files, follow subagents, and keep a real browser beside the conversation without installing a separate terminal harness.

[**Gradivus**](https://atlas.perseus.tufts.edu/dictionaries/entry/urn:cite2:scaife-viewer:dictionary-entries.atlas_v1:lat.ls.perseus-eng2-n19800/) is a Latin surname of Mars, probably from *gradior*: 'he who steps forth, marches out.' The name suits software that moves technical work forward.

The packaged application contains Electron, the renderer, the local workspace runtime, and a compiled OMP executable. End users do not need Bun, Node.js, or a separate OMP installation.

## What is inside

- **OMP Chat** for Work and Code sessions, streaming output, steering, follow-ups, interrupts, models, and thinking controls.
- **Reviewable technical history** with tool activity, reasoning, changed files, diffs, and session recovery.
- **Subagent visibility** with per-agent status and transcript inspection.
- **Integrated browser workspaces** with multiple tabs and split panes next to the chat.
- **Local-first state** for workspaces, sessions, credentials, and runtime files.
- **Contained desktop packaging** for macOS and 64-bit Windows 10/11.
- **Unified light and dark themes** across the desktop shell, OMP Chat, inspector, composer, dialogs, and settings.

## Build locally

Gradivus uses Bun 1.4.0 and Electron Forge.

From the repository root:

```sh
bun install --frozen-lockfile
```

Build the native addon that matches the current computer, then create the contained desktop artifact:

```sh
bun scripts/bazel-natives.ts host --dest packages/natives/native
bun --cwd=packages/desktop run make:contained
```

The local packaging command creates the following outputs:

| Platform | Output |
| --- | --- |
| macOS Apple Silicon | `Gradivus-macOS-arm64.zip` |
| macOS Intel | `Gradivus-macOS-x64.zip` |
| Windows 10/11 x64 | `GradivusSetup.exe` and a portable ZIP |

Generated files live in `packages/desktop/dist`.

> [!NOTE]
> Local development builds are unsigned. macOS may require **Open** from Finder's context menu, and Windows may display a SmartScreen warning.

## Develop

```sh
bun run desktop:start
```

Useful checks:

```sh
bun run desktop:check
bun run desktop:test
```

## Architecture

Gradivus is intentionally thin around OMP:

1. Electron owns the native window, security boundaries, file dialogs, browser views, and lifecycle.
2. The Svelte renderer presents OMP Chat, session history, settings, diffs, and browser workspaces.
3. A shared Gradivus theme supplies the shell and chat surfaces, foregrounds, borders, focus states, and accents for light and dark mode.
4. A local workspace runtime persists tabs, panes, profiles, and browser state.
5. The packaged OMP executable runs RPC sessions and streams events back into the desktop application.

## Project status

Gradivus is under active development. Local packaging produces contained macOS (`Gradivus.app`, packaged as a `Gradivus-<platform>-<arch>` root) and Windows builds with the OMP executable bundled into the application. Code signing, Apple notarization, automatic updates, store distribution, and hosted release automation remain separate release-engineering work.

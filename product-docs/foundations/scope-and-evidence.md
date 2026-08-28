# Scope and evidence

## Product surface

This documentation describes the **Gradivus desktop application** in full: the workspace shell, the browser workspace, OMP Chat, Settings, and the surfaces that connect to the OMP backend. It begins at app launch and includes:

- the workspace shell: launch, connection overlay, title bar, window controls, tab strip, the fixed chat tab, browser-tab lifecycle, global shortcuts, and the Settings route;
- the browser workspace: browser panes, splits, address-bar navigation, page loading, and persistence;
- element targeting and Page Agent delivery from the browser into OMP work;
- the OMP runtime connection: startup, on-demand chat runtimes, residency limits, failure cards, reconnect, and relaunch;
- workspace selection and chat-session navigation in OMP Chat;
- the composer, runtime picker, context meter, attachments, and slash commands;
- primary turns, streaming, steering, queued follow-ups, Stop, rollback, and recovery;
- the conversation transcript, paging, follow state, disclosures, tool activity, and semantic entries;
- Agent Hub, Files, current-diff review, and extension requests;
- the chat-local terminal drawer with its platform-selected terminal engines;
- Settings and provider/account flows; and
- in-app notifications and shell-level feedback.

Packaging, update delivery, the OMP terminal UI, SDK/RPC reference material, and internal workspace-runtime architecture are outside scope except where their behavior changes a documented surface.

## Default user and configuration

The baseline user is one local desktop user with a normal writable repository or folder. The baseline chat is a Work session. New chats currently default to Work; a Work/Code switch is not exposed in the renderer.

Code-established application defaults are:

| Concern | Default |
| --- | --- |
| Theme | Dark |
| Interface density | Comfortable |
| Reduce motion | Off, while the operating-system reduced-motion preference still applies |
| Transcript tool details | Shown |
| Browser-tab close confirmation | On |
| Terminal shell | Platform default: `cmd.exe` (`COMSPEC`) on Windows, `/bin/zsh` on macOS, `$SHELL` or `/bin/bash` on Linux |
| Terminal font size | 14 |
| Terminal font family | Cascadia Mono stack |
| Terminal cursor | Blinking bar |
| Terminal scrollback | 10,000 lines |
| Browser home page | `https://omp.sh` |
| Browser search | Google template |
## Units of interaction

The primary unit is a **conversation turn**: compose, submit, observe admission, follow extended activity, and finish or interrupt. Other feature-specific units are:

- one app launch of the workspace shell, from connecting overlay to quit;
- one browser-tab and pane lifecycle;
- one element-targeting delivery lifecycle;
- one workspace-picker and chat-session lifecycle;
- one attachment staging and admission lifecycle;
- one transcript-follow or disclosure lifecycle;
- one inspector review/action lifecycle;
- one Local terminal drawer lifecycle;
- one Settings mutation or provider-authentication lifecycle;
- one extension request; and
- one OMP runtime connection lifecycle across the app session.

## Evidence vocabulary

| Label | Meaning |
| --- | --- |
| **Observed** | Playwright drove the actual Electron shell and renderer in this checkout. |
| **Tested** | The named executable assertion was run successfully in this documentation pass. |
| **Test-specified** | The test was inspected but its runner did not complete successfully in this pass. |
| **Code-established** | Production code directly determines the state transition. |
| **Inference** | The conclusion follows plausibly from code but remains unobserved and unasserted. |
| **Open question** | Available evidence does not settle the behavior or desired product rule. |

A runtime fixture is valid evidence for visibility, focus, state, and renderer/main-process integration. It is not evidence for external provider behavior. Copied test-local state machines are design intent, not mounted renderer evidence.

## Source revision

- Revision anchor: `ac5f533bb245ef7f911dfc165c7c39356a2ac639` (feat: complete Gradivus identity and UI cutover)
- Evidence date: 2026-08-28
- Workstation: Windows x64 (this pass); macOS arm64 (2026-08-25 pass, before the Gradivus identity cutover and Page Agent/terminal-renderer changes)
- Working-tree boundary: the cross-platform terminal-renderer cutover and related desktop renderer, main-process, and test changes are modified or untracked on top of the anchor. This set therefore documents the working tree anchored at the commit above, not a clean checkout of that commit.

Every feature document ends with the same revision boundary. Update the anchor and re-run the affected journeys when behavior changes.

## Runtime evidence collected

The following commands exercised real Electron windows with isolated temporary user data on Windows x64 on 2026-08-28:

| Command | Result | What it establishes |
| --- | --- | --- |
| `bunx playwright test` (desktop and selection specs) | **36 passed** in 4.2 minutes (after the composer footer fix; the first run of the day was 35/36) | Shell, browser tabs, chat journeys, composer, attachments, transcript, settings, inspectors, terminal (including WASM failure recovery on the `wterm-dom` engine), themes, density, focus, Axe, and all eight selection journeys. The composer failure was [CHAT-012](../bug-triage.md#chat-012--the-composer-footer-loses-its-attachment-bar-at-narrow-widths), resolved the same day. |
| `GRADIVUS_REAL_OMP=1 bunx playwright test --config playwright.real.config.ts` | **1 passed** in 6.1 s | The compiled real OMP runtime boots through the Electron chat path and answers `/context`. |
| `bunx vitest run test/terminal-renderer-selection.test.ts test/theme-palette.test.ts` | **14 passed** | Platform-to-terminal-engine routing and shared terminal palette contrast guarantees. |
| `bun run check` | **clean** | Biome (93 files), TypeScript/Svelte types (37 files, 0 errors), and Sass accept the current tree. |

The fixture starts a real Electron main process and Svelte renderer, an isolated local workspace runtime, loopback gRPC, and a deterministic chat RPC process. It requires no external provider credentials or provider request for the seeded chat journey. It is not a total network sandbox: browser panes may still navigate HTTP/HTTPS and the launch environment begins from the parent environment before overriding user-data paths.

A direct launch outside the Playwright harness was not used as verification. The controlled Electron journeys are the runtime-observation source for this set.

## Verification blockers

- The package unit suite (`bun run test`) was not run end to end in this pass, so unit-only assertions are cited as **test-specified**. The 2026-08-25 pass recorded the suite completing 32 files / 226 tests after [CHAT-010](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete) was resolved; that claim has not been re-established on this tree.
- The composer geometry journey failed at narrow widths in the first run of the pass and was fixed within it ([CHAT-012](../bug-triage.md#chat-012--the-composer-footer-loses-its-attachment-bar-at-narrow-widths), resolved): the attachment shelf is back in the composer footer, right-aligning the runtime picker, context meter, and Send button. The final full-suite run is green.
- The port the e2e webServer uses (5173) was occupied by an unrelated local dev server on this workstation during the pass; the suite was executed against an equivalent fixture server port with the packaged app unchanged. This is an environment note, not a product behavior.

## Primary source map

| User-facing area | Production sources | Behavioral evidence |
| --- | --- | --- |
| Workspace shell and routing | `packages/desktop/src/renderer/ui/pages/App.svelte`, `ui/templates/WorkspaceShell.svelte`, `ui/molecules/WorkspaceTab.svelte`, `ui/molecules/WindowControls.svelte`, `src/main/main.ts` | `e2e/desktop.spec.ts` |
| Browser workspace | `ui/organisms/BrowserPane.svelte`, `ui/molecules/BrowserToolbar.svelte`, `ui/molecules/AddressForm.svelte`, `ui/atoms/BrowserSurface.svelte`, `src/main/workspace-host.ts` | `e2e/desktop.spec.ts`, `e2e/omp-selection.spec.ts`, `test/workspace-host-browser*.test.ts` |
| Element targeting and Page Agents | `src/main/workspace-host.ts`, `src/main/desktop-host.ts`, `src/shared/selection-agent.ts`, `ui/organisms/SelectionQueuePane.svelte` | `e2e/omp-selection.spec.ts`, `test/selection-flow.test.ts`, `test/workspace-host-selection.test.ts` |
| OMP runtime connection | `src/main/desktop-host.ts`, `src/main/rpc-process.ts`, `src/main/rpc-client.ts`, `src/main/runtime-supervisor.ts`, `src/main/runtime-reconnect.ts`, `src/main/backend-path.ts` | `e2e/desktop.spec.ts`, `e2e/real.spec.ts`, `test/rpc-*.test.ts`, `test/runtime-*.test.ts` |
| Chat state and orchestration | `packages/desktop/src/renderer/ui/pages/OmpChat.svelte` | `desktop.spec.ts`, `real.spec.ts`, `test/e2e-chat-progress.test.ts` |
| Session rail and persistence | `SessionRail.svelte`, `src/main/session-registry.ts`, `desktop-host.ts`, `runtime-supervisor.ts` | `test/session-registry.test.ts`, `desktop-host.test.ts`, `runtime-supervisor.test.ts` |
| Composer and attachments | `Composer.svelte`, `AttachmentChip.svelte`, `src/main/prompt-attachments.ts` | `desktop.spec.ts`, `test/prompt-attachments.test.ts` |
| Transcript and projection | `TimelineEntry.svelte`, `src/main/transcript-store.ts` | `desktop.spec.ts`, transcript projection tests |
| Terminal drawer | `ui/organisms/ChatTerminalDrawer.svelte`, `src/renderer/terminal/*`, `src/main/workspace-host.ts` | `desktop.spec.ts`, `test/terminal-renderer-selection.test.ts`, workspace-host terminal tests |
| Agent Hub and Files | `AgentHubPanel.svelte`, `FileActivityPanel.svelte`, `FileDiffInspector.svelte` | `desktop.spec.ts` |
| Settings and accounts | `SettingsShell.svelte`, `ApplicationSettingsPanel.svelte`, `src/main/app-settings.ts`, `desktop-host.ts` | `desktop.spec.ts`, `test/app-settings.test.ts` |
| Security and lifecycle | `src/main/main.ts`, `guards.ts`, `shutdown.ts` | desktop and workspace-runtime tests |

## Evidence limitations

- No passing mounted Electron journey forces an OMP chat process to disconnect and then verifies the visible **Reconnect** path, drives **Stop** to full abort reconciliation, severs the workspace daemon, crashes a chat child, or reproduces the silent launch exit (CHAT-014).
- The browser pane right-click menu labels exist but its actions are dead code paths (CHAT-013).
- The composer footer geometry was broken at the start of this pass (CHAT-012) and repaired within it; composer one-surface claims rest on the post-fix 36/36 run only.
- No multi-device, remote-human collaboration, operating-system notification, offline queue, or read-only workspace mode exists in the inspected product surface.
- Current-diff review is a live workspace diff, not a historical record of the tool operation that introduced the path.
- Runtime visibility established by Playwright does not settle subjective animation feel or every platform's native focus behavior; the macOS/Linux terminal-engine journey (LT-18) has not been rerun since the renderer cutover.

These limitations remain explicit in feature checklists and triage rather than being converted into guarantees.

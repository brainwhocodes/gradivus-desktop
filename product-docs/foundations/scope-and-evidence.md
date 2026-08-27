# Scope and evidence

## Product surface

This documentation describes the **OMP Chat** experience inside the Gradivus Electron desktop application. It begins when the workspace shell connects to its local workspace runtime and includes:

- the fixed OMP Chat tab and initial loading state;
- workspace selection and chat-session navigation;
- the composer, runtime picker, context meter, attachments, and slash commands;
- primary turns, streaming, steering, queued follow-ups, Stop, rollback, and recovery;
- the conversation transcript, paging, follow state, disclosures, tool activity, and semantic entries;
- Agent Hub, Files, current-diff review, and extension requests;
- the chat-local terminal drawer;
- Settings and provider/account flows that affect OMP Chat;
- in-app notifications; and
- browser element-selection delivery to OMP Chat.

Generic browser navigation and splitting are documented only where they interrupt or feed a chat interaction. Packaging, update delivery, the OMP terminal UI, SDK/RPC reference material, and internal workspace-runtime architecture are outside scope.

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
| Terminal font size | 14 |
| Terminal cursor | Blinking bar |
| Terminal scrollback | 10,000 lines |
| Browser home page | `https://omp.sh` |
| Browser search | Google template |

Provider, model, thinking level, runtime controls, and OMP defaults are supplied by the local OMP runtime. Fixture-backed runtime observations use deterministic fixture providers and models; they do not establish a real provider's latency, credentials, rate limits, or error wording.

## Units of interaction

The primary unit is a **conversation turn**: compose, submit, observe admission, follow extended activity, and finish or interrupt. Other feature-specific units are:

- a workspace-picker and chat-session lifecycle;
- one attachment staging and admission lifecycle;
- one transcript-follow or disclosure lifecycle;
- one inspector review/action lifecycle;
- one Local terminal drawer lifecycle;
- one Settings mutation or provider-authentication lifecycle;
- one extension request; and
- one browser-selection delivery lifecycle.

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

- Revision anchor: `c125341133ff90a29fe266e1b166bac0183338c8`
- Evidence date: 2026-08-25
- Workstation: macOS arm64
- Working-tree boundary: relevant desktop renderer, main-process, test, and E2E files were reported as modified or untracked during research. This set therefore documents the working tree anchored at the commit above, not a clean checkout of that commit.

Every feature document ends with the same revision boundary. Update the anchor and re-run the affected journeys when behavior changes.

## Runtime evidence collected

The following commands exercised real Electron windows with isolated temporary user data:

| Command | Result | What it establishes |
| --- | --- | --- |
| `bun run test:e2e:browser` from `packages/desktop` | **24 passed** in 2.2 minutes | OMP Chat shell, composer, attachments, transcript, settings, inspectors, terminal, themes, density, focus, and Axe journeys using the deterministic RPC fixture. |
| `bunx playwright test e2e/omp-selection.spec.ts` | **8 passed** in 35.4 seconds | BrowserView selection lifecycle and delivery into OMP Chat. |
| `GRADIVUS_REAL_OMP=1 bunx playwright test --config playwright.real.config.ts` | **1 passed** in 5.4 seconds | The compiled OMP runtime handles `/context` through the Electron chat path. Rerun post-cutover under the renamed variables: **1 passed** on macOS arm64. |

The fixture starts a real Electron main process and Svelte renderer, an isolated local workspace runtime, loopback gRPC, and a deterministic chat RPC process. It requires no external provider credentials or provider request for the seeded chat journey. It is not a total network sandbox: browser panes may still navigate HTTP/HTTPS and the launch environment begins from the parent environment before overriding user-data paths.

A direct launch outside the Playwright harness was not used as verification. The controlled Electron journeys are the runtime-observation source for this set.

## Verification blocker

`bun run test` in `packages/desktop` did not complete cleanly. Vitest reported 28 passed files, one failed `markdown-keywords.test.ts` import of `bun:test`, two unhandled worker exits, and a Node heap out-of-memory failure. This run is not treated as passing unit evidence. The blocker is tracked in [`bug-triage.md`](../bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).

The passing Electron journeys remain valid independent runtime evidence. Source unit tests are cited as **test-specified** unless their behavior is also covered by the passing Electron journeys.

## Primary source map

| User-facing area | Production sources | Behavioral evidence |
| --- | --- | --- |
| Workspace shell and chat route | `packages/desktop/src/renderer/ui/pages/App.svelte`, `WorkspaceShell.svelte` | `packages/desktop/e2e/desktop.spec.ts` |
| Chat state and orchestration | `packages/desktop/src/renderer/ui/pages/OmpChat.svelte` | `desktop.spec.ts`, `real.spec.ts`, `test/e2e-chat-progress.test.ts` |
| Session rail and persistence | `SessionRail.svelte`, `src/main/session-registry.ts`, `desktop-host.ts`, `runtime-supervisor.ts` | `test/session-registry.test.ts`, `desktop-host.test.ts`, `runtime-supervisor.test.ts` |
| Composer and attachments | `Composer.svelte`, `AttachmentChip.svelte`, `src/main/prompt-attachments.ts` | `desktop.spec.ts`, `test/prompt-attachments.test.ts` |
| Transcript and projection | `TimelineEntry.svelte`, `TimelinePresentation.svelte`, `src/main/transcript-store.ts`, `transcript-presentation.ts` | `desktop.spec.ts`, `test/transcript-projection.test.ts` |
| Agent Hub and Files | `AgentHubPanel.svelte`, `FileActivityPanel.svelte`, `FileDiffInspector.svelte` | `desktop.spec.ts` |
| Local terminal | `ChatTerminalDrawer.svelte`, `src/main/workspace-host.ts` | `desktop.spec.ts`, workspace-host terminal tests |
| Settings and accounts | `SettingsShell.svelte`, `ApplicationSettingsPanel.svelte`, `OmpChat.svelte`, `src/main/app-settings.ts`, `desktop-host.ts` | `desktop.spec.ts`, `test/app-settings.test.ts`, settings host tests |
| Browser selection to chat | browser pane/selection renderer and workspace-host selection sources | `e2e/omp-selection.spec.ts`, workspace-runtime selection tests |
| Security and lifecycle | `src/main/main.ts`, `guards.ts`, `shutdown.ts`, workspace-runtime client/store | desktop and workspace-runtime tests |

## Evidence limitations

- No passing mounted Electron journey forces an OMP chat process to disconnect and then verifies the visible **Reconnect** path.
- No passing mounted journey clicks **Stop** and verifies the full abort reconciliation contract.
- No runtime journey covers a pending extension request while the user switches chat, reloads the renderer, or exits the app.
- No real external provider sign-in, provider outage, multi-account failover, or locked-account failure was executed in this pass.
- No multi-device, remote-human collaboration, operating-system notification, offline queue, or read-only workspace mode exists in the inspected product surface.
- Current-diff review is a live workspace diff, not a historical record of the tool operation that introduced the path.
- Runtime visibility established by Playwright does not settle subjective animation feel or every platform's native focus behavior.

These limitations remain explicit in feature checklists and triage rather than being converted into guarantees.
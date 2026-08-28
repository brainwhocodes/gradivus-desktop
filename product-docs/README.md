# Gradivus desktop product description

This directory describes the **Gradivus desktop application** from the user's point of view: the workspace shell, the browser workspace, OMP Chat, Settings, and every surface that connects to the OMP backend. It is a behavior map, not API reference material or an implementation design. Each feature is documented as an externally observable state chart: what starts the interaction, what changes immediately, what remains pending, what is committed, and what the user sees when the interaction is interrupted.

## Scope

In scope:

- the workspace shell: launch, title bar, window controls, tab strip, the fixed chat tab, global shortcuts, and the Settings route;
- the browser workspace: browser tabs, panes, splits, address-bar navigation, and persistence;
- element targeting and Page Agent delivery from the browser into OMP work;
- the OMP runtime connection: startup, resident and dormant chat runtimes, residency limits, failure cards, reconnect, and persistence;
- the OMP Chat tab and its workspace/chat session rail;
- composer, runtime controls, context, slash commands, attachments, and active-turn controls;
- conversation transcript, semantic activity, history paging, follow state, and disclosures;
- changed-file review, Agent Hub, and extension requests;
- the chat-local terminal drawer, including its platform-selected terminal engines;
- Settings and provider/account flows; and
- feedback, errors, interruption, persistence, accessibility, security, and offline boundaries.

Out of scope except where they change a documented surface: packaging/release engineering, automatic updates, the terminal-only OMP CLI/TUI, SDK/API reference material, and internal architecture with no visible consequence.

The baseline is one local desktop user, a normal writable local folder, a Work session, and default machine-local settings. Variants are documented as modifiers.

## Source and verification boundary

- Revision anchor: `ac5f533bb245ef7f911dfc165c7c39356a2ac639` (feat: complete Gradivus identity and UI cutover)
- Evidence date: 2026-08-28
- Environment: Windows x64 (this pass); macOS arm64 (2026-08-25 pass, pre-cutover)
- Working tree: the cross-platform terminal-renderer cutover and related desktop changes are modified or untracked on top of the anchor. These documents describe that working tree, not a clean checkout of the commit alone.
| Journey | Result |
| --- | --- |
| `bunx playwright test` (desktop + selection specs) | 36/36 passed after the composer footer fix ([CHAT-012](./bug-triage.md#chat-012--the-composer-footer-loses-its-attachment-bar-at-narrow-widths), resolved in this pass; the pre-fix run was 35/36) |
| `GRADIVUS_REAL_OMP=1 bunx playwright test --config playwright.real.config.ts` | 1/1 passed — compiled real OMP runtime answers `/context` through the Electron chat path |
| `bunx vitest run test/terminal-renderer-selection.test.ts test/theme-palette.test.ts` | 14/14 passed |
| `bun run check` (Biome, types, Svelte, styles) | clean |

The fixture-backed journeys launch the actual Electron shell and renderer with isolated temporary user data and a deterministic local RPC fixture. They establish mounted visibility, focus, state, and feedback without requiring a real provider request. The real-runtime journey establishes startup through the packaged OMP path; it does not establish a real provider response.

The package unit suite was not run end to end in this pass; unit-only assertions are cited as **test-specified**. The 2026-08-25 pass records the suite completing 32 files / 226 tests after [CHAT-010](./bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete) was resolved; this pass did not re-run it.

Full evidence rules and source locations: [`foundations/scope-and-evidence.md`](./foundations/scope-and-evidence.md).

## How to read this set

1. Read [`glossary.md`](./glossary.md) for canonical terms, especially chat session versus workspace session.
2. Read [`foundations/experience-model.md`](./foundations/experience-model.md) for hierarchy, state, ownership, and commitment boundaries.
3. Read the feature document for the interaction being investigated.
4. Use the matching file under `verification/` to reproduce observable claims.
5. Check [`bug-triage.md`](./bug-triage.md) before treating a surprising code path as intended behavior.
6. Use cross-cutting documents only for rules shared by several features.

Future contributors should follow [`goal.md`](./goal.md), which fixes the evidence, section-order, interruption, cross-system, and verification contracts.

## Evidence conventions

| Label | Use |
| --- | --- |
| **Observed** | Seen while Playwright drove the actual Electron application in this checkout. |
| **Tested** | Established by an executable assertion that passed in this documentation pass. |
| **Test-specified** | Present in a test whose runner did not complete successfully here. |
| **Code-established** | Determined directly from production behavior branches. |
| **Inference** | Plausible but not observed or asserted. |
| **Open question** | Evidence or desired behavior remains unsettled. |

A feature is **verified** only when every P1 and P2 checklist claim has passed or its failure/gap is filed in [`bug-triage.md`](./bug-triage.md). Otherwise it is **drafted**. No feature is marked verified from source review alone.

## Coverage

| User-facing feature | Description | Verification | Status | Remaining boundary |
| --- | --- | --- | --- | --- |
| Workspace shell and tab navigation | [`features/workspace-shell-and-tab-navigation.md`](./features/workspace-shell-and-tab-navigation.md) | [`verification/workspace-shell-and-tab-navigation.md`](./verification/workspace-shell-and-tab-navigation.md) | drafted | Window controls, geometry persistence, single-instance, and mounted runtime-reconnect paths remain unverified. |
| Browser workspace | [`features/browser-workspace.md`](./features/browser-workspace.md) | [`verification/browser-workspace.md`](./verification/browser-workspace.md) | drafted | Address-bar branch rules, grid upgrade, relaunch persistence, popups, and error pages lack mounted coverage; the pane context menu is CHAT-013. |
| OMP runtime connection | [`features/omp-runtime-connection.md`](./features/omp-runtime-connection.md) | [`verification/omp-runtime-connection.md`](./verification/omp-runtime-connection.md) | drafted | Eviction, idle timeout, crash card, daemon loss, and silent launch exit (CHAT-014) remain unit-backed or code-established only. |
| Element targeting and Page Agent delivery | [`features/browser-selection-to-chat.md`](./features/browser-selection-to-chat.md) | [`verification/browser-selection-to-chat.md`](./verification/browser-selection-to-chat.md) | drafted | The Page Agent cutover changed this surface; provisioning, hidden-session inline, and cwd-based chat resolution have e2e coverage of outward effects but not a dedicated checklist pass. CHAT-002 remains the blocked shell-recovery item. |
| Workspaces and chat sessions | [`features/workspaces-and-chat-sessions.md`](./features/workspaces-and-chat-sessions.md) | [`verification/workspaces-and-chat-sessions.md`](./verification/workspaces-and-chat-sessions.md) | drafted | Relaunch, rename, dormant-runtime reopening, Stop, rail error/unseen, and mounted Reconnect remain unverified. Evidence last refreshed 2026-08-25. |
| Attachments | [`features/attachments.md`](./features/attachments.md) | [`verification/attachments.md`](./verification/attachments.md) | drafted | Exact boundary, teardown, clipboard-file/image, permission/disk, and active-turn retention decisions remain incomplete. Evidence last refreshed 2026-08-25. |
| Reviewing the conversation transcript | [`features/reviewing-the-conversation-transcript.md`](./features/reviewing-the-conversation-transcript.md) | [`verification/reviewing-the-conversation-transcript.md`](./verification/reviewing-the-conversation-transcript.md) | drafted | Large-reasoning disclosure remains filed as CHAT-004; P3 restart/disclosure questions remain explicit. Evidence last refreshed 2026-08-25. |
| Composing and controlling turns | [`features/composing-and-controlling-turns.md`](./features/composing-and-controlling-turns.md) | [`verification/composing-and-controlling-turns.md`](./verification/composing-and-controlling-turns.md) | drafted | Mounted Stop, OMP Reconnect, complete keyboard rules, timer/throughput, and modifier apply timing remain blocked. The composer footer geometry is restored and green (CHAT-012 resolved); the feature doc's evidence sections await their own refresh. Evidence last refreshed 2026-08-25. |
| Agent Hub | [`features/agent-hub.md`](./features/agent-hub.md) | [`verification/agent-hub.md`](./verification/agent-hub.md) | drafted | Failure, concurrency, paging, unread/background, and restart boundaries remain unverified. Evidence last refreshed 2026-08-25. |
| Extension requests and notifications | [`features/extension-requests-and-notifications.md`](./features/extension-requests-and-notifications.md) | [`verification/extension-requests-and-notifications.md`](./verification/extension-requests-and-notifications.md) | drafted | Mounted modal method/cancel/focus coverage is absent; inactive-chat loss is CHAT-001. Evidence last refreshed 2026-08-25. |
| Local terminal drawer | [`features/local-terminal-drawer.md`](./features/local-terminal-drawer.md) | [`verification/local-terminal-drawer.md`](./verification/local-terminal-drawer.md) | drafted | The renderer cutover is verified on Windows; the macOS/Linux engine journey (LT-18), workspace-cwd, resize-in-flight, renderer reload, and reconnect items remain blocked. |
| Settings and provider accounts | [`features/settings-and-provider-accounts.md`](./features/settings-and-provider-accounts.md) | [`verification/settings-and-provider-accounts.md`](./verification/settings-and-provider-accounts.md) | drafted | Search, reset/relaunch, validation, real auth/account mutation, and failure states remain blocked. Evidence last refreshed 2026-08-25. |

## Foundations

| Document | Purpose |
| --- | --- |
| [`foundations/scope-and-evidence.md`](./foundations/scope-and-evidence.md) | Product boundary, default configuration, evidence classes, revision, runtime results, source map, and evidence limitations. |
| [`foundations/experience-model.md`](./foundations/experience-model.md) | Visible hierarchy, state chart, object ownership, commitment timing, transcript model, and feedback taxonomy. |

## Cross-cutting behavior

| Document | Purpose |
| --- | --- |
| [`cross-cutting/interruption-recovery-and-persistence.md`](./cross-cutting/interruption-recovery-and-persistence.md) | Shared cancellation, failure, container ownership, relaunch, and recovery boundaries. |
| [`cross-cutting/security-privacy-and-connectivity.md`](./cross-cutting/security-privacy-and-connectivity.md) | Sandbox and permission policy, URL/file boundaries, credentials, local-first state, offline limits, and absence of multi-device sync. |
| [`cross-cutting/accessibility-focus-and-feedback.md`](./cross-cutting/accessibility-focus-and-feedback.md) | Keyboard and focus, live regions, semantic roles, contrast, themes, density, reduced motion, bounded content, and notification feedback. |
| [`cross-cutting/settings-scope-and-commit.md`](./cross-cutting/settings-scope-and-commit.md) | Application, active Runtime, OMP defaults, and Accounts scopes; mutation lifecycle, apply timing, persistence, and absence of undo. |

## Shared artifacts

| Document | Purpose |
| --- | --- |
| [`goal.md`](./goal.md) | Standing instructions and required contracts for future documentation work. |
| [`glossary.md`](./glossary.md) | Canonical product vocabulary and naming distinctions. |
| [`bug-triage.md`](./bug-triage.md) | Suspected defects, reproduction steps, severity, rationale, decisions, and resolution thresholds. |
| [`verification/`](./verification/) | One observable checklist per feature, with setup, steps, expected result, priority, environment, evidence, and pass/fail/blocked result. |

## Work order for updates

1. Establish the user-facing change and its owning feature.
2. Trace production state transitions and domain ownership.
3. Read the matching behavioral tests; reject copied harnesses as mounted proof.
4. Run the narrowest actual Electron journey that exercises visibility, timing, focus, and feedback.
5. Update the feature document's five phases, seven interruption classes, modifiers, cross-system concerns, edge cases, revision, and open questions.
6. Update observable checklist claims and Result fields.
7. Add or resolve triage entries instead of presenting uncertain behavior as intended.
8. Update this coverage table.
9. Validate local links, heading order, canonical terminology, evidence labels, and revision anchors.

## Documentation rules

- Describe behavior once at the user-facing point where it is encountered.
- Preserve surprising behavior and limits.
- Keep tests and runtime observations separate.
- Mark non-applicable cross-system concerns explicitly.
- Use `> Technical note:` only when an implementation fact changes user expectations.
- Do not present extension requests as durable transcript approvals.
- Do not present the Files diff as historical; it is the current working-tree diff.
- Do not call local agent/IRC activity remote-human collaboration.
- Do not call an OAuth routing lock encryption or workspace read-only state.
- Do not call the chat tab "OMP Chat" in quoted interface labels; its visible tab label is **Gradivus**.

# Gradivus OMP Chat product description

This directory describes the Electron **OMP Chat** experience from the user's point of view. It is a behavior map, not API reference material or an implementation design. Each feature is documented as an externally observable state chart: what starts the interaction, what changes immediately, what remains pending, what is committed, and what the user sees when the interaction is interrupted.

## Scope

In scope:

- the fixed OMP Chat tab and its workspace/chat session rail;
- composer, runtime controls, context, slash commands, attachments, and active-turn controls;
- conversation transcript, semantic activity, history paging, follow state, and disclosures;
- changed-file review, Agent Hub, and extension requests;
- the chat-local terminal drawer;
- Settings and provider/account flows that affect chat;
- OMP Chat feedback, errors, interruption, persistence, accessibility, security, and offline boundaries; and
- browser selection where it is captured and delivered to OMP Chat.

Out of scope except at a chat boundary: generic browser navigation and split layout, packaging/release engineering, automatic updates, terminal-only OMP CLI/TUI behavior, SDK/API contracts, and internal architecture that has no visible consequence.

The baseline is one local desktop user, a normal writable local folder, a Work session, and default machine-local settings. Variants are documented as modifiers.

## Source and verification boundary

- Revision anchor: `c125341133ff90a29fe266e1b166bac0183338c8`
- Evidence date: 2026-08-25
- Environment: macOS arm64
- Working tree: relevant desktop renderer, main-process, test, and E2E files were modified or untracked during research. These documents describe that working tree anchored at the revision above, not a clean checkout of the commit alone.

Executed Electron evidence:

| Journey | Result |
| --- | --- |
| `bun run test:e2e:browser` from `packages/desktop` | 24/24 passed |
| `bunx playwright test e2e/omp-selection.spec.ts` | 8/8 passed |
| `GRADIVUS_REAL_OMP=1 bunx playwright test --config playwright.real.config.ts` | 1/1 passed post-cutover under the renamed variables (macOS arm64) |

The fixture-backed journeys launch the actual Electron shell and renderer with isolated temporary user data and a deterministic local RPC fixture. They establish mounted visibility, focus, state, and feedback without requiring a real provider request. The compiled-runtime journey establishes `/context` through the packaged OMP path; it does not establish a real provider response.

`bun run test` in `packages/desktop` did not complete: 28 test files passed before a `bun:test` import failure under Vitest, worker exits, and a heap out-of-memory failure. Unit-only assertions are therefore **test-specified**, not passing evidence. See [CHAT-010](./bug-triage.md#chat-010--the-desktop-unit-test-command-does-not-complete).

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
| Workspaces and chat sessions | [`features/workspaces-and-chat-sessions.md`](./features/workspaces-and-chat-sessions.md) | [`verification/workspaces-and-chat-sessions.md`](./verification/workspaces-and-chat-sessions.md) | drafted | Relaunch, rename, dormant-runtime reopening, Stop, rail error/unseen, and mounted Reconnect remain unverified. |
| Composing and controlling turns | [`features/composing-and-controlling-turns.md`](./features/composing-and-controlling-turns.md) | [`verification/composing-and-controlling-turns.md`](./verification/composing-and-controlling-turns.md) | drafted | Mounted Stop, OMP Reconnect, complete keyboard rules, timer/throughput, and modifier apply timing remain blocked. |
| Attachments | [`features/attachments.md`](./features/attachments.md) | [`verification/attachments.md`](./verification/attachments.md) | drafted | Exact boundary, teardown, clipboard-file/image, permission/disk, and active-turn retention decisions remain incomplete. |
| Reviewing the conversation transcript | [`features/reviewing-the-conversation-transcript.md`](./features/reviewing-the-conversation-transcript.md) | [`verification/reviewing-the-conversation-transcript.md`](./verification/reviewing-the-conversation-transcript.md) | **verified** | Large-reasoning disclosure remains filed as CHAT-004; P3 restart/disclosure questions remain explicit. |
| Reviewing changed files | [`features/reviewing-changed-files.md`](./features/reviewing-changed-files.md) | [`verification/reviewing-changed-files.md`](./verification/reviewing-changed-files.md) | drafted | Deleted, renamed, binary, clean, unavailable, and error diff states lack mounted coverage. |
| Agent Hub | [`features/agent-hub.md`](./features/agent-hub.md) | [`verification/agent-hub.md`](./verification/agent-hub.md) | drafted | Failure, concurrency, paging, unread/background, and restart boundaries remain unverified. |
| Extension requests and notifications | [`features/extension-requests-and-notifications.md`](./features/extension-requests-and-notifications.md) | [`verification/extension-requests-and-notifications.md`](./verification/extension-requests-and-notifications.md) | drafted | Mounted modal method/cancel/focus coverage is absent; inactive-chat loss is CHAT-001. |
| Local terminal drawer | [`features/local-terminal-drawer.md`](./features/local-terminal-drawer.md) | [`verification/local-terminal-drawer.md`](./verification/local-terminal-drawer.md) | drafted | The tested shell surface differs from the documented Agent activity/Shell model; reconnect, resize, failure, and session ownership need mounted checks. |
| Settings and provider accounts | [`features/settings-and-provider-accounts.md`](./features/settings-and-provider-accounts.md) | [`verification/settings-and-provider-accounts.md`](./verification/settings-and-provider-accounts.md) | drafted | Search, reset/relaunch, validation, real auth/account mutation, and failure states remain blocked. |
| Browser selection to chat | [`features/browser-selection-to-chat.md`](./features/browser-selection-to-chat.md) | [`verification/browser-selection-to-chat.md`](./verification/browser-selection-to-chat.md) | **verified** | Filed workspace-failure behavior and P3 ownership/lifecycle questions remain explicit. |

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
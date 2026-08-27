# Security, privacy, and connectivity

## Scope

This document describes the shared trust boundary around OMP Chat: sandboxed Electron surfaces, denied web permissions, allowed URL and file transitions, credential handling, transcript disclosure, local persistence, network dependence, and the absence of cloud sync or multi-device behavior. It states user-visible consequences; feature-specific sign-in, attachment, extension-request, and browser-selection steps remain in their owning documents.

## Trust rules at a glance

| Rule | User-visible consequence | Evidence |
| --- | --- | --- |
| Electron web permissions are denied by default. | Embedded content does not receive camera, microphone, location, notification, or other Electron session permission grants, and Gradivus does not show a remembered per-site grant surface. | **Code-established:** `packages/desktop/src/main/main.ts:436-438`. No passing journey requested these permissions. |
| Renderer and embedded browser content are isolated from desktop privileges. | Web content cannot directly use Node integration or attach its own webviews. Main-window popups and navigation away from the app origin are denied. | **Code-established:** `packages/desktop/src/main/main.ts:402-432`; `packages/desktop/src/main/workspace-host.ts:1105-1111`. |
| External destinations pass an allowlist. | External launch accepts HTTPS, `mailto:`, and loopback HTTP only. Public HTTP, `file:`, and `javascript:` destinations are rejected. | **Code-established:** `packages/desktop/src/main/guards.ts:45-55`. **Test-specified:** `packages/desktop/test/session-registry.test.ts:149-154`, **“allows only explicitly safe external URL schemes”**; the unit command did not pass as a suite. |
| Workspace files remain inside the selected workspace. | **Open file** resolves the real workspace and target paths; a path escaping the workspace is rejected rather than opened. | **Code-established:** `packages/desktop/src/main/guards.ts:57-70`. |
| Credentials stay with the local OMP runtime. | Settings can show provider availability, connection state, and OAuth account identity, but does not expose stored access tokens. Sign-in moves through the provider's official external browser flow. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:3051-3144`; `packages/desktop/src/main/desktop-host.ts:1215-1350`. |
| Chat and settings persistence are machine-local. | Chat records, OMP history, workspace state, and application preferences are local files/services; no account-backed synchronization or device handoff is established. | **Code-established:** `packages/desktop/src/main/session-registry.ts:18-115,138-182`; `packages/desktop/src/main/app-settings.ts:103-174`; `packages/workspace-runtime/src/store.ts:96-225`. |
| Collaboration means local OMP participants. | Agent Hub agents, advisors, and IRC signals are not remote-human presence, shared drafting, or cloud co-editing. | **Code-established:** `packages/desktop/src/renderer/ui/organisms/AgentHubPanel.svelte:152-323`; `packages/desktop/src/main/transcript-presentation.ts:316-323,438-463,608-624`. |
| There is no offline submission queue. | Losing the provider or local runtime does not create a “send later” state. Recovery uses the prompt card, OMP-chat **Reconnect**, or automatic workspace-runtime reconnect. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2669-2677`; `packages/desktop/src/main/main.ts:233-334`. |

## Sandboxed surfaces and permission denial

The main OMP Chat renderer starts with context isolation, no Node integration, sandboxing, no webview attachment, and web security enabled. The main window denies new windows and blocks navigation away from the development origin or the packaged `gradivus://app` application origin (`packages/desktop/src/main/main.ts:402-432`). Embedded browser views use the same isolation posture (`packages/desktop/src/main/workspace-host.ts:1105-1111`).

A request or permission check against Electron's default session receives `false` (`packages/desktop/src/main/main.ts:436-438`). This is a global deny rule, not a prompt-the-user policy. Current evidence establishes no exceptions or remembered site-level grants.

Observable consequences and limits:

- A browser page cannot rely on Gradivus granting camera, microphone, geolocation, or native notification permission.
- The product provides no permissions dashboard in Settings.
- OMP extension confirmation is not an Electron site permission. It is an OMP-controlled modal request and the user's response is returned to OMP.
- Native notifications are effectively unsupported at this boundary; OMP Chat instead uses in-app notifications.
- **Open question:** the injected browser selection inspector's **Copy** action uses the page clipboard path. Whether a user-gesture clipboard write remains usable under the deny-all handler has not been runtime verified (`packages/desktop/src/main/workspace-host.ts:467`; `packages/desktop/src/main/main.ts:436-438`).

> Technical note: preload IPC is narrow and main-process handlers verify the sending frame before accepting privileged calls (`packages/desktop/src/main/main.ts:475-549,898-913`). This keeps the user-facing allowlists authoritative even if a web surface constructs its own message.

## URLs, browser transitions, and files

### Embedded browser addresses

The browser workspace accepts HTTP and HTTPS destinations. Plain search text is expanded through the configured search template, and an accepted popup target becomes a Gradivus browser pane under the same HTTP/HTTPS rule (`packages/desktop/src/main/workspace-host.ts:718-748,2722-2747`). These browser capabilities do not weaken the external-link allowlist.

### Leaving the application

Actions that launch the operating-system browser or mail client permit:

- HTTPS;
- `mailto:`; and
- HTTP only for `127.0.0.1`, `localhost`, or `[::1]`.

Other schemes and public HTTP are rejected (`packages/desktop/src/main/guards.ts:45-55`). Provider authentication uses this external safe-URL route. An extension `open_url` request attempts the same transition and is then answered as cancelled because the interaction moved outside OMP Chat (`packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2207-2212,2421-2433`).

### Files and workspace boundaries

Workspace file opening compares real paths, including resolved symbolic links, and rejects a target outside the real workspace (`packages/desktop/src/main/guards.ts:57-70`). This rule governs opening a file from OMP Chat; it is not a claim that OMP tools can only read or write inside the workspace. Tool authority and approval policy come from the local OMP runtime.

Attachments are copied into a temporary chat-owned store before admission. Generic files are delivered as trusted temporary-file references, images use native image input, and oversized prompts become temporary PROMPT attachments. Their limits and cleanup are owned by [Attachments](../features/attachments.md), not by the browser permission model.

Browser element selection has an explicit target chat and reports acceptance/error in the originating browser card. Its complete delivery lifecycle is in [Browser selection to chat](../features/browser-selection-to-chat.md).

## Credentials, accounts, and private input

Provider availability and accounts are supplied by OMP. The desktop presents four distinct concepts:

1. **Provider access** — Available, Connected, or Unavailable state returned by the local runtime.
2. **Browser sign-in** — an official provider authentication flow opened outside Gradivus.
3. **Private sign-in step** — password/one-time-code input rendered as a password field when OMP requests sensitive follow-up input.
4. **OAuth account routing lock** — a local routing pin, not encryption, a workspace lock, or read-only mode.

Provider/account status and identity cross into the desktop; the interface explicitly states that tokens remain in the local runtime (`packages/desktop/src/renderer/ui/pages/OmpChat.svelte:3051-3144`). No desktop API-key entry form was found. Whether API-key setup is intentionally runtime/CLI-only is an **Open question**.

Account actions are authoritative OMP mutations. Sign-out, routing lock, clearing a lock, and failover have no undo history. Removing a stored OAuth account requires native confirmation; the effect is locally destructive after confirmation (`packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1640-1735`). The account-lock/failover outcome when a locked credential is unavailable is not established by a passing runtime journey.

Authentication interruption has bounded behavior:

- one login operation is shared while active and provider actions are disabled;
- explicit cancellation sends an empty response and relies on OMP to surface the outcome;
- authentication/extension backdrops are not established as cancelable by Escape or backdrop click; and
- no real provider sign-in, token expiry, multi-account failover, or provider outage was executed for this documentation pass.

A separate high-severity source gap can make authentication discovery failure appear as an available, signed-out provider. It is tracked as [`CHAT-009`](../bug-triage.md#chat-009--auth-discovery-failure-can-look-like-an-available-provider) with evidence at `packages/desktop/src/main/desktop-host.ts:1226-1240`.

## Privacy of transcript and review surfaces

OMP Chat deliberately bounds or filters technical material before presentation:

- Work sessions remove most raw tool arguments, results, and technical details. Code sessions retain more detail (`packages/desktop/src/shared/projection.ts:1-27`).
- The **Transcript tool details** application preference hides activity summaries and argument badges, but does not hide changed-file/image rows or Code-session technical detail (`packages/desktop/src/renderer/ui/organisms/TimelineEntry.svelte:138-214`). It is a disclosure preference, not a redaction or access-control boundary.
- Tool results update one tool entry instead of producing a second result row. Read/write/edit previews are bounded, with explicit expansion where supported (`packages/desktop/src/main/transcript-store.ts:383-485`).
- Large Reasoning content has a known mismatch: the user can request the “full” record, but the renderer still truncates it. Do not treat that control as complete disclosure; see [`CHAT-004`](../bug-triage.md#chat-004--full-large-reasoning-remains-truncated).
- **View diff** reads the current working tree. It is review of present state, not an immutable record of what a particular tool changed (`packages/desktop/src/renderer/ui/organisms/FileDiffInspector.svelte:22-64`).
- Extension requests are live modal input and do not become ordinary transcript entries. A sensitive request masks current input, but durability of the outstanding request is not established.

The passing Electron journey **“renders semantic transcript messages”** (`packages/desktop/e2e/desktop.spec.ts:1748-1822`) observed hidden control/instruction payloads, bounded semantic presentations, and provider-error disclosure with no serious/critical Axe findings. It does not establish that arbitrary provider/tool output contains no secrets.

## Local-first persistence and connectivity

### Local durable data

The desktop writes application settings and chat-session metadata under the local Electron user-data boundary. OMP owns resumable transcript/session files, and the workspace runtime owns browser/terminal workspace state. A packaged or fixture launch does not imply cloud backup or encrypted-at-rest storage.

Application settings use a temporary file plus rename and serialize updates/reset (`packages/desktop/src/main/app-settings.ts:136-174`). Chat registry and workspace-authority repair/serialization are separate persistence models. The single-instance rule focuses an existing local app instance rather than opening a second one against the same user-data directory (`packages/desktop/src/main/main.ts:148-166`).

### Offline and degraded states

There is no `offline` badge, `navigator.onLine` workflow, offline queue, or deferred cross-device delivery in the inspected product. The practical boundaries are:

| Dependency | Available locally without that dependency | When unavailable |
| --- | --- | --- |
| External provider/network | Saved local settings, chat metadata, and already persisted OMP history may still exist. | New provider-backed work can fail into prompt recovery or provider-error feedback. Automatic retry is an OMP preference, not an offline queue. |
| Local OMP process/RPC | Desktop chat record and saved OMP session file remain. | The chat enters error and offers **Reconnect**. No passing Electron journey executed this recovery. |
| Local workspace runtime | The mounted renderer may retain live in-memory OMP Chat state temporarily. | The shell automatically retries the authority connection, but visible reconnect/exhaustion feedback is not currently rendered. See [`CHAT-002`](../bug-triage.md#chat-002--workspace-reconnect-and-outer-shell-errors-are-not-rendered). |
| Embedded-page network | OMP Chat and local state remain separate. | No custom browser offline page is established. |

Machine-local does not mean network-isolated. The fixture-backed Electron journey launches isolated temporary user data and a deterministic loopback chat RPC process without provider credentials, but browser panes can still navigate HTTP/HTTPS and the process inherits a parent environment before test overrides (`product-docs/foundations/scope-and-evidence.md:76-88`).

## Collaboration and multi-device limits

The observed product model is one local desktop user and local OMP participants:

- Agent Hub exposes retained agents/advisors, local messages, revive/kill rules, unread state, and history.
- The transcript can present IRC incoming, autoreply, and relay signals.
- Background completion stays with the originating local chat.

No source or passing journey establishes:

- remote-human presence or cursors;
- shared drafts or concurrent chat edits;
- account-backed chat/settings synchronization;
- cloud conflict resolution;
- device lists, device trust, handoff, or remote revocation;
- multi-device notification delivery; or
- native operating-system notifications.

These are unsupported/not applicable for the documented surface, not silently inferred future capabilities. The local workspace-authority revision/idempotence model protects local command processing; it is not a remote collaboration protocol.

## Owning feature documents

- Provider access, browser sign-in, private steps, account identity, routing lock, failover, and removal: [Settings and provider accounts](../features/settings-and-provider-accounts.md).
- OMP modal questions and in-app notification behavior: [Extension requests and notifications](../features/extension-requests-and-notifications.md).
- Temporary-file transport and cleanup: [Attachments](../features/attachments.md).
- Browser-to-chat target and delivery boundary: [Browser selection to chat](../features/browser-selection-to-chat.md).
- Agent/advisor read-only and local collaboration behavior: [Agent Hub](../features/agent-hub.md).
- Transcript disclosure and bounded content: [Reviewing the conversation transcript](../features/reviewing-the-conversation-transcript.md).
- Current-state diff review and file-opening boundary: [Reviewing changed files](../features/reviewing-changed-files.md).
- Chat records, resume files, and local folders: [Workspaces and chat sessions](../features/workspaces-and-chat-sessions.md).

## Revision and evidence limits

- Source revision: working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources may be modified or untracked relative to that commit.
- Evidence date and environment: 2026-08-25, macOS arm64.
- Runtime evidence: `desktop.spec.ts` **24/24 passed**, `omp-selection.spec.ts` **8/8 passed**, and `real.spec.ts` **1/1 passed**. Those journeys establish the named local Electron surfaces, not external-provider or hostile-site behavior.
- Separate test evidence: `bun run test` failed. Unit-only assertions about URL rejection, persistence, reconnection, and settings are **test-specified**, not passing evidence.
- Evidence limits: no mounted journey requested browser permissions, attempted hostile renderer IPC, completed real provider authentication, exercised provider outage or account failover, audited credentials at rest, forced OMP/workspace-runtime disconnection, or used a second device. Security controls in those areas are **Code-established**; user-visible recovery remains **Open question** where stated.

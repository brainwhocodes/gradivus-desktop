# Settings scope and commit

## Scope

This document defines the shared Settings model for OMP Chat: which container owns each value, what is captured by a mutation, when a change applies, what survives relaunch, how pending/error feedback behaves, and why closing Settings is not undo. The four user-facing containers are **Application**, **Runtime**, **OMP defaults**, and **Accounts**. Individual control wording and provider flows remain in the owning feature documents.

## The four settings containers

| Container | User-visible owner | Applies to | Persistence and timing | Availability | Evidence |
| --- | --- | --- | --- | --- | --- |
| **Application** | This Gradivus installation | Theme, density, reduce motion, transcript detail, browser-tab behavior/defaults, terminal presentation/defaults, and the stored default path | Machine-local settings file. Most visual changes apply immediately after persistence; some defaults affect the next browser navigation or terminal process. | Available from the workspace shell. Each control is disabled while its own mutation is pending; Reset is disabled while any application mutation is pending. | **Code-established:** `packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:11-216`; `packages/desktop/src/renderer/ui/pages/App.svelte:135-271,410-458`; `packages/desktop/src/main/app-settings.ts:13-174`. |
| **Runtime** | Active chat session | Current provider, model, thinking level, fast mode, queue/interrupt behavior, compaction, and automatic retry when exposed | Active-session mutation. The runtime returns the authoritative current snapshot. | Only meaningful for the active, composable chat; stopped/error sessions require opening/resuming/reconnecting as applicable. | **Code-established:** `packages/desktop/src/shared/contracts.ts:49-137`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2827-3017`. |
| **OMP defaults** | Local OMP runtime | Runtime-reported defaults for appearance, model, interaction, context, files, shell, tools, and tasks | Each runtime-reported setting declares **Immediate** or **Next session** apply timing. The desktop does not invent unsupported values. | Can be queried through an active ready chat or a short-lived local OMP settings connection. | **Code-established:** `packages/desktop/src/shared/contracts.ts:49-92`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1475-1506,3018-3041`; `packages/desktop/src/main/desktop-host.ts:1263-1310,2037-2125`. |
| **Accounts** | Local OMP provider access | Provider availability/sign-in, local OAuth account routing lock, account failover, sign-out, and account removal | OMP is authoritative. Provider status and account identity return to the desktop; credentials remain in the local runtime. | Provider actions are disabled while authentication is busy; account actions depend on the returned provider/account capabilities. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1640-1735,1837-1887,2206-2275,3051-3144`; `packages/desktop/src/main/desktop-host.ts:1215-1350`. |

The container is part of the product contract. A similarly named value in another container is not an override of the same record unless the interface explicitly says so.

## Application defaults

Code establishes these defaults for a fresh local settings file:

| Concern | Default |
| --- | --- |
| Theme | Dark |
| Interface density | Comfortable |
| Reduce motion | Off; the operating-system reduced-motion preference still applies |
| Transcript tool details | Shown |
| Browser-tab close confirmation | On |
| Terminal shell | Platform-specific default |
| Terminal font size | 14 |
| Terminal cursor | Blinking bar |
| Terminal scrollback | 10,000 lines |
| Browser home page | `https://omp.sh` |
| Browser search | Google search template |

Source: `packages/desktop/src/main/app-settings.ts:13-40`. The test `packages/desktop/test/app-settings.test.ts:7-150` specifies defaults, persistence/reload, reset, serialized concurrent writes, detached snapshots, and corrupt-file recovery; because `bun run test` failed, its unit-only assertions remain **test-specified**.

Provider, model, thinking level, runtime controls, and OMP-default choices are not application defaults. They are supplied by the local OMP runtime.

## Application mutation lifecycle

An application mutation follows one externally visible sequence:

```text
current value
  → control disabled + “Saving <label>…”
  → persisted snapshot
  → immediate or future-use application
  → “<label> updated.”
```

On failure, the prior snapshot remains active and Gradivus shows error feedback. Mutations are serialized, so two quick changes do not write competing files in parallel. Only the latest mutation status is displayed (`packages/desktop/src/renderer/ui/pages/App.svelte:174-271`).

The main process writes the complete settings snapshot to a temporary JSON file and renames it into place. Update and reset operations share the same serialized queue (`packages/desktop/src/main/app-settings.ts:103-174`).

> Technical note: the desktop applies a detached snapshot returned by the main process rather than trusting the control's local value. This is why a failed write keeps the previous application state even if the control briefly represented a requested change.

### Navigation during a mutation

Closing Settings is not cancellation. A queued application mutation continues, and a successful persisted value remains in effect after the user returns to the workspace. Reopening Settings reads the latest visible snapshot/status rather than rolling back to the value present when the route first opened (`packages/desktop/src/renderer/ui/pages/App.svelte:174-271,459-503`).

The passing Electron test **“reopens settings after a delayed refresh closes”** verifies that pending account-refresh state is not applied to a stale closed route and that reopening can later receive the current result (`packages/desktop/e2e/desktop.spec.ts:1384-1408`). The related test **“detaches the active browser view while routed settings are open”** verifies that Settings temporarily detaches the native browser view and reattaches the same browser identity/URL/tab selection on return (`packages/desktop/e2e/desktop.spec.ts:1409-1458`).

## Apply timing by application preference

| Preference | Apply timing | Observable boundary |
| --- | --- | --- |
| Theme | Current application after persistence | Renderer tokens, native window/browser backgrounds, Local terminal palette, and active browser-selection inspector update. System follows later OS scheme changes. Sources: `packages/desktop/src/renderer/ui/pages/App.svelte:135-171`; `packages/desktop/src/main/workspace-host.ts:854-864`. |
| Interface density | Current application after persistence | Root density changes immediately. Comfortable/Compact remains a layout preference, not per-chat state. |
| Reduce motion | Current application after persistence | App motion is reduced immediately; OS `prefers-reduced-motion` applies independently (`packages/desktop/src/renderer/styles/_foundation.scss:101-117`). |
| Transcript tool details | Current transcript presentation | Activity summaries and argument badges are shown/hidden. It does not erase transcript history or change Code-session technical disclosure. |
| Confirm browser-tab close | The next applicable browser-tab close | It applies to browser tabs, not chat-session Stop, app-window close, or terminal exit (`packages/desktop/src/renderer/ui/pages/App.svelte:496-503`). |
| Terminal font family/size, cursor style/blink, scrollback | Current open Local terminal plus future terminals where supported | The drawer updates presentation live. Scrollback remains a retained-line limit, not durable chat history (`packages/desktop/src/renderer/ui/organisms/ChatTerminalDrawer.svelte:35-43`; `packages/desktop/src/main/workspace-host.ts:1367-1450`). |
| Terminal shell | Newly opened terminal process | It does not replace the shell of an already-running PTY (`packages/desktop/src/main/workspace-host.ts:1367-1450`). |
| Browser home page | New browser tabs/splits | Existing pages retain their URL. |
| Browser search template | Later plain-text browser navigation | Existing browser history and current pages do not change. |
| Default root directory | Current code uses it as a Local terminal cwd fallback | The visible copy says it is the root for new workspaces, but new workspace creation still opens a directory picker. Treat the mismatch as suspected, not as the intended rule; see [`CHAT-008`](../bug-triage.md#chat-008--default-root-directory-does-not-set-the-new-workspace-default). |

Theme and density were **Observed/Tested** in the passing 24-test Electron journey. The core test `packages/desktop/e2e/desktop.spec.ts:179-225`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys”**, opens Settings, observes focused search, chooses Compact, visits Accounts, and returns to the composer. `packages/desktop/e2e/desktop.spec.ts:1823-2130`, **“applies AAA neutral palettes in dark and light modes”**, exercises Dark, Light, System, OS scheme updates, and native/renderer/terminal surfaces.

## Runtime settings belong to the active chat

The **Runtime** container changes current chat behavior, not application-wide defaults. The active chat's OMP runtime reports available provider/model/thinking choices and accepts the mutation. The compact Runtime disclosure beside the composer is the same user-visible scope: it summarizes the active provider, model, and thinking level rather than storing application preferences.

Externally observable rules:

- selecting a new chat changes the runtime snapshot and controls to that chat;
- an inactive chat's running/completion state remains owned by that chat rather than becoming the new active Runtime scope;
- active-session controls can be unavailable while the selected chat is starting, stopping, loading, errored, or otherwise non-composable;
- an error chat uses **Reconnect** to resume its saved OMP session before ordinary active settings can be relied upon; and
- returned OMP state is authoritative if the requested value cannot be applied.

The passing test `packages/desktop/e2e/desktop.spec.ts:228-306`, **“keeps the runtime summary and disclosure usable at both densities”**, changes provider, model, and thinking level, observes the updated summary, closes with Escape, and verifies focus return in Comfortable and Compact density. It does not establish persistence after relaunch, a mutation during an active turn, or a real provider's accepted choices.

A stale draft can currently leave **Send** appearing actionable while `canCompose` is false. Runtime-scope action availability therefore has a high-severity suspected gap: [`CHAT-005`](../bug-triage.md#chat-005--send-can-remain-actionable-while-the-chat-cannot-compose).

## OMP defaults and declared apply timing

**OMP defaults** is a runtime-described settings inventory. The desktop supports the visible tabs Appearance, Model, Interaction, Context, Files, Shell, Tools, and Tasks, but it does not define their complete schema or semantics. A setting's label, description, choices, current/default value, and apply timing come from OMP (`packages/desktop/src/shared/contracts.ts:49-92`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1475-1506,3018-3041`).

| Apply timing | User expectation |
| --- | --- |
| **Immediate** | The runtime accepts the value for current behavior without a next-session badge. The exact affected work remains defined by that OMP setting. |
| **Next session** | Settings shows **Next session** and success copy **Starts with the next session**. The active chat is not silently rewritten to behave as though it started with the new default. |

If a ready chat exists, its OMP client carries the mutation. Otherwise the desktop can use a short-lived local OMP connection to query/update defaults (`packages/desktop/src/main/desktop-host.ts:1263-1310`). That implementation detail does not turn OMP defaults into application settings.

Unsupported categories are filtered instead of being rendered as nonfunctional controls (`packages/desktop/src/main/desktop-host.ts:2037-2125`). No passing mounted journey exercised the complete OMP-default inventory, immediate/next-session badge, invalid runtime value, or persistence through a new session. Those claims are **Code-established**.

## Accounts and provider access

**Accounts** is a local OMP access surface, not cloud synchronization for Gradivus.

Visible states and actions include:

- provider Available, Connected, or Unavailable;
- **Sign in** through the provider's external browser flow;
- private password/one-time-code follow-up input when requested;
- **Sign out**;
- OAuth account identity/status without token disclosure;
- **Lock** or **Clear lock** for the OAuth account routing lock;
- one global account-failover toggle; and
- destructive local account removal after native confirmation.

Provider actions are disabled while an authentication operation is busy. One in-progress sign-in promise is shared rather than launching duplicate browser flows (`packages/desktop/src/main/desktop-host.ts:271-281`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2237-2259,3078-3082`).

The runtime returns the authoritative provider/account snapshot after each action. There is no settings undo for sign-in, sign-out, lock, failover, or removal. Removal confirmation prevents accidental activation but does not create a restoration history.

The passing core journey observed the **Accounts** category, **Provider access**, and a fixture ChatGPT Plus/Pro provider (`packages/desktop/e2e/desktop.spec.ts:219-221`). It did not authenticate a real provider, exercise sign-out/removal, lock an account, force failover, or verify unavailable-account precedence. A source fallback can also make auth discovery failure look like an available provider; see [`CHAT-009`](../bug-triage.md#chat-009--auth-discovery-failure-can-look-like-an-available-provider).

## Persistence, validation, reset, and no undo

### Persistence

After a successful Application write, the complete normalized snapshot is machine-local and intended to survive relaunch. Runtime/OMP-default/account persistence belongs to OMP and is not proven by the application settings file. Ephemeral success/error labels do not become a settings history.

### Validation

Application settings normalize closed enums and booleans. Terminal font size clamps to 8–48 and scrollback clamps to 500–100,000. Shell, font, path, homepage, and search-template strings are trimmed/nonempty, but executable existence, directory existence, and URL/template usability are not all validated when the value is saved (`packages/desktop/src/main/app-settings.ts:45-100`).

Therefore a value can persist successfully and fail only when later used—for example, a nonworking shell, directory, homepage, or search template. No passing mounted journey exercised those delayed-use failures.

### Reset

**Reset application defaults** is a new serialized persisted mutation. It is disabled while any application setting is busy, reapplies the fresh defaults on success, and reports status/error like any other write (`packages/desktop/src/renderer/ui/organisms/ApplicationSettingsPanel.svelte:68-88`; `packages/desktop/src/renderer/ui/pages/App.svelte:174-271`). It does not restore a prior personalized snapshot after another action.

### No undo or redo

There is no settings transaction, Apply button, Cancel-to-roll-back, undo stack, redo stack, or account-action history. The externally observable commit point is the successful authoritative response:

| Action | Before commit | After commit | On failure | Undo |
| --- | --- | --- | --- | --- |
| Application update | Requested control disabled; saving status | Persisted normalized snapshot and applicable live/future effect | Prior snapshot retained; error feedback | None |
| Reset application defaults | Reset and controls respect busy state | Fresh defaults persisted and reapplied | Prior snapshot retained | None |
| Runtime update | Active control pending/disabled as implemented | OMP-returned active-session state | Existing runtime snapshot remains; action error | None |
| OMP-default update | Runtime-described control pending | Returned value plus Immediate/Next-session success meaning | Existing value remains; action error | None |
| Account/auth action | Provider/account controls busy | Returned provider/account snapshot | Existing snapshot plus auth/action feedback | None; removal alone requires confirmation |

Closing Settings changes only the route and focus. It is never a rollback operation.

## Owning feature documents

- Complete Settings navigation, application preferences, provider sign-in, account lock/failover/removal, and visible status copy: [Settings and provider accounts](../features/settings-and-provider-accounts.md).
- Active-turn implications of Runtime controls and non-composable states: [Composing and controlling turns](../features/composing-and-controlling-turns.md).
- Runtime ownership while selecting, opening, resuming, or reconnecting a chat: [Workspaces and chat sessions](../features/workspaces-and-chat-sessions.md).
- Transcript-detail preference and its disclosure consequences: [Reviewing the conversation transcript](../features/reviewing-the-conversation-transcript.md).
- Terminal presentation, shell lifetime, scrollback, and default-directory behavior: [Local terminal drawer](../features/local-terminal-drawer.md).
- Notification roles and extension modal input during provider/runtime work: [Extension requests and notifications](../features/extension-requests-and-notifications.md).

## Revision and evidence limits

- Source revision: working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources may be modified or untracked relative to that commit.
- Evidence date and environment: 2026-08-25, macOS arm64.
- Runtime evidence: `desktop.spec.ts` **24/24 passed**, `omp-selection.spec.ts` **8/8 passed**, and `real.spec.ts` **1/1 passed**. Settings-specific passing paths are named above.
- Separate test evidence: `bun run test` failed. `app-settings.test.ts`, settings-search tests, host-setting tests, and unit palette assertions are **test-specified** where the passing Electron journeys do not cover them.
- Evidence limits: no passing mounted journey verified application-settings relaunch, corrupt-settings recovery copy, reset during a pending write, invalid shell/path/URL/template use, every Settings search keyboard path, real provider authentication, OAuth routing-lock/failover precedence, account removal, or OMP-default Immediate/Next-session behavior. Those remain **Code-established**, **Inference**, or **Open question** as labelled and are linked to [`bug-triage.md`](../bug-triage.md).

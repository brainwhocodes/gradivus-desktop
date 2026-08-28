# Accessibility, focus, and feedback

## Scope

This document defines the accessibility behavior shared across OMP Chat: keyboard admission and Escape ownership, focus movement and return, semantic roles and live regions, visual contrast, theme/density/motion preferences, bounded content, responsive behavior, and notification feedback. It records verified paths and known gaps without replacing the detailed feature interactions.

## Interaction rules at a glance

| Rule | Externally observable consequence | Evidence |
| --- | --- | --- |
| Keyboard actions follow the currently visible control state. | Enter sends when idle and steers an active turn; Shift+Enter inserts a line break; IME composition does not trigger submission. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1725-1780`. **Tested:** `packages/desktop/e2e/desktop.spec.ts:1707-1747`, **“routes Enter to steering while a turn is active”**. |
| Escape belongs to the innermost dismissible surface. | Slash/action menus close first; Runtime/Context disclosures close and return focus; Settings clears a query before closing; a second Settings Escape returns to the workspace. | **Code-established:** `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1725-1780`; `packages/desktop/src/renderer/ui/molecules/RuntimePicker.svelte:1-142`; `packages/desktop/src/renderer/ui/organisms/ContextMeter.svelte:1-112`; `packages/desktop/src/renderer/ui/organisms/SettingsShell.svelte:69-128,132-215`; `packages/desktop/src/renderer/ui/pages/App.svelte:459-503,619-638`. |
| Focus returns to the control that opened a temporary surface where explicitly implemented. | Closing Settings, Runtime, Context, About, Files diff, or the action menu does not strand focus in removed content. | **Code-established:** `packages/desktop/src/renderer/ui/pages/App.svelte:459-503`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:764-767,2445-2448`; disclosure and menu components. **Tested:** relevant paths in `packages/desktop/e2e/desktop.spec.ts:228-306,1513-1607`. |
| Status and errors have distinct semantics. | Non-urgent info/success notification copy is announced as status; warning/error is announced as alert. Every notification can be dismissed. | **Code-established:** `packages/desktop/src/renderer/ui/molecules/Toast.svelte:1-27`. **Tested:** warning dismissal in `packages/desktop/e2e/desktop.spec.ts:1748-1822`, **“renders semantic transcript messages”**. |
| Themes and density change the current interface. | Dark, Light, System, Comfortable, and Compact update the active desktop surface rather than waiting for relaunch. | **Code-established:** `packages/desktop/src/renderer/ui/pages/App.svelte:135-171,410-458`. **Tested:** `packages/desktop/e2e/desktop.spec.ts:179-225` and `:1823-2130`. |
| Reduced motion has both app and operating-system inputs. | The app preference and the OS reduced-motion preference shorten transitions and disable smooth scrolling; a narrow reduced-motion composer remains usable. | **Code-established:** `packages/desktop/src/renderer/styles/_foundation.scss:101-117`. **Tested:** `packages/desktop/e2e/desktop.spec.ts:1021-1057`, **“keeps file drag overlay accessible and overflow-safe at narrow reduced-motion settings”**. |
| Long or technical content is bounded by default. | Transcript summaries, IRC/advisor/custom/context/execution entries, tool previews, diff previews, and the composer use caps/disclosures rather than forcing unbounded layout. | **Code-established:** `packages/desktop/src/main/transcript-presentation.ts:127-653`; `packages/desktop/src/main/transcript-store.ts:383-485`; `packages/desktop/src/renderer/ui/organisms/FileDiffInspector.svelte:22-64`; `packages/desktop/src/renderer/ui/organisms/Composer.svelte:1-337`. |

## Keyboard and focus ownership

### Composer and active turn

- Empty Enter performs no product action. Idle Enter invokes **Send**; active-turn Enter invokes **Steer**. Shift+Enter remains text input, and IME composition bypasses the shortcut (`packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1725-1780`).
- The slash menu uses Arrow Up/Down with wraparound, Escape to dismiss, Tab to insert the selected command, and Enter to insert or submit according to exact command matching (`packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1725-1780`; `packages/desktop/src/renderer/command-search.ts:4-42`).
- **More actions** exposes **Queue for next turn**. Escape closes the menu and restores focus to the trigger (`packages/desktop/src/renderer/ui/organisms/Composer.svelte:286-333`).
- Attachment removal is a labelled button and is keyboard activatable. The passing composer journeys exercise keyboard removal and Escape behavior at comfortable/compact densities and narrow widths (`packages/desktop/e2e/desktop.spec.ts:466-973,1021-1057`).
- No explicit focus move is implemented after a normal turn completes, a chat is selected, a new chat is created, or a welcome suggestion fills the draft. The user's actual focus after those transitions is an **Open question** rather than a documented return guarantee.

### Settings

Opening Settings autofocuses **Search settings**. Selecting a category moves focus to that category heading. Search changes update a polite result-count announcement and show a no-results state when appropriate (`packages/desktop/src/renderer/ui/organisms/SettingsShell.svelte:69-128,132-215`).

Escape follows two stages:

1. when Search contains a query, the first Escape clears it and keeps Settings open;
2. with no query to clear, Escape closes Settings and focus returns to the invoking workspace control (`packages/desktop/src/renderer/ui/organisms/SettingsShell.svelte:102-128`; `packages/desktop/src/renderer/ui/pages/App.svelte:459-503,619-638`).

The passing core journey observed Search initially focused, category selection, a density change, navigation to Accounts, Settings close, and return to a usable composer (`packages/desktop/e2e/desktop.spec.ts:179-225`, **“runs current OMP Chat feedback, recovery, local command, folder creation, settings, and Axe journeys”**). It did not execute keyboard navigation through every Settings control or run a dedicated open-Settings Axe audit.

### Disclosures, inspectors, and dialogs

- Runtime and Context disclosures expose `aria-expanded`/`aria-controls`; Escape closes and restores trigger focus. The passing Electron test **“keeps the runtime summary and disclosure usable at both densities”** covers these transitions (`packages/desktop/e2e/desktop.spec.ts:228-306`).
- Agent Hub and Files controls carry open/close labels. The passing inspector journey activates the surfaces, opens a retained-agent transcript and a file diff, closes by keyboard, checks focus behavior, and includes a modal Axe pass (`packages/desktop/e2e/desktop.spec.ts:1513-1607`, **“opens Agent Hub and Files inspectors with fixture lifecycle and activity controls”**).
- About and file-diff close paths explicitly restore their invoking controls (`packages/desktop/src/renderer/ui/pages/App.svelte:470-493`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:764-767,2445-2448`).
- Generic extension/auth dialogs do not establish initial focus, a focus trap, or Escape/backdrop cancellation. They depend on explicit buttons, and select requests can lack a general Cancel action (`packages/desktop/src/renderer/ui/molecules/ModalShell.svelte:1-83`; `packages/desktop/src/renderer/ui/pages/OmpChat.svelte:2206-2275,3147-3150`). This is a likely accessibility and interruption gap, not a verified modal contract.
- The workspace tab strip does not establish roving-tab or Arrow-key navigation, and the browser close affordance is not established as an independent keyboard action (`packages/desktop/src/renderer/ui/molecules/WorkspaceTab.svelte:23-70`). OMP Chat itself remains the fixed, non-closeable tab.

## Semantic structure and live feedback

### Regions, labels, and roles

The product uses named controls and semantic regions rather than relying only on icons:

- the composer textarea is labelled **Message OMP**;
- the central history is exposed as the conversation transcript;
- Runtime and Context are disclosure buttons;
- Agent Hub, Files, Local terminal, changed-file actions, attachment removal, Stop, and notification dismissal have action labels; and
- transcript entries preserve semantic identity such as user, assistant, Reasoning, tool, system, IRC, advisor, execution, and provider-error presentations.

The mounted semantic-transcript journey observed accessible system/IRC/advisor/job/diagnostic/execution/provider-error rows, expandable details, hidden internal instruction/control payloads, no horizontal overflow, and no serious/critical Axe findings (`packages/desktop/e2e/desktop.spec.ts:1748-1822`). This does not substitute for a screen-reader reading-order audit.

### Live regions and urgency

| Feedback | Semantic behavior | Lifetime |
| --- | --- | --- |
| Active-turn state | A visible live status reports generation/reasoning/activity while Stop remains available. | While the turn is active. |
| Settings search count | Polite live status announces the number of matching settings. | While Settings search changes. |
| In-app info/success notification | `role=status`. | Singleton until dismissed or replaced by a later notice. |
| In-app warning/error notification | `role=alert`. | Singleton until dismissed or replaced. |
| Attachment staging/error | Visible status/error copy remains near the composer; atomic rejection preserves prior input. | Until later staging/action state replaces it. |
| Prompt recovery | A persistent card above the composer explains that admission failed and offers account repair or Retry. | Until resolved or state changes. |
| Runtime failure | Transcript-area card reports **Runtime stopped unexpectedly** and offers **Reconnect**. | Current errored chat state. |
| Browser selection delivery | Result/error remains in the originating browser card until **Close**. | Until explicit acknowledgement. |

OMP Chat notifications do not auto-dismiss. A later notice replaces the current notice singleton, and errors use a separate singleton. There is no notification history, native notification, sound, badge preference, or multi-device delivery (`packages/desktop/src/renderer/ui/pages/OmpChat.svelte:1190-1238,2294-2297,2425-2427,2476-2482,3148-3149`; `packages/desktop/src/renderer/ui/molecules/Toast.svelte:1-27`).

Outer-shell workspace reconnect and action errors are rendered as bottom-right toasts: transient notices with `role=status`, action errors with `role=alert`, and the persistent retry-exhausted error with **Retry** and dismiss controls. The earlier absence of this feedback path was [`CHAT-002`](../bug-triage.md#chat-002--workspace-reconnect-and-outer-shell-errors-are-not-rendered), resolved 2026-08-25; a mounted journey that severs the runtime and observes the announcements remains open.

## Themes, contrast, density, and motion

### Theme and contrast

The application offers Dark, Light, and System themes. Explicit Dark/Light override the operating system; System follows the current OS scheme. Theme changes update renderer tokens, native window/browser backgrounds, the Local terminal palette, and the active browser-selection inspector (`packages/desktop/src/renderer/ui/pages/App.svelte:135-171`; `packages/desktop/src/main/workspace-host.ts:854-864`).

The passing Electron test **“applies AAA neutral palettes in dark and light modes”** exercises Dark, Light, and System; focus indicators; terminal surfaces; native and renderer background parity; narrow layout; an OS scheme change; enhanced-contrast Axe; and stable replay (`packages/desktop/e2e/desktop.spec.ts:1823-2130`). It establishes the tested palette paths, not every arbitrary embedded web page.

Source tests specify AAA text/semantic/ANSI contrast and 3:1 component/focus boundaries (`packages/desktop/test/theme-palette.test.ts:75-267`). Because the package unit command failed, those unit-only assertions remain **test-specified** where not also exercised by the mounted Electron journey.

Forced-colors CSS retains focus/selection affordances (`packages/desktop/src/renderer/styles/_foundation.scss:119-135`), but no passing journey enabled OS forced-colors. At 200–400% zoom, actual reading order, clipping, and focus visibility also remain open.

### Interface density and responsive layout

Comfortable is the default; Compact changes the root `data-density` immediately (`packages/desktop/src/renderer/ui/pages/App.svelte:161-171,410-458`). The core journey observed Compact application, and the dedicated composer/runtime journeys exercised both densities across wide and narrow viewports (`packages/desktop/e2e/desktop.spec.ts:179-306,466-973`).

At narrow sizes, the composer changes from one-row to two-row structure, its textarea grows to a cap and then scrolls, chips remain removable, menus remain bounded, and drag overlay content avoids horizontal overflow. These claims are **Tested** by the named mounted composer and drag-overlay journeys, not inferred from static styles.

### Motion

Reduce motion is an application preference and is off by default. When enabled, `data-reduce-motion=true` shortens animations/transitions and disables smooth scrolling. The CSS separately honors the OS `prefers-reduced-motion` signal even when the app preference is off (`packages/desktop/src/renderer/styles/_foundation.scss:101-117`).

The reduced-motion drag journey passed with Compact density at a narrow viewport and asserted no composer animation plus no serious/critical Axe findings (`packages/desktop/e2e/desktop.spec.ts:1021-1057`). The preference is not propagated into injected embedded-page inspector styling; only the page's OS media query is established. Whether the application preference should govern that inspector is an **Open question**.

## Bounded content and progressive disclosure

Bounding is an accessibility and performance rule, not permission to label partial data as complete.

| Surface | Default bound | Expansion or recovery |
| --- | --- | --- |
| Status/activity semantic entries | Up to four entries inline. | **Show status details** or **Show activity details** reveals the remainder. |
| IRC | Three preview lines. | **Show full IRC message**. |
| Advisor findings | First three notes. | **Show remaining advisor notes**. |
| Custom/extension content | Collapses when explicitly requested, omitted, or over 16 KiB. | **Show full … message** where supported. |
| Context transition | Two-line preview. | **Show full … summary**. |
| Command execution | Three-line output preview. | Lazy **Show full output**. |
| Read/write/edit tool activity | Bounded line previews. | **Show full preview** where supported. |
| File diff | Up to 2,000 lines or 256 KiB; counts cover the full patch. | Status reports binary/unavailable/clean states; no claim that the preview is the full patch. |
| Reasoning | Lazy historical hydration, with a renderer display cap. | Current “full” path can still show only a 16 KiB preview for records over 64 KiB. |

The history journey passed with 100-row paging, paused follow, unseen activity, bounded read/write/edit summaries, and **Jump to latest** (`packages/desktop/e2e/desktop.spec.ts:1459-1511`). The semantic journey passed with expansion and responsive overflow checks (`packages/desktop/e2e/desktop.spec.ts:1748-1822`).

The Reasoning exception is tracked as [`CHAT-004`](../bug-triage.md#chat-004--full-large-reasoning-remains-truncated). Until resolved, documentation and labels must not imply that a bounded preview exposes every byte.

## Owning feature documents

- Composer keys, active-turn controls, and prompt recovery: [Composing and controlling turns](../features/composing-and-controlling-turns.md).
- Attachment buttons, drag overlay, staging feedback, limits, and cleanup: [Attachments](../features/attachments.md).
- Transcript semantics, follow state, and disclosures: [Reviewing the conversation transcript](../features/reviewing-the-conversation-transcript.md).
- File inventory, current diff, and modal focus: [Reviewing changed files](../features/reviewing-changed-files.md).
- Agent/advisor focus, read-only states, and retained transcripts: [Agent Hub](../features/agent-hub.md).
- Modal requests and in-app notification sources: [Extension requests and notifications](../features/extension-requests-and-notifications.md).
- Settings search, appearance controls, and account actions: [Settings and provider accounts](../features/settings-and-provider-accounts.md).
- Drawer controls and terminal visual preferences: [Local terminal drawer](../features/local-terminal-drawer.md).
- Browser-card feedback and delivery acknowledgement: [Browser selection to chat](../features/browser-selection-to-chat.md).

## Revision and evidence limits

- Source revision: working tree anchored at `c125341133ff90a29fe266e1b166bac0183338c8`; relevant desktop sources may be modified or untracked relative to that commit.
- Evidence date and environment: 2026-08-25, macOS arm64.
- Runtime evidence: `desktop.spec.ts` **24/24 passed**, `omp-selection.spec.ts` **8/8 passed**, and `real.spec.ts` **1/1 passed**. Passing claims above identify the actual mounted Electron journey that exercised them.
- Separate test evidence: `bun run test` failed. Unit-only palette, search, and projection assertions are **test-specified**, not passing evidence.
- Evidence limits: no dedicated screen-reader audit, complete tab-order audit, open-Settings/auth/extension-modal Axe pass, forced-colors run, 200–400% zoom run, IME runtime journey, native Finder drag, or cross-platform native focus audit was performed. Generic modal focus containment, workspace-tab keyboard navigation, turn-completion focus, and full Reasoning disclosure remain **Open question** or triaged gaps.

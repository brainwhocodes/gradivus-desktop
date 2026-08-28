# Glossary

This vocabulary is canonical for the Gradivus OMP Chat product description. Use the preferred term in prose and preserve quoted interface labels exactly when they differ.

## Product and surfaces

**Gradivus**  
The canonical product name used by this documentation set and the repository root `README.md`.

**OMP**  
Oh My Pi, the local coding-agent runtime that owns models, provider access, tool execution, and resumable conversation history.

**OMP Chat**
The fixed Electron chat tab where a user chooses a workspace, manages chats, composes requests, follows OMP activity, and opens chat-scoped inspectors. It is a surface within Gradivus, not another product name. Its visible tab label is **Gradivus** with a small **native** pill.

**workspace shell**
The Electron window around OMP Chat and browser tabs. It owns the custom title bar, window controls (Minimize, Maximize/Restore, Close), the tab strip, global keyboard shortcuts, the Settings route, and the initial connection overlay.

**tab strip**
The row of tabs at the top of the workspace shell. It always contains the fixed chat tab and zero or more browser tabs.

**browser tab**
A durable workspace record shown in the tab strip. Browser tabs are named **Browser**, **Browser 2**, and so on; page titles never reach the tab strip.

**browser pane**
One sandboxed native web view inside a browser tab. A tab holds one to four panes arranged as columns, rows, or a 2×2 grid.

**browser workspace**
The browser-tab and browser-pane area beside OMP Chat, including per-pane address bars, the browser toolbar, and the element-targeting entry points.

**window controls**
The Minimize, Maximize/Restore, and Close controls in the custom title bar. Window geometry does not persist across relaunch.

**Local terminal drawer**
The chat-local drawer opened from the transcript header with the terminal toggle. Its interactive area is a region named **Shell terminal**, rendered by a platform-selected terminal engine. The shell does not add its input or output to OMP context or the conversation transcript.

**terminal engine**
The platform-selected renderer inside the Local terminal drawer: `wterm-dom` (DOM rows with the libghostty WebAssembly core) on Windows, and `ghostty-web` (canvas with the Ghostty Web WebAssembly core) on macOS and Linux. Exposed on the drawer as `data-terminal-renderer`.

## Containers and persistence

**rail workspace**  
A group in the OMP Chat session rail. Chats are grouped when their local `cwd` paths are exactly equal. A rail workspace is a presentation grouping, not the workspace runtime's authority record.

**workspace authority**  
The durable workspace-runtime document that owns browser tabs, panes, terminal records, revisions, and capability state. It is separate from OMP Chat session metadata.

**chat session**  
One selectable conversation in the session rail. It has a local folder, title, timestamps, OMP session identifier, and resumable OMP session file. Prefer this term over the overloaded implementation term “session.”

**Work session**  
A chat whose stored kind is `work`. New desktop chats currently use this kind. The renderer does not expose a Work/Code kind switch.

**Code session**  
A legacy or restored chat whose stored kind is `code`. Code sessions disclose more technical tool detail than Work sessions.

**OMP session**  
The resumable coding-agent conversation and JSONL history behind a chat session.

**workspace session**  
An internal workspace-authority actor and capability connection. It is not a chat session and should appear only in a `Technical note`.

**resident runtime**  
A live OMP child process available to a chat session.

**dormant runtime**  
A saved chat session whose OMP child process is stopped. Opening the chat starts or resumes it from its saved OMP session file.

**workspace runtime**  
The local daemon that persists workspace-authority state and owns durable browser and terminal services. Its reconnect lifecycle is distinct from reconnecting an errored OMP chat.

**runtime residency**
The supervisor rule that at most three chat runtimes stay resident, an idle runtime stops after five minutes, and opening a further chat evicts the least-recently-used idle one. Evicted chats resume transparently from their saved OMP session file.

**Page Agent**
The hidden OMP session Gradivus provisions automatically the first time a user selects a page element. It runs inline element work and queued tasks, is visible in the browser pane's Agent Hub, and never appears in the chat rail.

**element targeting**
The interaction of selecting a page element in a browser pane and giving OMP an instruction through the Page Agent. Its delivery actions are **Ask OMP** (inline), **Send to Chat**, and **Add to Queue**.

## Conversation and turn lifecycle

**conversation transcript**  
The ordered, reviewable history in the center of OMP Chat. This is the preferred term. The code and package README also call it a timeline.

**transcript entry**  
One user, assistant, reasoning, tool, semantic system, or fallback record in the conversation transcript.

**turn**  
A primary user submission and OMP's resulting work until completion, failure, or interruption.

**active turn**  
A turn for which the renderer has a pending submission or OMP reports a running state. The composer changes from **Send** to **Steer**, exposes **Queue for next turn**, and the live status exposes **Stop**.

**draft**  
Unsubmitted composer text. Draft text is renderer-local and is not durable across process exit.

**primary message**  
A submission made while no turn is active. It starts a new turn.

**steering message**  
A message admitted into the currently active turn. The visible action is **Steer** and Enter performs this action while a turn is active.

**queued follow-up**  
A message explicitly sent with **Queue for next turn**. Implementation contracts call this a follow-up.

**local command**  
A slash command completed by the runtime without invoking the agent. Its output can enter the transcript even though no agent turn starts.

**optimistic user entry**  
The immediate local copy of a submitted message. The canonical backend user entry replaces it after acknowledgement so the transcript retains one user entry.

**optimistic reasoning placeholder**  
The immediate running entry shown while OMP prepares a response. It is removed or reconciled when authoritative activity arrives or the turn finishes.

**prompt result**  
The correlated asynchronous outcome that says whether a submitted prompt was admitted, completed locally, or failed before agent work could start.

**prompt recovery card**  
The **Prompt could not start** card shown after a start or preflight failure. It preserves recovery context and offers provider settings and Retry.

**Reconnect**  
The user action that resumes an errored OMP chat from its saved session file. Do not use it for automatic workspace-runtime reconnection.

## Composer and attachments

**composer**  
The textarea, attachment controls, runtime picker, context meter, and Send/Steer actions at the bottom of the active chat.

**runtime picker**  
The disclosure that summarizes and changes the active provider, model, and thinking level.

**thinking level**  
The runtime setting controlling reasoning effort. The transcript's user-facing disclosure is labelled **Reasoning**; do not use “thinking” and “reasoning” interchangeably outside quoted labels.

**context meter**  
The disclosure showing used, remaining, and total context tokens, the selected model, and generation throughput when available.

**plan mode**  
A session mode visibly marked **PLAN MODE**. It changes composer guidance but does not create a separate chat container.

**staged attachment**  
A temporary file, image, or oversized prompt copied into a chat-session attachment store and represented by a removable chip before admission.

**FILE attachment**  
A generic file delivered to OMP as a trusted temporary-file reference.

**IMG attachment**  
An image recognized by content signature and delivered through OMP's image input path.

**PROMPT attachment**  
Text larger than the inline prompt limit, staged as the complete request. The visible chip is currently named **Pasted prompt**, including for oversized programmatic input.

## Transcript and review

**Reasoning entry**  
A disclosure containing OMP reasoning text and an estimated token count. Running, complete, and error presentation differ.

**tool entry**  
A stable transcript row for one tool-call identifier. Partial output and completion update the same row.

**tool activity**  
A bounded, user-safe summary of a read, write, edit, or Agent Hub operation. It is not the raw tool request or result.

**technical details**  
Additional tool arguments and result material exposed for Code sessions. Work sessions intentionally project less detail.

**semantic entry**  
A structured status, activity, IRC, advisor, custom, context, execution, or assistant-outcome presentation derived from a runtime event.

**current working-tree diff**  
The diff fetched when the user chooses **View diff**. It reflects the current workspace state, not a historical snapshot captured when the tool ran.

**timeline follow**  
The per-chat intent to keep the conversation transcript at its latest entry. Scrolling upward pauses follow.

**Jump to latest**  
The control that returns a paused transcript to the bottom, clears its unseen count, and resumes timeline follow.

## Inspectors and delegated work

**Agent Hub**  
The chat-scoped inspector for retained OMP agents and advisors. It exposes roster state, bounded progress, transcripts, unread state, messaging, and permitted lifecycle actions.

**retained agent**  
An OMP agent that remains visible in Agent Hub after its latest activity. Its state can be running, idle, parked, or aborted.

**advisor**  
A read-only Agent Hub participant whose findings remain inspectable but cannot receive ordinary lifecycle or messaging actions.

**aborted agent history**  
The read-only retained transcript shown after an agent is killed or otherwise aborted.

**Files inspector**  
The chat-scoped inventory of successful completed write/edit activity, deduplicated by path and ordered newest first.

**unseen completion**  
A completed turn or agent update in a chat other than the one the user is currently reviewing. The session rail or Agent Hub shows a marker or count.

## Requests, accounts, and feedback

**extension request**  
An ephemeral OMP modal asking the user to select, confirm, enter, or edit a value. It is not a durable transcript entry.

**notification**  
A manually dismissible in-app toast. OMP Chat does not currently provide a notification center, operating-system notification, sound, or multi-device delivery.

**provider access**  
The Settings area showing provider availability and sign-in state reported by OMP.

**OAuth account routing lock**  
A routing pin that keeps a provider on one local OAuth account. It is not encryption, a workspace lock, or a read-only state.

**account failover**  
The runtime option allowing another stored OAuth account to be selected when appropriate.

**application settings**  
Machine-local Gradivus preferences such as theme, density, reduced motion, transcript detail, browser defaults, and terminal appearance.

**OMP defaults**  
Runtime-reported defaults for future or current OMP behavior. Their apply timing can be immediate or next session.

## Evidence terms

**Observed**  
Seen while Playwright drove the actual Electron application in this checkout.

**Tested**  
Established by an executable assertion. A test found in source but not run is identified separately as test-specified.

**Code-established**  
Directly determined from a production state transition or renderer branch, without a runtime observation.

**Inference**  
A reasonable consequence of the implementation that has not been observed or asserted. Inferences are explicitly labelled.

**Open question**  
Behavior that the available source, tests, and runtime journey do not settle.